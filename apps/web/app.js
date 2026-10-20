const boot = window.__REVIEW__;
const state = {
  repoId: "",
  repos: [],
  scope: "slice",
  mode: "unified",
  symbol: null,
  identifier: "",
  fileId: "",
  files: [],
  sliceId: "",
  historyPage: 1,
  locations: [],
  source: "",
  signature: "",
  picked: [],
  anchor: "",
  explainThreads: [],
  drafts: {},
  viewSession: "",
  loadedExplainSession: "",
  sessions: [],
};

let events = null;

const labels = {
  locked: "锁定",
  awaiting_release: "待放行",
  editing: "编辑中",
  awaiting_review: "待核对",
  approved: "核对通过",
  rejected: "退回",
};

function gateLabel(gate) {
  if (gate.lease === "revert") return "待撤回";
  if (gate.phase === "requirement" && gate.state === "awaiting_release") return "待需求准入";
  if (gate.phase === "development" && gate.state === "awaiting_release") return "待开发";
  if (gate.phase === "development" && gate.state === "editing") return "开发中";
  return labels[gate.state];
}

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${boot.token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

async function bootRepo() {
  const repo = await api("/repos", { method: "POST", body: JSON.stringify({ path: boot.repoPath }) });
  state.repoId = repo.repoId;
  state.repos = await api("/repos");
  renderRepoSelect();
  $("repo-select").addEventListener("change", () => {
    void switchRepo($("repo-select").value).catch(showError);
  });
  $("pick-repo").addEventListener("click", () => void pickRepo().catch(showError));
  $("register-repo").addEventListener("click", () => void registerRepo().catch(showError));
  $("repo-path").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void registerRepo().catch(showError);
  });
  connect();
  await refresh();
  setInterval(() => void refresh().catch(showError), 1500);
}

function folderName(repoPath) {
  return repoPath.split("/").filter(Boolean).pop() || repoPath;
}

function repoLabel(repo, repos) {
  const name = folderName(repo.path);
  const same = repos.filter((item) => folderName(item.path) === name);
  if (same.length < 2) return name;
  const parts = repo.path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function renderWorkBranches(status) {
  $("requirement-branch").textContent = status.requirement || "未建立";
  $("development-branch").textContent = status.development || "未建立";
}

function shownBranches(status) {
  if (state.scope === "session" && state.viewSession) {
    const viewing = state.sessions.find((item) => item.sessionId === state.viewSession);
    if (viewing) return viewing;
  }
  return status;
}

function renderRepoSelect() {
  const select = $("repo-select");
  select.replaceChildren();
  for (const repo of state.repos) {
    const option = document.createElement("option");
    option.value = repo.id;
    option.textContent = repoLabel(repo, state.repos);
    option.title = repo.path;
    select.append(option);
  }
  select.value = state.repoId;
  const current = state.repos.find((repo) => repo.id === state.repoId);
  $("repo-name").textContent = current ? folderName(current.path) : "代码评审";
}

async function pickRepo() {
  showNotice("正在打开本机文件夹选择框。");
  const picked = await api("/repos/pick-path", { method: "POST", body: "{}" });
  $("repo-path").value = picked.path;
  showNotice("已选中路径，可以登记。");
}

async function registerRepo() {
  const path = $("repo-path").value.trim();
  if (!path) {
    showNotice("请填写要登记的工程路径。");
    return;
  }
  const registered = await api("/repos", { method: "POST", body: JSON.stringify({ path }) });
  $("repo-path").value = "";
  state.repos = await api("/repos");
  const same = registered.repoId === state.repoId;
  state.repoId = registered.repoId;
  renderRepoSelect();
  if (!same) resetView();
  await refresh();
  showNotice("工程已登记，当前查看这一项。");
}

async function switchRepo(repoId) {
  if (!repoId || repoId === state.repoId) return;
  state.repoId = repoId;
  resetView();
  renderRepoSelect();
  await refresh();
}

function resetView() {
  state.fileId = "";
  state.sliceId = "";
  state.historyPage = 1;
  state.signature = "";
  state.locations = [];
  state.source = "";
  state.picked = [];
  state.anchor = "";
  state.explainThreads = [];
  state.drafts = {};
  state.viewSession = "";
  state.loadedExplainSession = "";
  state.sessions = [];
  $("source").hidden = true;
  $("diff").replaceChildren();
  connect();
}

function connect() {
  if (events) {
    events.onmessage = null;
    events.close();
  }
  events = new WebSocket(`ws://127.0.0.1:${location.port}/repos/${state.repoId}/events?token=${boot.token}`);
  events.addEventListener("message", () => void refresh().catch(showError));
}

function diffQuery() {
  const params = new URLSearchParams();
  params.set("scope", state.scope);
  if (state.sliceId && state.scope === "slice") params.set("sliceId", state.sliceId);
  if (state.scope === "session" && state.viewSession) params.set("sessionId", state.viewSession);
  return params.toString();
}

function activeSessionId(sessions) {
  if (state.scope === "session" && state.viewSession) return state.viewSession;
  return sessions.current || "";
}

let refreshRunning = false;
let refreshQueued = false;

async function refresh() {
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }
  refreshRunning = true;
  try {
    do {
      refreshQueued = false;
      await loadPanel();
    } while (refreshQueued);
  } finally {
    refreshRunning = false;
  }
}

