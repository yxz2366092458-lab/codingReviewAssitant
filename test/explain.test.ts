import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { explainPrompt, explainSelection, loadThreads, loadTurns, normalizeLines, readAnchor, remember, resolveExplainSession, saveExplainMode, saveThread, saveTurns, selectionAnchors, sessionPrompt, threadFor } from "../apps/daemon/src/explain.ts";
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

test("历史会话单独保留解释，不会串到当前会话", async () => {
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
  const top = [{ path: "a.ts", side: "head" as const, line: 10, text: "a" }, { path: "a.ts", side: "head" as const, line: 11, text: "b" }];
  const bottom = [{ path: "a.ts", side: "head" as const, line: 40, text: "c" }];
  const anchors = selectionAnchors([...top, ...bottom, { path: "a.ts", side: "head", line: 4, text: "d" }]);
  assert.deepEqual(anchors.map((item) => [item.start, item.end]), [[4, 4], [10, 11], [40, 40]]);
  const upper = readAnchor({ path: "a.ts", side: "head", start: 10, end: 11 });
  const lower = readAnchor({ path: "a.ts", side: "head", start: 40, end: 40 });
  if (!upper || !lower) throw new Error("锚点无效");
  saveThread(db, "repo", "old-session", upper, [{ role: "assistant", content: "上面的解释" }]);
  saveThread(db, "repo", "old-session", lower, [{ role: "assistant", content: "下面的解释" }]);
  const threads = loadThreads(db, "repo", "old-session");
  assert.deepEqual(threads.map((item) => item.turns[0]?.content), ["上面的解释", "下面的解释"]);
  saveExplainMode(db, "repo", "old-session", upper, "pseudo", "返回合计");
  const stored = await explainSelection(db, "repo", "old-session", top, "pseudo", upper);
  assert.equal(stored.cached, true);
  assert.equal(stored.reply, "返回合计");
  assert.equal(stored.modes.line, undefined);
  const visible = loadThreads(db, "repo", "old-session").find((item) => item.start === 10);
  assert.equal(visible?.modes.pseudo, "返回合计");
});

test("伪代码和按行解释分开生成，默认提示是伪代码", () => {
  const pseudo = explainPrompt(lines, "pseudo");
  const byLine = explainPrompt(lines, "line");
  assert.match(pseudo, /伪代码/);
  assert.match(pseudo, /apps\/web\/app\.js:12/);
  assert.doesNotMatch(pseudo, /按行解释/);
  assert.match(byLine, /按行解释/);
  assert.doesNotMatch(byLine, /伪代码/);
});
