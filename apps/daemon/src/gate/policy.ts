import type { CheckResult, GateState, Lease } from "../../../../packages/protocol/src/index.ts";

const WRITE_TOOLS = new Set([
  "Write",
  "StrReplace",
  "Edit",
  "Delete",
  "NotebookEdit",
  "ApplyPatch",
  "EditNotebook",
  "MultiEdit",
  "WriteFile",
  "DeleteFile",
]);

const PROTECTED = [
  ".cursor/hooks.json",
  ".cursor/hooks/review-gate.sh",
  ".claude/settings.json",
  "AGENTS.md",
  "CLAUDE.md",
];

export type ToolCall = {
  tool: string;
  command: string;
  paths: string[];
  agent: string;
};

export function normalizeToolCall(raw: Record<string, unknown>): ToolCall {
  const tool = String(raw.tool_name ?? raw.tool ?? (raw.command ? "Shell" : ""));
  const command = String(raw.command ?? "");
  const input = (raw.tool_input ?? raw.input ?? {}) as Record<string, unknown>;
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "target_file", "target_notebook"]) {
    if (typeof input[key] === "string") paths.add(input[key]);
  }
  if (Array.isArray(input.file_paths)) {
    for (const item of input.file_paths) if (typeof item === "string") paths.add(item);
  }
  return { tool, command, paths: [...paths], agent: String(raw.agent ?? "cursor") };
}

export function decide(call: ToolCall, state: GateState, lease: Lease | null, bugfix = false): CheckResult {
  if (isReviewGate(call.command)) return { permission: "allow", message: "" };
  if (call.paths.some(isProtected)) {
    return { permission: "deny", message: "门禁文件只能由面板里的「安装门禁」写入。" };
  }

  const writing = isWrite(call);
  if (!writing) return { permission: "allow", message: "" };
  if (bugfix) return { permission: "allow", message: "" };

  if (state === "editing" && lease === "revert") {
    if (isRevertCommand(call.command)) return { permission: "allow", message: "" };
    return { permission: "deny", message: "这段已退回。现在只能撤回该提交，不能夹带新的修改。" };
  }

  if (state === "editing" && lease !== "revert") return { permission: "allow", message: "" };

  if (state === "awaiting_review") {
    return { permission: "deny", message: "这一段已经结束。等人核对通过后，再登记下一段。" };
  }
  return {
    permission: "deny",
    message: "门禁未放行。请先执行 review-gate intend，写明这一小段代码的作用，再执行 review-gate wait。",
  };
}

function isReviewGate(command: string): boolean {
  return /\breview-gate\b/.test(command);
}

function isProtected(filePath: string): boolean {
  const norm = filePath.replaceAll("\\", "/");
  return PROTECTED.some((item) => norm === item || norm.endsWith(`/${item}`));
}

function isWrite(call: ToolCall): boolean {
  if (WRITE_TOOLS.has(call.tool)) return true;
  if (/write|delete|apply.?patch/i.test(call.tool) && !/read/i.test(call.tool)) return true;
  if (!call.command) return false;
  if (/\bgit\s+(add|commit|checkout|restore|reset|apply|stash|rebase|merge|cherry-pick|switch|mv|rm|clean|am|revert)\b/.test(call.command)) {
    return true;
  }
  if (/\bsed\s+-[^\n]*\bi\b/.test(call.command) || /\btee\b/.test(call.command)) return true;
  if (/>>/.test(call.command)) return true;
  if (/(?<![&\d])>(?!&)/.test(call.command)) return true;
  return false;
}

function isRevertCommand(command: string): boolean {
  return /\bgit\s+(revert|reset)\b/.test(command);
}
