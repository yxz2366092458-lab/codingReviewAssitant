import assert from "node:assert/strict";
import test from "node:test";
import { roundLabel } from "../apps/daemon/src/round.ts";

test("最后一轮有明确文案", () => {
  assert.equal(roundLabel(true), "最后一轮");
  assert.equal(roundLabel(false), "不是最后一轮");
  assert.equal(roundLabel(null), "");
});