async function loadPanel() {
  const [status, gate, diff, slices, sessionPage] = await Promise.all([
    api(`/repos/${state.repoId}/status`),
    api(`/repos/${state.repoId}/gate`),
    api(`/repos/${state.repoId}/diff?${diffQuery()}`),
    api(`/repos/${state.repoId}/slices?page=${state.historyPage}`),
    api(`/repos/${state.repoId}/sessions`),
  ]);
  state.sessions = sessionPage.sessions ?? [];
  const active = activeSessionId(sessionPage);
  const signature = JSON.stringify({
    gate: gate.state,
    lease: gate.lease,
    purpose: gate.slice?.purpose,
    finalRound: gate.finalRound,
    phase: gate.phase,
    files: (diff.files ?? []).map((file) => `${file.fileId}:${file.summary ?? ""}`),
    scope: state.scope,
    mode: state.mode,
    requirement: status.requirement,
    development: status.development,
    historyPage: slices.page,
    history: (slices.items ?? []).map((slice) => `${slice.sliceId}:${slice.state}`).join(","),
    sessions: state.sessions.map((item) => `${item.sessionId}:${item.current}`).join(","),
    active,
    fileId: state.fileId,
    symbol: state.symbol,
    locations: state.locations.map((item) => `${item.path}:${item.line}`),
  });
  if (signature === state.signature) return;
  if (active !== state.loadedExplainSession) {
    const thread = await api(`/repos/${state.repoId}/explain?sessionId=${encodeURIComponent(active)}`);
    state.explainThreads = thread.threads ?? [];
    state.loadedExplainSession = active;
  }
  state.signature = signature;
  renderSessions(active);
  renderWorkBranches(shownBranches(status));
  $("gate-label").textContent = gateLabel(gate);
  document.querySelectorAll("[data-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scope === state.scope);
  });
  state.files = diff.files ?? [];
  renderSummary(gate);
  renderFiles(diff.files ?? []);
  renderHistory(slices);
  if (!state.fileId && diff.files?.[0]) state.fileId = diff.files[0].fileId;
  if (state.fileId && (diff.files ?? []).some((file) => file.fileId === state.fileId)) await renderPatch();
  else {
    $("diff").replaceChildren();
    $("viewbar").replaceChildren();
    showFileHead(emptyDiffText(gate), "");
  }
}

