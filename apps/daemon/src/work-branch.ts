import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertBranchName, checkoutBranch, commitsAhead, createBranch, listLocalBranches, mergeBranch, mergeFastForward, renameBranch } from "./branches.ts";

export function workBranchNames(title: string): { requirement: string; development: string } {
  const slug = title.trim().replace(/\s+/g, "-").replace(/\./g, "").slice(0, 48);
  if (!slug || slug.startsWith("-")) throw new Error("需求名不能为空");
  return { requirement: `req/${slug}`, development: `dev/${slug}` };
}

export function sessionSlug(sessionId: string): string {
  return sessionId.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
}

export function developmentSlug(branch: string): string | null {
  const match = /^dev\/([A-Za-z0-9]{8,})$/.exec(branch.trim());
  return match?.[1] ?? null;
}

export function unmatchedBranchMessage(branch: string, mergedInto = ""): string {
  const name = branch.trim() || "当前分支";
  if (name.startsWith("cursor/")) {
    if (mergedInto) {
      return `分支「${name}」还没有认领到需求会话。可以先认领，再走需求分支合并；这次只把它并进了「${mergedInto}」，没有动其他会话。`;
    }
    return `分支「${name}」还没有认领到需求会话。可以认领到一条会话，或在核对通过时只并进所选目标。`;
  }
  if (mergedInto) {
    return `分支「${name}」没有对应的需求会话，已将该分支合并到「${mergedInto}」，没有动其他会话。`;
  }
  return `分支「${name}」没有对应的需求会话，没有合并。未登记的开发分支不会并入其他会话。`;
}

