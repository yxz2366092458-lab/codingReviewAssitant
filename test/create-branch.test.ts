import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../apps/daemon/src/server.ts";

test("按名字从基准提交创建本地分支，不切换当前检出", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-create-branch-"));
  const home = mkdtempSync(join(tmpdir(), "review-create-branch-home-"));
  process.env.REVIEW_HOME = home;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Review",
    GIT_AUTHOR_EMAIL: "review@local",
    GIT_COMMITTER_NAME: "Review",
    GIT_COMMITTER_EMAIL: "review@local",
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  git(["init", "-b", "main"]);
  writeFileSync(join(root, "readme.txt"), "base\n");
  git(["add", "readme.txt"]);
  git(["commit", "-m", "init"]);
  git(["branch", "release"]);
  writeFileSync(join(root, "readme.txt"), "later\n");
  git(["add", "readme.txt"]);
  git(["commit", "-m", "later"]);
  const server = await startServer({ repoPath: root, open: false });
  try {
    const repo = await call(server, "POST", "/repos", { path: root });
    const opened = await call(server, "POST", `/repos/${repo.repoId}/gate/intent`, {
      purpose: "选择合并目标",
      agent: "test",
    });
    assert.equal(opened.state, "awaiting_release");
    const checkedOut = git(["branch", "--show-current"]).trim();
    const created = await call(server, "POST", `/repos/${repo.repoId}/branches`, { name: "ship" });
    assert.equal(created.branch, "ship");
    assert.equal(git(["branch", "--show-current"]).trim(), checkedOut);
    assert.equal(git(["rev-parse", "ship"]).trim(), git(["rev-parse", "release"]).trim());
    assert.notEqual(git(["rev-parse", "ship"]).trim(), git(["rev-parse", "main"]).trim());
    const gate = await call(server, "GET", `/repos/${repo.repoId}/gate`);
    assert.equal(gate.state, "awaiting_release");
    const invalid = await call(server, "POST", `/repos/${repo.repoId}/branches`, { name: "bad name" }, false);
    assert.equal(invalid.status, 400);
    assert.equal(git(["branch", "--show-current"]).trim(), checkedOut);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.REVIEW_HOME;
  }
});

async function call(
  server: { url: string; token: string },
  method: string,
  path: string,
  body?: unknown,
  expectOk = true,
) {
  const response = await fetch(`${server.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!expectOk) return { status: response.status, ...payload };
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}
