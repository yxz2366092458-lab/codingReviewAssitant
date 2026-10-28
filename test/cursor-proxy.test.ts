import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentArgs, promptInput, readAgentRun, startCursorProxy, useCursorProxy } from "../apps/daemon/src/cursor-proxy.ts";
import { completePrompt, completeRun } from "../apps/daemon/src/summary-ai.ts";

test("从请求里取出要交给 Cursor 的原文", () => {
  assert.equal(promptInput({ input: " 解释这几行 " }), "解释这几行");
  assert.equal(promptInput({}), "");
  assert.equal(promptInput(null), "");
});

test("启动参数传给实际进程，评论修改不会被重新改成只读", () => {
  const source = readFileSync(new URL("../apps/daemon/src/cursor-proxy.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function runCursorAgent"));
  assert.match(body, /request\.args/);
  assert.equal(body.includes("agentArgs("), false);
});

test("要求修改时允许写入，并从流里取出未执行的写文件内容", () => {
  const args = agentArgs("/repo", "把这行改掉", true);
  assert.equal(args.includes("--force"), true);
  assert.equal(args.includes("stream-json"), true);
  assert.equal(args.includes("ask"), false);
  assert.equal(args.at(-1), "把这行改掉");
  const run = readAgentRun([
    JSON.stringify({ type: "assistant", message: { content: [{ text: "我会修改 a.ts" }] } }),
    JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "1", tool_call: { writeToolCall: { args: { path: "a.ts", fileText: "return 0;\n" }, result: { error: "未执行" } } } }),
    JSON.stringify({ type: "result", result: "已经改好了。" }),
  ].join("\n"));
  assert.equal(run.text, "已经改好了。");
  assert.equal(run.writes[0]?.applied, false);
  assert.equal(run.writes[0]?.contents, "return 0;\n");
  const applied = readAgentRun(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "2",
    tool_call: { writeToolCall: { args: { path: "a.ts", fileText: "return 1;\n" }, result: { success: { path: "/repo/a.ts" } } } },
  }));
  assert.equal(applied.writes[0]?.applied, true);
});

test("调用 Cursor agent 时信任工作区，只提问，不让它改文件", () => {
  const args = agentArgs("/repo", "说明这段代码");
  assert.equal(args.includes("--mode"), true);
  assert.equal(args.includes("ask"), true);
  assert.equal(args.includes("--trust"), true);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--yolo"), false);
  assert.equal(args.at(-1), "说明这段代码");
});

test("评论修改把工作区和写入参数交给本机 Cursor", async () => {
  const proxy = await startCursorProxy({
    repoPath: "/fallback",
    run: async ({ repoPath, prompt, args }) => {
      assert.equal(repoPath, "/work");
      assert.equal(prompt, "请改");
      assert.equal(args.includes("--force"), true);
      assert.equal(args.includes("stream-json"), true);
      assert.equal(args.includes("--workspace"), true);
      assert.equal(args.includes("/work"), true);
      assert.equal(args.includes("ask"), false);
      return "动作：修改\n说明：\n改成 0。\n代码：\nreturn 0;";
    },
  });
  useCursorProxy({ url: proxy.url, token: proxy.token });
  try {
    const run = await completeRun("请改", true, "/work");
    assert.equal(run.text, "动作：修改\n说明：\n改成 0。\n代码：\nreturn 0;");
    assert.deepEqual(run.writes, []);
  } finally {
    useCursorProxy(null);
    await proxy.close();
  }
});

test("解释和总结发给本机 Cursor 代理，不经过 dongcc", async () => {
  const source = readFileSync(new URL("../apps/daemon/src/summary-ai.ts", import.meta.url), "utf8");
  assert.equal(source.includes("dongcc"), false);
  assert.equal(source.includes("config.toml"), false);
  assert.equal(source.includes("8787"), false);
  const proxy = await startCursorProxy({
    repoPath: "/repo",
    run: async ({ prompt, args }) => {
      assert.equal(prompt, "hello");
      assert.equal(args.includes("--trust"), true);
      assert.equal(args.includes("--force"), false);
      assert.equal(args.includes("ask"), true);
      return "这是 Cursor 的说明";
    },
  });
  const endpoint = new URL(proxy.url);
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.notEqual(endpoint.port, "8787");
  useCursorProxy({ url: proxy.url, token: proxy.token });
  try {
    assert.equal(await completePrompt("hello"), "这是 Cursor 的说明");
  } finally {
    useCursorProxy(null);
    await proxy.close();
  }
});
