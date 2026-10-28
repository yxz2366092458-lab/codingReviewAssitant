import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../apps/daemon/src/server.ts";

test("核对通过和需求准入都预填已绑定的合并目标", () => {
  const source = readFileSync(new URL("../apps/web/app.js", import.meta.url), "utf8");
  const uses = source.match(/fillBranches\(picker\.querySelector\("select"\), gate\.mergeTarget \|\| ""\)/g);
  assert.equal(uses?.length, 2);
  assert.match(source, /if \(result\.mergeNote\) showNotice\(result\.mergeNote\)/);
});

test("需求准入前没有合并目标就不能放行", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-merge-target-"));
  const home = mkdtempSync(join(tmpdir(), "review-merge-target-home-"));
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
  const server = await startServer({ repoPath: root, open: false });
  try {
    const repo = await call(server, "POST", "/repos", { path: root });
    const pair = await call(server, "POST", `/repos/${repo.repoId}/work-branches`, { name: "demo" });
    assert.equal(pair.development, "dev/demo");
    const opened = await call(server, "POST", `/repos/${repo.repoId}/gate/intent`, {
      purpose: "写下这条需求",
      agent: "test",
    });
    const blocked = await call(
      server,
      "POST",
      `/repos/${repo.repoId}/gate/release`,
      { sliceId: opened.slice.sliceId },
      false,
    );
    assert.equal(blocked.status, 409);
    const bound = await call(server, "POST", `/repos/${repo.repoId}/gate/target`, { branch: "release" });
    assert.equal(bound.mergeTarget, "release");
    const gate = await call(server, "GET", `/repos/${repo.repoId}/gate`);
    assert.equal(gate.phase, "requirement");
    assert.equal(gate.mergeTarget, "release");
    const released = await call(server, "POST", `/repos/${repo.repoId}/gate/release`, { sliceId: opened.slice.sliceId });
    assert.equal(released.state, "editing");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.REVIEW_HOME;
  }
});

test("切片分支没有需求会话时，核对通过不会合并其他会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-ack-unmatched-"));
  const home = mkdtempSync(join(tmpdir(), "review-ack-unmatched-home-"));
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
  const server = await startServer({ repoPath: root, open: false });
  try {
    const repo = await call(server, "POST", "/repos", { path: root });
    const older = await call(server, "POST", `/repos/${repo.repoId}/work-branches`, { name: "old" });
    assert.equal(older.development, "dev/old");
    const bound = await call(server, "POST", `/repos/${repo.repoId}/gate/target`, { branch: "release" });
    assert.equal(bound.mergeTarget, "release");
    writeFileSync(join(root, "old.txt"), "old\n");
    git(["add", "old.txt"]);
    git(["commit", "-m", "old session"]);
    git(["switch", "release"]);
    git(["switch", "-c", "feature-api"]);
    const purpose = "在接口分支上改一处";
    const opened = await call(server, "POST", `/repos/${repo.repoId}/gate/intent`, { purpose, agent: "test" });
    await call(server, "POST", `/repos/${repo.repoId}/gate/release`, { sliceId: opened.slice.sliceId });
    writeFileSync(join(root, "api.txt"), "api\n");
    git(["add", "api.txt"]);
    git(["commit", "-m", purpose]);
    const reviewed = await call(server, "POST", `/repos/${repo.repoId}/gate/complete`, {});
    assert.equal(reviewed.state, "awaiting_review");
    const sha = (name: string) => git(["rev-parse", name]);
    const before = {
      oldReq: sha("req/old"),
      oldDev: sha("dev/old"),
      release: sha("release"),
    };
    assert.notEqual(before.oldReq, before.oldDev);
    const gate = await call(server, "GET", `/repos/${repo.repoId}/gate?branch=${encodeURIComponent(older.development)}`);
    assert.equal(gate.mergeTarget, "release");
    const current = await call(server, "GET", `/repos/${repo.repoId}/gate`);
    assert.equal(current.mergeTarget, null);
    const status = await call(server, "GET", `/repos/${repo.repoId}/status`);
    assert.equal(status.branch, "feature-api");
    assert.equal(status.requirement, null);
    assert.equal(status.development, null);
    const acked = await call(server, "POST", `/repos/${repo.repoId}/gate/ack`, {
      sliceId: reviewed.slice.sliceId,
      branch: "release",
    });
    assert.equal(acked.state, "locked");
    assert.match(acked.mergeNote, /已将该分支合并到「release」/);
    assert.match(acked.mergeNote, /没有动其他会话/);
    assert.doesNotMatch(acked.mergeNote, /没有写入/);
    assert.equal(sha("req/old"), before.oldReq);
    assert.equal(sha("dev/old"), before.oldDev);
    assert.equal(sha("release"), sha("feature-api"));
    assert.equal(git(["branch", "--show-current"]).trim(), "feature-api");
    assert.match(git(["ls-tree", "-r", "--name-only", "release"]), /api\.txt/);
    assert.doesNotMatch(git(["ls-tree", "-r", "--name-only", "release"]), /old\.txt/);
    assert.doesNotMatch(git(["ls-tree", "-r", "--name-only", "req/old"]), /old\.txt/);
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
