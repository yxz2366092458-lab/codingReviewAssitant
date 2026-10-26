import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { recentFolderPaths } from "../apps/daemon/src/cursor-workspaces.ts";
import { startServer } from "../apps/daemon/src/server.ts";

test("只取最近打开的工程文件夹", () => {
  const paths = recentFolderPaths([
    { folderUri: "file:///Users/me/Desktop/product/product-portal" },
    { fileUri: "file:///Users/me/Desktop/product/product-portal/Readme.md" },
    { folderUri: "http://example.com/repo" },
    { folderUri: "file:///Users/me/Desktop/%E4%BA%A7%E5%93%81" },
  ]);
  assert.deepEqual(paths, ["/Users/me/Desktop/product/product-portal", "/Users/me/Desktop/产品"]);
});

test("启动时把 Cursor 最近打开的 Git 仓库登记进来", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-discover-host-"));
  const extra = mkdtempSync(join(tmpdir(), "review-discover-extra-"));
  const home = mkdtempSync(join(tmpdir(), "review-discover-home-"));
  const state = join(home, "state.vscdb");
  process.env.REVIEW_HOME = home;
  process.env.REVIEW_CURSOR_STATE = state;
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Review",
    GIT_AUTHOR_EMAIL: "review@local",
    GIT_COMMITTER_NAME: "Review",
    GIT_COMMITTER_EMAIL: "review@local",
  };
  const init = (cwd: string) => {
    execFileSync("git", ["init", "-b", "master"], { cwd, env: gitEnv });
    writeFileSync(join(cwd, "readme.txt"), "base\n");
    execFileSync("git", ["add", "readme.txt"], { cwd, env: gitEnv });
    execFileSync("git", ["commit", "-m", "init"], { cwd, env: gitEnv });
  };
  init(root);
  init(extra);
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: extra, encoding: "utf8" }).trim();
  const db = new DatabaseSync(state);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "history.recentlyOpenedPathsList",
    JSON.stringify({
      entries: [{ folderUri: pathToFileURL(extra).href }, { fileUri: pathToFileURL(join(extra, "readme.txt")).href }],
    }),
  );
  db.close();
  const server = await startServer({ repoPath: root, open: false, discoverWorkspaces: true });
  try {
    const repos = await call(server, "GET", "/repos");
    assert.equal(repos.some((repo: { path: string }) => repo.path === top), true);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.REVIEW_HOME;
    delete process.env.REVIEW_CURSOR_STATE;
  }
});

async function call(server: { url: string; token: string }, method: string, path: string) {
  const response = await fetch(`${server.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.token}` },
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}
