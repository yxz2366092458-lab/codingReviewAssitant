import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK_COMMAND = "./hooks/review-gate.sh";

export function installGate(cliPath: string, cursorDir = join(homedir(), ".cursor")): void {
  const hookDir = join(cursorDir, "hooks");
  mkdirSync(hookDir, { recursive: true });
  const script = join(hookDir, "review-gate.sh");
  writeFileSync(
    script,
    `#!/bin/bash
exec node --experimental-strip-types ${shellQuote(cliPath)} check-tool
`,
  );
  chmodSync(script, 0o755);
  mergeHooks(join(cursorDir, "hooks.json"));
}

function mergeHooks(file: string): void {
  const entry = { command: HOOK_COMMAND, failClosed: true };
  let json: { version?: number; hooks?: Record<string, Array<{ command?: string; failClosed?: boolean }>> } = {
    version: 1,
    hooks: {},
  };
  if (existsSync(file)) {
    json = JSON.parse(readFileSync(file, "utf8")) as typeof json;
  }
  json.version = 1;
  json.hooks ??= {};
  for (const event of ["preToolUse", "beforeShellExecution"]) {
    const list = json.hooks[event] ?? [];
    if (!list.some((item) => item.command === HOOK_COMMAND)) list.push(entry);
    json.hooks[event] = list;
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
