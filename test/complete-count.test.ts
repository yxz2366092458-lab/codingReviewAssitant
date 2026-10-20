import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { complete, GateError } from "../apps/daemon/src/gate/machine.ts";
import { insertSlice, openStore } from "../apps/daemon/src/session/store.ts";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd });
}

test("放行后有多个提交也能进入待核对，没有提交则不收口", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-complete-"));
  const home = mkdtempSync(join(tmpdir(), "review-complete-home-"));
  const previous = process.env.REVIEW_HOME;
  process.env.REVIEW_HOME = home;
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  writeFileSync(join(cwd, "b.txt"), "b\n");
  git(cwd, ["add", "b.txt"]);
  git(cwd, ["commit", "-m", "first"]);
  writeFileSync(join(cwd, "c.txt"), "c\n");
  git(cwd, ["add", "c.txt"]);
  git(cwd, ["commit", "-m", "second"]);
  const db = openStore();
  const now = new Date().toISOString();
  insertSlice(db, {
    id: "slice-1",
    repo_id: "repo",
    agent: "test",
    purpose: "second",
    state: "editing",
    lease: "edit",
    base_sha: base,
    commit_sha: null,
    mismatch: 0,
    reject_reason: null,
    created_at: now,
    released_at: now,
    reviewed_at: null,
  });
  const reviewed = await complete(db, cwd, "repo");
  assert.equal(reviewed.state, "awaiting_review");
  assert.equal(reviewed.slice?.mismatch, false);
  db.prepare("UPDATE work_slices SET state = 'editing', lease = 'edit', base_sha = ?, commit_sha = NULL").run(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
  );
  await assert.rejects(() => complete(db, cwd, "repo"), (error: unknown) => {
    assert.ok(error instanceof GateError);
    assert.equal(error.message, "放行后还没有提交");
    return true;
  });
  db.close();
  if (previous === undefined) delete process.env.REVIEW_HOME;
  else process.env.REVIEW_HOME = previous;
});
