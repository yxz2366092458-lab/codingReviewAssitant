import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseIntendArgs, parsePlanSteps } from "../apps/cli/args.ts";
import {
  advancePlanStep,
  applyIntent,
  codingPlanSnapshot,
  displayFinalRound,
  planLabel,
  readCodingPlan,
  readFinalRound,
  roundLabel,
  saveCodingPlan,
  setFinalRound,
} from "../apps/daemon/src/round.ts";

test("最后一轮有明确文案", () => {
  assert.equal(roundLabel(true), "最后一轮");
  assert.equal(roundLabel(false), "不是最后一轮");
  assert.equal(roundLabel(null), "");
});

test("计划未完成时不是最后一轮，做完最后一项才是", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["改协议", "改门禁", "改面板"]);

  const first = applyIntent(db, "repo", "s1", { claimedFinal: true, step: 1 });
  assert.equal(first?.finalRound, false);
  assert.equal(first?.corrected, true);
  assert.equal(displayFinalRound(db, "repo", "s1"), false);
  advancePlanStep(db, "repo", "s1");

  const second = applyIntent(db, "repo", "s2", { claimedFinal: false, step: 2 });
  assert.equal(second?.finalRound, false);
  assert.equal(second?.corrected, false);
  assert.equal(displayFinalRound(db, "repo", "s2"), false);
  advancePlanStep(db, "repo", "s2");

  const third = applyIntent(db, "repo", "s3", { claimedFinal: true, step: 3 });
  assert.equal(third?.finalRound, true);
  assert.equal(third?.corrected, false);
  assert.equal(displayFinalRound(db, "repo", "s3"), true);
  assert.equal(planLabel(codingPlanSnapshot(db, "repo", "s3")), "计划 3/3：改面板");
  advancePlanStep(db, "repo", "s3");

  assert.equal(readCodingPlan(db, "repo")?.completed, 3);
  assert.equal(displayFinalRound(db, "repo", "s3"), true);
  assert.equal(displayFinalRound(db, "repo", "s1"), false);
});

test("不写步骤时按下一个未完成步骤判断", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["第一步", "最后一步"]);
  const opening = applyIntent(db, "repo", "s1", { claimedFinal: true });
  assert.equal(opening?.finalRound, false);
  assert.equal(opening?.stepIndex, 0);
  advancePlanStep(db, "repo", "s1");

  const closing = applyIntent(db, "repo", "s2", { claimedFinal: false });
  assert.equal(closing?.finalRound, true);
  assert.equal(closing?.corrected, true);
  assert.equal(closing?.stepIndex, 1);
  assert.equal(displayFinalRound(db, "repo", "s2"), true);
});

test("跳到最后一项但前面没做完，不能标成最后一轮", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["一步", "二步", "三步"]);
  const jumped = applyIntent(db, "repo", "s3", { claimedFinal: true, step: 3 });
  assert.equal(jumped?.finalRound, false);
  assert.equal(jumped?.corrected, true);
  advancePlanStep(db, "repo", "s3");
  assert.equal(readCodingPlan(db, "repo")?.completed, 0);
  assert.equal(displayFinalRound(db, "repo", "s3"), false);
});

test("只有一步的计划，这一轮就是最后一轮", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["只做这一处"]);
  const only = applyIntent(db, "repo", "s1", { claimedFinal: false, step: 1 });
  assert.equal(only?.finalRound, true);
  assert.equal(only?.corrected, true);
  assert.equal(displayFinalRound(db, "repo", "s1"), true);
});

test("没有计划时不能标成最后一轮", () => {
  const db = memory();
  const claimed = applyIntent(db, "repo", "s1", { claimedFinal: true });
  assert.equal(claimed?.finalRound, false);
  assert.equal(claimed?.corrected, true);
  assert.equal(displayFinalRound(db, "repo", "s1"), false);
  assert.equal(readFinalRound(db, "s1"), false);

  const quiet = applyIntent(db, "repo", "s2", { claimedFinal: false });
  assert.equal(quiet?.finalRound, false);
  assert.equal(quiet?.corrected, false);
  assert.equal(applyIntent(db, "repo", "s3", {}), null);
  assert.equal(displayFinalRound(db, "repo", "s3"), null);
});

