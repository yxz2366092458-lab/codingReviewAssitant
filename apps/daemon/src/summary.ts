import type { FileChange, FileStatus } from "../../../packages/protocol/src/index.ts";

const statusVerb: Record<FileStatus, string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名并修改",
};

export function summarizeFile(file: FileChange, patch = ""): string {
  const name = file.path.split("/").filter(Boolean).pop() ?? file.path;
  if (file.binary) return `${name}是二进制文件，这次${statusVerb[file.status]}。`;
  if (file.status === "D") return `删除了${name}。`;
  const hunks = readHunks(patch);
  const added = hunks.flatMap((hunk) => hunk.added);
  const removed = hunks.flatMap((hunk) => hunk.removed);
  const functions = unique([
    ...hunks.flatMap((hunk) => headingNames(hunk.heading)),
    ...declarations(added),
    ...declarations(removed),
  ]).slice(0, 3);
  const feature = featureClause(added, removed);
  const verb = statusVerb[file.status];
  const where = functions.length ? `${verb}了${functions.join("、")}` : `${verb}了内容`;
  if (feature) return `${name}${where}，功能是${feature}。`;
  return `${name}${where}。`;
}

function readHunks(patch: string): Array<{ heading: string; added: string[]; removed: string[] }> {
  const hunks: Array<{ heading: string; added: string[]; removed: string[] }> = [];
  let current: { heading: string; added: string[]; removed: string[] } | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ .*@@(.*)$/.exec(line);
    if (header) {
      current = { heading: (header[1] ?? "").trim(), added: [], removed: [] };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1).trim());
    else if (line.startsWith("-")) current.removed.push(line.slice(1).trim());
  }
  return hunks;
}

function headingNames(heading: string): string[] {
  const match = heading.match(/(?:function|class)\s+(\w+)/) ?? heading.match(/(\w+)\s*\(/);
  return match?.[1] ? [match[1]] : [];
}

function declarations(lines: string[]): string[] {
  const names: string[] = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /(?:export\s+)?class\s+(\w+)/,
    /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)/,
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match?.[1]) names.push(match[1]);
    }
  }
  return names;
}

function featureClause(added: string[], removed: string[]): string {
  const next = phrases(added);
  const prev = phrases(removed);
  if (prev[0] && next[0] && prev[0] !== next[0]) return `把${clip(prev[0])}改成${clip(next[0])}`;
  if (next[0]) return clip(next[0]);
  const created = unique(declarations(added)).filter((item) => !declarations(removed).includes(item));
  if (created.length) return `提供${created.join("、")}`;
  return "";
}

function phrases(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const comment = /\/\/\s*(.+)$/.exec(line);
    if (comment?.[1]) found.push(comment[1].trim());
    for (const match of line.matchAll(/["'`]([^"'`]{2,48})["'`]/g)) {
      if (/[\u4e00-\u9fff]/.test(match[1] ?? "")) found.push(match[1] ?? "");
    }
  }
  return found;
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, "");
  return clean.length > 28 ? `${clean.slice(0, 28)}…` : clean;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
