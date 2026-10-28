import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Lease, SliceState, WorkSlice } from "../../../../packages/protocol/src/index.ts";
import { databaseFile, daemonFile } from "../paths.ts";

export type RepoRow = {
  id: string;
  path: string;
  base_ref: string;
  created_at: string;
};

export type SliceRow = {
  id: string;
  repo_id: string;
  agent: string;
  purpose: string;
  branch: string;
  state: SliceState;
  lease: Lease | null;
  base_sha: string | null;
  commit_sha: string | null;
  mismatch: number;
  reject_reason: string | null;
  created_at: string;
  released_at: string | null;
  reviewed_at: string | null;
};

export function openStore(): DatabaseSync {
  const db = new DatabaseSync(databaseFile());
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      base_ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_slices (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      purpose TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      lease TEXT,
      base_sha TEXT,
      commit_sha TEXT,
      mismatch INTEGER NOT NULL DEFAULT 0,
      reject_reason TEXT,
      created_at TEXT NOT NULL,
      released_at TEXT,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS slice_attempts (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      slice_id TEXT,
      agent TEXT,
      tool TEXT,
      path TEXT,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      base_ref TEXT,
      head_ref TEXT,
      base_sha TEXT,
      head_sha TEXT,
      fingerprint TEXT,
      file_count INTEGER NOT NULL,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_changes (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      old_path TEXT,
      status TEXT NOT NULL,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      binary INTEGER NOT NULL,
      patch_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS patch_blobs (
      hash TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unclaimed_diffs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolution TEXT NOT NULL
    );
  `);
  const sliceColumns = db.prepare("PRAGMA table_info(work_slices)").all() as Array<{ name: string }>;
  if (!sliceColumns.some((column) => column.name === "branch")) {
    db.exec("ALTER TABLE work_slices ADD COLUMN branch TEXT NOT NULL DEFAULT ''");
  }
  db.prepare(
    `UPDATE work_slices SET state = 'awaiting_release', lease = NULL WHERE state = 'editing'`,
  ).run();
  return db;
}

export function toSlice(row: SliceRow): WorkSlice {
  return {
    sliceId: row.id,
    repoId: row.repo_id,
    agent: row.agent,
    purpose: row.purpose,
    state: row.state,
    lease: row.lease,
    baseSha: row.base_sha,
    commitSha: row.commit_sha,
    mismatch: row.mismatch === 1,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    reviewedAt: row.reviewed_at,
    rejectReason: row.reject_reason,
  };
}

export function findRepoByPath(db: DatabaseSync, repoPath: string): RepoRow | undefined {
  return db.prepare("SELECT * FROM repos WHERE path = ?").get(repoPath) as RepoRow | undefined;
}

export function findRepo(db: DatabaseSync, id: string): RepoRow | undefined {
  return db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
}

export function listRepos(db: DatabaseSync): RepoRow[] {
  return db.prepare("SELECT * FROM repos ORDER BY created_at").all() as unknown as RepoRow[];
}

export function insertRepo(db: DatabaseSync, row: RepoRow): void {
  db.prepare("INSERT INTO repos (id, path, base_ref, created_at) VALUES (?, ?, ?, ?)").run(
    row.id,
    row.path,
    row.base_ref,
    row.created_at,
  );
}

export function setBaseRef(db: DatabaseSync, id: string, baseRef: string): void {
  db.prepare("UPDATE repos SET base_ref = ? WHERE id = ?").run(baseRef, id);
}

export function activeSlice(db: DatabaseSync, repoId: string, branch: string): SliceRow | undefined {
  return db.prepare(
    `SELECT * FROM work_slices
     WHERE repo_id = ? AND branch = ? AND state IN ('awaiting_release', 'editing', 'awaiting_review')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(repoId, branch) as SliceRow | undefined;
}

export function findSlice(db: DatabaseSync, id: string): SliceRow | undefined {
  return db.prepare("SELECT * FROM work_slices WHERE id = ?").get(id) as SliceRow | undefined;
}

export function insertSlice(db: DatabaseSync, row: SliceRow): void {
  db.prepare(
    `INSERT INTO work_slices (
      id, repo_id, agent, purpose, branch, state, lease, base_sha, commit_sha, mismatch, reject_reason, created_at, released_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.repo_id,
    row.agent,
    row.purpose,
    row.branch,
    row.state,
    row.lease,
    row.base_sha,
    row.commit_sha,
    row.mismatch,
    row.reject_reason,
    row.created_at,
    row.released_at,
    row.reviewed_at,
  );
}

export function updateSlice(db: DatabaseSync, id: string, fields: Partial<SliceRow>): void {
  const current = findSlice(db, id);
  if (!current) return;
  const next = { ...current, ...fields };
  db.prepare(
    `UPDATE work_slices SET
      state = ?, lease = ?, base_sha = ?, commit_sha = ?, mismatch = ?, reject_reason = ?, released_at = ?, reviewed_at = ?
     WHERE id = ?`,
  ).run(
    next.state,
    next.lease,
    next.base_sha,
    next.commit_sha,
    next.mismatch,
    next.reject_reason,
    next.released_at,
    next.reviewed_at,
    id,
  );
}

export const SLICE_PAGE_SIZE = 10;

export function countSlices(db: DatabaseSync, repoId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM work_slices WHERE repo_id = ?").get(repoId) as { total: number };
  return Number(row.total);
}

export function listSlices(db: DatabaseSync, repoId: string, page = 1): SliceRow[] {
  const current = Number.isInteger(page) && page > 0 ? page : 1;
  const offset = (current - 1) * SLICE_PAGE_SIZE;
  return db.prepare(
    "SELECT * FROM work_slices WHERE repo_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
  ).all(repoId, SLICE_PAGE_SIZE, offset) as unknown as SliceRow[];
}

export function recordAttempt(
  db: DatabaseSync,
  input: { repoId: string; sliceId: string | null; agent: string | null; tool: string; path: string | null; result: string },
): void {
  db.prepare(
    `INSERT INTO slice_attempts (id, repo_id, slice_id, agent, tool, path, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.repoId,
    input.sliceId,
    input.agent,
    input.tool,
    input.path,
    input.result,
    new Date().toISOString(),
  );
}

export type DaemonInfo = { pid: number; port: number; token: string };

export function writeDaemonInfo(info: DaemonInfo): void {
  const file = daemonFile();
  writeFileSync(file, JSON.stringify(info, null, 2));
  chmodSync(file, 0o600);
}

export function readDaemonInfo(): DaemonInfo | null {
  const file = daemonFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}