function renderSummary(gate) {
  const slice = gate.slice;
  $("meta").textContent = slice ? `${slice.agent} · ${slice.createdAt.slice(11, 16)}` : "";
  $("purpose").textContent = slice?.purpose ?? "等待 Agent 登记这一小段的作用。";
  const round = $("round-label");
  round.hidden = gate.finalRound !== true && gate.finalRound !== false;
  round.textContent = gate.finalRound === true ? "最后一轮" : gate.finalRound === false ? "不是最后一轮" : "";
  round.classList.toggle("final", gate.finalRound === true);
  const phase = $("phase-label");
  phase.hidden = gate.phase !== "requirement" && gate.phase !== "development";
  phase.textContent = gate.phase === "requirement" ? "需求准入" : gate.phase === "development" ? "开发过程" : "";
  phase.classList.toggle("development", gate.phase === "development");
  const wrap = $("decision-wrap");
  const decisions = $("decisions");
  decisions.replaceChildren();
  const show = gate.state === "awaiting_release" || gate.state === "awaiting_review";
  wrap.hidden = !show;
  if (!show || !slice) return;
  const primary = gate.state !== "awaiting_release" ? "核对通过" : gate.phase === "requirement" ? "需求准入" : "放行";
  decisions.append(decision(primary, () => act(gate.state === "awaiting_release" ? "release" : "ack", slice.sliceId)));
  decisions.append(decision("退回", () => act("reject", slice.sliceId)));
  const banner = $("banner");
  banner.hidden = !(slice.mismatch || gate.lease === "revert");
  banner.textContent = gate.lease === "revert"
    ? "已退回。Agent 现在只能撤回这一提交。"
    : slice.mismatch
      ? "提交说明和作用说明不一致。核对或退回后才能开始下一段。"
      : "";
}

function decision(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "decision";
  button.textContent = label;
  button.addEventListener("click", () => void onClick().catch(showError));
  return button;
}

async function act(name, sliceId) {
  const reason = name === "reject" ? window.prompt("退回原因", "") ?? "" : "";
  if (name === "reject" && reason === null) return;
  await api(`/repos/${state.repoId}/gate/${name}`, {
    method: "POST",
    body: JSON.stringify({ sliceId, reason }),
  });
  state.sliceId = "";
  await refresh();
}

function showFileHead(pathText, summary) {
  $("file-path").textContent = pathText;
  const node = $("file-summary");
  node.hidden = !summary;
  node.textContent = summary;
}

function renderFiles(files) {
  const aside = $("files");
  aside.replaceChildren();
  if (files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "这一范围没有文件差异。";
    aside.append(empty);
    return;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = `file${file.fileId === state.fileId ? " selected" : ""}`;
    const name = document.createElement("span");
    name.textContent = file.path.split("/").pop();
    const stat = document.createElement("small");
    stat.textContent = `+${file.additions} -${file.deletions}`;
    row.append(name, stat);
    row.addEventListener("click", () => {
      state.fileId = file.fileId;
      state.source = "";
      state.picked = [];
      state.anchor = "";
      $("source").hidden = true;
      void refresh().catch(showError);
    });
    aside.append(row);
  }
}

async function renderPatch() {
  const patch = await api(`/repos/${state.repoId}/files/${state.fileId}/patch?${diffQuery()}`);
  const file = state.files.find((item) => item.fileId === state.fileId);
  showFileHead(patch.truncated ? `${patch.path} · 补丁过大，只保留清单` : patch.path, file?.summary ?? "");
  renderViewbar();
  const diff = $("diff");
  diff.replaceChildren();
  if (state.mode === "unified") diff.append(unified(patch));
  else diff.append(split(patch));
  paintPicked();
  placeExplainBars();
}

