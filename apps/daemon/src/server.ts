import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import { installGate } from "./adapters/install.ts";
import { acknowledge, checkCall, complete, GateError, gateView, intend, reject, release, syncRepo } from "./gate/machine.ts";
import {
  detectBaseRef,
  fileIdFor,
  listCommit,
  listRange,
  listStaged,
  listUnstaged,
  listWorktree,
  parentOf,
  patchRange,
  repoStatus,
} from "./git/diff.ts";
import { git } from "./git/runner.ts";
import { watchRepo } from "./git/watcher.ts";
import {
  findRepo,
  findRepoByPath,
  findSlice,
  insertRepo,
  listRepos,
  listSlices,
  openStore,
  setBaseRef,
  toSlice,
  writeDaemonInfo,
} from "./session/store.ts";
import { chooseFolder } from "./pick-folder.ts";
import { readFinalRound, setFinalRound } from "./round.ts";
import { summarizeFile } from "./summary.ts";
import { openPanel } from "./panel.ts";
import { findSymbols, readSource } from "./symbols.ts";

type SocketClient = { send: (text: string) => void };

const webRoot = join(import.meta.dirname, "../../web");
const cliPath = join(import.meta.dirname, "../../cli/review-gate.ts");

export type RunningServer = {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
};

export async function startServer(options: { repoPath: string; open?: boolean }): Promise<RunningServer> {
  const db = openStore();
  const token = randomBytes(32).toString("hex");
  const repoPath = await topLevel(resolve(options.repoPath));
  const clients = new Set<SocketClient>();
  let fingerprint = "";
  let stopped = false;

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      const status = error instanceof GateError ? error.status : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : "服务错误" });
    }
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const client: SocketClient = {
      send(text: string) {
        const payload = Buffer.from(text);
        const header = [0x81];
        if (payload.length < 126) header.push(payload.length);
        else header.push(126, payload.length >> 8, payload.length & 0xff);
        socket.write(Buffer.concat([Buffer.from(header), payload]));
      },
    };
    clients.add(client);
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });

  const watcher = watchRepo(repoPath, () => {
    void onRepoChange();
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeDaemonInfo({ pid: process.pid, port, token });
  const url = `http://127.0.0.1:${port}/`;
  if (options.open) openPanel(url);

  async function onRepoChange(): Promise<void> {
    if (stopped) return;
    try {
      const repo = findRepoByPath(db, repoPath);
      if (!repo || stopped) return;
      const changed = await syncRepo(db, repoPath, repo.id);
      if (stopped) return;
      const status = await repoStatus(repo.path, repo.base_ref);
      const porcelain = await git(repo.path, ["status", "--porcelain=v1", "-z"]);
      const next = `${status.head}:${porcelain}`;
      if (!changed && next === fingerprint) return;
      fingerprint = next;
      publish(repo.id);
    } catch {
      return;
    }
  }

  function publish(repoId: string): void {
    const view = gateView(db, repoId);
    const payload = JSON.stringify({
      type: "gate.updated",
      repoId,
      state: view.state,
      sliceId: view.slice?.sliceId ?? null,
      purpose: view.slice?.purpose ?? null,
      agent: view.slice?.agent ?? null,
    });
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { pid: process.pid, version: VERSION, repos: listRepos(db).length });
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const html = readFileSync(join(webRoot, "index.html"), "utf8").replace(
        "/*__BOOT__*/",
        `window.__REVIEW__=${JSON.stringify({ token, repoPath })};`,
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && (path === "/app.js" || path === "/app.css")) {
      const type = path.endsWith(".js") ? "text/javascript" : "text/css";
      res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      res.end(readFileSync(join(webRoot, path.slice(1))));
      return;
    }
    if (!authorized(req, token)) {
      sendJson(res, 401, { error: "未授权" });
      return;
    }
    if (req.method === "GET" && path === "/repos") {
      sendJson(res, 200, listRepos(db));
      return;
    }
    if (req.method === "POST" && path === "/repos") {
      const body = await readJson(req);
      sendJson(res, 200, await registerRepo(String(body.path ?? repoPath)));
      return;
    }
    if (req.method === "POST" && path === "/repos/pick-path") {
      try {
        sendJson(res, 200, { path: await chooseFolder() });
      } catch (error) {
        const message = error instanceof Error ? error.message : "没有选到文件夹";
        sendJson(res, 400, { error: message });
      }
      return;
    }

    const repoMatch = /^\/repos\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!repoMatch) {
      sendJson(res, 404, { error: "没有这个地址" });
      return;
    }
    const repo = findRepo(db, decodeURIComponent(repoMatch[1] ?? ""));
    if (!repo) {
      sendJson(res, 404, { error: "仓库未登记" });
      return;
    }
    const rest = repoMatch[2] ?? "";
    const scope = url.searchParams.get("scope") ?? "slice";
    const sliceId = url.searchParams.get("sliceId");

    if (req.method === "GET" && rest === "status") {
      const status = await repoStatus(repo.path, repo.base_ref);
      const view = gateView(db, repo.id);
      sendJson(res, 200, { ...status, baseRef: repo.base_ref, gate: view.state, lease: view.lease });
      return;
    }
    if (req.method === "POST" && rest === "base") {
      const body = await readJson(req);
      const baseRef = String(body.baseRef ?? "").trim();
      if (!baseRef) throw new GateError(400, "基准分支不能为空");
      setBaseRef(db, repo.id, baseRef);
      sendJson(res, 200, { baseRef });
      return;
    }
    if (req.method === "GET" && rest === "gate") {
      sendJson(res, 200, present(gateView(db, repo.id)));
      return;
    }
    if (req.method === "POST" && rest === "gate/intent") {
      const body = await readJson(req);
      const view = intend(db, repo.id, String(body.agent ?? "agent"), String(body.purpose ?? ""));
      if (typeof body.final === "boolean" && view.slice) setFinalRound(db, view.slice.sliceId, body.final);
      publish(repo.id);
      sendJson(res, 200, present(view));
      return;
    }
    if (req.method === "GET" && rest === "gate/wait") {
      await waitFor(req, res, repo.id, sliceId);
      return;
    }
    if (req.method === "GET" && rest === "gate/settle") {
      await settleFor(req, res, sliceId);
      return;
    }
    if (req.method === "POST" && rest === "gate/release") {
      const body = await readJson(req);
      publishAfter(repo.id, await release(db, repo.path, String(body.sliceId ?? "")));
      sendJson(res, 200, gateView(db, repo.id));
      return;
    }
    if (req.method === "POST" && rest === "gate/ack") {
      const body = await readJson(req);
      acknowledge(db, String(body.sliceId ?? ""));
      publish(repo.id);
      sendJson(res, 200, gateView(db, repo.id));
      return;
    }
    if (req.method === "POST" && rest === "gate/reject") {
      const body = await readJson(req);
      await reject(db, repo.path, String(body.sliceId ?? ""), String(body.reason ?? ""));
      publish(repo.id);
      sendJson(res, 200, gateView(db, repo.id));
      return;
    }
    if (req.method === "POST" && rest === "gate/complete") {
      await complete(db, repo.path, repo.id);
      publish(repo.id);
      sendJson(res, 200, present(gateView(db, repo.id)));
      return;
    }
    if (req.method === "POST" && rest === "gate/check") {
      sendJson(res, 200, checkCall(db, repo.id, await readJson(req)));
      return;
    }
    if (req.method === "POST" && rest === "gate/install") {
      installGate(repo.path, cliPath);
      sendJson(res, 200, { installed: true });
      return;
    }
    if (req.method === "GET" && rest === "slices") {
      sendJson(res, 200, listSlices(db, repo.id).map(toSlice));
      return;
    }
    if (req.method === "GET" && rest === "diff") {
      const files = await safeFiles(repo.path, repo.base_ref, repo.id, scope, sliceId);
      const args = await diffArgsFor(repo.path, repo.base_ref, repo.id, scope, sliceId);
      const summarized = [];
      for (const file of files) {
        summarized.push({ ...file, summary: await fileSummary(repo.path, args, file) });
      }
      sendJson(res, 200, { scope, files: summarized });
      return;
    }
    const patchMatch = /^files\/([^/]+)\/patch$/.exec(rest);
    if (req.method === "GET" && patchMatch) {
      const filePath = decodeURIComponent(patchMatch[1] ?? "");
      const diffArgs = await diffArgsFor(repo.path, repo.base_ref, repo.id, scope, sliceId);
      const patch = await patchRange(repo.path, diffArgs, filePath);
      sendJson(res, 200, { fileId: fileIdFor(filePath), path: filePath, ...patch });
      return;
    }
    if (req.method === "GET" && rest === "symbols") {
      const kind = url.searchParams.get("kind") ?? "implementation";
      const allowed = kind === "references" || kind === "definition" ? kind : "implementation";
      const identifier = url.searchParams.get("identifier") ?? "";
      sendJson(res, 200, { kind: allowed, identifier, items: findSymbols(repo.path, identifier, allowed) });
      return;
    }
    if (req.method === "GET" && rest === "source") {
      sendJson(res, 200, readSource(repo.path, url.searchParams.get("path") ?? "", Number(url.searchParams.get("line") ?? "1")));
      return;
    }
    sendJson(res, 404, { error: "没有这个地址" });
  }

  function present(view: ReturnType<typeof gateView>) {
    const sliceId = view.slice?.sliceId ?? null;
    return { ...view, finalRound: sliceId ? readFinalRound(db, sliceId) : null };
  }

  async function registerRepo(inputPath: string): Promise<{ repoId: string; branch: string; baseRef: string }> {
    const top = await topLevel(resolve(inputPath));
    const existing = findRepoByPath(db, top);
    const baseRef = existing?.base_ref ?? (await detectBaseRef(top));
    const id = existing?.id ?? randomUUID();
    if (!existing) insertRepo(db, { id, path: top, base_ref: baseRef, created_at: new Date().toISOString() });
    const status = await repoStatus(top, baseRef);
    return { repoId: id, branch: status.branch, baseRef };
  }

  async function safeFiles(cwd: string, baseRef: string, repoId: string, scope: string, sliceId: string | null) {
    try {
      if (scope === "branch") return await listRange(cwd, baseRef, (await git(cwd, ["rev-parse", "HEAD"])).trim());
      if (scope === "staged") return await listStaged(cwd);
      if (scope === "unstaged") return await listUnstaged(cwd);
      const commit = commitFor(repoId, sliceId);
      if (commit) {
        const parent = await parentOf(cwd, commit);
        return parent ? await listCommit(cwd, parent, commit) : [];
      }
      return await listWorktree(cwd);
    } catch {
      return [];
    }
  }

  async function diffArgsFor(cwd: string, baseRef: string, repoId: string, scope: string, sliceId: string | null): Promise<string[]> {
    if (scope === "branch") return [`${baseRef}...${(await git(cwd, ["rev-parse", "HEAD"])).trim()}`];
    if (scope === "staged") return ["--cached"];
    if (scope === "unstaged") return [];
    const commit = commitFor(repoId, sliceId);
    if (commit) {
      const parent = await parentOf(cwd, commit);
      if (parent) return [parent, commit];
    }
    return ["HEAD"];
  }

  async function fileSummary(cwd: string, diffArgs: string[], file: Parameters<typeof summarizeFile>[0]): Promise<string> {
    if (file.binary) return summarizeFile(file, "");
    try {
      const text = await git(cwd, ["diff", "-U3", "--find-renames", ...diffArgs, "--", file.path]);
      return summarizeFile(file, text);
    } catch {
      return summarizeFile(file, "");
    }
  }

  function commitFor(repoId: string, sliceId: string | null): string | null {
    if (sliceId) return findSlice(db, sliceId)?.commit_sha ?? null;
    return gateView(db, repoId).slice?.commitSha ?? null;
  }

  function publishAfter(repoId: string, _view: unknown): void {
    publish(repoId);
  }

  function waitFor(req: IncomingMessage, res: ServerResponse, repoId: string, sliceId: string | null): Promise<void> {
    const current = sliceId ? findSlice(db, sliceId) : null;
    if (current && (current.state === "editing" || current.state === "rejected")) {
      sendJson(res, 200, gateView(db, repoId));
      return Promise.resolve();
    }
    return new Promise((done) => {
      const timer = setInterval(() => {
        const row = sliceId ? findSlice(db, sliceId) : null;
        const view = gateView(db, repoId);
        const finished = row?.state === "editing" || row?.state === "rejected" || (view.state === "editing" && (!sliceId || view.slice?.sliceId === sliceId));
        if (!finished) return;
        clearInterval(timer);
        sendJson(res, 200, view.slice ? view : { state: "locked", lease: null, slice: row ? toSlice(row) : null });
        done();
      }, 300);
      req.on("close", () => {
        clearInterval(timer);
        done();
      });
    });
  }

  function settleFor(req: IncomingMessage, res: ServerResponse, sliceId: string | null): Promise<void> {
    const send = () => {
      const row = sliceId ? findSlice(db, sliceId) : null;
      if (!row || (row.state !== "approved" && row.state !== "rejected")) return false;
      sendJson(res, 200, { state: row.state, finalRound: readFinalRound(db, row.id) });
      return true;
    };
    if (send()) return Promise.resolve();
    return new Promise((done) => {
      const timer = setInterval(() => {
        if (!send()) return;
        clearInterval(timer);
        done();
      }, 300);
      req.on("close", () => {
        clearInterval(timer);
        done();
      });
    });
  }

  return {
    url,
    port,
    token,
    close: () =>
      new Promise((resolveClose) => {
        stopped = true;
        watcher.close();
        server.close(() => {
          db.close();
          resolveClose();
        });
      }),
  };
}

async function topLevel(repoPath: string): Promise<string> {
  return (await git(repoPath, ["rev-parse", "--show-toplevel"])).trim();
}

function authorized(req: IncomingMessage, token: string): boolean {
  return (req.headers.authorization ?? "") === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
