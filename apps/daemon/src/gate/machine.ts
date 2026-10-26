import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GateView } from "../../../../packages/protocol/src/index.ts";
import { commitsSince, commitSubject, parentOf, repoStatus } from "../git/diff.ts";
import { git } from "../git/runner.ts";
import {
  activeSlice,
  findSlice,
  insertSlice,
  listRepos,
  recordAttempt,
  toSlice,
  updateSlice,
  type SliceRow,
} from "../session/store.ts";
import { readBugfix } from "./bugfix.ts";
import { decide, normalizeToolCall } from "./policy.ts";

export class GateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GateError";
  }
}

export function gateView(db: DatabaseSync, repoId: string, branch: string): GateView {
  const row = activeSlice(db, repoId, branch);
  if (!row) return { state: "locked", lease: null, slice: null };
  return { state: row.state as GateView["state"], lease: row.lease, slice: toSlice(row) };
}

export function intend(db: DatabaseSync, repoId: string, agent: string, purpose: string, branch: string): GateView {
  const text = purpose.trim();
  if (!text) throw new GateError(400, "作用说明不能为空");
  const name = branch.trim();
  if (!name) throw new GateError(400, "没有当前分支");
  const existing = activeSlice(db, repoId, name);
  if (existing) return gateView(db, repoId, name);
  const now = new Date().toISOString();
  insertSlice(db, {
    id: randomUUID(),
    repo_id: repoId,
    agent: agent || "agent",
    purpose: text,
    branch: name,
    state: "awaiting_release",
    lease: null,
    base_sha: null,
    commit_sha: null,
    mismatch: 0,
    reject_reason: null,
    created_at: now,
    released_at: null,
    reviewed_at: null,
  });
  return gateView(db, repoId, name);
}

export async function pinOpenSlices(db: DatabaseSync): Promise<void> {
  for (const repo of listRepos(db)) {
    let branch = "";
    try {
      branch = (await git(repo.path, ["symbolic-ref", "--short", "HEAD"])).trim();
    } catch {
      continue;
    }
    if (!branch) continue;
    db.prepare(
      `UPDATE work_slices SET branch = ?
       WHERE repo_id = ? AND branch = '' AND state IN ('awaiting_release', 'editing', 'awaiting_review')`,
    ).run(branch, repo.id);
  }
}

export async function release(db: DatabaseSync, repoPath: string, sliceId: string): Promise<GateView> {
  const row = need(db, sliceId);
  if (row.state !== "awaiting_release") throw new GateError(409, "这一段现在不能放行");
  const status = await repoStatus(repoPath, "HEAD");
  updateSlice(db, sliceId, {
    state: "editing",
    lease: "edit",
    base_sha: status.head,
    released_at: new Date().toISOString(),
  });
  return gateView(db, row.repo_id, row.branch);
}

export function acknowledge(db: DatabaseSync, sliceId: string): GateView {
  const row = need(db, sliceId);
  if (row.state !== "awaiting_review") throw new GateError(409, "这一段还不能核对通过");
  updateSlice(db, sliceId, { state: "approved", lease: null, reviewed_at: new Date().toISOString() });
  return gateView(db, row.repo_id, row.branch);
}

export async function reject(db: DatabaseSync, repoPath: string, sliceId: string, reason: string): Promise<GateView> {
  const row = need(db, sliceId);
  if (row.state !== "awaiting_release" && row.state !== "awaiting_review") {
    throw new GateError(409, "这一段现在不能退回");
  }
  if (row.state === "awaiting_review" && row.commit_sha) {
    const parent = await parentOf(repoPath, row.commit_sha);
    updateSlice(db, sliceId, {
      state: "editing",
      lease: "revert",
      base_sha: parent,
      reject_reason: reason.trim() || "退回",
    });
    return gateView(db, row.repo_id, row.branch);
  }
  updateSlice(db, sliceId, {
    state: "rejected",
    lease: null,
    reject_reason: reason.trim() || "退回",
    reviewed_at: new Date().toISOString(),
  });
  return gateView(db, row.repo_id, row.branch);
}

export async function complete(db: DatabaseSync, repoPath: string, repoId: string): Promise<GateView> {
  const branch = await checkedOutBranch(repoPath);
  const row = activeSlice(db, repoId, branch);
  if (!row) throw new GateError(409, "没有正在编辑的切片");
  if (row.state === "awaiting_review") return gateView(db, repoId, branch);
  if (row.state !== "editing" || row.lease === "revert") throw new GateError(409, "这一段还不能提交收口");
  if (!row.base_sha) throw new GateError(409, "这一段还没有放行记录");
  const porcelain = await git(repoPath, ["status", "--porcelain=v1", "-uno", "-z"]);
  if (porcelain.length > 0) throw new GateError(409, "工作区还有未提交的修改");
  const commits = await commitsSince(repoPath, row.base_sha);
  if (commits.length === 0) throw new GateError(409, "放行后还没有提交");
  const subject = await commitSubject(repoPath);
  updateSlice(db, row.id, reviewedFrom(commits, subject, row.purpose));
  return gateView(db, repoId, branch);
}

export async function syncRepo(db: DatabaseSync, repoPath: string, repoId: string): Promise<boolean> {
  const branch = await checkedOutBranch(repoPath);
  const row = activeSlice(db, repoId, branch);
  if (!row || row.state !== "editing") return false;
  if (row.lease === "revert") {
    const head = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    if (row.base_sha && head === row.base_sha) {
      updateSlice(db, row.id, {
        state: "rejected",
        lease: null,
        reviewed_at: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }
  const before = row.state;
  await settleEdit(db, repoPath, row);
  return findSlice(db, row.id)?.state !== before;
}

async function settleEdit(db: DatabaseSync, repoPath: string, row: SliceRow): Promise<void> {
  if (!row.base_sha || row.lease === "revert") return;
  const porcelain = await git(repoPath, ["status", "--porcelain=v1", "-uno", "-z"]);
  if (porcelain.length > 0) return;
  const commits = await commitsSince(repoPath, row.base_sha);
  if (commits.length === 0) return;
  const subject = await commitSubject(repoPath);
  updateSlice(db, row.id, reviewedFrom(commits, subject, row.purpose));
}

function reviewedFrom(commits: string[], subject: string, purpose: string) {
  return {
    state: "awaiting_review" as const,
    lease: null,
    commit_sha: commits[0] ?? null,
    mismatch: subject === purpose ? 0 : 1,
  };
}

export function checkCall(db: DatabaseSync, repoId: string, raw: Record<string, unknown>, branch: string) {
  const call = normalizeToolCall(raw);
  const view = gateView(db, repoId, branch);
  const result = decide(call, view.state, view.lease, readBugfix(db, repoId) !== null);
  recordAttempt(db, {
    repoId,
    sliceId: view.slice?.sliceId ?? null,
    agent: call.agent,
    tool: call.tool || "shell",
    path: call.paths[0] ?? null,
    result: result.permission,
  });
  return result;
}

async function checkedOutBranch(repoPath: string): Promise<string> {
  try {
    return (await git(repoPath, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    return "";
  }
}

function need(db: DatabaseSync, sliceId: string): SliceRow {
  const row = findSlice(db, sliceId);
  if (!row) throw new GateError(404, "找不到这一段");
  return row;
}
