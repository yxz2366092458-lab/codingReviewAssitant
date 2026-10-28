import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentWrite } from "./cursor-proxy.ts";
import { completePrompt, completeRun } from "./summary-ai.ts";

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

export type ExplainProgress = {
  phase: "understand" | "agent" | "revise" | "write" | "answer" | "fail";
  text: string;
};

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

修改时只输出下面这一段，不要再另起一条只说已经修改。程序会把代码写入选中的当前文件。
动作：修改
说明：
用中文写清选中代码要改成什么。
代码：
写出替换选中范围的完整代码，保留原有缩进。不要加围栏。
答复时不要改文件。

${prior ? `同一会话里已经说过：\n${prior}\n\n` : ""}这次评论和选中的代码：
${userTurn(lines, comment)}`;
}

export function parseCommentAction(raw: string): CommentAction {
  const source = raw.trim();
  const normalized = unwrapFence(source.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const rows = normalized.split("\n");
  const actionAt = rows.findIndex((row) => actionKind(row));
  if (actionAt < 0) {
    const fenced = singleFence(normalized);
    if (fenced && /改成|改为|修改为|替换为/.test(normalized)) {
      const text = normalized.replace(/```[^\n]*\n[\s\S]*?\n```/g, "").trim() || "已按评论替换选中代码。";
      return { kind: "edit", text, code: fenced };
    }
    return { kind: "reply", text: source };
  }
  const kind = actionKind(rows[actionAt]);
  let cursor = actionAt + 1;
  while (cursor < rows.length && rows[cursor].trim() === "") cursor += 1;
  if (!marker(rows[cursor] ?? "", "说明")) return { kind: "reply", text: source };
  if (kind === "reply") {
    const body = rows.slice(cursor + 1);
    const text = body.join("\n").trim();
    if (!text || body.some((row) => marker(row, "代码"))) return { kind: "reply", text: source };
    return { kind: "reply", text };
  }
  const codeAt = rows.findIndex((row, index) => index > cursor && marker(row, "代码"));
  if (codeAt < 0) {
    const fenced = singleFence(rows.slice(cursor + 1).join("\n"));
    const text = rows.slice(cursor + 1).join("\n").replace(/```[^\n]*\n[\s\S]*?\n```/g, "").trim();
    if (text && fenced) return { kind: "edit", text, code: fenced };
    return { kind: "reply", text: source };
  }
  const text = rows.slice(cursor + 1, codeAt).join("\n").trim();
  const code = stripCodeFence(rows.slice(codeAt + 1).join("\n"));
  if (!text || !code.trim()) return { kind: "reply", text: source };
  return { kind: "edit", text, code };
}

function normalizeLabel(line: string): string {
  return line.trim().replace(/^\*+|\*+$/g, "").replace(/\*/g, "").trim().replace(/:/g, "：").replace(/\s+/g, "");
}

function actionKind(line: string): "edit" | "reply" | "" {
  const clean = normalizeLabel(line);
  if (clean === "动作：修改") return "edit";
  if (clean === "动作：答复") return "reply";
  return "";
}

function marker(line: string, name: string): boolean {
  return normalizeLabel(line) === `${name}：`;
}

function unwrapFence(source: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(source.trim());
  return match?.[1] ?? source;
}

function singleFence(source: string): string {
  const matches = [...source.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1) return "";
  return (matches[0]?.[1] ?? "").replace(/\s+$/, "");
}

function stripCodeFence(code: string): string {
  const lines = code.replace(/\s+$/, "").split("\n");
  if (lines[0]?.startsWith("```")) lines.shift();
  if (lines[lines.length - 1]?.trim() === "```") lines.pop();
  return lines.join("\n").replace(/\s+$/, "");
}

