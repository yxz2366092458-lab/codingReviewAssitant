import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decide } from "../apps/daemon/src/gate/policy.ts";
import { startServer } from "../apps/daemon/src/server.ts";

test("登记 bugfix 需求后，锁定时也允许写入", async () => {
  const write = { tool: "Write", command: "", paths: ["src/pay.ts"], agent: "cursor" };
  assert.equal(decide(write, "locked", null, true).permission, "allow");
  assert.equal(decide(write, "awaiting_review", null, true).permission, "allow");
  assert.equal(decide({ ...write, paths: ["AGENTS.md"] }, "locked", null, true).permission, "deny");

  const root = mkdtempSync(join(tmpdir(), "review-bugfix-"));
  const home = mkdtempSync(join(tmpdir(), "review-bugfix-home-"));
  process.env.REVIEW_HOME = home;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Review",
    GIT_AUTHOR_EMAIL: "review@local",
    GIT_COMMITTER_NAME: "Review",
    GIT_COMMITTER_EMAIL: "review@local",
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  git(["init", "-b", "master"]);
  writeFileSync(join(root, "readme.txt"), "base\n");
  git(["add", "readme.txt"]);
  git(["commit", "-m", "init"]);
  const server = await startServer({ repoPath: root, open: false });
  try {
    const repo = await call(server, "POST", "/repos", { path: root });
    const denied = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/pay.ts" },
    });
    assert.equal(denied.permission, "deny");
    const opened = await call(server, "POST", `/repos/${repo.repoId}/gate/bugfix`, { purpose: "修复空指针" });
    assert.equal(opened.bugfix, "修复空指针");
    const allowed = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/pay.ts" },
    });
    assert.equal(allowed.permission, "allow");
    const gate = await call(server, "GET", `/repos/${repo.repoId}/gate`);
    assert.equal(gate.state, "locked");
    assert.equal(gate.bugfix, "修复空指针");
    const closed = await call(server, "POST", `/repos/${repo.repoId}/gate/bugfix`, { purpose: "  " });
    assert.equal(closed.bugfix, null);
    const blocked = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/pay.ts" },
    });
    assert.equal(blocked.permission, "deny");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.REVIEW_HOME;
  }
});

async function call(server: { url: string; token: string }, method: string, path: string, body?: unknown) {
  const response = await fetch(`${server.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}
