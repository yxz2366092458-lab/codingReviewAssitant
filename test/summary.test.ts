import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFile } from "../apps/daemon/src/summary.ts";
import { summaryPrompt, responseText } from "../apps/daemon/src/summary-ai.ts";

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

test("交给 AI 的提示按位置要求写清改前改后", () => {
  const prompt = summaryPrompt(file, "@@ summarizeFile\n-旧\n+新\n");
  assert.match(prompt, /位置：文件名/);
  assert.match(prompt, /原来是……，现在改成……/);
  assert.match(prompt, /文件：apps\/daemon\/src\/summary.ts/);
  assert.match(prompt, /状态：修改/);
});

test("从模型响应里取出总结正文", () => {
  const text = responseText({
    output: [{ content: [{ text: "位置：summary.ts 的 summarizeFile。\n改法：原来返回旧文案，现在改成新文案。" }] }],
  });
  assert.match(text, /位置：summary.ts/);
});
