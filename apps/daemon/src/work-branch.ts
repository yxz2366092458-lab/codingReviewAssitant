import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkoutBranch, createBranch, listLocalBranches, mergeFastForward } from "./branches.ts";

export function workBranchNames(title: string): { requirement: string; development: string } {
  const slug = title.trim().replace(/\s+/g, "-").replace(/\./g, "").slice(0, 48);
  if (!slug || slug.startsWith("-")) throw new Error("需求名不能为空");
  return { requirement: `req/${slug}`, development: `dev/${slug}` };
}

export function sessionBranchNames(sessionId: string, summary: string): { requirement: string; development: string } {
  const slug = sessionId.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  if (slug.length < 8) throw new Error("会话无效");
  return { requirement: requirementBranchName(summary), development: `dev/${slug}` };
}

export function requirementBranchName(summary: string): string {
  const slug = summary
    .trim()
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[.~^:?*[\]\\@{}<>"'`|/]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
    .replace(/[-.]+$/g, "");
  if (!slug) throw new Error("会话总结不能为空");
  return `req/${slug}`;
}

export function composerName(sessionId: string, file = cursorStateFile()): string {
  const id = sessionId.trim();
  if (!id || !existsSync(file)) return "";
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT value FROM composerHeaders WHERE composerId = ?").get(id) as { value?: string } | undefined;
    if (!row?.value) return "";
    const parsed = JSON.parse(row.value) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name.trim() : "";
  } catch {
    return "";
  } finally {
    db?.close();
  }
}

export function userAskFromTranscript(text: string): string {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (parsed as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (!chunk || typeof chunk !== "object") continue;
      const raw = (chunk as { text?: unknown }).text;
      if (typeof raw !== "string") continue;
      const match = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
      const ask = match?.[1]?.trim() ?? "";
      if (ask) return ask.replace(/\s+/g, " ");
    }
  }
  return "";
}

export function readSessionSummary(sessionId: string): string {
  return composerName(sessionId) || firstUserAsk(sessionId);
}

function cursorStateFile(): string {
  return join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
}

