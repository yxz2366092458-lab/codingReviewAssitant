import type { DatabaseSync } from "node:sqlite";

export function readBugfix(db: DatabaseSync, repoId: string): string | null {
  ensureBugfix(db);
  const row = db.prepare("SELECT purpose FROM bugfix_entries WHERE repo_id = ?").get(repoId) as
    | { purpose: string }
    | undefined;
  const purpose = row?.purpose.trim() ?? "";
  return purpose || null;
}

export function openBugfix(db: DatabaseSync, repoId: string, purpose: string): void {
  ensureBugfix(db);
  db.prepare(
    `INSERT INTO bugfix_entries (repo_id, purpose, created_at) VALUES (?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET purpose = excluded.purpose, created_at = excluded.created_at`,
  ).run(repoId, purpose.trim(), new Date().toISOString());
}

export function closeBugfix(db: DatabaseSync, repoId: string): void {
  ensureBugfix(db);
  db.prepare("DELETE FROM bugfix_entries WHERE repo_id = ?").run(repoId);
}

function ensureBugfix(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS bugfix_entries (
    repo_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}
