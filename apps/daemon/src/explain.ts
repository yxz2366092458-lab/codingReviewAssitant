import type { DatabaseSync } from "node:sqlite";
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

export function resolveExplainSession(requested: string, known: string[], current: string): string {
  const id = requested.trim();
  const fallback = current.trim() || "panel";
  if (!id || id === fallback) return fallback;
  if (known.includes(id)) return id;
  throw new Error("没有这个会话");
}

function ensureExplainTurns(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS explain_turns (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (repo_id, session_id, position)
  )`);
}

export function loadTurns(db: DatabaseSync, repoId: string, sessionId: string): ExplainTurn[] {
  ensureExplainTurns(db);
  const rows = db.prepare(
    "SELECT role, content FROM explain_turns WHERE repo_id = ? AND session_id = ? ORDER BY position",
  ).all(repoId, sessionId) as Array<{ role: string; content: string }>;
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role as ExplainTurn["role"], content: row.content }));
}

export function saveTurns(db: DatabaseSync, repoId: string, sessionId: string, turns: ExplainTurn[]): void {
  ensureExplainTurns(db);
  const kept = turns.slice(-12);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM explain_turns WHERE repo_id = ? AND session_id = ?").run(repoId, sessionId);
    const insert = db.prepare(
      "INSERT INTO explain_turns (repo_id, session_id, position, role, content) VALUES (?, ?, ?, ?, ?)",
    );
    kept.forEach((turn, index) => insert.run(repoId, sessionId, index, turn.role, turn.content));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function explainInSession(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
  lines: CodeLine[],
  comment: string,
): Promise<{ reply: string; turns: ExplainTurn[] }> {
  if (!lines.length) throw new Error("先选中代码行");
  const history = loadTurns(db, repoId, sessionId);
  let reply = "";
  try {
    reply = (await completePrompt(sessionPrompt(history, lines, comment))).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "总结失败" || message === "总结为空") throw new Error("解释失败");
    throw error;
  }
  if (!reply) throw new Error("解释失败");
  const turns = [...history, { role: "user" as const, content: userTurn(lines, comment) }, { role: "assistant" as const, content: reply }].slice(-12);
  saveTurns(db, repoId, sessionId, turns);
  return { reply, turns };
}
