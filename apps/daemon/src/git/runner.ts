import { execFile } from "node:child_process";
import { enqueueGit } from "./lock.ts";

const ALLOWED = new Set(["rev-parse", "merge-base", "status", "diff", "diff-index", "log", "show", "rev-list", "symbolic-ref"]);

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export function git(cwd: string, args: string[], timeout = 15000): Promise<string> {
  const sub = args[0];
  if (!sub || !ALLOWED.has(sub)) {
    return Promise.reject(new GitError(`git 子命令不在白名单：${sub ?? ""}`));
  }
  return enqueueGit(
    () =>
      new Promise((resolve, reject) => {
        execFile(
          "git",
          args,
          {
            cwd,
            timeout,
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, GIT_PAGER: "cat" },
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new GitError(stderr?.toString().trim() || error.message));
              return;
            }
            resolve(stdout.toString());
          },
        );
      }),
  );
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
