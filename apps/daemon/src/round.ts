import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CodingPlan = {
  steps: string[];
  completed: number;
  updatedAt: string;
};

export type CodingPlanSnapshot = {
  steps: string[];
  completed: number;
  total: number;
  current: number | null;
  sliceStep: number | null;
};

export type RoundReport = {
  claimedFinal?: boolean;
  step?: number;
};

export type RoundDecision = {
  finalRound: boolean;
  corrected: boolean;
  stepIndex: number | null;
};

export function ensureRounds(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS slice_rounds (
    slice_id TEXT PRIMARY KEY,
    final INTEGER NOT NULL
  )`);
  const columns = db.prepare("PRAGMA table_info(slice_rounds)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "step_index")) {
    db.exec("ALTER TABLE slice_rounds ADD COLUMN step_index INTEGER");
  }
  if (!columns.some((column) => column.name === "plan_token")) {
    db.exec("ALTER TABLE slice_rounds ADD COLUMN plan_token TEXT");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS coding_plans (
    repo_id TEXT PRIMARY KEY,
    steps TEXT NOT NULL,
    completed INTEGER NOT NULL,
    updated_at TEXT NOT NULL
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

export function planLabel(plan: CodingPlanSnapshot | null): string {
  if (!plan || plan.total < 1) return "";
  const step = plan.sliceStep ?? plan.current;
  if (!step) return plan.completed >= plan.total ? `计划 ${plan.total}/${plan.total} 已完成` : "";
  const name = plan.steps[step - 1] ?? "";
  return name ? `计划 ${step}/${plan.total}：${name}` : `计划 ${step}/${plan.total}`;
}

export function saveCodingPlan(db: DatabaseSync, repoId: string, steps: string[]): CodingPlan {
  const cleaned = steps.map((step) => step.trim()).filter((step) => step.length > 0);
  if (cleaned.length === 0) throw new Error("coding 计划至少要有一步");
  ensureRounds(db);
  const updatedAt = randomUUID();
  db.prepare(
    `INSERT INTO coding_plans (repo_id, steps, completed, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(repo_id) DO UPDATE SET steps = excluded.steps, completed = 0, updated_at = excluded.updated_at`,
  ).run(repoId, JSON.stringify(cleaned), updatedAt);
  return { steps: cleaned, completed: 0, updatedAt };
}

export function readCodingPlan(db: DatabaseSync, repoId: string): CodingPlan | null {
  ensureRounds(db);
  const row = db.prepare("SELECT steps, completed, updated_at FROM coding_plans WHERE repo_id = ?").get(repoId) as
    | { steps: string; completed: number; updated_at: string }
    | undefined;
  if (!row) return null;
  const steps = parseSteps(row.steps);
  if (!steps || steps.length === 0) return null;
  const completed = Number.isInteger(row.completed) && row.completed > 0 ? Math.min(row.completed, steps.length) : 0;
  return { steps, completed, updatedAt: row.updated_at };
}

export function codingPlanSnapshot(db: DatabaseSync, repoId: string, sliceId: string | null): CodingPlanSnapshot | null {
  const plan = readCodingPlan(db, repoId);
  if (!plan) return null;
  const stepIndex = sliceId ? readStepIndex(db, sliceId) : null;
  return {
    steps: plan.steps,
    completed: plan.completed,
    total: plan.steps.length,
    current: plan.completed >= plan.steps.length ? null : plan.completed + 1,
    sliceStep: stepIndex == null ? null : stepIndex + 1,
  };
}

export function reportFromBody(body: { final?: unknown; step?: unknown }): RoundReport {
  return {
    claimedFinal: typeof body.final === "boolean" ? body.final : undefined,
    step: typeof body.step === "number" && Number.isInteger(body.step) ? body.step : undefined,
  };
}

export function decideFinalRound(plan: CodingPlan | null, report: RoundReport): RoundDecision | null {
  if (!plan) {
    if (typeof report.claimedFinal !== "boolean") return null;
    return { finalRound: false, corrected: report.claimedFinal === true, stepIndex: null };
  }
  const stepIndex = resolveStep(plan, report.step);
  const finalRound = stepIndex != null && stepIndex === plan.completed && stepIndex === plan.steps.length - 1;
  const corrected = typeof report.claimedFinal === "boolean" && report.claimedFinal !== finalRound;
  return { finalRound, corrected, stepIndex };
}

export function applyIntent(db: DatabaseSync, repoId: string, sliceId: string, report: RoundReport): RoundDecision | null {
  const plan = readCodingPlan(db, repoId);
  const decision = decideFinalRound(plan, report);
  if (!decision) return null;
  ensureRounds(db);
  db.prepare(
    `INSERT INTO slice_rounds (slice_id, final, step_index, plan_token) VALUES (?, ?, ?, ?)
     ON CONFLICT(slice_id) DO UPDATE SET final = excluded.final, step_index = excluded.step_index, plan_token = excluded.plan_token`,
  ).run(sliceId, decision.finalRound ? 1 : 0, decision.stepIndex, plan?.updatedAt ?? null);
  return decision;
}

export function advancePlanStep(db: DatabaseSync, repoId: string, sliceId: string): void {
  const plan = readCodingPlan(db, repoId);
  if (!plan || plan.completed >= plan.steps.length) return;
  const stepIndex = readStepIndex(db, sliceId);
  if (stepIndex == null || stepIndex !== plan.completed) return;
  db.prepare("UPDATE coding_plans SET completed = ? WHERE repo_id = ? AND completed = ?").run(
    plan.completed + 1,
    repoId,
    plan.completed,
  );
}

export function displayFinalRound(db: DatabaseSync, repoId: string, sliceId: string): boolean | null {
  ensureRounds(db);
  const row = db.prepare("SELECT final, step_index, plan_token FROM slice_rounds WHERE slice_id = ?").get(sliceId) as
    | { final: number; step_index: number | null; plan_token: string | null }
    | undefined;
  if (!row) return null;
  const plan = readCodingPlan(db, repoId);
  if (!plan) return row.final === 1;
  if (row.plan_token !== plan.updatedAt || row.step_index == null || row.step_index !== plan.steps.length - 1) return false;
  return row.step_index === plan.completed || row.step_index < plan.completed;
}

function resolveStep(plan: CodingPlan, step: number | undefined): number | null {
  if (step == null) {
    if (plan.completed >= plan.steps.length) return null;
    return plan.completed;
  }
  if (!Number.isInteger(step) || step < 1 || step > plan.steps.length) return null;
  return step - 1;
}

function readStepIndex(db: DatabaseSync, sliceId: string): number | null {
  ensureRounds(db);
  const row = db.prepare("SELECT step_index FROM slice_rounds WHERE slice_id = ?").get(sliceId) as
    | { step_index: number | null }
    | undefined;
  if (!row || row.step_index == null) return null;
  return row.step_index;
}

function parseSteps(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
    return value;
  } catch {
    return null;
  }
}
