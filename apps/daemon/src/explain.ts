import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
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

export type ExplainAnchor = {
  path: string;
  side: "base" | "head";
  start: number;
  end: number;
};

export type ExplainStyle = "pseudo" | "line";

export type ExplainModes = {
  pseudo?: string;
  line?: string;
};

export type ExplainThread = ExplainAnchor & {
  turns: ExplainTurn[];
  modes: ExplainModes;
};

const blankAnchor: ExplainAnchor = { path: "", side: "head", start: 0, end: 0 };

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

export function selectionAnchors(lines: CodeLine[]): Array<ExplainAnchor & { lines: CodeLine[] }> {
  const buckets = new Map<string, CodeLine[]>();
  for (const line of lines) {
    const key = `${line.path}\0${line.side}`;
    const list = buckets.get(key) ?? [];
    list.push(line);
    buckets.set(key, list);
  }
  const groups: Array<ExplainAnchor & { lines: CodeLine[] }> = [];
  for (const list of buckets.values()) {
    const sorted = [...list].sort((left, right) => left.line - right.line);
    let current: CodeLine[] = [];
    const push = () => {
      if (!current.length) return;
      groups.push({
        path: current[0].path,
        side: current[0].side,
        start: current[0].line,
        end: current[current.length - 1].line,
        lines: current,
      });
    };
    for (const line of sorted) {
      const previous = current[current.length - 1];
      if (previous && line.line > previous.line + 1) {
        push();
        current = [];
      }
      if (!previous || line.line !== previous.line) current.push(line);
    }
    push();
  }
  return groups;
}

export function anchorFor(lines: CodeLine[]): ExplainAnchor | null {
  const groups = selectionAnchors(lines);
  if (groups.length !== 1) return null;
  return { path: groups[0].path, side: groups[0].side, start: groups[0].start, end: groups[0].end };
}

export function readAnchor(value: unknown): ExplainAnchor | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const path = String(record.path ?? "").trim();
  const start = Number(record.start);
  const end = Number(record.end);
  if (!path || (record.side !== "base" && record.side !== "head")) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { path, side: record.side, start, end };
}

export function userTurn(lines: CodeLine[], comment: string): string {
  const note = comment.trim() || "解释这些代码的作用。";
  const body = lines
    .map((line) => `${line.path}:${line.line}（${line.side === "base" ? "基准" : "改后"}）${line.text}`)
    .join("\n");
  return `${note}\n\n${body}`;
}

export function explainPrompt(lines: CodeLine[], style: ExplainStyle): string {
  const body = lines
    .map((line) => `${line.path}:${line.line}（${line.side === "base" ? "基准" : "改后"}）${line.text}`)
    .join("\n");
  const task = style === "pseudo"
    ? "用中文写出伪代码。伪代码要能看出这些行的步骤和分支。"
    : "用中文按行解释。每一行都说明它在做什么。";
  return `你是代码评审助手。只根据给出的代码行${task}不要评价好坏，不要编造没出现的行为。\n\n${body}`;
}

export type CommentAction =
  | { kind: "reply"; text: string }
  | { kind: "edit"; text: string; code: string };

export function sessionPrompt(history: ExplainTurn[], lines: CodeLine[], comment: string): string {
  const prior = history.map((turn) => `${turn.role === "user" ? "人" : "AI"}：${turn.content}`).join("\n\n");
  return `你是代码评审助手，正在同一会话里处理人的评论。只根据给出的代码行，在答复和修改之间二选一。不要评价好坏，不要编造没出现的行为。

人如果是在问这些代码做什么，就答复。人如果是在要求改这些选中的代码，就修改。

答复时只输出：
动作：答复
说明：
用中文先说这些行共同完成的事，再按行说明各自的作用。

修改时只输出：
动作：修改
说明：
用中文写清选中代码要改成什么。
代码：
写出替换选中范围的完整代码，保留原有缩进。不要加围栏。

${prior ? `同一会话里已经说过：\n${prior}\n\n` : ""}这次评论和选中的代码：
${userTurn(lines, comment)}`;
}

export function parseCommentAction(raw: string): CommentAction {
  const source = raw.trim();
  const rows = source.split("\n");
  const kind = rows[0] === "动作：答复" ? "reply" : rows[0] === "动作：修改" ? "edit" : "";
  if (!kind || rows[1] !== "说明：") return { kind: "reply", text: source };
  if (kind === "reply") {
    const text = rows.slice(2).join("\n").trim();
    if (!text || rows.includes("代码：")) return { kind: "reply", text: source };
    return { kind: "reply", text };
  }
  const codeAt = rows.indexOf("代码：");
  if (codeAt < 3) return { kind: "reply", text: source };
  const text = rows.slice(2, codeAt).join("\n").trim();
  const code = rows.slice(codeAt + 1).join("\n").replace(/\s+$/, "");
  if (!text || !code.trim()) return { kind: "reply", text: source };
  return { kind: "edit", text, code };
}

