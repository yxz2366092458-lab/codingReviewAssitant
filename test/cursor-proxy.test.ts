import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentArgs, promptInput, startCursorProxy, useCursorProxy } from "../apps/daemon/src/cursor-proxy.ts";
import { completePrompt } from "../apps/daemon/src/summary-ai.ts";

test("从请求里取出要交给 Cursor 的原文", () => {
  assert.equal(promptInput({ input: " 解释这几行 " }), "解释这几行");
  assert.equal(promptInput({}), "");
  assert.equal(promptInput(null), "");
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
