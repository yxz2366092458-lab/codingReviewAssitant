import type { FileChange, FileStatus } from "../../../packages/protocol/src/index.ts";

const statusLabel: Record<FileStatus, string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名",
};

export function summarizeFile(file: FileChange): string {
  const name = file.path.split("/").filter(Boolean).pop() ?? file.path;
  if (file.binary) return `${name}是二进制文件，这次${statusLabel[file.status]}。`;
  return `${name}这次${statusLabel[file.status]}，增加 ${file.additions} 行，删除 ${file.deletions} 行。`;
}
