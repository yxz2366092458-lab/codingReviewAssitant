import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const cursorBin = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

export type AgentRun = (request: { repoPath: string; prompt: string; args: string[] }) => Promise<string>;

type ProxyTarget = { url: string; token: string };

let current: ProxyTarget | null = null;

export function useCursorProxy(target: ProxyTarget | null): void {
  current = target;
}

export function cursorProxyTarget(): ProxyTarget {
  if (!current) throw new Error("Cursor 代理没有启动");
  return current;
}

export function promptInput(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const input = (body as { input?: unknown }).input;
  return typeof input === "string" ? input.trim() : "";
}

export function agentArgs(repoPath: string, prompt: string): string[] {
  return ["-p", "--mode", "ask", "--trust", "--output-format", "text", "--workspace", repoPath, prompt];
}

export function resolveAgentLaunch(): { command: string; prefix: string[] } {
  const localAgent = join(homedir(), ".local", "bin", "agent");
  const localCursorAgent = join(homedir(), ".local", "bin", "cursor-agent");
  if (existsSync(localAgent)) return { command: localAgent, prefix: [] };
  if (existsSync(localCursorAgent)) return { command: localCursorAgent, prefix: [] };
  if (existsSync(cursorBin)) return { command: cursorBin, prefix: ["agent"] };
  return { command: "agent", prefix: [] };
}

export async function startCursorProxy(options: { repoPath: string; run?: AgentRun }): Promise<ProxyTarget & { close: () => Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const run = options.run ?? ((request) => runCursorAgent(request.repoPath, request.prompt));
  let chain: Promise<void> = Promise.resolve();
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/responses") {
        sendJson(res, 404, { error: "没有这个接口" });
        return;
      }
      if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
        sendJson(res, 401, { error: "未授权" });
        return;
      }
      const prompt = promptInput(await readJson(req));
      if (!prompt) {
        sendJson(res, 400, { error: "没有要解释的内容" });
        return;
      }
      const text = await enqueue(() => run({ repoPath: options.repoPath, prompt, args: agentArgs(options.repoPath, prompt) }));
      sendJson(res, 200, { output_text: text });
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message.trim() : "总结失败";
      sendJson(res, 502, { error: message.slice(0, 500) });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function runCursorAgent(repoPath: string, prompt: string): Promise<string> {
  const launch = resolveAgentLaunch();
  const args = [...launch.prefix, ...agentArgs(repoPath, prompt)];
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, args, { cwd: repoPath, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Cursor 超时"));
    }, 90_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === "ENOENT" ? new Error("找不到 Cursor agent") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim().slice(0, 500) || "Cursor 没有完成解释"));
        return;
      }
      const text = stdout.trim();
      if (!text) reject(new Error("总结为空"));
      else resolve(text);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
