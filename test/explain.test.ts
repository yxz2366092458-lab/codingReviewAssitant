import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyAgentWrites, applySelectionEdit, explainPrompt, explainSelection, loadThreads, loadTurns, normalizeLines, parseCommentAction, planFileEdits, readAnchor, remember, resolveExplainSession, saveExplainMode, saveThread, saveTurns, selectionAnchors, sessionPrompt, threadFor } from "../apps/daemon/src/explain.ts";
import { readAgentRun } from "../apps/daemon/src/cursor-proxy.ts";
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
  assert.match(prompt, /动作：答复/);
  assert.match(prompt, /动作：修改/);
});

test("评论动作能解析成答复或修改，格式不对就当作答复", () => {
  const reply = parseCommentAction("动作：答复\n说明：\n这行返回合计。");
  assert.deepEqual(reply, { kind: "reply", text: "这行返回合计。" });
  const edit = parseCommentAction("动作：修改\n说明：\n改成直接返回。\n代码：\nreturn total;");
  assert.deepEqual(edit, { kind: "edit", text: "改成直接返回。", code: "return total;" });
  const broken = "请把这行改成 return 0;";
  assert.deepEqual(parseCommentAction(broken), { kind: "reply", text: broken });
  assert.equal(parseCommentAction("动作：修改\n说明：\n还没给出代码。").kind, "reply");
  const wrapped = parseCommentAction("好的，我来改。\n动作：修改\r\n说明：\r\n改成直接返回。\r\n代码：\r\n```ts\r\nreturn 0;\r\n```");
  assert.deepEqual(wrapped, { kind: "edit", text: "改成直接返回。", code: "return 0;" });
  const fenceOnly = parseCommentAction("把选中的行改为：\n```\nreturn 0;\n```");
  assert.equal(fenceOnly.kind, "edit");
  if (fenceOnly.kind === "edit") assert.equal(fenceOnly.code, "return 0;");
});

test("最后一句声称改好时，仍用前面的修改块写文件", () => {
  const stream = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "动作：修改\n说明：\n改成直接返回。\n代码：\nreturn 0;" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已经改好了。" }] } }),
    JSON.stringify({ type: "result", result: "动作：修改\n说明：\n改成直接返回。\n代码：\nreturn 0;已经改好了。" }),
  ].join("\n");
  const run = readAgentRun(stream);
  const action = parseCommentAction(run.text);
  assert.equal(action.kind, "edit");
  if (action.kind !== "edit") return;
  assert.equal(action.code, "return 0;");
  const root = mkdtempSync(join(tmpdir(), "review-edit-"));
  const file = join(root, "a.ts");
  writeFileSync(file, "const a = 1;\nreturn total;\n");
  const plan = planFileEdits(action, run.text, run.writes);
  assert.equal(plan.selection, true);
  applySelectionEdit(root, [{ path: "a.ts", side: "head", line: 2, text: "return total;" }], action.code);
  assert.equal(readFileSync(file, "utf8"), "const a = 1;\nreturn 0;\n");
});

test("工具调用里的修改没落盘时，由评审程序写入", () => {
  const root = mkdtempSync(join(tmpdir(), "review-write-"));
  const file = join(root, "a.ts");
  writeFileSync(file, "return total;\n");
  const action = parseCommentAction("已经修改了 a.ts，但工具没有执行。");
  const writes = [{ path: "a.ts", contents: "return 0;\n", applied: false }];
  const plan = planFileEdits(action, "已经修改了 a.ts，但工具没有执行。", writes);
  assert.equal(plan.selection, false);
  assert.equal(plan.edited, true);
  applyAgentWrites(root, plan.writes);
  assert.equal(readFileSync(file, "utf8"), "return 0;\n");
  assert.throws(() => applyAgentWrites(root, [{ path: "../outside.ts", contents: "no\n", applied: false }]), /路径超出仓库/);
  const reply = parseCommentAction("动作：答复\n说明：\n这行只是返回合计。");
  const ignored = planFileEdits(reply, "动作：答复\n说明：\n这行只是返回合计。", writes);
  assert.equal(ignored.edited, false);
});

test("修改只替换核对过的当前文件行", () => {
  const root = mkdtempSync(join(tmpdir(), "review-edit-"));
  const file = join(root, "a.ts");
  writeFileSync(file, "const a = 1;\nreturn total;\n\nconst b = 2;\n");
  applySelectionEdit(root, [
    { path: "a.ts", side: "head", line: 2, text: "return total;" },
    { path: "a.ts", side: "head", line: 3, text: " " },
  ], "return 0;\nfilled");
  assert.equal(readFileSync(file, "utf8"), "const a = 1;\nreturn 0;\nfilled\nconst b = 2;\n");
});

test("基准侧、原文变化和仓库外路径都不改文件", () => {
  const root = mkdtempSync(join(tmpdir(), "review-edit-"));
  const file = join(root, "a.ts");
  const original = "return total;\n";
  writeFileSync(file, original);
  const head = [{ path: "a.ts", side: "head" as const, line: 1, text: "return total;" }];
  assert.throws(() => applySelectionEdit(root, [{ ...head[0], side: "base" }], "return 0;"), /只能修改当前文件里的代码/);
  assert.throws(() => applySelectionEdit(root, [{ ...head[0], text: "return other;" }], "return 0;"), /选中的代码已经变了/);
  assert.throws(() => applySelectionEdit(root, [{ ...head[0], path: "../outside.ts" }], "return 0;"), /路径超出仓库/);
  assert.equal(readFileSync(file, "utf8"), original);
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