function firstUserAsk(sessionId: string): string {
  const id = sessionId.trim();
  const root = join(homedir(), ".cursor", "projects");
  if (!id || !existsSync(root)) return "";
  for (const project of readdirSync(root)) {
    const file = join(root, project, "agent-transcripts", id, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    return userAskFromTranscript(readFileSync(file, "utf8"));
  }
  return "";
}

export function readWorkBranches(
  db: DatabaseSync,
  repoId: string,
  headBranch = "",
): { requirement: string; development: string } | null {
  ensureWorkBranches(db);
  const rows = db.prepare("SELECT requirement, development FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{
    requirement: string;
    development: string;
  }>;
  if (!rows.length) return null;
  if (headBranch) {
    const match = rows.find((row) => row.development === headBranch);
    if (match) return match;
  }
  return rows[rows.length - 1] ?? null;
}

export async function openWorkBranches(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  baseRef: string,
  title: string,
  fromSession = false,
  summaryText = "",
): Promise<{ requirement: string; development: string }> {
  const sessionId = fromSession ? title.trim() : "";
  if (fromSession) {
    const existing = readSessionBranches(db, repoId, sessionId);
    if (existing) {
      await checkoutBranch(cwd, existing.development);
      return existing;
    }
  }
  const summary = fromSession ? summaryText.trim() || readSessionSummary(sessionId) : "";
  if (fromSession && !summary) throw new Error("没有会话总结");
  const named = fromSession ? sessionBranchNames(sessionId, summary) : workBranchNames(title);
  const requirement = fromSession ? await availableRequirement(db, cwd, repoId, named.requirement) : named.requirement;
  const pair = { requirement, development: named.development };
  await createBranch(cwd, pair.requirement, baseRef);
  await createBranch(cwd, pair.development, pair.requirement);
  await checkoutBranch(cwd, pair.development);
  ensureWorkBranches(db);
  db.prepare(
    `INSERT INTO work_branches (repo_id, session_id, requirement, development) VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, session_id) DO UPDATE SET requirement = excluded.requirement, development = excluded.development`,
  ).run(repoId, sessionId, pair.requirement, pair.development);
  return pair;
}

export async function mergeWorkBranches(db: DatabaseSync, cwd: string, repoId: string, headBranch: string): Promise<void> {
  const pair = readWorkBranches(db, repoId, headBranch);
  if (!pair) return;
  await mergeFastForward(cwd, pair.requirement, pair.development);
}

export type WorkSession = {
  sessionId: string;
  requirement: string;
  development: string;
  current: boolean;
};

export function listWorkSessions(db: DatabaseSync, repoId: string, headBranch: string): WorkSession[] {
  ensureWorkBranches(db);
  const rows = db.prepare(
    "SELECT session_id, requirement, development FROM work_branches WHERE repo_id = ? ORDER BY rowid DESC",
  ).all(repoId) as Array<{ session_id: string; requirement: string; development: string }>;
  return rows
    .filter((row) => row.session_id.trim())
    .map((row) => ({
      sessionId: row.session_id.trim(),
      requirement: row.requirement,
      development: row.development,
      current: headBranch !== "" && row.development === headBranch,
    }));
}

export function readSessionBranches(
  db: DatabaseSync,
  repoId: string,
  sessionId: string,
): { requirement: string; development: string } | null {
  const match = listWorkSessions(db, repoId, "").find((item) => item.sessionId === sessionId.trim());
  if (!match) return null;
  return { requirement: match.requirement, development: match.development };
}

export function currentSessionId(db: DatabaseSync, repoId: string, headBranch: string): string {
  ensureWorkBranches(db);
  const rows = db.prepare("SELECT session_id, development FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{
    session_id: string;
    development: string;
  }>;
  if (!rows.length) return "";
  const match = headBranch ? rows.find((row) => row.development === headBranch) : undefined;
  return (match ?? rows[rows.length - 1])?.session_id.trim() ?? "";
}

export function sessionPhase(
  db: DatabaseSync,
  repoId: string,
  headBranch: string,
  sliceId: string | null,
): "requirement" | "development" | null {
  const row = readRecord(db, repoId, headBranch);
  if (!row) return null;
  if (!row.admitted || (sliceId && row.requirement_slice === sliceId)) return "requirement";
  return "development";
}

export function admitSession(db: DatabaseSync, repoId: string, headBranch: string, sliceId: string): void {
  const row = readRecord(db, repoId, headBranch);
  if (!row || row.admitted) return;
  db.prepare("UPDATE work_branches SET admitted = 1, requirement_slice = ? WHERE repo_id = ? AND development = ?").run(
    sliceId,
    repoId,
    row.development,
  );
}

async function availableRequirement(db: DatabaseSync, cwd: string, repoId: string, name: string): Promise<string> {
  ensureWorkBranches(db);
  const rows = db.prepare("SELECT requirement FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{ requirement: string }>;
  const used = new Set([...rows.map((row) => row.requirement), ...(await listLocalBranches(cwd))]);
  if (!used.has(name)) return name;
  for (let index = 2; index < 100; index += 1) {
    const next = `${name}-${index}`;
    if (!used.has(next)) return next;
  }
  throw new Error("需求分支重名");
}

function readRecord(db: DatabaseSync, repoId: string, headBranch: string) {
  ensureWorkBranches(db);
  const rows = db.prepare(
    "SELECT requirement, development, admitted, requirement_slice FROM work_branches WHERE repo_id = ?",
  ).all(repoId) as Array<{
    requirement: string;
    development: string;
    admitted: number;
    requirement_slice: string | null;
  }>;
  if (!rows.length) return null;
  if (headBranch) {
    const match = rows.find((row) => row.development === headBranch);
    if (match) return match;
  }
  return rows[rows.length - 1] ?? null;
}

function ensureWorkBranches(db: DatabaseSync): void {
  const create = () => {
    db.exec(`CREATE TABLE IF NOT EXISTS work_branches (
      repo_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requirement TEXT NOT NULL,
      development TEXT NOT NULL,
      admitted INTEGER NOT NULL DEFAULT 0,
      requirement_slice TEXT,
      PRIMARY KEY (repo_id, session_id)
    )`);
  };
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_branches'").get() as
    | { name: string }
    | undefined;
  if (!existing) {
    create();
    return;
  }
  const columns = db.prepare("PRAGMA table_info(work_branches)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "session_id")) {
    db.exec("ALTER TABLE work_branches RENAME TO work_branches_old");
    create();
    db.exec(
      "INSERT INTO work_branches (repo_id, session_id, requirement, development) SELECT repo_id, '', requirement, development FROM work_branches_old",
    );
    db.exec("DROP TABLE work_branches_old");
  }
  const ready = db.prepare("PRAGMA table_info(work_branches)").all() as Array<{ name: string }>;
  if (!ready.some((column) => column.name === "admitted")) {
    db.exec("ALTER TABLE work_branches ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0");
  }
  if (!ready.some((column) => column.name === "requirement_slice")) {
    db.exec("ALTER TABLE work_branches ADD COLUMN requirement_slice TEXT");
  }
}
