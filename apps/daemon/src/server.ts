import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import { installGate } from "./adapters/install.ts";
import { closeBugfix, openBugfix, readBugfix } from "./gate/bugfix.ts";
import { acknowledge, checkCall, complete, GateError, gateView, intend, pinOpenSlices, reject, release, syncRepo } from "./gate/machine.ts";
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
  activeSlice,
  findSlice,
  insertRepo,
  countSlices,
  listRepos,
  listSlices,
  openStore,
  SLICE_PAGE_SIZE,
  setBaseRef,
  toSlice,
  writeDaemonInfo,
} from "./session/store.ts";
import { checkoutBranch, createBranch, listLocalBranches, startRef } from "./branches.ts";
import { chooseFolder } from "./pick-folder.ts";
import { startCursorProxy, useCursorProxy } from "./cursor-proxy.ts";
import { cursorRecentStatePath, readRecentFolderPaths } from "./cursor-workspaces.ts";
import { explainInSession, explainSelection, loadThreads, normalizeLines, readAnchor, resolveExplainSession } from "./explain.ts";
import { admitSession, bindMergeTarget, currentSessionId, listWorkSessions, mergeRequirementIntoBranch, mergeWorkBranches, openWorkBranches, readMergeTarget, readSessionBranches, readSessionSummary, readWorkBranches, repairSessionRequirements, sessionPhase } from "./work-branch.ts";
import { readFinalRound, setFinalRound } from "./round.ts";
import { summarizeFile } from "./summary.ts";
import { openPanel } from "./panel.ts";
import { readLocalLines } from "./local-file.ts";
import { findSymbols, readSource } from "./symbols.ts";
import { loadImpactChain } from "./impact.ts";

type SocketClient = { send: (text: string) => void };

const webRoot = join(import.meta.dirname, "../../web");
const cliPath = join(import.meta.dirname, "../../cli/review-gate.ts");

export type RunningServer = {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
};