export function sessionBranchNames(sessionId: string, summary: string): { requirement: string; development: string } {
  const slug = sessionSlug(sessionId);
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

export class UnmatchedWorkBranchError extends Error {
  constructor(branch: string) {
    super(unmatchedBranchMessage(branch));
    this.name = "UnmatchedWorkBranchError";
  }
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
  return matchDevelopment(rows, headBranch);
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
      const provided = summaryText.trim();
      await repairSessionRequirements(db, cwd, repoId, provided ? { [sessionId]: provided } : {});
      const current = readSessionBranches(db, repoId, sessionId) ?? existing;
      await checkoutBranch(cwd, current.development);
      return current;
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
  if (pair) {
    await mergeFastForward(cwd, pair.requirement, pair.development);
    return;
  }
  if (hasWorkBranches(db, repoId)) throw new UnmatchedWorkBranchError(headBranch);
}

export async function mergeRequirementIntoBranch(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  headBranch: string,
  targetBranch: string,
): Promise<void> {
  const target = assertBranchName(targetBranch);
  const pair = readWorkBranches(db, repoId, headBranch);
  if (!pair) {
    if (hasWorkBranches(db, repoId)) throw new UnmatchedWorkBranchError(headBranch);
    throw new Error("还没有需求分支");
  }
  await mergeBranch(cwd, target, pair.requirement);
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
  const match = listWorkSessions(db, repoId, "").find((item) => sameSession(item.sessionId, sessionId));
  if (!match) return null;
  return { requirement: match.requirement, development: match.development };
}

export async function claimWorkBranch(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  branch: string,
  sessionId = "",
  knownSummary?: string,
): Promise<{ sessionId: string; requirement: string; development: string }> {
  const name = assertBranchName(branch);
  if (!(await listLocalBranches(cwd)).includes(name)) throw new Error("没有这个本地分支");
  const branchSlug = developmentSlug(name);
  const provided = sessionId.trim();
  let owner = "";
  if (branchSlug && !provided) owner = branchSlug;
  else if (!provided) throw new Error("请选择或建立会话后再认领这个分支");
  else if (sessionSlug(provided).length < 8) throw new Error("会话无效");
  else owner = provided;
  ensureWorkBranches(db);
  const existingDev = readWorkBranches(db, repoId, name);
  if (existingDev) {
    return {
      sessionId: currentSessionId(db, repoId, name),
      requirement: existingDev.requirement,
      development: existingDev.development,
    };
  }
  const existingSession = readSessionBranches(db, repoId, owner);
  if (existingSession && existingSession.development !== name) throw new Error("这条会话已经绑定了别的开发分支");
  if (existingSession) return { sessionId: owner, requirement: existingSession.requirement, development: name };
  const slugHint = branchSlug || sessionSlug(owner);
  const summary = knownSummary ?? (provided ? readSessionSummary(provided) : summaryForSlug(slugHint));
  const requirement = await ensureClaimRequirement(db, cwd, repoId, name, slugHint, summary);
  db.prepare("INSERT INTO work_branches (repo_id, session_id, requirement, development) VALUES (?, ?, ?, ?)").run(
    repoId,
    owner,
    requirement,
    name,
  );
  return { sessionId: owner, requirement, development: name };
}

export async function listUnclaimedBranches(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
): Promise<Array<{ branch: string; kind: "dev" | "cursor" }>> {
  ensureWorkBranches(db);
  const rows = db.prepare("SELECT development FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{
    development: string;
  }>;
  const claimed = new Set(rows.map((row) => row.development));
  const unclaimed: Array<{ branch: string; kind: "dev" | "cursor" }> = [];
  for (const branch of await listLocalBranches(cwd)) {
    if (claimed.has(branch)) continue;
    if (branch.startsWith("dev/")) unclaimed.push({ branch, kind: "dev" });
    else if (branch.startsWith("cursor/")) unclaimed.push({ branch, kind: "cursor" });
  }
  return unclaimed;
}

export function currentSessionId(db: DatabaseSync, repoId: string, headBranch: string): string {
  ensureWorkBranches(db);
  const rows = db.prepare("SELECT session_id, development FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{
    session_id: string;
    development: string;
  }>;
  return matchDevelopment(rows, headBranch)?.session_id.trim() ?? "";
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

export function readMergeTarget(db: DatabaseSync, repoId: string, headBranch: string): string {
  return readRecord(db, repoId, headBranch)?.merge_target?.trim() ?? "";
}

export async function bindMergeTarget(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  headBranch: string,
  target: string,
): Promise<string> {
  const name = assertBranchName(target);
  const row = readRecord(db, repoId, headBranch);
  if (!row) throw new Error("还没有这条会话的分支");
  if (row.admitted) throw new Error("需求已经准入，不能再改合并目标");
  if (name === row.development || name === row.requirement) throw new Error("合并目标不能是这条会话自己的分支");
  const branches = await listLocalBranches(cwd);
  if (!branches.includes(name)) throw new Error("没有这个本地分支");
  db.prepare("UPDATE work_branches SET merge_target = ? WHERE repo_id = ? AND development = ?").run(
    name,
    repoId,
    row.development,
  );
  return name;
}

export async function repairSessionRequirements(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  summaries: Record<string, string> = {},
): Promise<void> {
  ensureWorkBranches(db);
  const rows = db.prepare("SELECT session_id, requirement FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{
    session_id: string;
    requirement: string;
  }>;
  const branches = new Set(await listLocalBranches(cwd));
  for (const row of rows) {
    const sessionId = row.session_id.trim();
    const slug = sessionSlug(sessionId);
    if (slug.length < 8 || row.requirement !== `req/${slug}` || !branches.has(row.requirement)) continue;
    const summary = summaries[sessionId]?.trim() || readSessionSummary(sessionId);
    if (!summary) continue;
    let desired = "";
    try {
      desired = requirementBranchName(summary);
    } catch {
      continue;
    }
    if (desired === row.requirement) continue;
    let next = desired;
    try {
      next = await availableRequirement(db, cwd, repoId, desired);
      if (next === row.requirement || branches.has(next)) continue;
      await renameBranch(cwd, row.requirement, next);
    } catch {
      continue;
    }
    branches.delete(row.requirement);
    branches.add(next);
    db.prepare("UPDATE work_branches SET requirement = ? WHERE repo_id = ? AND session_id = ?").run(next, repoId, row.session_id);
  }
}

function sameSession(stored: string, asked: string): boolean {
  const left = stored.trim();
  const right = asked.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const storedSlug = sessionSlug(left);
  const askedSlug = sessionSlug(right);
  return storedSlug.length >= 8 && storedSlug === askedSlug;
}

function summaryForSlug(slug: string): string {
  const id = sessionIdForSlug(slug);
  return id ? readSessionSummary(id) : "";
}

function sessionIdForSlug(slug: string, file = cursorStateFile()): string {
  const target = slug.trim();
  if (target.length < 8 || !existsSync(file)) return "";
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT composerId FROM composerHeaders").all() as Array<{ composerId?: string }>;
    for (const row of rows) {
      const id = String(row.composerId ?? "");
      if (id === target || sessionSlug(id) === target) return id;
    }
    return "";
  } catch {
    return "";
  } finally {
    db?.close();
  }
}

async function ensureClaimRequirement(
  db: DatabaseSync,
  cwd: string,
  repoId: string,
  development: string,
  slugHint: string,
  summary: string,
): Promise<string> {
  ensureWorkBranches(db);
  const locals = await listLocalBranches(cwd);
  const rows = db.prepare("SELECT requirement FROM work_branches WHERE repo_id = ?").all(repoId) as Array<{
    requirement: string;
  }>;
  const used = new Set(rows.map((row) => row.requirement));
  if (slugHint.length >= 8) {
    const exact = `req/${slugHint}`;
    if (locals.includes(exact) && !used.has(exact) && (await commitsAhead(cwd, exact, development)) !== null) return exact;
  }
  const closest = await uniqueClosestRequirement(
    cwd,
    development,
    locals.filter((item) => item.startsWith("req/") && !used.has(item)),
  );
  if (closest) return closest;
  let desired = "";
  if (summary.trim()) {
    try {
      desired = requirementBranchName(summary);
    } catch {
      desired = "";
    }
  }
  if (!desired && slugHint) desired = `req/${slugHint.slice(0, 48)}`;
  if (!desired) throw new Error("没有会话总结");
  const requirement = await availableRequirement(db, cwd, repoId, desired);
  if (!locals.includes(requirement)) await createBranch(cwd, requirement, development);
  return requirement;
}

async function uniqueClosestRequirement(cwd: string, development: string, candidates: string[]): Promise<string> {
  let best = "";
  let bestAhead = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const candidate of candidates) {
    if (candidate === development) continue;
    const ahead = await commitsAhead(cwd, candidate, development);
    if (ahead === null) continue;
    if (ahead < bestAhead) {
      best = candidate;
      bestAhead = ahead;
      tied = false;
    } else if (ahead === bestAhead) {
      tied = true;
    }
  }
  return tied ? "" : best;
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
    "SELECT requirement, development, admitted, requirement_slice, merge_target FROM work_branches WHERE repo_id = ?",
  ).all(repoId) as Array<{
    requirement: string;
    development: string;
    admitted: number;
    requirement_slice: string | null;
    merge_target: string | null;
  }>;
  return matchDevelopment(rows, headBranch);
}

function matchDevelopment<T extends { development: string }>(rows: T[], headBranch: string): T | null {
  const branch = headBranch.trim();
  if (!branch) return null;
  return rows.find((row) => row.development === branch) ?? null;
}

function hasWorkBranches(db: DatabaseSync, repoId: string): boolean {
  ensureWorkBranches(db);
  const row = db.prepare("SELECT 1 AS ok FROM work_branches WHERE repo_id = ? LIMIT 1").get(repoId) as { ok: number } | undefined;
  return row !== undefined;
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
      merge_target TEXT,
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
  if (!ready.some((column) => column.name === "merge_target")) {
    db.exec("ALTER TABLE work_branches ADD COLUMN merge_target TEXT");
  }
}
