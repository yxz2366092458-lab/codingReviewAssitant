import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFile } from "../apps/daemon/src/summary.ts";

test("一个文件总结成一句话", () => {
  const text = summarizeFile({
    fileId: "a",
    path: "apps/web/app.js",
    oldPath: null,
    status: "M",
    additions: 8,
    deletions: 1,
    binary: false,
  });
  assert.equal(text, "app.js这次修改，增加 8 行，删除 1 行。");
});
