import { createHash } from "node:crypto";
import type { FileChange, FileStatus } from "../../../packages/protocol/src/index.ts";
import { cursorProxyTarget, type AgentWrite } from "./cursor-proxy.ts";
import { summarizeFile } from "./summary.ts";

const statusLabel: Record<FileStatus, string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名并修改",
};

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export function summaryPrompt(file: FileChange, patch: string): string {
  const body = patch.length > 12000 ? `${patch.slice(0, 12000)}\n…diff 已截断，只根据可见部分总结。` : patch;
  return `你是代码评审助手。只根据下面这一个文件的 unified diff，说明改动点在哪里、是怎么改的。

写给正在核对这段 diff 的人，放在该文件 diff 上方。用中文，按改动点分段。每处单独一段，先写位置，再写改法。不要评价好坏，不要写 diff 里没有的行为。

每一处都写成：
位置：文件名，以及具体函数、类、分支或配置。多处就按 diff 中的出现顺序逐条写。
改法：写清改前和改后。能对应到语句、条件、文案或调用时，用简短原文对照，写成「原来是……，现在改成……」。不要只说「修改了某函数」。
结果：这处改动改变了什么行为。看不出行为变化时，写「从 diff 看不出行为变化」，不要编。

不要统计增删行数，不要复述整段 diff。整段以看清改动点为准，一般 150 到 300 字。

文件：${file.path}
状态：${statusLabel[file.status]}
${body}`;
}

export function responseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { output_text?: unknown; output?: unknown; choices?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  const parts: string[] = [];
  if (Array.isArray(record.output)) {
    for (const item of record.output) collectText(item, parts);
  }
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== "object") continue;
      collectText((choice as { message?: unknown }).message, parts);
    }
  }
  return parts.join("\n").trim();
}

export async function summarizeDiff(file: FileChange, patch: string): Promise<string> {
  if (file.binary || file.status === "D" || !patch.trim()) return summarizeFile(file, patch);
  const key = createHash("sha256").update(`${file.path}\0${patch}`).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;
  const running = pending.get(key);
  if (running) return running;
  const task = ask(summaryPrompt(file, patch))
    .then(({ text }) => {
      const clean = text.trim();
      if (!clean) return summarizeFile(file, patch);
      if (cache.size > 80) cache.clear();
      cache.set(key, clean);
      return clean;
    })
    .catch(() => summarizeFile(file, patch))
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

function collectText(value: unknown, parts: string[]): void {
  if (!value || typeof value !== "object") return;
  const record = value as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") parts.push(record.text);
  if (typeof record.content === "string") parts.push(record.content);
  if (!Array.isArray(record.content)) return;
  for (const block of record.content) collectText(block, parts);
}

export async function completePrompt(prompt: string): Promise<string> {
  return (await ask(prompt)).text;
}

export async function completeRun(prompt: string, write = false, repoPath = ""): Promise<{ text: string; writes: AgentWrite[] }> {
  return ask(prompt, write, repoPath);
}

export function responseWrites(payload: unknown): AgentWrite[] {
  if (!payload || typeof payload !== "object") return [];
  const writes = (payload as { writes?: unknown }).writes;
  if (!Array.isArray(writes)) return [];
  const parsed: AgentWrite[] = [];
  for (const item of writes) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    if (!path) continue;
    parsed.push({
      path,
      contents: typeof record.contents === "string" ? record.contents : undefined,
      oldText: typeof record.oldText === "string" ? record.oldText : undefined,
      newText: typeof record.newText === "string" ? record.newText : undefined,
      applied: record.applied === true,
    });
  }
  return parsed;
}

async function ask(prompt: string, write = false, repoPath = ""): Promise<{ text: string; writes: AgentWrite[] }> {
  const target = cursorProxyTarget();
  const response = await fetch(`${target.url}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "cursor", input: prompt, write, repoPath, store: false }),
    signal: AbortSignal.timeout(100_000),
  });
  if (!response.ok) {
    let message = "总结失败";
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) message = payload.error.trim();
    } catch {
      message = "总结失败";
    }
    throw new Error(message);
  }
  const payload = await response.json();
  const text = responseText(payload);
  const writes = responseWrites(payload);
  if (!text && writes.length === 0) throw new Error("总结为空");
  return { text, writes };
}
