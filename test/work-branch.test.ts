import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { commitTrackedEdits, mergeFastForward, startRef } from "../apps/daemon/src/branches.ts";
import { admitSession, claimWorkBranch, composerName, currentSessionId, developmentSlug, mergeRequirementIntoBranch, mergeWorkBranches, openWorkBranches, readMergeTarget, readWorkBranches, sessionBranchNames, sessionPhase, unmatchedBranchMessage, UnmatchedWorkBranchError, userAskFromTranscript, workBranchNames } from "../apps/daemon/src/work-branch.ts";

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

test("核验前先提交评论改过的文件，再切分支", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-commit-edits-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "req/demo"]);
  git(cwd, ["switch", "-c", "dev/demo"]);
  writeFileSync(join(cwd, "a.txt"), "changed\n");
  writeFileSync(join(cwd, "note.txt"), "untracked\n");
  assert.equal(await commitTrackedEdits(cwd, "采纳评审评论中的修改。"), true);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd }).toString(), "?? note.txt\n");
  assert.match(execFileSync("git", ["log", "-1", "--format=%s"], { cwd }).toString(), /采纳评审评论中的修改/);
  assert.equal(execFileSync("git", ["show", "HEAD:a.txt"], { cwd }).toString(), "changed\n");
  await mergeFastForward(cwd, "req/demo", "dev/demo");
  assert.equal(execFileSync("git", ["show", "req/demo:a.txt"], { cwd }).toString(), "changed\n");
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
  await mergeWorkBranches(db, cwd, "repo", "dev/demo");
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
  assert.equal(sessionPhase(db, "repo", "feature-api", "slice-2"), null);
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
  await mergeRequirementIntoBranch(db, cwd, "repo", "dev/demo", "ship");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), "hold");
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "ship"], { cwd }).toString();
  assert.match(files, /q\.txt/);
  assert.match(files, /r\.txt/);
  await assert.rejects(() => mergeRequirementIntoBranch(db, cwd, "repo", "dev/demo", "missing"), /没有这个本地分支/);
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
  await assert.rejects(() => mergeRequirementIntoBranch(db, cwd, "repo", "dev/demo", "ship"));
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), "hold");
  assert.equal(execFileSync("git", ["rev-parse", "ship"], { cwd }).toString(), before);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd }).toString(), "");
});

test("对不上的切片分支不会回落到其他会话", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-unmatched-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "release"]);
  git(cwd, ["branch", "req/old"]);
  git(cwd, ["branch", "dev/old"]);
  git(cwd, ["switch", "dev/old"]);
  writeFileSync(join(cwd, "old.txt"), "old\n");
  git(cwd, ["add", "old.txt"]);
  git(cwd, ["commit", "-m", "old"]);
  git(cwd, ["switch", "main"]);
  git(cwd, ["branch", "req/new"]);
  git(cwd, ["switch", "-c", "dev/new"]);
  writeFileSync(join(cwd, "new.txt"), "new\n");
  git(cwd, ["add", "new.txt"]);
  git(cwd, ["commit", "-m", "new"]);
  git(cwd, ["switch", "main"]);
  git(cwd, ["switch", "-c", "feature-api"]);
  writeFileSync(join(cwd, "api.txt"), "api\n");
  git(cwd, ["add", "api.txt"]);
  git(cwd, ["commit", "-m", "api"]);
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_branches (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    requirement TEXT NOT NULL,
    development TEXT NOT NULL,
    admitted INTEGER NOT NULL DEFAULT 0,
    requirement_slice TEXT,
    merge_target TEXT,
    PRIMARY KEY (repo_id, session_id)
  )`);
  const insert = db.prepare(
    "INSERT INTO work_branches (repo_id, session_id, requirement, development, merge_target) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("repo", "old-session", "req/old", "dev/old", null);
  insert.run("repo", "new-session", "req/new", "dev/new", "release");
  const sha = (name: string) => execFileSync("git", ["rev-parse", name], { cwd }).toString();
  const before = [sha("req/old"), sha("dev/old"), sha("req/new"), sha("dev/new"), sha("release"), sha("feature-api")];
  await assert.rejects(() => mergeWorkBranches(db, cwd, "repo", "feature-api"), UnmatchedWorkBranchError);
  await assert.rejects(
    () => mergeRequirementIntoBranch(db, cwd, "repo", "feature-api", "release"),
    /分支「feature-api」没有对应的需求会话，没有合并/,
  );
  assert.deepEqual([sha("req/old"), sha("dev/old"), sha("req/new"), sha("dev/new"), sha("release"), sha("feature-api")], before);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), "feature-api");
  assert.equal(readWorkBranches(db, "repo", "feature-api"), null);
  const matched = readWorkBranches(db, "repo", "dev/new");
  assert.equal(matched?.requirement, "req/new");
  assert.equal(matched?.development, "dev/new");
  assert.equal(readMergeTarget(db, "repo", "feature-api"), "");
  assert.equal(readMergeTarget(db, "repo", "dev/new"), "release");
  assert.equal(currentSessionId(db, "repo", "feature-api"), "");
  assert.equal(sessionPhase(db, "repo", "feature-api", "slice-api"), null);
  await mergeWorkBranches(db, cwd, "repo", "dev/new");
  assert.equal(sha("req/new"), sha("dev/new"));
  assert.notEqual(sha("req/old"), sha("dev/old"));
  await mergeRequirementIntoBranch(db, cwd, "repo", "dev/new", "release");
  const releaseFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", "release"], { cwd }).toString();
  assert.match(releaseFiles, /new\.txt/);
  assert.doesNotMatch(releaseFiles, /old\.txt/);
  assert.doesNotMatch(releaseFiles, /api\.txt/);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), "feature-api");
});

test("认领 dev 分支后能匹配需求会话并走原来的合并", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-claim-dev-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "release"]);
  git(cwd, ["branch", "req/old"]);
  git(cwd, ["branch", "dev/old"]);
  const slug = "abcd1234ef567890";
  assert.equal(developmentSlug(`dev/${slug}`), slug);
  git(cwd, ["branch", `req/${slug}`]);
  git(cwd, ["switch", "-c", `dev/${slug}`]);
  writeFileSync(join(cwd, "claim.txt"), "claim\n");
  git(cwd, ["add", "claim.txt"]);
  git(cwd, ["commit", "-m", "claim"]);
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_branches (
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    requirement TEXT NOT NULL,
    development TEXT NOT NULL,
    admitted INTEGER NOT NULL DEFAULT 0,
    requirement_slice TEXT,
    merge_target TEXT,
    PRIMARY KEY (repo_id, session_id)
  )`);
  db.prepare("INSERT INTO work_branches (repo_id, session_id, requirement, development) VALUES (?, ?, ?, ?)").run(
    "repo",
    "old-session",
    "req/old",
    "dev/old",
  );
  assert.equal(readWorkBranches(db, "repo", `dev/${slug}`), null);
  await assert.rejects(() => mergeWorkBranches(db, cwd, "repo", `dev/${slug}`), UnmatchedWorkBranchError);
  const claimed = await claimWorkBranch(db, cwd, "repo", `dev/${slug}`, "", "");
  assert.equal(claimed.sessionId, slug);
  assert.equal(claimed.development, `dev/${slug}`);
  assert.equal(claimed.requirement, `req/${slug}`);
  const matched = readWorkBranches(db, "repo", `dev/${slug}`);
  assert.equal(matched?.requirement, `req/${slug}`);
  assert.equal(matched?.development, `dev/${slug}`);
  await mergeWorkBranches(db, cwd, "repo", `dev/${slug}`);
  assert.equal(execFileSync("git", ["rev-parse", `req/${slug}`], { cwd }).toString(), execFileSync("git", ["rev-parse", `dev/${slug}`], { cwd }).toString());
  await mergeRequirementIntoBranch(db, cwd, "repo", `dev/${slug}`, "release");
  assert.match(execFileSync("git", ["ls-tree", "-r", "--name-only", "release"], { cwd }).toString(), /claim\.txt/);
  assert.doesNotMatch(execFileSync("git", ["ls-tree", "-r", "--name-only", "req/old"], { cwd }).toString(), /claim\.txt/);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim(), `dev/${slug}`);
});

