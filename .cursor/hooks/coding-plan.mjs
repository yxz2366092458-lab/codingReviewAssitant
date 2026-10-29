#!/usr/bin/env node

const context = [
  "评审门禁：写代码前必须先执行 review-gate plan，列出多步 coding 计划。",
  "每一轮用 review-gate intend \"作用\" --step N 报告当前步骤，并可用 --final 报告你认为这是不是最后一轮 coding。",
  "面板上的「是否最后一轮」以计划为准。计划不存在或还没做完时不会标成最后一轮；只有计划最后一项才会标成最后一轮。",
].join("");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks).toString("utf8").trim();
let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch {
  input = {};
}

const event = input.hook_event_name || (typeof input.command === "string" ? "beforeShellExecution" : "sessionStart");

if (event === "beforeShellExecution") {
  const command = String(input.command ?? "");
  let agentMessage = "";
  if (/review-gate(?:\.ts)?\s+intend\b/.test(command) && command.includes("--final")) {
    agentMessage = "是否最后一轮由已登记的 coding 计划决定。计划不存在或还没做完时，--final 不会标成最后一轮。";
  } else if (/review-gate(?:\.ts)?\s+intend\b/.test(command)) {
    agentMessage = "先用 review-gate plan 列出 coding 计划，再用 --step 指明这一轮是哪一步。未写 --step 时按下一个未完成步骤计。";
  } else if (/review-gate(?:\.ts)?\s+plan\b/.test(command)) {
    agentMessage = "登记 coding 计划后，每一轮 intend 要带上 --step。只有计划最后一项才会是最后一轮。";
  }
  process.stdout.write(JSON.stringify({
    permission: "allow",
    ...(agentMessage ? { agent_message: agentMessage } : {}),
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ additional_context: context }));
