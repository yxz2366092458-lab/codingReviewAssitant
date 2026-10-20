import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { normalizeLines, remember, sessionPrompt, threadFor } from "../apps/daemon/src/explain.ts";
import { currentSessionId } from "../apps/daemon/src/work-branch.ts";

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