export function planFileEdits(action: CommentAction, raw: string, writes: AgentWrite[], force = false): { edited: boolean; selection: boolean; writes: AgentWrite[] } {
  const pending = writes.filter((item) => !item.applied && (item.contents !== undefined || (item.oldText !== undefined && item.newText !== undefined)));
  if (writes.some((item) => item.applied)) return { edited: true, selection: false, writes: [] };
  if (action.kind === "edit") return { edited: true, selection: true, writes: pending };
  const structuredReply = /动作[:：]\s*答复/.test(raw) && !/动作[:：]\s*修改/.test(raw);
  if (structuredReply && !force) return { edited: false, selection: false, writes: [] };
  if (pending.length && (force || declaresChange(raw))) return { edited: true, selection: false, writes: pending };
  return { edited: false, selection: false, writes: [] };
}

export function commentRequestsEdit(comment: string): boolean {
  const text = comment.trim();
  if (!text) return false;
  const question = /[？?]|(为什么|为何|是什么|什么意思|怎么理解|如何理解|干什么|做什么|影响范围|解释一下|什么作用)/.test(text);
  const strong = /改成|改为|修改为|替换成|替换为|配置为|删掉|删除这|去掉这|无需重新声明|不要重新声明|不用重新声明/.test(text) || /^修改(?!的)/.test(text);
  if (question && !strong) return false;
  if (strong) return true;
  return /不要/.test(text);
}

export function selectionReplacement(lines: CodeLine[], comment: string, modelText: string): string | null {
  if (!commentRequestsEdit(comment)) return null;
  const rows = lines.map((line) => (line.text === " " ? "" : line.text));
  let next = rows.slice();
  next = applyPairSwaps(next, modelText);
  next = applyPairSwaps(next, comment);
  next = applyConfiguredUrl(next, `${comment}\n${modelText}`);
  next = dropRedeclarations(next, comment);
  next = applyQuotedReplacement(next, comment);
  const before = rows.join("\n");
  const after = next.join("\n");
  if (after === before || !after.trim()) return null;
  return after;
}

function applyPairSwaps(rows: string[], text: string): string[] {
  if (!text.trim()) return rows;
  let next = rows.join("\n");
  const patterns = [
    /从\s*`([^`]+)`\s*(?:改成|改为|修改为|替换成|替换为)\s*`([^`]+)`/g,
    /从\s*"([^"]+)"\s*(?:改成|改为|修改为|替换成|替换为)\s*"([^"]+)"/g,
    /从\s*(\S+)\s*(?:改成|改为|修改为|替换成|替换为)\s*(\S+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const from = match[1]?.trim().replace(/[。；]+$/g, "");
      const to = match[2]?.trim().replace(/[。；]+$/g, "");
      if (!from || !to || from === to || !next.includes(from)) continue;
      next = next.split(from).join(to);
    }
  }
  return next.split("\n");
}