function renderViewbar() {
  const bar = $("viewbar");
  bar.className = "viewbar";
  bar.replaceChildren();
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = "查看";
  const row = document.createElement("div");
  row.className = "row";
  row.append(
    viewButton("单文件", state.mode === "unified", () => { state.mode = "unified"; }),
    viewButton("双文件", state.mode === "split", () => { state.mode = "split"; }),
    viewButton("定义", state.symbol === "definition", () => void symbols("definition")),
    viewButton("引用", state.symbol === "references", () => void symbols("references")),
  );
  bar.append(kicker, row);
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "点行号多选，Shift 连选。连续选区的正下方展开解释栏，一个文件里可以有多条。";
  bar.append(hint);
  const box = $("locations");
  box.replaceChildren();
  for (const item of state.locations) {
    const link = document.createElement("span");
    link.className = "loc";
    link.textContent = `${item.path}:${item.line}`;
    link.title = item.preview;
    link.addEventListener("click", (event) => {
      if (!event.metaKey) return;
      event.preventDefault();
      void openLocation(item);
    });
    box.append(link);
  }
}

function viewButton(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.classList.toggle("active", active);
  button.addEventListener("click", () => void Promise.resolve(onClick()).catch(showError));
  return button;
}

function unified(patch) {
  const frag = document.createDocumentFragment();
  for (const hunk of patch.hunks ?? []) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const side = line.type === "del" ? "base" : "head";
      const shown = line.type === "del" ? oldLine : newLine;
      frag.append(lineRow(line.text, line.type, shown, null, side, patch.path));
      if (line.type !== "add") oldLine += 1;
      if (line.type !== "del") newLine += 1;
    }
  }
  return frag;
}

function split(patch) {
  const left = document.createElement("div");
  const right = document.createElement("div");
  left.className = "split-col";
  right.className = "split-col";
  const title = (text) => {
    const node = document.createElement("div");
    node.className = "file-head";
    node.textContent = text;
    return node;
  };
  left.append(title("基准"));
  right.append(title("改后"));
  for (const hunk of patch.hunks ?? []) {
    const removed = [];
    const added = [];
    const flush = () => {
      const count = Math.max(removed.length, added.length);
      for (let index = 0; index < count; index += 1) {
        left.append(lineRow(removed[index]?.text ?? "", removed[index] ? "del" : "context", removed[index]?.line ?? "", null, "base", patch.path));
        right.append(lineRow(added[index]?.text ?? "", added[index] ? "add" : "context", added[index]?.line ?? "", null, "head", patch.path));
      }
      removed.length = 0;
      added.length = 0;
    };
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === "context") {
        flush();
        left.append(lineRow(line.text, "context", oldLine, null, "base", patch.path));
        right.append(lineRow(line.text, "context", newLine, null, "head", patch.path));
        oldLine += 1;
        newLine += 1;
      } else if (line.type === "del") {
        removed.push({ text: line.text, line: oldLine });
        oldLine += 1;
      } else {
        added.push({ text: line.text, line: newLine });
        newLine += 1;
      }
    }
    flush();
  }
  const wrap = document.createElement("div");
  wrap.className = "split";
  wrap.append(left, right);
  return wrap;
}

function lineRow(text, type, primary, secondary, side, path) {
  const row = document.createElement("div");
  row.className = `line ${type === "context" ? "" : type}`;
  row.dataset.line = String(primary);
  row.dataset.side = side;
  row.dataset.path = path;
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = primary === "" ? "" : String(primary);
  const code = document.createElement("span");
  code.textContent = text || " ";
  if (secondary !== null) {
    const oldNum = document.createElement("span");
    oldNum.className = "num";
    oldNum.textContent = "";
    row.append(oldNum);
  }
  if (primary !== "") {
    num.title = "点选，Shift 连选";
    num.addEventListener("click", (event) => pickLine(event, row));
  }
  row.append(num, code);
  return row;
}

function lineKey(row) {
  return `${row.dataset.path}\0${row.dataset.side}\0${row.dataset.line}`;
}

