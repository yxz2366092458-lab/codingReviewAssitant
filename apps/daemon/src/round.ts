import type { DatabaseSync } from "node:sqlite";

export function ensureRounds(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS slice_rounds (
    slice_id TEXT PRIMARY KEY,
    final INTEGER NOT NULL
  )`);
}

export function setFinalRound(db: DatabaseSync, sliceId: string, final: boolean): void {
  ensureRounds(db);
  db.prepare(
    `INSERT INTO slice_rounds (slice_id, final) VALUES (?, ?)
     ON CONFLICT(slice_id) DO UPDATE SET final = excluded.final`,
  ).run(sliceId, final ? 1 : 0);
}

export function readFinalRound(db: DatabaseSync, sliceId: string): boolean | null {
  ensureRounds(db);
  const row = db.prepare("SELECT final FROM slice_rounds WHERE slice_id = ?").get(sliceId) as { final: number } | undefined;
  if (!row) return null;
  return row.final === 1;
}

export function roundLabel(finalRound: boolean | null): string {
  if (finalRound === true) return "最后一轮";
  if (finalRound === false) return "不是最后一轮";
  return "";
}