test("没有配对需求分支时，认领会按编号补一条", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-claim-create-req-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  const slug = "fedcba9876543210";
  git(cwd, ["switch", "-c", `dev/${slug}`]);
  const db = new DatabaseSync(":memory:");
  const claimed = await claimWorkBranch(db, cwd, "repo", `dev/${slug}`, "", "");
  assert.equal(claimed.requirement, `req/${slug}`);
  assert.match(execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd }).toString(), new RegExp(`req/${slug}`));
  assert.equal(readWorkBranches(db, "repo", `dev/${slug}`)?.requirement, `req/${slug}`);
});

test("cursor 分支认领后能匹配，文案说明可以认领或只并进目标", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-claim-cursor-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "review@local"]);
  git(cwd, ["config", "user.name", "review"]);
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git(cwd, ["add", "a.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["branch", "req/old"]);
  git(cwd, ["branch", "dev/old"]);
  git(cwd, ["switch", "-c", "cursor/agent-fix"]);
  writeFileSync(join(cwd, "fix.txt"), "fix\n");
  git(cwd, ["add", "fix.txt"]);
  git(cwd, ["commit", "-m", "fix"]);
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
    "old-session",
    "req/old",
    "dev/old",
  );
  await assert.rejects(() => claimWorkBranch(db, cwd, "repo", "cursor/agent-fix", "", ""), /请选择或建立会话/);
  assert.match(unmatchedBranchMessage("cursor/agent-fix"), /可以认领到一条会话/);
  assert.match(unmatchedBranchMessage("cursor/agent-fix"), /只并进所选目标/);
  assert.match(unmatchedBranchMessage("cursor/agent-fix", "release"), /并进了「release」/);
  assert.match(new UnmatchedWorkBranchError("feature-api").message, /没有对应的需求会话/);
  const session = "c39dda95-5a27-42ce-9123-194b6979821f";
  const claimed = await claimWorkBranch(db, cwd, "repo", "cursor/agent-fix", session, "Cursor branch claim");
  assert.equal(claimed.sessionId, session);
  assert.equal(claimed.development, "cursor/agent-fix");
  assert.equal(claimed.requirement, "req/Cursor-branch-claim");
  assert.equal(readWorkBranches(db, "repo", "cursor/agent-fix")?.development, "cursor/agent-fix");
  assert.equal(currentSessionId(db, "repo", "cursor/agent-fix"), session);
  await mergeWorkBranches(db, cwd, "repo", "cursor/agent-fix");
  assert.match(execFileSync("git", ["ls-tree", "-r", "--name-only", claimed.requirement], { cwd }).toString(), /fix\.txt/);
  assert.doesNotMatch(execFileSync("git", ["ls-tree", "-r", "--name-only", "req/old"], { cwd }).toString(), /fix\.txt/);
});