function pickLine(event, row) {
  event.preventDefault();
  event.stopPropagation();
  if (!row.dataset.line) return;
  const key = lineKey(row);
  if (event.shiftKey && state.anchor) {
    const rows = [...document.querySelectorAll(`#diff .line[data-side="${row.dataset.side}"]`)].filter((item) => item.dataset.line);
    const start = rows.findIndex((item) => lineKey(item) === state.anchor);
    const end = rows.findIndex((item) => lineKey(item) === key);
    if (start >= 0 && end >= 0) {
      const [from, to] = start < end ? [start, end] : [end, start];
      state.picked = rows.slice(from, to + 1).map(lineKey);
    }
  } else if (state.picked.includes(key)) {
    state.picked = state.picked.filter((item) => item !== key);
  } else {
    state.picked = [...state.picked, key];
  }
  state.anchor = key;
  paintPicked();
  placeExplainBars();
}

function paintPicked() {
  for (const row of document.querySelectorAll("#diff .line")) {
    row.classList.toggle("picked", state.picked.includes(lineKey(row)));
  }
}

function selectedLines() {
  return [...document.querySelectorAll("#diff .line")]
    .filter((row) => state.picked.includes(lineKey(row)))
    .map((row) => ({
      path: row.dataset.path,
      side: row.dataset.side,
      line: Number(row.dataset.line),
      text: row.querySelector("span:last-child")?.textContent ?? "",
    }));
}

function anchorKey(anchor) {
  return `${anchor.path}\0${anchor.side}\0${anchor.start}\0${anchor.end}`;
}

function contiguousGroups(lines) {
  const buckets = new Map();
  for (const line of lines) {
    const key = `${line.path}\0${line.side}`;
    const list = buckets.get(key) ?? [];
    list.push(line);
    buckets.set(key, list);
  }
  const groups = [];
  for (const list of buckets.values()) {
    list.sort((left, right) => left.line - right.line);
    let current = [];
    const push = () => {
      if (!current.length) return;
      groups.push({
        path: current[0].path,
        side: current[0].side,
        start: current[0].line,
        end: current[current.length - 1].line,
        lines: current,
      });
    };
    for (const line of list) {
      const previous = current[current.length - 1];
      if (previous && line.line > previous.line + 1) {
        push();
        current = [];
      }
      if (!previous || line.line !== previous.line) current.push(line);
    }
    push();
  }
  return groups;
}

function linesBetween(anchor) {
  return [...document.querySelectorAll("#diff .line")]
    .filter((row) => row.dataset.path === anchor.path && row.dataset.side === anchor.side)
    .map((row) => ({
      path: row.dataset.path,
      side: row.dataset.side,
      line: Number(row.dataset.line),
      text: row.querySelector("span:last-child")?.textContent ?? "",
    }))
    .filter((line) => line.line >= anchor.start && line.line <= anchor.end);
}

function placeExplainBars() {
  for (const dock of document.querySelectorAll("#diff .inline-comment")) {
    const box = dock.querySelector("textarea");
    if (box) state.drafts[dock.dataset.anchor] = box.value;
    dock.remove();
  }
  const bars = new Map();
  for (const thread of state.explainThreads) {
    if (!thread.path) continue;
    bars.set(anchorKey(thread), { ...thread, lines: thread.lines ?? [] });
  }
  for (const group of contiguousGroups(selectedLines())) {
    const key = anchorKey(group);
    const existing = bars.get(key) ?? { ...group, turns: [] };
    existing.lines = group.lines;
    bars.set(key, existing);
  }
  for (const group of bars.values()) {
    const row = [...document.querySelectorAll("#diff .line")].find((item) => item.dataset.path === group.path && item.dataset.side === group.side && Number(item.dataset.line) === group.end);
    if (row) row.after(explainDock(group));
  }
}

