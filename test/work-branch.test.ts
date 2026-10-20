import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mergeFastForward, startRef } from "../apps/daemon/src/branches.ts";
import { admitSession, composerName, mergeRequirementIntoBranch, mergeWorkBranches, openWorkBranches, sessionBranchNames, sessionPhase, userAskFromTranscript, workBranchNames } from "../apps/daemon/src/work-branch.ts";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd });
}

test("有 release 分支时从 release 启动，否则沿用原来的基准", () => {
  assert.equal(startRef(["main", "release", "dev/demo"], "HEAD"), "release");
  assert.equal(startRef(["main", "dev/demo"], "HEAD"), "HEAD");
});

test("需求分支用会话总结，开发分支仍用会话编号", () => {
  assert.deepEqual(sessionBranchNames("c39dda95-5a27-42ce-9123-194b6979821f", "User project and branch management"), {
    requirement: "req/User-project-and-branch-management",
    development: "dev/c39dda955a2742ce",
  });
});

test("会话标题和第一条用户请求都能当作会话总结", () => {
  const file = join(mkdtempSync(join(tmpdir(), "review-summary-")), "state.vscdb");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)").run(
    "c39dda95-5a27-42ce-9123-194b6979821f",
    JSON.stringify({ name: "  User project and branch management  " }),
  );
  db.close();
  assert.equal(composerName("c39dda95-5a27-42ce-9123-194b6979821f", file), "User project and branch management");
  const ask = userAskFromTranscript(
    `${JSON.stringify({ message: { content: [{ type: "text", text: "<user_query>\n把需求分支改成会话总结\n</user_query>" }] } })}\n`,
  );
  assert.equal(ask, "把需求分支改成会话总结");
});

test("新建会话分支时需求分支取会话总结", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-session-branch-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  const db = new DatabaseSync(":memory:");
  const session = "c39dda95-5a27-42ce-9123-194b6979821f";
  const pair = await openWorkBranches(db, cwd, "repo", "HEAD", session, true, "User project and branch management");
  assert.equal(pair.requirement, "req/User-project-and-branch-management");
  assert.equal(pair.development, "dev/c39dda955a2742ce");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), pair.development);
});

test("已有会话编号的需求分支改成会话总结", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-rename-req-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  const session = "fdea6284-fcb1-49cb-81a6-403628394b65";
  git(cwd, ["branch", "req/fdea6284fcb149cb"]);
  git(cwd, ["branch", "dev/fdea6284fcb149cb"]);
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
    session,
    "req/fdea6284fcb149cb",
    "dev/fdea6284fcb149cb",
  );
  const pair = await openWorkBranches(db, cwd, "repo", "HEAD", session, true, "Session naming issue");
  assert.equal(pair.requirement, "req/Session-naming-issue");
  assert.equal(pair.development, "dev/fdea6284fcb149cb");
  const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd }).toString();
  assert.match(branches, /req\/Session-naming-issue/);
  assert.doesNotMatch(branches, /req\/fdea6284fcb149cb/);
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

function rememberBranches(db: DatabaseSync) {
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
}

test("需求分支可以合进任意选中的分支，并停回原来的分支", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-pick-merge-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "hold"]);
  git(cwd, ["branch", "ship"]);
  git(cwd, ["branch", "req/demo"]);
  git(cwd, ["switch", "ship"]);
  writeFileSync(join(cwd, "r.txt"), "r\n");
  git(cwd, ["add", "r.txt"]);
  git(cwd, ["commit", "-m", "ship"]);
  git(cwd, ["switch", "req/demo"]);
  writeFileSync(join(cwd, "q.txt"), "q\n");
  git(cwd, ["add", "q.txt"]);
  git(cwd, ["commit", "-m", "requirement"]);
  git(cwd, ["switch", "hold"]);
  const db = new DatabaseSync(":memory:");
  rememberBranches(db);
  await mergeRequirementIntoBranch(db, cwd, "repo", "hold", "ship");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), "hold");
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "ship"], { cwd }).toString();
  assert.match(files, /q\.txt/);
  assert.match(files, /r\.txt/);
  await assert.rejects(() => mergeRequirementIntoBranch(db, cwd, "repo", "hold", "missing"), /没有这个本地分支/);
});

test("合并到选中分支发生冲突时撤回，需求没有进入该分支", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-pick-conflict-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "hold"]);
  git(cwd, ["branch", "ship"]);
  git(cwd, ["branch", "req/demo"]);
  git(cwd, ["switch", "ship"]);
  writeFileSync(join(cwd, "a.txt"), "ship\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "ship"]);
  git(cwd, ["switch", "req/demo"]);
  writeFileSync(join(cwd, "a.txt"), "requirement\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "requirement"]);
  git(cwd, ["switch", "hold"]);
  const db = new DatabaseSync(":memory:");
  rememberBranches(db);
  const before = execFileSync("git", ["rev-parse", "ship"], { cwd }).toString();
  await assert.rejects(() => mergeRequirementIntoBranch(db, cwd, "repo", "hold", "ship"));
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), "hold");
  assert.equal(execFileSync("git", ["rev-parse", "ship"], { cwd }).toString(), before);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd }).toString(), "");
});

