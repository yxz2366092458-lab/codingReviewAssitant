import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadTurns, normalizeLines, remember, resolveExplainSession, saveTurns, sessionPrompt, threadFor } from "../apps/daemon/src/explain.ts";
import { currentSessionId, listWorkSessions, readSessionBranches } from "../apps/daemon/src/work-branch.ts";

const lines = [{ path: "apps/web/app.js", side: "head" as const, line: 12, text: "return total;" }];

test("同一会话的下一次评论带上之前的解释", () => {
  const first = sessionPrompt([], lines, "这行做什么");
  assert.match(first, /apps\/web\/app\.js:12/);
  assert.match(first, /return total;/);
  assert.match(first, /这行做什么/);
  const second = sessionPrompt(
    [
      { role: "user", content: "这行做什么" },
      { role: "assistant", content: "返回合计。" },
    ],
    lines,
    "合计从哪来",
  );
  assert.match(second, /返回合计/);
  assert.match(second, /合计从哪来/);
  assert.match(second, /同一会话里已经说过/);
});

test("评论留空时仍然要求解释作用", () => {
  const prompt = sessionPrompt([], lines, "  ");
  assert.match(prompt, /解释这些代码的作用/);
});

test("非法行会被丢掉，同一会话累积评论", () => {
  const picked = normalizeLines([
    { path: "a.ts", side: "base", line: 3, text: "old" },
    { path: "", line: 1, text: "skip" },
    { line: 0, path: "a.ts", text: "skip" },
  ]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.side, "base");
  const key = "repo:session-explain";
  const first = remember(key, [], picked, "解释", "读出旧值。");
  const second = remember(key, first, picked, "旧值给谁用", "留给后面比较。");
  assert.equal(second.length, 4);
  assert.equal(second[3]?.content, "留给后面比较。");
  assert.equal(threadFor(key).length, 4);
});

test("当前开发分支对应这次会话", () => {
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
    "c39dda95-5a27-42ce-9123-194b6979821f",
    "req/c39dda955a2742ce",
    "dev/c39dda955a2742ce",
  );
  assert.equal(currentSessionId(db, "repo", "dev/c39dda955a2742ce"), "c39dda95-5a27-42ce-9123-194b6979821f");
});

test("历史会话单独保留解释，不会串到当前会话", () => {
  assert.equal(resolveExplainSession("old-session", ["old-session", "new-session"], "new-session"), "old-session");
  assert.equal(resolveExplainSession("", ["old-session", "new-session"], "new-session"), "new-session");
  assert.throws(() => resolveExplainSession("missing", ["old-session"], "new-session"), /没有这个会话/);
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
  const insert = db.prepare("INSERT INTO work_branches (repo_id, session_id, requirement, development) VALUES (?, ?, ?, ?)");
  insert.run("repo", "old-session", "req/old", "dev/old");
  insert.run("repo", "new-session", "req/new", "dev/new");
  const listed = listWorkSessions(db, "repo", "dev/new");
  assert.equal(listed.find((item) => item.sessionId === "old-session")?.current, false);
  assert.equal(listed.find((item) => item.sessionId === "new-session")?.current, true);
  assert.deepEqual(readSessionBranches(db, "repo", "old-session"), { requirement: "req/old", development: "dev/old" });
  saveTurns(db, "repo", "old-session", [{ role: "assistant", content: "历史会话里的解释" }]);
  saveTurns(db, "repo", "new-session", [{ role: "assistant", content: "当前会话里的解释" }]);
  assert.equal(loadTurns(db, "repo", "old-session")[0]?.content, "历史会话里的解释");
  assert.equal(loadTurns(db, "repo", "new-session")[0]?.content, "当前会话里的解释");
});
