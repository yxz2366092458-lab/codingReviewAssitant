import { execFile } from "node:child_process";

export function assertBranchName(name: string): string {
  const branch = name.trim();
  if (!branch || branch.startsWith("-") || branch.includes("..") || /[\s\0]/.test(branch)) {
    throw new Error("分支名无效");
  }
  return branch;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 15000, env: { ...process.env, GIT_PAGER: "cat" } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr?.toString() || error.message).trim() || "切换分支失败"));
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

export async function checkoutBranch(cwd: string, name: string): Promise<void> {
  const branch = assertBranchName(name);
  const branches = await listLocalBranches(cwd);
  if (!branches.includes(branch)) throw new Error("没有这个本地分支");
  await runGit(cwd, ["switch", "--", branch]);
}