export async function startServer(options: { repoPath: string; open?: boolean; discoverWorkspaces?: boolean }): Promise<RunningServer> {
  const db = openStore();
  await pinOpenSlices(db);
  const token = randomBytes(32).toString("hex");
  const repoPath = await topLevel(resolve(options.repoPath));
  await beginOnRelease();
  const clients = new Set<SocketClient>();
  let fingerprint = "";
  let stopped = false;
  let discovering = false;
  let discovery: ReturnType<typeof setInterval> | null = null;

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

  const cursorProxy = await startCursorProxy({ repoPath });
  useCursorProxy({ url: cursorProxy.url, token: cursorProxy.token });
  await discoverCursorRepos();
  if (options.discoverWorkspaces) discovery = setInterval(() => void discoverCursorRepos(), 8000);

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeDaemonInfo({ pid: process.pid, port, token });
  const url = `http://127.0.0.1:${port}/`;
  if (options.open) openPanel(url);

  async function discoverCursorRepos(): Promise<void> {
    if (!options.discoverWorkspaces || stopped || discovering) return;
    discovering = true;
    try {
      const folders = readRecentFolderPaths(cursorRecentStatePath());
      for (const folder of folders) {
        if (stopped) return;
        let top = "";
        try {
          top = await topLevel(folder);
        } catch {
          continue;
        }
        if (stopped || findRepoByPath(db, top)) continue;
        const registered = await registerRepo(top);
        if (stopped) return;
        publish(registered.repoId, registered.branch);
      }
    } catch {
      return;
    } finally {
      discovering = false;
    }
  }

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
      publish(repo.id, status.branch);
    } catch {
      return;
    }
  }

  function publish(repoId: string, branch: string): void {
    const view = gateView(db, repoId, branch);
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && (path === "/app.js" || path === "/app.css" || path === "/impact-layout.js")) {
      const type = path.endsWith(".js") ? "text/javascript" : "text/css";
      res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
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
    const sessionQuery = url.searchParams.get("sessionId");

    if (req.method === "GET" && rest === "status") {
      const status = await repoStatus(repo.path, repo.base_ref);
      const view = gateView(db, repo.id, status.branch);
      await repairSessionRequirements(db, repo.path, repo.id);
      const pair = readWorkBranches(db, repo.id, status.branch);
      sendJson(res, 200, {
        ...status,
        baseRef: repo.base_ref,
        requirement: pair?.requirement ?? null,
        development: pair?.development ?? null,
        mergeTarget: readMergeTarget(db, repo.id, status.branch) || null,
        gate: view.state,
        lease: view.lease,
      });
      return;
    }
    if (req.method === "GET" && rest === "branches") {
      sendJson(res, 200, { branches: await listLocalBranches(repo.path) });
      return;
    }
    if (req.method === "POST" && rest === "branches") {
      const body = await readJson(req);
      const name = String(body.name ?? "");
      const head = await headBranch(repo.path);
      try {
        await createBranch(repo.path, name, await branchBase(repo.path, repo.base_ref));
      } catch (error) {
        const message = error instanceof Error ? error.message : "不能建立分支";
        throw new GateError(message === "分支名无效" ? 400 : 409, message);
      }
      if ((await headBranch(repo.path)) !== head) throw new GateError(500, "新建分支不应切换当前检出");
      sendJson(res, 200, { branch: name.trim() });
      return;
    }
    if (req.method === "POST" && rest === "branch") {
      const body = await readJson(req);
      const head = await headBranch(repo.path);
      const view = gateView(db, repo.id, head);
      if (view.state !== "locked") throw new GateError(409, "评审进行中，不能切换分支");
      await checkoutBranch(repo.path, String(body.branch ?? ""));
      publish(repo.id, await headBranch(repo.path));
      const status = await repoStatus(repo.path, repo.base_ref);
      sendJson(res, 200, { branch: status.branch });
      return;
    }
    if (req.method === "POST" && rest === "work-branches") {
      const body = await readJson(req);
      const head = await headBranch(repo.path);
      const view = gateView(db, repo.id, head);
      if (view.state !== "locked") throw new GateError(409, "评审进行中，不能建立分支");
      const pair = await openWorkBranches(db, repo.path, repo.id, await branchBase(repo.path, repo.base_ref), String(body.name ?? ""));
      publish(repo.id, await headBranch(repo.path));
      sendJson(res, 200, pair);
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
      const head = await headBranch(repo.path);
      const asked = url.searchParams.get("branch")?.trim() ?? "";
      const branch = asked || head;
      const view = gateView(db, repo.id, branch);
      if (branch === head && view.slice && view.state !== "awaiting_release" && view.state !== "locked") {
        admitSession(db, repo.id, head, view.slice.sliceId);
      }
      sendJson(res, 200, {
        ...present(view),
        phase: sessionPhase(db, repo.id, branch, view.slice?.sliceId ?? null),
        mergeTarget: readMergeTarget(db, repo.id, branch) || null,
        branch,
        bugfix: readBugfix(db, repo.id),
      });
      return;
    }
    if (req.method === "POST" && rest === "gate/bugfix") {
      const body = await readJson(req);
      const purpose = String(body.purpose ?? "").trim();
      if (!purpose) closeBugfix(db, repo.id);
      else openBugfix(db, repo.id, purpose);
      publish(repo.id, await headBranch(repo.path));
      sendJson(res, 200, { bugfix: readBugfix(db, repo.id) });
      return;
    }
    if (req.method === "POST" && rest === "gate/intent") {
      const body = await readJson(req);
      let head = await headBranch(repo.path);
      if (!gateView(db, repo.id, head).slice) {
        const session = String(body.session ?? "").trim();
        if (session) {
          if (!readSessionBranches(db, repo.id, session) && !readSessionSummary(session)) {
            throw new GateError(400, "没有会话总结");
          }
          await openWorkBranches(db, repo.path, repo.id, await branchBase(repo.path, "HEAD"), session, true);
          head = await headBranch(repo.path);
        }
      }
      const view = intend(db, repo.id, String(body.agent ?? "agent"), String(body.purpose ?? ""), head);
      if (typeof body.final === "boolean" && view.slice) setFinalRound(db, view.slice.sliceId, body.final);
      publish(repo.id, head);
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
    if (req.method === "POST" && rest === "gate/target") {
      const body = await readJson(req);
      const head = await headBranch(repo.path);
      try {
        const mergeTarget = await bindMergeTarget(db, repo.path, repo.id, head, String(body.branch ?? ""));
        publish(repo.id, head);
        sendJson(res, 200, { mergeTarget });
      } catch (error) {
        const message = error instanceof Error ? error.message : "不能绑定合并目标";
        throw new GateError(409, message);
      }
      return;
    }
    if (req.method === "POST" && rest === "gate/release") {
      const body = await readJson(req);
      const head = await headBranch(repo.path);
      const targetSlice = String(body.sliceId ?? "");
      const slice = findSlice(db, targetSlice);
      const branch = slice?.branch || head;
      if (sessionPhase(db, repo.id, branch, targetSlice) === "requirement" && !readMergeTarget(db, repo.id, branch)) {
        throw new GateError(409, "需求准入前要先绑定合并目标分支。");
      }
      const released = await release(db, repo.path, targetSlice);
      admitSession(db, repo.id, branch, targetSlice);
      publish(repo.id, await headBranch(repo.path));
      sendJson(res, 200, released);
      return;
    }
    if (req.method === "POST" && rest === "gate/ack") {
      const body = await readJson(req);
      const status = await repoStatus(repo.path, repo.base_ref);
      const slice = findSlice(db, String(body.sliceId ?? ""));
      const branchName = slice?.branch || status.branch;
      await mergeWorkBranches(db, repo.path, repo.id, branchName);
      const branch = String(body.branch ?? "").trim();
      if (branch) {
        try {
          await mergeRequirementIntoBranch(db, repo.path, repo.id, branchName, branch);
        } catch (error) {
          const message = error instanceof Error ? error.message : "合并失败";
          throw new GateError(409, message);
        }
      }
      const view = acknowledge(db, String(body.sliceId ?? ""));
      publish(repo.id, status.branch);
      sendJson(res, 200, view);
      return;
    }
    if (req.method === "POST" && rest === "gate/reject") {
      const body = await readJson(req);
      const view = await reject(db, repo.path, String(body.sliceId ?? ""), String(body.reason ?? ""));
      publish(repo.id, await headBranch(repo.path));
      sendJson(res, 200, view);
      return;
    }
    if (req.method === "POST" && rest === "gate/complete") {
      const view = await complete(db, repo.path, repo.id);
      publish(repo.id, await headBranch(repo.path));
      sendJson(res, 200, present(view));
      return;
    }
    if (req.method === "POST" && rest === "gate/check") {
      const body = await readJson(req);
      sendJson(res, 200, checkCall(db, repo.id, body, await headBranch(repo.path)));
      return;
    }
    if (req.method === "POST" && rest === "gate/install") {
      installGate(cliPath);
      sendJson(res, 200, { installed: true });
      return;
    }
    if (req.method === "GET" && rest === "sessions") {
      const head = await headBranch(repo.path);
      const sessions = listWorkSessions(db, repo.id, head);
      sendJson(res, 200, { sessions, current: currentSessionId(db, repo.id, head) });
      return;
    }
    if (req.method === "GET" && rest === "slices") {
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
      sendJson(res, 200, {
        items: listSlices(db, repo.id, page).map(toSlice),
        total: countSlices(db, repo.id),
        page,
        pageSize: SLICE_PAGE_SIZE,
      });
      return;
    }
    if (req.method === "GET" && rest === "impact") {
      const files = await safeFiles(repo.path, repo.base_ref, repo.id, scope, sliceId, sessionQuery);
      const paths = files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]);
      sendJson(res, 200, loadImpactChain(repo.path, paths));
      return;
    }
    if (req.method === "GET" && rest === "diff") {
      const files = await safeFiles(repo.path, repo.base_ref, repo.id, scope, sliceId, sessionQuery);
      const args = await diffArgsFor(repo.path, repo.base_ref, repo.id, scope, sliceId, sessionQuery);
      const summarized = await Promise.all(
        files.map(async (file) => ({ ...file, summary: await fileSummary(repo.path, args, file) })),
      );
      sendJson(res, 200, { scope, files: summarized });
      return;
    }
    const patchMatch = /^files\/([^/]+)\/patch$/.exec(rest);
    if (req.method === "GET" && patchMatch) {
      const filePath = decodeURIComponent(patchMatch[1] ?? "");
      const diffArgs = await diffArgsFor(repo.path, repo.base_ref, repo.id, scope, sliceId, sessionQuery);
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
    if (req.method === "GET" && rest === "local-file") {
      const filePath = url.searchParams.get("path") ?? "";
      const from = Number(url.searchParams.get("from") ?? "1");
      const to = Number(url.searchParams.get("to") ?? "0");
      try {
        sendJson(res, 200, readLocalLines(repo.path, filePath, from, to));
      } catch (error) {
        const message = error instanceof Error ? error.message : "读不到本地文件";
        throw new GateError(400, message);
      }
      return;
    }
    if (req.method === "GET" && rest === "explain") {
      const session = explainSession(repo.id, await headBranch(repo.path), sessionQuery ?? "");
      sendJson(res, 200, { sessionId: session, threads: loadThreads(db, repo.id, session) });
      return;
    }
    if (req.method === "POST" && rest === "explain") {
      const body = await readJson(req);
      const lines = normalizeLines(body.lines);
      if (!lines.length) throw new GateError(400, "先选中代码行");
      const session = explainSession(repo.id, await headBranch(repo.path), String(body.sessionId ?? ""));
      const anchor = readAnchor(body.anchor) ?? undefined;
      if (body.mode === "pseudo" || body.mode === "line") {
        const result = await explainSelection(db, repo.id, session, lines, body.mode, anchor);
        sendJson(res, 200, { sessionId: session, ...result });
        return;
      }
      const comment = String(body.comment ?? "").trim();
      if (!comment) throw new GateError(400, "先写下评论");
      const result = await explainInSession(db, repo.id, session, lines, comment, anchor, repo.path);
      sendJson(res, 200, { sessionId: session, ...result });
      return;
    }
    sendJson(res, 404, { error: "没有这个地址" });
  }

  function present(view: ReturnType<typeof gateView>) {
    const sliceId = view.slice?.sliceId ?? null;
    return { ...view, finalRound: sliceId ? readFinalRound(db, sliceId) : null };
  }

  async function beginOnRelease(): Promise<void> {
    const registered = await registerRepo(repoPath);
    const next = await branchBase(repoPath, registered.baseRef);
    if (next !== "release") return;
    if (registered.baseRef !== "release") setBaseRef(db, registered.repoId, "release");
    try {
      const current = (await git(repoPath, ["symbolic-ref", "--short", "HEAD"])).trim();
      if (gateView(db, registered.repoId, current).state !== "locked") return;
      if (current !== "release") await checkoutBranch(repoPath, "release");
    } catch {
      return;
    }
  }

  async function branchBase(path: string, fallback: string): Promise<string> {
    if (path !== repoPath) return fallback;
    return startRef(await listLocalBranches(path), fallback);
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

  async function headBranch(cwd: string): Promise<string> {
    try {
      return (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
    } catch {
      return "";
    }
  }

  function explainSession(repoId: string, head: string, requested: string): string {
    const known = listWorkSessions(db, repoId, head).map((item) => item.sessionId);
    try {
      return resolveExplainSession(requested, known, currentSessionId(db, repoId, head));
    } catch (error) {
      throw new GateError(404, error instanceof Error ? error.message : "没有这个会话");
    }
  }

  function reviewedSession(repoId: string, sessionId: string | null) {
    const pair = sessionId ? readSessionBranches(db, repoId, sessionId) : null;
    if (!pair) return null;
    return { pair, view: gateView(db, repoId, pair.development) };
  }

  async function safeFiles(cwd: string, baseRef: string, repoId: string, scope: string, sliceId: string | null, sessionId: string | null) {
    try {
      if (scope === "session") {
        const review = reviewedSession(repoId, sessionId);
        if (!review) return [];
        const slice = review.view.slice;
        if (slice?.commitSha) {
          const parent = await parentOf(cwd, slice.commitSha);
          return parent ? await listCommit(cwd, parent, slice.commitSha) : [];
        }
        if (review.view.state === "editing" && review.pair.development === await headBranch(cwd)) {
          return await listWorktree(cwd);
        }
        return await listRange(cwd, review.pair.requirement, review.pair.development);
      }
      if (scope === "branch") {
        const pair = readWorkBranches(db, repoId, await headBranch(cwd));
        if (pair) return await listRange(cwd, pair.requirement, pair.development);
        return await listRange(cwd, baseRef, (await git(cwd, ["rev-parse", "HEAD"])).trim());
      }
      if (scope === "staged") return await listStaged(cwd);
      if (scope === "unstaged") return await listUnstaged(cwd);
      const commit = commitFor(repoId, sliceId, await headBranch(cwd));
      if (commit) {
        const parent = await parentOf(cwd, commit);
        return parent ? await listCommit(cwd, parent, commit) : [];
      }
      return await listWorktree(cwd);
    } catch {
      return [];
    }
  }

  async function diffArgsFor(cwd: string, baseRef: string, repoId: string, scope: string, sliceId: string | null, sessionId: string | null): Promise<string[]> {
    if (scope === "session") {
      const review = reviewedSession(repoId, sessionId);
      if (!review) return ["HEAD"];
      const slice = review.view.slice;
      if (slice?.commitSha) {
        const parent = await parentOf(cwd, slice.commitSha);
        if (parent) return [parent, slice.commitSha];
      }
      if (review.view.state === "editing" && review.pair.development === await headBranch(cwd)) return ["HEAD"];
      return [`${review.pair.requirement}...${review.pair.development}`];
    }
    if (scope === "branch") {
      const pair = readWorkBranches(db, repoId, await headBranch(cwd));
      if (pair) return [`${pair.requirement}...${pair.development}`];
      return [`${baseRef}...${(await git(cwd, ["rev-parse", "HEAD"])).trim()}`];
    }
    if (scope === "staged") return ["--cached"];
    if (scope === "unstaged") return [];
    const commit = commitFor(repoId, sliceId, await headBranch(cwd));
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

  function commitFor(repoId: string, sliceId: string | null, branch: string): string | null {
    if (sliceId) return findSlice(db, sliceId)?.commit_sha ?? null;
    return gateView(db, repoId, branch).slice?.commitSha ?? null;
  }

  async function waitFor(req: IncomingMessage, res: ServerResponse, repoId: string, sliceId: string | null): Promise<void> {
    const repo = findRepo(db, repoId);
    const head = repo ? await headBranch(repo.path) : "";
    const branchOf = (row: { branch?: string } | null | undefined) => row?.branch || head;
    const current = sliceId ? findSlice(db, sliceId) : activeSlice(db, repoId, head);
    if (current && (current.state === "editing" || current.state === "rejected")) {
      sendJson(res, 200, gateView(db, repoId, branchOf(current)));
      return;
    }
    return new Promise((done) => {
      const timer = setInterval(() => {
        const row = sliceId ? findSlice(db, sliceId) : activeSlice(db, repoId, head);
        const view = gateView(db, repoId, branchOf(row));
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
        if (discovery) clearInterval(discovery);
        watcher.close();
        useCursorProxy(null);
        void cursorProxy.close().finally(() => {
          server.close(() => {
            db.close();
            resolveClose();
          });
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
