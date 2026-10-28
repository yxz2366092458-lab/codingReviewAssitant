import { execFile } from "node:child_process";
import { enqueueGit, retryOnIndexLock } from "./git/lock.ts";

export function assertBranchName(name: string): string {
  const branch = name.trim();
  if (!branch || branch.startsWith("-") || branch.includes("..") || /[\s\0]/.test(branch)) {
    throw new Error("分支名无效");
  }
  return branch;
}

export function startRef(branches: string[], fallback: string): string {
  return branches.includes("release") ? "release" : fallback;
}

function runGit(cwd: string, args: string[], timeout = 15000): Promise<string> {
  return enqueueGit(() => retryOnIndexLock(() => runGitOnce(cwd, args, timeout)));
}

function runGitOnce(cwd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout, env: { ...process.env, GIT_PAGER: "cat" } },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr?.toString() || stdout?.toString() || error.message).trim();
          reject(new Error(detail || "切换分支失败"));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

export async function listLocalBranches(cwd: string): Promise<string[]> {
  const text = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function listOriginBranches(cwd: string): Promise<string[]> {
  let text = "";
  try {
    text = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const ref = line.trim();
    if (!ref.startsWith("origin/") || ref === "origin/HEAD") continue;
    const name = ref.slice("origin/".length);
    if (!name) continue;
    names.push(name);
  }
  return names;
}

export async function fetchOrigin(cwd: string): Promise<void> {
  const remotes = (await runGit(cwd, ["remote"])).split("\n").map((line) => line.trim());
  if (!remotes.includes("origin")) return;
  await runGit(cwd, ["fetch", "--prune", "origin"], 60000);
}

export async function listBranchCandidates(
  cwd: string,
  refresh = false,
): Promise<{ branches: string[]; remoteOnly: string[] }> {
  if (refresh) await fetchOrigin(cwd);
  const local = await listLocalBranches(cwd);
  const present = new Set(local);
  const remoteOnly = (await listOriginBranches(cwd))
    .filter((name) => !present.has(name))
    .map((name) => `origin/${name}`);
  return { branches: [...local, ...remoteOnly], remoteOnly };
}

export async function trackOriginBranch(cwd: string, name: string): Promise<string> {
  const branch = assertBranchName(name.trim().replace(/^origin\//, ""));
  if ((await listLocalBranches(cwd)).includes(branch)) return branch;
  let remote = await listOriginBranches(cwd);
  if (!remote.includes(branch)) {
    await fetchOrigin(cwd);
    remote = await listOriginBranches(cwd);
  }
  if (!remote.includes(branch)) throw new Error("origin 上没有这个分支");
  await runGit(cwd, ["branch", "--track", branch, `origin/${branch}`]);
  return branch;
}

export async function materializeBranch(cwd: string, requested: string): Promise<string> {
  const trimmed = requested.trim();
  const localName = assertBranchName(trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed);
  if ((await listLocalBranches(cwd)).includes(localName)) return localName;
  return trackOriginBranch(cwd, localName);
}

export async function commitsAhead(cwd: string, ancestor: string, head: string): Promise<number | null> {
  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", ancestor, head]);
  } catch {
    return null;
  }
  const count = Number((await runGit(cwd, ["rev-list", "--count", `${ancestor}..${head}`])).trim());
  return Number.isFinite(count) ? count : null;
}

export async function commitTrackedEdits(cwd: string, message: string): Promise<boolean> {
  const porcelain = await runGit(cwd, ["status", "--porcelain"]);
  const tracked = porcelain.split("\n").filter((line) => line && !line.startsWith("??"));
  if (!tracked.length) return false;
  await runGit(cwd, ["add", "-u"]);
  await runGit(cwd, ["commit", "-m", message]);
  return true;
}

export async function checkoutBranch(cwd: string, name: string): Promise<void> {
  const branch = assertBranchName(name);
  const branches = await listLocalBranches(cwd);
  if (!branches.includes(branch)) throw new Error("没有这个本地分支");
  await runGit(cwd, ["switch", "--", branch]);
}

export async function createBranch(cwd: string, name: string, start: string): Promise<void> {
  const branch = assertBranchName(name);
  const point = assertBranchName(start);
  const branches = await listLocalBranches(cwd);
  if (branches.includes(branch)) return;
  await runGit(cwd, ["branch", branch, point]);
}

export async function renameBranch(cwd: string, from: string, to: string): Promise<void> {
  const source = assertBranchName(from);
  const target = assertBranchName(to);
  if (source === target) return;
  await runGit(cwd, ["branch", "-m", source, target]);
}

export async function mergeFastForward(cwd: string, target: string, source: string): Promise<void> {
  const into = assertBranchName(target);
  const from = assertBranchName(source);
  await commitTrackedEdits(cwd, "采纳评审评论中的修改。");
  const current = (await runGit(cwd, ["branch", "--show-current"])).trim();
  await runGit(cwd, ["switch", "--", into]);
  try {
    await runGit(cwd, ["merge", "--ff-only", from]);
  } finally {
    if (current) await runGit(cwd, ["switch", "--", current]);
  }
}

export async function mergeBranch(cwd: string, target: string, source: string): Promise<void> {
  const into = assertBranchName(target);
  const from = assertBranchName(source);
  if (into === from) return;
  const branches = await listLocalBranches(cwd);
  if (!branches.includes(into) || !branches.includes(from)) throw new Error("没有这个本地分支");
  await commitTrackedEdits(cwd, "采纳评审评论中的修改。");
  const current = (await runGit(cwd, ["branch", "--show-current"])).trim();
  await runGit(cwd, ["switch", "--", into]);
  let failed: unknown;
  try {
    await runGit(cwd, ["merge", "--no-edit", from]);
  } catch (error) {
    failed = error;
    await runGit(cwd, ["merge", "--abort"]).catch(() => undefined);
  } finally {
    if (current && current !== into) await runGit(cwd, ["switch", "--", current]);
  }
  if (failed) throw failed;
}
