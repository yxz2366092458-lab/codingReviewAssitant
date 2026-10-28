import { resolve } from "node:path";
import { openPanel } from "./panel.ts";
import { startServer } from "./server.ts";
import { readDaemonInfo } from "./session/store.ts";

const args = process.argv.slice(2);
const repoFlag = args.indexOf("--repo");
const repoPath = resolve(repoFlag >= 0 ? args[repoFlag + 1] ?? "." : ".");
const open = !args.includes("--no-open");

const existing = readDaemonInfo();
if (existing && alive(existing.pid) && !args.includes("--force")) {
  const url = `http://127.0.0.1:${existing.port}/`;
  process.stdout.write(`${url}\n`);
  if (open) openPanel(url);
  process.exit(0);
}

const running = await startServer({ repoPath, open, discoverWorkspaces: true });
process.stdout.write(`${running.url}\n`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
