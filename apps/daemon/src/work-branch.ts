import type { DatabaseSync } from "node:sqlite";
import { checkoutBranch, createBranch, mergeFastForward } from "./branches.ts";

export function workBranchNames(title: string): { requirement: string; development: string } {
  const slug = title.trim().replace(/\s+/g, "-").replace(/\./g, "").slice(0, 48);
  if (!slug || slug.startsWith("-")) throw new Error("需求名不能为空");
  return { requirement: `req/${slug}`, development: `dev/${slug}` };
}

export function sessionBranchNames(sessionId: string): { requirement: string; development: string } {
  const slug = sessionId.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  if (slug.length < 8) throw new Error("会话无效");
  return { requirement: `req/${slug}`, development: `dev/${slug}` };
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
): Promise<{ requirement: string; development: string }> {
  const pair = fromSession ? sessionBranchNames(title) : workBranchNames(title);
  const sessionId = fromSession ? title.trim() : "";
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
