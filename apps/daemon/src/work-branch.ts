import type { DatabaseSync } from "node:sqlite";
import { checkoutBranch, createBranch, mergeFastForward } from "./branches.ts";

export function workBranchNames(title: string): { requirement: string; development: string } {
  const slug = title.trim().replace(/\s+/g, "-").replace(/\./g, "").slice(0, 48);
  if (!slug || slug.startsWith("-")) throw new Error("需求名不能为空");
  return { requirement: `req/${slug}`, development: `dev/${slug}` };
}

export function readWorkBranches(db: DatabaseSync, repoId: string): { requirement: string; development: string } | null {
  ensureWorkBranches(db);
  const row = db.prepare("SELECT requirement, development FROM work_branches WHERE repo_id = ?").get(repoId) as
    | { requirement: string; development: string }
    | undefined;
  return row ?? null;
}

export async function openWorkBranches(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  baseRef: string,
  title: string,
): Promise<{ requirement: string; development: string }> {
  const pair = workBranchNames(title);
  await createBranch(cwd, pair.requirement, baseRef);
  await createBranch(cwd, pair.development, pair.requirement);
  await checkoutBranch(cwd, pair.development);
  ensureWorkBranches(db);
  db.prepare(
    `INSERT INTO work_branches (repo_id, requirement, development) VALUES (?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET requirement = excluded.requirement, development = excluded.development`,
  ).run(repoId, pair.requirement, pair.development);
  return pair;
}

export async function mergeWorkBranches(db: DatabaseSync, cwd: string, repoId: string): Promise<void> {
  const pair = readWorkBranches(db, repoId);
  if (!pair) return;
  await mergeFastForward(cwd, pair.requirement, pair.development);
}

function ensureWorkBranches(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_branches (
    repo_id TEXT PRIMARY KEY,
    requirement TEXT NOT NULL,
    development TEXT NOT NULL
  )`);
}
