import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mergeFastForward } from "../apps/daemon/src/branches.ts";
import { admitSession, mergeWorkBranches, sessionBranchNames, sessionPhase, workBranchNames } from "../apps/daemon/src/work-branch.ts";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd });
}

test("会话编号分成需求分支和开发分支", () => {
  assert.deepEqual(sessionBranchNames("c39dda95-5a27-42ce-9123-194b6979821f"), {
    requirement: "req/c39dda955a2742ce",
    development: "dev/c39dda955a2742ce",
  });
});

test("需求名分成需求分支和开发分支", () => {
  assert.deepEqual(workBranchNames("登记多个工程"), {
    requirement: "req/登记多个工程",
    development: "dev/登记多个工程",
  });
});

test("准入合并后，分支对比只剩下还没合并的提交", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-branches-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  const pair = workBranchNames("demo");
  git(cwd, ["branch", pair.requirement, "main"]);
  git(cwd, ["branch", pair.development, pair.requirement]);
  git(cwd, ["switch", pair.development]);
  writeFileSync(join(cwd, "b.txt"), "b\n");
  git(cwd, ["add", "b.txt"]);
  git(cwd, ["commit", "-m", "feature"]);
  const before = execFileSync("git", ["diff", "--name-only", `${pair.requirement}...${pair.development}`], { cwd }).toString().trim();
  assert.equal(before, "b.txt");
  await mergeFastForward(cwd, pair.requirement, pair.development);
  const after = execFileSync("git", ["diff", "--name-only", `${pair.requirement}...${pair.development}`], { cwd }).toString().trim();
  assert.equal(after, "");
  writeFileSync(join(cwd, "c.txt"), "c\n");
  git(cwd, ["add", "c.txt"]);
  git(cwd, ["commit", "-m", "next"]);
  const next = execFileSync("git", ["diff", "--name-only", `${pair.requirement}...${pair.development}`], { cwd }).toString().trim();
  assert.equal(next, "c.txt");
});

test("停在其他分支时，核对通过仍把开发分支合进需求分支", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-merge-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "req/demo"]);
  git(cwd, ["switch", "-c", "dev/demo"]);
  writeFileSync(join(cwd, "b.txt"), "b\n");
  git(cwd, ["add", "b.txt"]);
  git(cwd, ["commit", "-m", "feature"]);
  git(cwd, ["switch", "main"]);
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_branches (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    requirement TEXT NOT NULL,
    development TEXT NOT NULL,
    PRIMARY KEY (repo_id, session_id)
  )`);
  db.prepare("INSERT INTO work_branches (repo_id, session_id, requirement, development) VALUES (?, ?, ?, ?)").run(
    "repo",
    "session",
    "req/demo",
    "dev/demo",
  );
  await mergeWorkBranches(db, cwd, "repo", "main");
  const requirement = execFileSync("git", ["rev-parse", "req/demo"], { cwd }).toString().trim();
  const development = execFileSync("git", ["rev-parse", "dev/demo"], { cwd }).toString().trim();
  const current = execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();
  assert.equal(requirement, development);
  assert.equal(current, "main");
});

test("第一轮放行是需求准入，之后的新段是开发过程", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_branches (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    requirement TEXT NOT NULL,
    development TEXT NOT NULL,
    admitted INTEGER NOT NULL DEFAULT 0,
    requirement_slice TEXT,
    PRIMARY KEY (repo_id, session_id)
  )`);
  db.prepare("INSERT INTO work_branches (repo_id, session_id, requirement, development) VALUES (?, ?, ?, ?)").run(
    "repo",
    "session",
    "req/demo",
    "dev/demo",
  );
  assert.equal(sessionPhase(db, "repo", "dev/demo", "slice-1"), "requirement");
  admitSession(db, "repo", "dev/demo", "slice-1");
  assert.equal(sessionPhase(db, "repo", "dev/demo", "slice-1"), "requirement");
  assert.equal(sessionPhase(db, "repo", "dev/demo", "slice-2"), "development");
});