function explainDock(group) {
  const key = anchorKey(group);
  const dock = document.createElement("div");
  dock.className = "inline-comment";
  dock.dataset.anchor = key;
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = group.start === group.end ? `第 ${group.start} 行` : `第 ${group.start}–${group.end} 行`;
  dock.append(kicker);
  for (const turn of group.turns ?? []) {
    const item = document.createElement("p");
    item.className = turn.role === "assistant" ? "explain" : "ask";
    item.textContent = turn.content;
    dock.append(item);
  }
  const text = document.createElement("textarea");
  text.rows = 2;
  text.placeholder = "评论这些代码。留空则直接解释作用。";
  text.value = state.drafts[key] ?? "";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "解释";
  button.addEventListener("click", () => void sendComment(group, text, button).catch(showError));
  dock.append(text, button);
  return dock;
}

async function sendComment(group, text, button) {
  const lines = group.lines?.length ? group.lines : linesBetween(group);
  if (!lines.length) {
    showNotice("先点行号选中要评论的代码。");
    return;
  }
  button.disabled = true;
  showNotice("正在让这个会话解释选中的代码。");
  try {
    const result = await api(`/repos/${state.repoId}/explain`, {
      method: "POST",
      body: JSON.stringify({
        lines,
        comment: text.value,
        sessionId: state.loadedExplainSession,
        anchor: { path: group.path, side: group.side, start: group.start, end: group.end },
      }),
    });
    const anchor = result.anchor ?? group;
    const key = anchorKey(anchor);
    state.explainThreads = state.explainThreads.filter((item) => anchorKey(item) !== key);
    state.explainThreads.push({ path: anchor.path, side: anchor.side, start: anchor.start, end: anchor.end, turns: result.turns ?? [] });
    if (result.sessionId) state.loadedExplainSession = result.sessionId;
    delete state.drafts[key];
    showNotice("");
    placeExplainBars();
  } finally {
    button.disabled = false;
  }
}

async function symbols(kind) {
  state.symbol = state.symbol === kind ? null : kind;
  state.locations = [];
  if (state.symbol) {
    if (!state.identifier) throw new Error("先在差异里点一个函数或对象名");
    const result = await api(`/repos/${state.repoId}/symbols?kind=${kind}&identifier=${encodeURIComponent(state.identifier)}`);
    state.locations = result.items ?? [];
  }
  await refresh();
}

async function openLocation(item) {
  const files = [...document.querySelectorAll(".file span")].map((node) => node.textContent);
  if (files.includes(item.path.split("/").pop()) && $( "diff").querySelector(`[data-path$="${item.path}"][data-line="${item.line}"]`)) {
    const target = $("diff").querySelector(`[data-line="${item.line}"]`);
    target?.scrollIntoView({ block: "center" });
    return;
  }
  const source = await api(`/repos/${state.repoId}/source?path=${encodeURIComponent(item.path)}&line=${item.line}`);
  state.source = source.text;
  const box = $("source");
  box.hidden = false;
  box.textContent = `${source.path}:${source.line}\n${source.text}`;
}

function identifierFrom(event) {
  const row = event.target.closest?.(".line");
  if (!row) return "";
  const text = row.querySelector("span:last-child")?.textContent ?? "";
  let offset = 0;
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && row.contains(range.startContainer)) offset = range.startOffset;
  const match = [...text.matchAll(/[A-Za-z_$][\w$]*/g)].find((item) => offset >= item.index && offset <= item.index + item[0].length);
  return match?.[0] ?? [...text.matchAll(/[A-Za-z_$][\w$]*/g)].at(-1)?.[0] ?? "";
}

function renderSessions(active) {
  const box = $("sessions");
  box.replaceChildren();
  if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有可以回看的会话。";
    box.append(empty);
    return;
  }
  for (const item of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.current ? `${item.development} · 当前` : item.development;
    button.title = item.sessionId;
    button.classList.toggle("active", item.sessionId === active);
    button.addEventListener("click", () => openSession(item));
    box.append(button);
  }
}

