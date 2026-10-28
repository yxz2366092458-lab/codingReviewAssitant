import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const MAX_BYTES = 2_000_000;

export type LocalFileText = {
  path: string;
  total: number;
  from: number;
  to: number;
  lines: string[];
  missing: boolean;
  binary: boolean;
  tooLarge: boolean;
};

export function readLocalLines(root: string, filePath: string, from = 1, to = 0): LocalFileText {
  const full = inside(root, filePath);
  let size = 0;
  try {
    size = statSync(full).size;
  } catch {
    return blank(filePath, { missing: true });
  }
  if (size > MAX_BYTES) return blank(filePath, { tooLarge: true });
  let buf: Buffer;
  try {
    buf = readFileSync(full);
  } catch {
    return blank(filePath, { missing: true });
  }
  if (buf.includes(0)) return blank(filePath, { binary: true });
  const text = buf.toString("utf8");
  const all = text.split("\n");
  if (text.endsWith("\n")) all.pop();
  const total = all.length;
  const start = Math.floor(from);
  const begin = Number.isFinite(start) && start > 0 ? start : 1;
  if (total === 0 || begin > total) {
    return { ...blank(filePath), total, from: begin, to: begin > total ? begin - 1 : 0 };
  }
  const endRaw = Math.floor(to);
  const end = Number.isFinite(endRaw) && endRaw > 0 ? Math.min(endRaw, total) : total;
  if (end < begin) return { ...blank(filePath), total, from: begin, to: begin - 1 };
  return {
    path: filePath,
    total,
    from: begin,
    to: end,
    lines: all.slice(begin - 1, end).map((line) => line.replace(/\r$/, "")),
    missing: false,
    binary: false,
    tooLarge: false,
  };
}

function blank(path: string, flags: Partial<Pick<LocalFileText, "missing" | "binary" | "tooLarge">> = {}): LocalFileText {
  return {
    path,
    total: 0,
    from: 0,
    to: 0,
    lines: [],
    missing: flags.missing === true,
    binary: flags.binary === true,
    tooLarge: flags.tooLarge === true,
  };
}

function inside(root: string, filePath: string): string {
  const full = resolve(root, filePath);
  const rel = relative(root, full);
  if (!filePath.trim() || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("路径超出仓库");
  return full;
}
