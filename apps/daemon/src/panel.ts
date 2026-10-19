import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const source = join(root, "apps/mac/Panel.swift");
const binary = join(root, "mac/代码评审.app/Contents/MacOS/panel");

export function openPanel(url: string): void {
  ensurePanelBinary();
  const child = spawn(binary, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function ensurePanelBinary(): void {
  if (!existsSync(source)) return;
  const stale = !existsSync(binary) || statSync(source).mtimeMs > statSync(binary).mtimeMs;
  if (!stale) return;
  execFileSync("swiftc", ["-O", "-framework", "Cocoa", "-framework", "WebKit", "-o", binary, source], {
    stdio: "ignore",
  });
}
