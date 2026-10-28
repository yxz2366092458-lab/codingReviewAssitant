import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../apps/daemon/src/server.ts";

test("另一条分支编辑中时，当前分支的写入仍然拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-branch-gate-"));
  const home = mkdtempSync(join(tmpdir(), "review-branch-gate-home-"));
  process.env.REVIEW_HOME = home;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Review",
    GIT_AUTHOR_EMAIL: "review@local",
    GIT_COMMITTER_NAME: "Review",
    GIT_COMMITTER_EMAIL: "review@local",
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  git(["init", "-b", "feature-a"]);
  writeFileSync(join(root, "readme.txt"), "base\n");
  git(["add", "readme.txt"]);
  git(["commit", "-m", "init"]);
  const server = await startServer({ repoPath: root, open: false });
  try {
    const repo = await call(server, "POST", "/repos", { path: root });
    const opened = await call(server, "POST", `/repos/${repo.repoId}/gate/intent`, {
      purpose: "改功能甲",
      agent: "test",
    });
    assert.equal(opened.state, "awaiting_release");
    await call(server, "POST", `/repos/${repo.repoId}/gate/release`, { sliceId: opened.slice.sliceId });
    const allowed = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/a.ts" },
    });
    assert.equal(allowed.permission, "allow");
    git(["checkout", "-b", "feature-b"]);
    const denied = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/b.ts" },
    });
    assert.equal(denied.permission, "deny");
    const other = await call(server, "POST", `/repos/${repo.repoId}/gate/intent`, {
      purpose: "改功能乙",
      agent: "test",
    });
    assert.equal(other.state, "awaiting_release");
    assert.notEqual(other.slice.sliceId, opened.slice.sliceId);
    const stillDenied = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/b.ts" },
    });
    assert.equal(stillDenied.permission, "deny");
    git(["checkout", "feature-a"]);
    const back = await call(server, "POST", `/repos/${repo.repoId}/gate/check`, {
      tool_name: "Write",
      tool_input: { path: "src/a.ts" },
    });
    assert.equal(back.permission, "allow");
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