export function applySelectionEdit(root: string, lines: CodeLine[], code: string): ExplainAnchor {
  const groups = selectionAnchors(lines);
  if (groups.length !== 1) throw new Error("请选择同一侧连续的代码行");
  const group = groups[0];
  if (!group || group.side !== "head") throw new Error("只能修改当前文件里的代码");
  if (!code.trim()) throw new Error("没有可替换的代码");
  const full = fileInside(root, group.path);
  let original = "";
  try {
    original = readFileSync(full, "utf8");
  } catch {
    throw new Error("文件不存在");
  }
  const rows = original.split("\n");
  const ending = original.endsWith("\n");
  if (ending) rows.pop();
  for (const line of group.lines) {
    const current = rows[line.line - 1];
    if (current === undefined || !sameLine(current, line.text)) throw new Error("选中的代码已经变了");
  }
  rows.splice(group.start - 1, group.lines.length, ...code.replace(/\s+$/, "").split("\n"));
  writeFileSync(full, ending ? `${rows.join("\n")}\n` : rows.join("\n"));
  return { path: group.path, side: group.side, start: group.start, end: group.end };
}

function fileInside(root: string, filePath: string): string {
  const full = resolve(root, filePath);
  const rel = relative(root, full);
  if (!filePath.trim() || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("路径超出仓库");
  return full;
}

function sameLine(fileLine: string, sent: string): boolean {
  return fileLine === sent || (fileLine === "" && sent === " ");
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
  const columns = db.prepare("PRAGMA table_info(explain_turns)").all() as Array<{ name: string }>;
  if (columns.length && !columns.some((column) => column.name === "path")) {
    db.exec("ALTER TABLE explain_turns RENAME TO explain_turns_old");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS explain_turns (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (repo_id, session_id, path, side, start_line, end_line, position)
  )`);
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'explain_turns_old'").get();
  if (!old) return;
  db.exec(`INSERT INTO explain_turns (repo_id, session_id, path, side, start_line, end_line, position, role, content)
    SELECT repo_id, session_id, '', 'head', 0, 0, position, role, content FROM explain_turns_old`);
  db.exec("DROP TABLE explain_turns_old");
}

export function loadThread(db: DatabaseSync, repoId: string, sessionId: string, anchor: ExplainAnchor): ExplainTurn[] {
  ensureExplainTurns(db);
  const rows = db.prepare(
    `SELECT role, content FROM explain_turns
     WHERE repo_id = ? AND session_id = ? AND path = ? AND side = ? AND start_line = ? AND end_line = ?
     ORDER BY position`,
  ).all(repoId, sessionId, anchor.path, anchor.side, anchor.start, anchor.end) as Array<{ role: string; content: string }>;
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role as ExplainTurn["role"], content: row.content }));
}

export function loadThreads(db: DatabaseSync, repoId: string, sessionId: string): ExplainThread[] {
  ensureExplainTurns(db);
  const rows = db.prepare(
    `SELECT path, side, start_line, end_line, role, content FROM explain_turns
     WHERE repo_id = ? AND session_id = ? AND path != ''
     ORDER BY path, side, start_line, end_line, position`,
  ).all(repoId, sessionId) as Array<{ path: string; side: string; start_line: number; end_line: number; role: string; content: string }>;
  const threads: ExplainThread[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const side = row.side === "base" ? "base" : "head";
    const last = threads[threads.length - 1];
    const turn = { role: row.role as ExplainTurn["role"], content: row.content };
    if (last && last.path === row.path && last.side === side && last.start === row.start_line && last.end === row.end_line) {
      last.turns.push(turn);
      continue;
    }
    threads.push({ path: row.path, side, start: row.start_line, end: row.end_line, turns: [turn], modes: {} });
  }
  const modes = loadModeMap(db, repoId, sessionId);
  for (const thread of threads) {
    const key = modeKey(thread);
    thread.modes = modes.get(key) ?? {};
    modes.delete(key);
  }
  for (const [key, value] of modes) {
    const [path, sideName, startText, endText] = key.split("\0");
    threads.push({
      path,
      side: sideName === "base" ? "base" : "head",
      start: Number(startText),
      end: Number(endText),
      turns: [],
      modes: value,
    });
  }
  return threads;
}

function modeKey(anchor: ExplainAnchor): string {
  return `${anchor.path}\0${anchor.side}\0${anchor.start}\0${anchor.end}`;
}

function ensureExplainModes(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS explain_modes (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    mode TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (repo_id, session_id, path, side, start_line, end_line, mode)
  )`);
}

function loadModeMap(db: DatabaseSync, repoId: string, sessionId: string): Map<string, ExplainModes> {
  ensureExplainModes(db);
  const rows = db.prepare(
    `SELECT path, side, start_line, end_line, mode, content FROM explain_modes
     WHERE repo_id = ? AND session_id = ?`,
  ).all(repoId, sessionId) as Array<{ path: string; side: string; start_line: number; end_line: number; mode: string; content: string }>;
  const modes = new Map<string, ExplainModes>();
  for (const row of rows) {
    if (row.mode !== "pseudo" && row.mode !== "line") continue;
    const key = `${row.path}\0${row.side}\0${row.start_line}\0${row.end_line}`;
    const current = modes.get(key) ?? {};
    current[row.mode] = row.content;
    modes.set(key, current);
  }
  return modes;
}

export function loadExplainModes(db: DatabaseSync, repoId: string, sessionId: string, anchor: ExplainAnchor): ExplainModes {
  return loadModeMap(db, repoId, sessionId).get(modeKey(anchor)) ?? {};
}

export function saveExplainMode(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
  anchor: ExplainAnchor,
  style: ExplainStyle,
  content: string,
): void {
  ensureExplainModes(db);
  db.prepare(
    `INSERT INTO explain_modes (repo_id, session_id, path, side, start_line, end_line, mode, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, session_id, path, side, start_line, end_line, mode) DO UPDATE SET content = excluded.content`,
  ).run(repoId, sessionId, anchor.path, anchor.side, anchor.start, anchor.end, style, content);
}

export function saveThread(db: DatabaseSync, repoId: string, sessionId: string, anchor: ExplainAnchor, turns: ExplainTurn[]): void {
  ensureExplainTurns(db);
  const kept = turns.slice(-12);
  db.exec("BEGIN");
  try {
    db.prepare(
      "DELETE FROM explain_turns WHERE repo_id = ? AND session_id = ? AND path = ? AND side = ? AND start_line = ? AND end_line = ?",
    ).run(repoId, sessionId, anchor.path, anchor.side, anchor.start, anchor.end);
    const insert = db.prepare(
      `INSERT INTO explain_turns (repo_id, session_id, path, side, start_line, end_line, position, role, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    kept.forEach((turn, index) => insert.run(repoId, sessionId, anchor.path, anchor.side, anchor.start, anchor.end, index, turn.role, turn.content));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadTurns(db: DatabaseSync, repoId: string, sessionId: string): ExplainTurn[] {
  return loadThread(db, repoId, sessionId, blankAnchor);
}

export function saveTurns(db: DatabaseSync, repoId: string, sessionId: string, turns: ExplainTurn[]): void {
  saveThread(db, repoId, sessionId, blankAnchor, turns);
}

export async function explainInSession(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
  lines: CodeLine[],
  comment: string,
  anchor?: ExplainAnchor,
  root = "",
): Promise<{ reply: string; turns: ExplainTurn[]; anchor: ExplainAnchor }> {
  if (!lines.length) throw new Error("先选中代码行");
  const target = anchor ?? anchorFor(lines);
  if (!target) throw new Error("请选择同一侧连续的代码行");
  const history = loadThread(db, repoId, sessionId, target);
  let reply = "";
  try {
    reply = (await completePrompt(sessionPrompt(history, lines, comment))).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "总结失败" || message === "总结为空") throw new Error("解释失败");
    throw error;
  }
  if (!reply) throw new Error("解释失败");
  const action = parseCommentAction(reply);
  const shown = action.text.trim();
  if (!shown) throw new Error("解释失败");
  if (action.kind === "edit") {
    if (!root) throw new Error("不能修改代码");
    applySelectionEdit(root, lines, action.code);
  }
  const turns = [...history, { role: "user" as const, content: userTurn(lines, comment) }, { role: "assistant" as const, content: shown }].slice(-12);
  saveThread(db, repoId, sessionId, target, turns);
  return { reply: shown, turns, anchor: target };
}

export async function explainSelection(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
  lines: CodeLine[],
  style: ExplainStyle,
  anchor?: ExplainAnchor,
): Promise<{ reply: string; anchor: ExplainAnchor; mode: ExplainStyle; cached: boolean; modes: ExplainModes }> {
  if (style !== "pseudo" && style !== "line") throw new Error("解释方式无效");
  if (!lines.length) throw new Error("先选中代码行");
  const target = anchor ?? anchorFor(lines);
  if (!target) throw new Error("请选择同一侧连续的代码行");
  const modes = loadExplainModes(db, repoId, sessionId, target);
  const cached = modes[style]?.trim() ?? "";
  if (cached) return { reply: cached, anchor: target, mode: style, cached: true, modes };
  let reply = "";
  try {
    reply = (await completePrompt(explainPrompt(lines, style))).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "总结失败" || message === "总结为空") throw new Error("解释失败");
    throw error;
  }
  if (!reply) throw new Error("解释失败");
  saveExplainMode(db, repoId, sessionId, target, style, reply);
  return { reply, anchor: target, mode: style, cached: false, modes: { ...modes, [style]: reply } };
}