function emptyDiffText(gate) {
  if (state.scope === "session") return "这个会话没有文件差异。";
  if (gate.state !== "awaiting_release") return "";
  return gate.phase === "requirement" ? "还没有差异。需求准入之后才会出现这一段的代码。" : "还没有差异。放行之后才会出现这一段的代码。";
}

function openSession(item) {
  state.viewSession = item.current ? "" : item.sessionId;
  state.scope = item.current ? "slice" : "session";
  state.sliceId = "";
  state.fileId = "";
  state.picked = [];
  state.anchor = "";
  state.signature = "";
  renderSessions(item.sessionId);
  if (!item.current) renderWorkBranches(item);
  $("diff").replaceChildren();
  $("viewbar").replaceChildren();
  showFileHead(item.current ? "" : "正在打开这个会话的差异。", "");
  void refresh().catch(showError);
}

function renderHistory(page) {
  const slices = page.items ?? [];
  const pageSize = page.pageSize || 10;
  const total = page.total ?? slices.length;
  const current = page.page || 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const body = $("history");
  body.replaceChildren();
  for (const slice of slices) {
    const row = document.createElement("tr");
    row.dataset.slice = slice.sliceId;
    for (const value of [slice.createdAt.slice(0, 16).replace("T", " "), slice.purpose, labels[slice.state] ?? slice.state]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    row.addEventListener("click", () => {
      state.sliceId = slice.sliceId;
      state.scope = "slice";
      state.viewSession = "";
      state.fileId = "";
      state.signature = "";
      void refresh().catch(showError);
    });
    body.append(row);
  }
  const pager = $("history-pager");
  pager.replaceChildren();
  pager.append(
    pageButton("上一页", current <= 1, () => {
      state.historyPage = current - 1;
      state.signature = "";
      void refresh().catch(showError);
    }),
    pageLabel(`${current} / ${pages}，共 ${total} 条`),
    pageButton("下一页", current >= pages, () => {
      state.historyPage = current + 1;
      state.signature = "";
      void refresh().catch(showError);
    }),
  );
}

function pageButton(text, disabled, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function pageLabel(text) {
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = text;
  return label;
}

function showNotice(text) {
  const node = $("notice");
  node.hidden = !text;
  node.textContent = text;
}

function showError(error) {
  showNotice(error instanceof Error ? error.message : String(error));
}

document.addEventListener("click", (event) => {
  const scope = event.target.closest?.("[data-scope]");
  if (scope) {
    state.scope = scope.dataset.scope;
    state.sliceId = "";
    state.fileId = "";
    state.viewSession = "";
    state.picked = [];
    state.anchor = "";
    state.signature = "";
    void refresh().catch(showError);
    return;
  }
  if (event.target.closest?.("#install")) {
    event.preventDefault();
    if (!state.repoId) {
      showNotice("仓库还没有登记成功，请刷新页面后再安装。");
      return;
    }
    void api(`/repos/${state.repoId}/gate/install`, { method: "POST", body: "{}" })
      .then(() => {
        showNotice("门禁已写入这个仓库。请新开一个 Agent 对话，放行前的写文件才会被拦住。");
      })
      .catch(showError);
    return;
  }
  const word = identifierFrom(event);
  if (!word) return;
  state.identifier = word;
  if (!event.metaKey) return;
  event.preventDefault();
  void api(`/repos/${state.repoId}/symbols?kind=implementation&identifier=${encodeURIComponent(word)}`)
    .then(async (result) => {
      const items = result.items ?? [];
      if (items.length === 1) return openLocation(items[0]);
      state.symbol = "implementation";
      state.locations = items;
      if (items.length === 0) throw new Error(`没有找到 ${word} 的实现`);
      renderViewbar();
    })
    .catch(showError);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Meta") document.body.classList.add("cmd");
});
window.addEventListener("keyup", (event) => {
  if (event.key === "Meta") document.body.classList.remove("cmd");
});
window.addEventListener("blur", () => document.body.classList.remove("cmd"));

void bootRepo().catch(showError);
