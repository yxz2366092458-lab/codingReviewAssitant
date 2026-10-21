import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PATH_KEYS = ["path", "file_path", "target_file", "target_notebook"];

export function hookProjectDir(payload: Record<string, unknown>, fallback = process.cwd()): string {
  const bases = candidateBases(payload);
  for (const filePath of editedPaths(payload)) {
    const absolute = toAbsolute(filePath, bases);
    const dir = absolute ? existingDir(absolute) : null;
    if (dir && !isCursorConfig(dir)) return dir;
  }
  for (const base of bases) {
    if (!isCursorConfig(base) && existingDir(base)) return base;
  }
  return fallback;
}

function candidateBases(payload: Record<string, unknown>): string[] {
  const input = inputOf(payload);
  const values = [payload.cwd, input.working_directory, input.cwd];
  if (Array.isArray(payload.workspace_roots)) values.push(...payload.workspace_roots);
  const found: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) continue;
    found.push(value.trim());
  }
  return found;
}

function editedPaths(payload: Record<string, unknown>): string[] {
  const input = inputOf(payload);
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  }
  if (Array.isArray(input.file_paths)) {
    for (const item of input.file_paths) {
      if (typeof item === "string" && item.trim()) paths.push(item.trim());
    }
  }
  return paths;
}

function inputOf(payload: Record<string, unknown>): Record<string, unknown> {
  const input = payload.tool_input ?? payload.input;
  if (!input || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

function toAbsolute(filePath: string, bases: string[]): string | null {
  if (isAbsolute(filePath)) return filePath;
  const base = bases.find((item) => !isCursorConfig(item));
  if (!base) return null;
  return resolve(base, filePath);
}

function existingDir(filePath: string): string | null {
  let current = filePath;
  for (let i = 0; i < 32; i += 1) {
    if (existsSync(current)) {
      try {
        return statSync(current).isDirectory() ? current : dirname(current);
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isCursorConfig(dir: string): boolean {
  return resolve(dir) === resolve(join(homedir(), ".cursor"));
}