function applyConfiguredUrl(rows: string[], text: string): string[] {
  const url = /配置为\s*(https?:\/\/[^\s，。]+)/.exec(text)?.[1]?.replace(/[。；,，]+$/g, "");
  if (!url) return rows;
  const wantsPc = /pc/i.test(text);
  return rows.map((row) => {
    const match = /^(\s*)([^#\s=][^=]*)=(.*)$/.exec(row);
    if (!match) return row;
    const key = match[2] ?? "";
    if (/mobile/i.test(key) || /deeplink/i.test(key)) return row;
    if (wantsPc && !/pc[-_]?url/i.test(key)) return row;
    if (!wantsPc && !/url/i.test(key)) return row;
    return `${match[1]}${key}=${url}`;
  });
}

function dropRedeclarations(rows: string[], comment: string): string[] {
  if (!/无需重新声明|不要重新声明|不用重新声明/.test(comment)) return rows;
  return rows.filter((row) => {
    const match = /^(\s*)([^#\s=][^=]*)=(.*)$/.exec(row);
    if (!match) return true;
    if ((match[3] ?? "").trim()) return true;
    const key = match[2] ?? "";
    const short = key.split(".").pop() ?? key;
    return !short || !comment.includes(short);
  });
}

function applyQuotedReplacement(rows: string[], comment: string): string[] {
  const match = /修改为\s*(\S+)/.exec(comment);
  if (!match?.[1]) return rows;
  const value = match[1].replace(/[。；;]+$/g, "");
  const joined = rows.join("\n");
  const quotes = [...joined.matchAll(/"([^"]+)"/g)];
  if (quotes.length !== 1 || !quotes[0]?.[1] || quotes[0][1] === value) return rows;
  return joined.replace(`"${quotes[0][1]}"`, `"${value}"`).split("\n");
}

function declaresChange(text: string): boolean {
  return /动作[:：]\s*修改|已修改|已经修改|已改|改好|改成|改为|修改为|替换为|已写入|I(?:'ve| have)? (?:updated|modified|changed)/i.test(text);
}

export function applyAgentWrites(root: string, writes: AgentWrite[]): string[] {
  const changed: string[] = [];
  for (const write of writes) {
    if (write.applied) {
      changed.push(write.path);
      continue;
    }
    const full = fileInside(root, write.path);
    if (typeof write.contents === "string") {
      writeFileSync(full, write.contents);
      changed.push(write.path);
      continue;
    }
    if (typeof write.oldText !== "string" || typeof write.newText !== "string" || !write.oldText) continue;
    let original = "";
    try {
      original = readFileSync(full, "utf8");
    } catch {
      throw new Error("文件不存在");
    }
    if (!original.includes(write.oldText)) throw new Error("选中的代码已经变了");
    writeFileSync(full, original.replace(write.oldText, write.newText));
    changed.push(write.path);
  }
  return changed;
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
  const left = fileLine.replace(/\r$/, "");
  const right = sent.replace(/\r$/, "");
  if (left === right || (left === "" && right === " ")) return true;
  return right.startsWith(" ") && right.slice(1) === left;
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

export function editPrompt(history: ExplainTurn[], lines: CodeLine[], comment: string, near: string): string {
  const prior = history.map((turn) => `${turn.role === "user" ? "人" : "AI"}：${turn.content}`).join("\n\n");
  return `你是代码评审助手。人要求修改选中的代码。程序会把你给出的代码写入当前文件。不要只说已经改好。

只输出下面这一段：
动作：修改
说明：
用中文写清选中代码要改成什么。
代码：
写出替换选中范围的完整代码，保留原有缩进。不要加围栏。

选中范围必须整段替换。人说某个配置保持原样、无需重新声明时，删掉对应的声明。人给出新的 url 时，只改它点名的那一项。

${near ? `文件中选中范围及其上文：\n${near}\n\n` : ""}${prior ? `同一会话里已经说过：\n${prior}\n\n` : ""}这次评论和选中的代码：
${userTurn(lines, comment)}`;
}

function neighborhood(root: string, lines: CodeLine[]): string {
  const group = selectionAnchors(lines)[0];
  if (!root || !group) return "";
  try {
    const original = readFileSync(fileInside(root, group.path), "utf8");
    const rows = original.split("\n");
    if (original.endsWith("\n")) rows.pop();
    const from = Math.max(1, group.start - 40);
    const to = Math.min(rows.length, group.end);
    return rows.slice(from - 1, to).map((row, index) => `${from + index}|${row}`).join("\n");
  } catch {
    return "";
  }
}

function resolveEdit(lines: CodeLine[], comment: string, reply: string): CommentAction {
  const parsed = reply ? parseCommentAction(reply) : { kind: "reply" as const, text: "" };
  if (!commentRequestsEdit(comment) || parsed.kind === "edit") return parsed;
  const code = selectionReplacement(lines, comment, reply) ?? usableReplacement(lines, reply);
  if (!code) return parsed;
  const note = parsed.text.trim();
  const prose = note && note !== reply.trim() ? note : "已按评论替换选中代码。";
  return { kind: "edit", text: prose, code };
}

function codeOnlyPrompt(lines: CodeLine[], comment: string, near: string): string {
  return `按评论修改选中代码。只输出修改后的完整代码，不要解释，不要标题，不要写「动作」或「说明」。
可以只包在一个代码块里。输出必须能替换选中的那些行。

${near ? `文件中选中范围及其上文：\n${near}\n\n` : ""}评论和选中的代码：
${userTurn(lines, comment)}`;
}

function usableReplacement(lines: CodeLine[], raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = parseCommentAction(text);
  if (parsed.kind === "edit" && parsed.code.trim()) return parsed.code.replace(/\s+$/, "");
  const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)];
  const fenced = (fences.at(-1)?.[1] ?? "").replace(/\s+$/, "");
  if (fenced && !isProse(fenced)) return fenced;
  const bare = unwrapFence(text).replace(/\s+$/, "");
  if (bare && !isProse(bare) && looksLikeRewrite(lines, bare)) return bare;
  return null;
}

function isProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/无法修改|不能修改|没有可替换|抱歉/.test(trimmed) && !/[=;{}]/.test(trimmed)) return true;
  const rows = trimmed.split("\n");
  if (rows.length === 1 && /[。！？]$/.test(trimmed) && !/[=;{}#]/.test(trimmed)) return true;
  const chinese = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const symbols = (trimmed.match(/[=;{}()[\].#]/g) ?? []).length;
  return chinese > trimmed.length * 0.45 && symbols < 2;
}

function looksLikeRewrite(lines: CodeLine[], code: string): boolean {
  const rows = code.split("\n");
  if (!rows.some((row) => row.trim()) || rows.length > lines.length + 12) return false;
  const original = lines.map((line) => (line.text === " " ? "" : line.text)).join("\n");
  const tokens = original.match(/[A-Za-z_][\w$.-]{2,}/g) ?? [];
  const shared = tokens.filter((token) => code.includes(token)).length;
  if (shared >= 1) return true;
  return rows.length > 1 && /[=;{}@#]/.test(code);
}

function plainReplacement(lines: CodeLine[], raw: string): string | null {
  const text = unwrapFence(raw.trim());
  if (!text || /动作[:：]/.test(text)) return null;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (chinese > text.length * 0.2) return null;
  const rows = text.replace(/\s+$/, "").split("\n");
  if (!rows.some((row) => row.trim()) || rows.length > lines.length + 8) return null;
  return rows.join("\n");
}

function writable(writes: AgentWrite[]): boolean {
  return writes.some((item) => item.applied || typeof item.contents === "string" || (typeof item.oldText === "string" && typeof item.newText === "string"));
}

function agentFailure(message: string): string {
  if (/Authentication required|CURSOR_API_KEY|CURSOR_AUTH_TOKEN|agent login/.test(message)) {
    return "Cursor agent 没有登录。请在终端执行 agent login 后再试。";
  }
  const text = message.trim();
  if (!text || text === "总结失败" || text === "总结为空") return "没有写出可替换的代码";
  return text.slice(0, 200);
}

export async function explainInSession(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
  lines: CodeLine[],
  comment: string,
  anchor?: ExplainAnchor,
  root = "",
  onProgress?: (event: ExplainProgress) => void,
): Promise<{ reply: string; turns: ExplainTurn[]; anchor: ExplainAnchor; edited: boolean; edit: { path: string; start: number; end: number; code: string } | null }> {
  if (!lines.length) throw new Error("先选中代码行");
  const target = anchor ?? anchorFor(lines);
  if (!target) throw new Error("请选择同一侧连续的代码行");
  const report = (phase: ExplainProgress["phase"], text: string) => onProgress?.({ phase, text });
  try {
    return await runComment(db, repoId, sessionId, lines, comment, target, root, report);
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : "解释失败";
    report("fail", message.startsWith("失败：") ? message : `失败：${message}`);
    throw error;
  }
}

async function runComment(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
  lines: CodeLine[],
  comment: string,
  target: ExplainAnchor,
  root: string,
  report: (phase: ExplainProgress["phase"], text: string) => void,
): Promise<{ reply: string; turns: ExplainTurn[]; anchor: ExplainAnchor; edited: boolean; edit: { path: string; start: number; end: number; code: string } | null }> {
  const history = loadThread(db, repoId, sessionId, target);
  const wantsEdit = commentRequestsEdit(comment);
  const near = wantsEdit ? neighborhood(root, lines) : "";
  let run: { text: string; writes: AgentWrite[] } = { text: "", writes: [] };
  let modelFailed = false;
  let agentError = "";
  if (wantsEdit) report("understand", "正在理解评论");
  else report("answer", "正在回答");
  report("agent", wantsEdit ? "正在调用 agent" : "正在回答");
  try {
    run = await completeRun(wantsEdit ? editPrompt(history, lines, comment, near) : sessionPrompt(history, lines, comment), wantsEdit, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!wantsEdit) {
      if (message === "总结失败" || message === "总结为空") throw new Error("解释失败");
      throw error;
    }
    modelFailed = true;
    agentError = message;
  }
  let reply = run.text.trim();
  let action = resolveEdit(lines, comment, reply);
  if (wantsEdit && action.kind !== "edit" && !writable(run.writes) && !modelFailed) {
    report("revise", "正在根据评论整理改动");
    try {
      const again = await completeRun(codeOnlyPrompt(lines, comment, near), false, root);
      const againReply = again.text.trim();
      const againAction = resolveEdit(lines, comment, againReply);
      if (againAction.kind === "edit") {
        action = againAction;
        reply = againReply;
      } else {
        const rawCode = plainReplacement(lines, againReply);
        if (rawCode) action = { kind: "edit", text: "已按评论替换选中代码。", code: rawCode };
      }
      if (writable(again.writes)) run = again;
    } catch {
      modelFailed = true;
    }
  }
  if (wantsEdit && action.kind !== "edit") {
    const local = selectionReplacement(lines, comment, reply);
    if (local) action = { kind: "edit", text: action.text.trim() || "已按评论替换选中代码。", code: local };
  }
  if (!reply && action.kind === "edit") reply = action.text;
  if (!reply && run.writes.length === 0 && action.kind !== "edit") throw new Error(wantsEdit ? agentFailure(agentError) : "解释失败");
  let shown = action.text.trim();
  const plan = planFileEdits(action, reply, run.writes, wantsEdit);
  if (wantsEdit && !plan.edited) throw new Error(agentFailure(agentError));
  let edit: { path: string; start: number; end: number; code: string } | null = null;
  if (plan.edited) report("write", "正在写入文件");
  if (plan.selection) {
    if (!root) throw new Error("不能修改代码");
    if (action.kind !== "edit") throw new Error("不能修改代码");
    try {
      const applied = applySelectionEdit(root, lines, action.code);
      edit = { path: applied.path, start: applied.start, end: applied.end, code: action.code };
    } catch (error) {
      if (selectionAlreadyApplied(root, lines, action.code)) {
        edit = { path: target.path, start: target.start, end: target.end, code: action.code };
      } else if (!plan.writes.length && !run.writes.some((item) => item.applied)) {
        throw error;
      }
    }
  }
  if (!edit && plan.writes.length) {
    if (!root) throw new Error("不能修改代码");
    const paths = applyAgentWrites(root, plan.writes);
    if (paths[0]) edit = { path: paths[0], start: 0, end: 0, code: "" };
  } else if (!edit && plan.edited) {
    const path = run.writes.find((item) => item.applied)?.path ?? run.writes[0]?.path ?? "";
    if (path) edit = { path, start: 0, end: 0, code: "" };
  }
  if (plan.edited && !shown) shown = "已写入文件。";
  if (plan.edited && !edit) throw new Error("没有写出可替换的代码");
  if (!shown) throw new Error("解释失败");
  const turns = [...history, { role: "user" as const, content: userTurn(lines, comment) }, { role: "assistant" as const, content: shown }].slice(-12);
  saveThread(db, repoId, sessionId, target, turns);
  return { reply: shown, turns, anchor: target, edited: plan.edited, edit };
}

function selectionAlreadyApplied(root: string, lines: CodeLine[], code: string): boolean {
  const group = selectionAnchors(lines)[0];
  if (!group || group.side !== "head") return false;
  try {
    const original = readFileSync(fileInside(root, group.path), "utf8");
    const rows = original.split("\n");
    if (original.endsWith("\n")) rows.pop();
    const current = rows.slice(group.start - 1, group.start - 1 + group.lines.length).join("\n");
    return current === code.replace(/\s+$/, "");
  } catch {
    return false;
  }
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
