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

export type AgentWrite = {
  path: string;
  contents?: string;
  oldText?: string;
  newText?: string;
  applied: boolean;
};

export function promptInput(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const input = (body as { input?: unknown }).input;
  return typeof input === "string" ? input.trim() : "";
}

export function requestWrite(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as { write?: unknown }).write === true;
}

export function requestRepo(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const repoPath = (body as { repoPath?: unknown }).repoPath;
  return typeof repoPath === "string" && repoPath.trim() ? repoPath.trim() : fallback;
}

export function agentArgs(repoPath: string, prompt: string, write = false): string[] {
  if (write) {
    return ["-p", "--trust", "--force", "--output-format", "stream-json", "--workspace", repoPath, prompt];
  }
  return ["-p", "--mode", "ask", "--trust", "--output-format", "text", "--workspace", repoPath, prompt];
}

export function readAgentRun(stdout: string): { text: string; writes: AgentWrite[] } {
  const raw = stdout.trim();
  if (!raw) return { text: "", writes: [] };
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  if (!events.some((event) => isAgentEvent(event))) return { text: raw, writes: [] };
  return fromEvents(events);
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
  const run = options.run ?? ((request) => runCursorAgent(request));
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
      const body = await readJson(req);
      const prompt = promptInput(body);
      if (!prompt) {
        sendJson(res, 400, { error: "没有要解释的内容" });
        return;
      }
      const write = requestWrite(body);
      const repoPath = requestRepo(body, options.repoPath);
      const text = await enqueue(() => run({ repoPath, prompt, args: agentArgs(repoPath, prompt, write) }));
      const parsed = readAgentRun(text);
      sendJson(res, 200, { output_text: parsed.text, writes: parsed.writes });
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

function runCursorAgent(request: { repoPath: string; prompt: string; args: string[] }): Promise<string> {
  const launch = resolveAgentLaunch();
  const args = [...launch.prefix, ...request.args];
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, args, { cwd: request.repoPath, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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

function isAgentEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as { type?: unknown }).type;
  return type === "result" || type === "assistant" || type === "tool_call" || type === "system";
}

function fromEvents(events: unknown[]): { text: string; writes: AgentWrite[] } {
  const messages: string[] = [];
  let result = "";
  const byCall = new Map<string, AgentWrite>();
  const order: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type === "result" && typeof record.result === "string") result = record.result;
    if (record.type === "assistant") {
      const text = messageText(record.message);
      if (text) messages.push(text);
    }
    if (record.type !== "tool_call") continue;
    const extracted = extractWrite(record.tool_call);
    if (!extracted?.path) continue;
    const callId = typeof record.call_id === "string" ? record.call_id : `anon-${order.length}`;
    const applied = record.subtype === "completed" && toolSuccess(record.tool_call);
    const prev = byCall.get(callId);
    const next: AgentWrite = {
      path: extracted.path || prev?.path || "",
      contents: extracted.contents ?? prev?.contents,
      oldText: extracted.oldText ?? prev?.oldText,
      newText: extracted.newText ?? prev?.newText,
      applied: Boolean(prev?.applied || applied),
    };
    if (!prev) order.push(callId);
    byCall.set(callId, next);
  }
  const editMessage = [...messages].reverse().find((item) => /动作[:：]\s*修改/.test(item));
  const text = (editMessage || result || messages.join("\n")).trim();
  return { text, writes: order.map((id) => byCall.get(id)).filter((item): item is AgentWrite => Boolean(item?.path)) };
}

function messageText(message: unknown): string {
  const parts: string[] = [];
  collectMessageText(message, parts);
  return parts.join("\n").trim();
}

function collectMessageText(value: unknown, parts: string[]): void {
  if (!value || typeof value !== "object") return;
  const record = value as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") parts.push(record.text);
  if (typeof record.content === "string") parts.push(record.content);
  if (!Array.isArray(record.content)) return;
  for (const block of record.content) collectMessageText(block, parts);
}

function extractWrite(call: unknown): { path: string; contents?: string; oldText?: string; newText?: string } | null {
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  const fn = record.function;
  if (fn && typeof fn === "object") {
    const name = (fn as { name?: unknown }).name;
    const args = parseArgs((fn as { arguments?: unknown }).arguments);
    if (typeof name === "string" && /write|edit|replace|patch/i.test(name) && args) return fieldsFrom(args);
  }
  for (const [key, value] of Object.entries(record)) {
    if (!/write|edit|replace|patch/i.test(key) || !value || typeof value !== "object") continue;
    const args = (value as { args?: unknown }).args;
    const source = args && typeof args === "object" ? args as Record<string, unknown> : value as Record<string, unknown>;
    const found = fieldsFrom(source);
    if (found) return found;
  }
  return null;
}

function parseArgs(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value as Record<string, unknown> : null;
}

function fieldsFrom(args: Record<string, unknown>): { path: string; contents?: string; oldText?: string; newText?: string } | null {
  const path = firstString(args, ["path", "file_path", "filePath", "target_file", "targetFile"]);
  if (!path) return null;
  const contents = firstString(args, ["fileText", "contents", "content", "file_text"]);
  const oldText = firstString(args, ["old_string", "oldString", "old_text", "oldText"]);
  const newText = firstString(args, ["new_string", "newString", "new_text", "newText"]);
  if (contents === undefined && (oldText === undefined || newText === undefined)) return null;
  return { path, contents, oldText, newText };
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function toolSuccess(call: unknown): boolean {
  const stack = [call];
  const seen = new Set<unknown>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if ("success" in current && (current as { success?: unknown }).success) return true;
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return false;
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
