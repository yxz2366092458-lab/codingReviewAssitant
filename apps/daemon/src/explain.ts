import { completePrompt } from "./summary-ai.ts";

export type CodeLine = {
  path: string;
  side: "base" | "head";
  line: number;
  text: string;
};

export type ExplainTurn = {
  role: "user" | "assistant";
  content: string;
};

const threads = new Map<string, ExplainTurn[]>();

export function normalizeLines(value: unknown): CodeLine[] {
  if (!Array.isArray(value)) return [];
  const lines: CodeLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const line = Number(record.line);
    const path = String(record.path ?? "").trim();
    if (!path || !Number.isInteger(line) || line < 1) continue;
    lines.push({
      path,
      side: record.side === "base" ? "base" : "head",
      line,
      text: String(record.text ?? "").slice(0, 500),
    });
    if (lines.length >= 80) break;
  }
  return lines;
}

export function userTurn(lines: CodeLine[], comment: string): string {
  const note = comment.trim() || "解释这些代码的作用。";
  const body = lines
    .map((line) => `${line.path}:${line.line}（${line.side === "base" ? "基准" : "改后"}）${line.text}`)
    .join("\n");
  return `${note}\n\n${body}`;
}

export function sessionPrompt(history: ExplainTurn[], lines: CodeLine[], comment: string): string {
  const prior = history.map((turn) => `${turn.role === "user" ? "人" : "AI"}：${turn.content}`).join("\n\n");
  return `你是代码评审助手，正在同一会话里回答人的评论。只根据给出的代码行解释它们在做什么。用中文，先说这些行共同完成的事，再按行说明各自的作用。不要评价好坏，不要编造没出现的行为。

${prior ? `同一会话里已经说过：\n${prior}\n\n` : ""}这次评论和选中的代码：
${userTurn(lines, comment)}`;
}

export function remember(key: string, history: ExplainTurn[], lines: CodeLine[], comment: string, reply: string): ExplainTurn[] {
  const turns = [...history, { role: "user" as const, content: userTurn(lines, comment) }, { role: "assistant" as const, content: reply }];
  const kept = turns.slice(-12);
  threads.set(key, kept);
  return kept;
}

export function threadFor(key: string): ExplainTurn[] {
  return threads.get(key) ?? [];
}

export async function explainInSession(
  key: string,
  lines: CodeLine[],
  comment: string,
): Promise<{ reply: string; turns: ExplainTurn[] }> {
  if (!lines.length) throw new Error("先选中代码行");
  const history = threadFor(key);
  let reply = "";
  try {
    reply = (await completePrompt(sessionPrompt(history, lines, comment))).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "总结失败" || message === "总结为空") throw new Error("解释失败");
    throw error;
  }
  if (!reply) throw new Error("解释失败");
  const turns = remember(key, history, lines, comment, reply);
  return { reply, turns };
}