test("没有计划的旧标记仍可读，登记计划后不再把它当成最后一轮", () => {
  const db = memory();
  db.exec("CREATE TABLE slice_rounds (slice_id TEXT PRIMARY KEY, final INTEGER NOT NULL)");
  db.prepare("INSERT INTO slice_rounds (slice_id, final) VALUES (?, ?)").run("old", 1);
  assert.equal(readFinalRound(db, "old"), true);
  assert.equal(displayFinalRound(db, "repo", "old"), true);

  setFinalRound(db, "older", true);
  assert.equal(displayFinalRound(db, "repo", "older"), true);

  saveCodingPlan(db, "repo", ["新的一步", "收尾"]);
  assert.equal(displayFinalRound(db, "repo", "old"), false);
  assert.equal(readFinalRound(db, "old"), true);
});

test("同一轮重复完成不会把进度往后推", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["一步", "二步"]);
  applyIntent(db, "repo", "s1", { claimedFinal: false, step: 1 });
  advancePlanStep(db, "repo", "s1");
  advancePlanStep(db, "repo", "s1");
  assert.equal(readCodingPlan(db, "repo")?.completed, 1);

  applyIntent(db, "repo", "again", { claimedFinal: true, step: 1 });
  advancePlanStep(db, "repo", "again");
  assert.equal(readCodingPlan(db, "repo")?.completed, 1);
  assert.equal(displayFinalRound(db, "repo", "again"), false);
});

test("重新登记计划会从头开始", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["一步", "二步"]);
  applyIntent(db, "repo", "s1", { step: 1 });
  advancePlanStep(db, "repo", "s1");
  const replaced = saveCodingPlan(db, "repo", [" 只剩收尾 ", ""]);
  assert.deepEqual(replaced.steps, ["只剩收尾"]);
  assert.equal(replaced.completed, 0);
  assert.equal(displayFinalRound(db, "repo", "s1"), false);
  const closing = applyIntent(db, "repo", "s2", { claimedFinal: false });
  assert.equal(closing?.finalRound, true);
  assert.equal(displayFinalRound(db, "repo", "s2"), true);
});

test("空计划不能登记", () => {
  const db = memory();
  assert.throws(() => saveCodingPlan(db, "repo", ["  ", ""]), /至少要有一步/);
});

test("步骤超出计划范围时不是最后一轮", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["一步"]);
  const missed = applyIntent(db, "repo", "s9", { claimedFinal: true, step: 9 });
  assert.equal(missed?.finalRound, false);
  assert.equal(missed?.stepIndex, null);
  advancePlanStep(db, "repo", "s9");
  assert.equal(readCodingPlan(db, "repo")?.completed, 0);
});

test("计划文案带上当前步骤", () => {
  const db = memory();
  saveCodingPlan(db, "repo", ["改协议", "改面板"]);
  applyIntent(db, "repo", "s1", { step: 1 });
  assert.equal(planLabel(codingPlanSnapshot(db, "repo", "s1")), "计划 1/2：改协议");
  assert.equal(planLabel(null), "");
});

test("intend 参数能读出步骤和最后一轮上报", () => {
  assert.deepEqual(parseIntendArgs(["改面板", "--final"]), { purpose: "改面板", final: true });
  assert.deepEqual(parseIntendArgs(["--step", "2", "--final", "改", "面板"]), { purpose: "改 面板", final: true, step: 2 });
  assert.deepEqual(parsePlanSteps([" 一步 ", "", "二步"]), ["一步", "二步"]);
  assert.throws(() => parseIntendArgs(["--step"]), /从 1 开始/);
  assert.throws(() => parseIntendArgs(["--step", "0"]), /从 1 开始/);
  assert.throws(() => parseIntendArgs(["--step", "x"]), /从 1 开始/);
});

function memory(): DatabaseSync {
  return new DatabaseSync(":memory:");
}
