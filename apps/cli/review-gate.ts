#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const home = process.env.REVIEW_HOME ?? join(homedir(), "Library/Application Support/CodingReviewAssistant");
const infoPath = join(home, "daemon.json");
const [command, ...rest] = process.argv.slice(2);

if (!existsSync(infoPath)) {
  process.stderr.write("评审服务没有运行。先在仓库目录执行 npm start。\n");
  process.exit(1);
}
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const root = git(["rev-parse", "--show-toplevel"]).trim();

if (command === "check-tool") {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const result = await call("POST", `/repos/${await repoId()}/gate/check`, payload);
  const denied = result.permission === "deny";
  process.stdout.write(JSON.stringify({
    permission: result.permission,
    user_message: denied ? result.message : "",
    agent_message: denied ? result.message : "",
  }));
  process.exit(denied ? 2 : 0);
}

if (command === "start") {
  const name = rest.join(" ").trim();
  const pair = await call("POST", `/repos/${await repoId()}/work-branches`, { name });
  process.stdout.write(`${pair.requirement}\n${pair.development}\n`);
  process.exit(0);
}

if (command === "intend") {
  const final = rest.includes("--final");
  const purpose = rest.filter((part) => part !== "--final").join(" ").trim();
  const view = await call("POST", `/repos/${await repoId()}/gate/intent`, {
    agent: process.env.REVIEW_AGENT ?? "agent",
    purpose,
    final,
  });
  process.stdout.write(`${view.slice?.sliceId ?? ""}\n${view.state}\n`);
  process.exit(0);
}

if (command === "wait") {
  const sliceId = rest[0] || "";
  const view = await call("GET", `/repos/${await repoId()}/gate/wait${sliceId ? `?sliceId=${sliceId}` : ""}`);
  process.stdout.write(`${view.state}\n`);
  process.exit(view.state === "editing" ? 0 : 1);
}

if (command === "complete") {
  const view = await call("POST", `/repos/${await repoId()}/gate/complete`, {});
  process.stdout.write(`${view.state}\n`);
  if (view.finalRound === true || !view.slice?.sliceId) process.exit(0);
  const settled = await callOptional("GET", `/repos/${await repoId()}/gate/settle?sliceId=${view.slice.sliceId}`);
  if (!settled) process.exit(0);
  if (settled.state === "approved") {
    process.stdout.write("继续下一轮\n");
    process.exit(0);
  }
  process.stdout.write(`${settled.state}\n`);
  process.exit(1);
}

process.stderr.write("用法：review-gate start \"需求名\" | intend \"作用\" [--final] | wait | complete | check-tool\n");
process.exit(1);

async function repoId() {
  const registered = await call("POST", "/repos", { path: root });
  return registered.repoId;
}

async function call(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    process.stderr.write(`${payload.error ?? "请求失败"}\n`);
    process.exit(1);
  }
  return payload;
}

async function callOptional(method, path) {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
  });
  if (response.status === 404) return null;
  const payload = await response.json();
  if (!response.ok) {
    process.stderr.write(`${payload.error ?? "请求失败"}\n`);
    process.exit(1);
  }
  return payload;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
