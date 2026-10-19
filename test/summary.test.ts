import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFile } from "../apps/daemon/src/summary.ts";

const file = {
  fileId: "a",
  path: "apps/daemon/src/summary.ts",
  oldPath: null,
  status: "M" as const,
  additions: 1,
  deletions: 1,
  binary: false,
};

test("总结写出改了哪个功能", () => {
  const text = summarizeFile(file, `@@ -10,3 +10,4 @@ export function summarizeFile
 export function summarizeFile(file) {
-  return "这次只报增删行数";
+  return "说明这次改了什么功能";
 }
`);
  assert.equal(text, "summary.ts修改了summarizeFile，功能是把这次只报增删行数改成说明这次改了什么功能。");
});
