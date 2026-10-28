import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installGate } from "../apps/daemon/src/adapters/install.ts";
import { hookProjectDir } from "../apps/daemon/src/hook-target.ts";

test("钩子按被编辑文件定位仓库，而不是用户钩子目录", () => {
  const project = mkdtempSync(join(tmpdir(), "review-hook-project-"));
  mkdirSync(join(project, "src"));
  const cursorHome = join(homedir(), ".cursor");
  const dir = hookProjectDir({
    cwd: cursorHome,
    workspace_roots: [cursorHome],
    tool_input: { path: join(project, "src", "New.java") },
  });
  assert.equal(dir, join(project, "src"));
});

test("没有文件路径时用工作区，不用用户钩子目录", () => {
  const project = mkdtempSync(join(tmpdir(), "review-hook-cwd-"));
  const dir = hookProjectDir({
    cwd: join(homedir(), ".cursor"),
    workspace_roots: [project],
    tool_input: { command: "git status" },
  });
  assert.equal(dir, project);
});

test("安装写到 Cursor 用户目录并保留已有钩子", () => {
  const cursorDir = mkdtempSync(join(tmpdir(), "review-cursor-"));
  writeFileSync(
    join(cursorDir, "hooks.json"),
    JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: "/usr/bin/git-ai" }] } }),
  );
  installGate("/tmp/review-gate.ts", cursorDir);
  const json = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")) as {
    hooks: { postToolUse: Array<{ command: string }>; preToolUse: Array<{ command: string }>; beforeShellExecution: Array<{ failClosed: boolean }> };
  };
  assert.equal(json.hooks.postToolUse[0]?.command, "/usr/bin/git-ai");
  assert.equal(json.hooks.preToolUse.at(-1)?.command, "./hooks/review-gate.sh");
  assert.equal(json.hooks.beforeShellExecution.at(-1)?.failClosed, true);
  const script = readFileSync(join(cursorDir, "hooks", "review-gate.sh"), "utf8");
  assert.match(script, /check-tool/);
  assert.match(script, /\/tmp\/review-gate\.ts/);
});
