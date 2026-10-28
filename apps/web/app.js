import { layoutImpact } from "./impact-layout.js";

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
  explainThreads: [],
  explainOpen: {},
  explainFolded: {},
  pendingExplain: {},
  explainProgress: {},
  drafts: {},
  viewSession: "",
  viewBranch: "",
  loadedExplainSession: "",
  sessions: [],
  branchQuery: "",
  branchChoice: "",
  branchNames: [],
  appliedEdit: null,
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
  if (gate.bugfix) return "bugfix";
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
  $("bugfix-entry").addEventListener("submit", (event) => void submitBugfix(event).catch(showError));
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
  state.explainThreads = [];
  state.explainOpen = {};
  state.explainFolded = {};
  state.pendingExplain = {};
  state.explainProgress = {};
  state.drafts = {};
  state.viewSession = "";
  state.viewBranch = "";
  state.loadedExplainSession = "";
  state.sessions = [];
  state.branchQuery = "";
  state.branchChoice = "";
  state.branchNames = [];
  state.appliedEdit = null;
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
  events.addEventListener("message", (event) => {
    const payload = readEvent(event.data);
    if (payload?.type === "explain.progress") {
      showExplainProgress(payload);
      return;
    }
    void refresh().catch(showError);
  });
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

async function syncRepoList() {
  const repos = await api("/repos");
  const same =
    repos.length === state.repos.length &&
    repos.every((repo, index) => repo.id === state.repos[index]?.id && repo.path === state.repos[index]?.path);
  if (same) return;
  state.repos = repos;
  if (!repos.some((repo) => repo.id === state.repoId) && repos[0]) {
    state.repoId = repos[0].id;
    resetView();
  }
  renderRepoSelect();
}

async function loadPanel() {
  await syncRepoList();
  const gatePath = state.viewBranch
    ? `/repos/${state.repoId}/gate?branch=${encodeURIComponent(state.viewBranch)}`
    : `/repos/${state.repoId}/gate`;
  const [status, gate, diff, slices, sessionPage] = await Promise.all([
    api(`/repos/${state.repoId}/status`),
    api(gatePath),
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
    bugfix: gate.bugfix ?? "",
    files: (diff.files ?? []).map((file) => `${file.fileId}:${file.additions}:${file.deletions}:${file.status}:${file.summary ?? ""}`),
    scope: state.scope,
    mode: state.mode,
    requirement: status.requirement,
    development: status.development,
    mergeTarget: status.mergeTarget ?? gate.mergeTarget ?? "",
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
    try {
      const thread = await api(`/repos/${state.repoId}/explain?sessionId=${encodeURIComponent(active)}`);
      state.explainThreads = thread.threads ?? [];
      restoreExplainBubbles();
      state.loadedExplainSession = active;
      showNotice("");
    } catch (error) {
      showError(error);
    }
  }
  state.signature = signature;
  renderSessions(active);
  renderWorkBranches(shownBranches(status));
  $("merge-target").textContent = (state.viewBranch ? gate.mergeTarget : status.mergeTarget) || "未绑定";
  $("gate-label").textContent = gateLabel(gate);
  document.querySelectorAll("[data-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scope === state.scope);
  });
  state.files = diff.files ?? [];
  renderSummary(gate);
  renderBugfix(gate);
  renderFiles(diff.files ?? []);
  renderHistory(slices);
  if (!state.fileId && diff.files?.[0]) state.fileId = diff.files[0].fileId;
  if (state.mode === "impact") {
    await renderImpact();
    return;
  }
  if (state.fileId && (diff.files ?? []).some((file) => file.fileId === state.fileId)) await renderPatch();
  else {
    $("diff").replaceChildren();
    $("viewbar").replaceChildren();
    showFileHead(emptyDiffText(gate), "");
  }
}

function renderBugfix(gate) {
  const input = $("bugfix-purpose");
  const button = $("bugfix-open");
  const open = Boolean(gate.bugfix);
  button.dataset.mode = open ? "close" : "open";
  button.textContent = open ? "恢复门禁" : "跳过门禁";
  if (document.activeElement === input) return;
  input.value = gate.bugfix || "";
}

async function submitBugfix(event) {
  event.preventDefault();
  const closing = $("bugfix-open").dataset.mode === "close";
  const purpose = closing ? "" : $("bugfix-purpose").value.trim();
  if (!closing && !purpose) return;
  await api(`/repos/${state.repoId}/gate/bugfix`, {
    method: "POST",
    body: JSON.stringify({ purpose }),
  });
  $("bugfix-purpose").blur();
  await refresh();
}

function renderSummary(gate) {
  if (gate.bugfix) {
    $("meta").textContent = "门禁已跳过";
    $("purpose").textContent = gate.bugfix;
    $("round-label").hidden = true;
    $("phase-label").hidden = true;
    $("decision-wrap").hidden = true;
    $("banner").hidden = true;
    return;
  }
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
  const typingBranch = document.activeElement instanceof HTMLInputElement && document.activeElement.id === "branch-search";
  const branchCaret = typingBranch ? document.activeElement.selectionStart : null;
  decisions.replaceChildren();
  const show = gate.state === "awaiting_release" || gate.state === "awaiting_review";
  wrap.hidden = !show;
  if (!show || !slice) return;
  if (gate.state === "awaiting_review") {
    const picker = renderBranchPicker(typingBranch, branchCaret, "选择分支");
    decisions.append(picker);
    decisions.append(decision("核验通过", () => verify(slice.sliceId, picker.querySelector("select"))));
    void fillBranches(picker.querySelector("select")).catch(showError);
  } else if (gate.phase === "requirement") {
    const picker = renderBranchPicker(typingBranch, branchCaret, "合并目标");
    decisions.append(picker);
    decisions.append(decision("需求准入", () => admit(slice.sliceId, picker.querySelector("select"))));
    void fillBranches(picker.querySelector("select"), gate.mergeTarget || "").catch(showError)
  } else {
    decisions.append(decision("放行", () => act("release", slice.sliceId)));
  }
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

function renderBranchPicker(wasTyping, caret, emptyLabel = "选择分支") {
  const picker = document.createElement("div");
  picker.className = "branch-picker";
  const search = document.createElement("input");
  search.id = "branch-search";
  search.type = "search";
  search.placeholder = "搜索或新建分支";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.value = state.branchQuery;
  const select = document.createElement("select");
  select.dataset.emptyLabel = emptyLabel;
  select.addEventListener("change", () => {
    state.branchChoice = select.value;
  });
  search.addEventListener("input", () => {
    state.branchQuery = search.value;
    renderBranchOptions(select);
  });
  picker.append(search, select);
  renderBranchOptions(select);
  if (wasTyping) {
    search.focus();
    if (caret !== null) search.setSelectionRange(caret, caret);
  }
  return picker;
}

function renderBranchOptions(select) {
  const query = state.branchQuery.trim();
  const queryLower = query.toLowerCase();
  const chosen = state.branchChoice;
  const names = state.branchNames.filter((name) => name.toLowerCase().includes(queryLower));
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  const emptyLabel = select.dataset.emptyLabel || "选择分支";
  placeholder.textContent = query && names.length === 0 ? "没有匹配的分支" : emptyLabel;
  select.append(placeholder);
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  if (query && !state.branchNames.includes(query)) {
    const create = document.createElement("option");
    create.value = `__create__:${query}`;
    create.textContent = `新建分支 ${query}`;
    select.append(create);
  }
  if (names.includes(chosen) || chosen.startsWith("__create__:")) select.value = chosen;
  else select.value = "";
}

async function fillBranches(select, preferred = "") {
  const { branches } = await api(`/repos/${state.repoId}/branches`);
  if (!select?.isConnected) return;
  state.branchNames = branches ?? [];
  if (!state.branchChoice && preferred && state.branchNames.includes(preferred)) {
    state.branchChoice = preferred;
  }
  renderBranchOptions(select);
}

async function ensureBranch(select) {
  let branch = select.value.trim();
  if (branch.startsWith("__create__:")) branch = branch.slice("__create__:".length).trim();
  if (!branch && state.branchQuery.trim() && !state.branchNames.includes(state.branchQuery.trim())) {
    branch = state.branchQuery.trim();
  }
  if (!branch) return "";
  if (!state.branchNames.includes(branch)) {
    await api(`/repos/${state.repoId}/branches`, {
      method: "POST",
      body: JSON.stringify({ name: branch }),
    });
    state.branchNames = [...state.branchNames, branch];
    state.branchChoice = branch;
    state.branchQuery = branch;
    renderBranchOptions(select);
    select.value = branch;
  }
  return branch;
}

async function admit(sliceId, select) {
  const branch = await ensureBranch(select);
  if (!branch) {
    showNotice("需求准入前要先绑定合并目标分支。");
    return;
  }
  await api(`/repos/${state.repoId}/gate/target`, {
    method: "POST",
    body: JSON.stringify({ branch }),
  });
  state.branchChoice = "";
  state.branchQuery = "";
  await act("release", sliceId);
}

let verifying = false;

async function verify(sliceId, select) {
  if (verifying) return;
  verifying = true;
  select.disabled = true;
  for (const field of $("decisions").querySelectorAll("button, input, select")) field.disabled = true;
  try {
    const branch = await ensureBranch(select);
    if (!branch) {
      showNotice("请选择要合并过去的分支。");
      return;
    }
    await api(`/repos/${state.repoId}/gate/ack`, {
      method: "POST",
      body: JSON.stringify({ sliceId, branch }),
    });
    state.sliceId = "";
    state.branchChoice = "";
    state.branchQuery = "";
    await refresh();
  } finally {
    verifying = false;
    if (select.isConnected) {
      for (const field of $("decisions").querySelectorAll("button, input, select")) field.disabled = false;
    }
  }
}

function showFileHead(pathText, summary) {
  $("file-path").textContent = pathText;
  const node = $("file-summary");
  node.hidden = !summary;
  node.textContent = summary;
}

function classNameOf(path) {
  return path.split("/").filter(Boolean).pop() || path;
}

async function copyClassName(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = "已复制";
  setTimeout(() => {
    if (button.isConnected) button.textContent = "复制";
  }, 1200);
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
    const label = classNameOf(file.path);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = label;
    name.title = label;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-name";
    copy.textContent = "复制";
    copy.title = "复制类名";
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyClassName(label, copy);
    });
    const stat = document.createElement("small");
    stat.textContent = `+${file.additions} -${file.deletions}`;
    row.append(name, copy, stat);
    row.addEventListener("click", () => {
      state.fileId = file.fileId;
      state.source = "";
      state.picked = [];
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
  paintAppliedEdit();
  placeExplainBars();
}

const IMPACT_EDGE_LABEL = {
  imports: "导入",
  calls: "调用",
  depends_on: "依赖",
  tested_by: "测试",
  configures: "配置",
  middleware: "中间件",
  triggers: "触发",
  reads_from: "读取",
  writes_to: "写入",
  subscribes: "订阅",
  publishes: "发布",
};

async function renderImpact() {
  showFileHead("影响链", "方法挂在所属类下面，只保留直接连到改动的影响边。");
  renderViewbar();
  const diff = $("diff");
  diff.replaceChildren();
  try {
    diff.append(impactGraph(await api(`/repos/${state.repoId}/impact?${diffQuery()}`)));
  } catch (error) {
    diff.append(emptyNote(error instanceof Error ? error.message : "影响链没有画出来"));
  }
}

function impactGraph(chain) {
  const wrap = document.createElement("div");
  wrap.className = "impact";
  if (!chain.available) {
    wrap.append(emptyNote("这个仓库还没有知识图谱，影响链画不出来。"));
    return wrap;
  }
  const nodes = chain.nodes ?? [];
  const edges = chain.edges ?? [];
  if (!nodes.length) {
    wrap.append(emptyNote("当前差异在知识图谱里没有对应节点。"));
    return wrap;
  }
  const legend = document.createElement("p");
  legend.className = "impact-legend";
  legend.innerHTML = `<span><i class="changed"></i>改动</span><span><i class="affected"></i>受影响</span>`;
  wrap.append(legend);
  if (!edges.length) wrap.append(emptyNote("这些改动没有直接的影响边。"));
  wrap.append(impactSvg(nodes, edges));
  return wrap;
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = text;
  return note;
}

function impactSvg(nodes, edges) {
  const layout = layoutImpact(nodes, edges);
  const svg = svgEl("svg", {
    width: layout.width,
    height: layout.height,
    role: "img",
    "aria-label": "改动影响链",
  });
  const marker = svgEl("marker", { id: "impact-arrow", viewBox: "0 0 8 8", refX: "8", refY: "4", markerWidth: "8", markerHeight: "8", orient: "auto" });
  marker.append(svgEl("path", { d: "M0,0 L8,4 L0,8 Z" }));
  const defs = svgEl("defs", {});
  defs.append(marker);
  svg.append(defs);
  for (const route of layout.routes) {
    svg.append(svgEl("path", { d: route.trunk, class: "impact-edge" }));
    for (const d of route.branches) svg.append(svgEl("path", { d, class: "impact-edge", "marker-end": "url(#impact-arrow)" }));
  }
  for (const label of layout.labels) {
    const text = svgEl("text", { x: label.x, y: label.y, "text-anchor": "start", class: "impact-edge-label" });
    text.textContent = IMPACT_EDGE_LABEL[label.type] ?? label.type;
    svg.append(text);
  }
  for (const frame of layout.frames) {
    svg.append(moduleFrame(frame));
    for (const block of frame.blocks) {
      if (block.kind === "class") svg.append(classNode(block));
      const symbols = block.kind === "class" ? block.methods : [block];
      for (const child of symbols) svg.append(symbolNode(child));
    }
  }
  return svg;
}

function moduleFrame(frame) {
  const group = svgEl("g", {});
  group.append(svgEl("rect", {
    x: frame.x,
    y: frame.y,
    width: frame.w,
    height: frame.h,
    rx: "10",
    class: frame.changed ? "impact-module changed" : "impact-module",
  }));
  const name = svgEl("text", { x: frame.x + 12, y: frame.y + 22, class: "impact-name" });
  name.textContent = clipText(frame.head, 24);
  const path = svgEl("text", { x: frame.x + 12, y: frame.y + 36, class: "impact-path" });
  path.textContent = clipText(frame.path, 32);
  group.append(name, path);
  const title = svgEl("title", {});
  title.textContent = frame.file?.summary || frame.path || frame.head;
  group.append(title);
  return group;
}

function classNode(block) {
  const group = svgEl("g", {});
  group.append(svgEl("rect", {
    x: block.x,
    y: block.y,
    width: block.w,
    height: block.h,
    rx: "8",
    class: block.changed ? "impact-class changed" : "impact-class",
  }));
  const name = svgEl("text", { x: block.x + 10, y: block.y + 18, class: "impact-name" });
  name.textContent = clipText(block.node.name, 22);
  group.append(name);
  const title = svgEl("title", {});
  title.textContent = block.node.summary || block.node.name;
  group.append(title);
  return group;
}

function symbolNode(child) {
  const group = svgEl("g", { transform: `translate(${child.x} ${child.y})` });
  group.append(svgEl("rect", {
    width: child.w,
    height: child.h,
    rx: "6",
    class: child.node.role === "changed" ? "impact-node changed" : "impact-node",
  }));
  const name = svgEl("text", { x: "10", y: "21", class: "impact-name" });
  name.textContent = clipText(child.node.name, 24);
  group.append(name);
  const title = svgEl("title", {});
  title.textContent = child.node.summary || child.node.name;
  group.append(title);
  return group;
}

function clipText(text, max) {
  const value = text || "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function svgEl(name, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
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
    viewButton("单文件", state.mode === "unified", () => { state.mode = "unified"; return refresh(); }),
    viewButton("双文件", state.mode === "split", () => { state.mode = "split"; return refresh(); }),
    viewButton("影响链", state.mode === "impact", () => { state.mode = "impact"; return refresh(); }),
    viewButton("定义", state.symbol === "definition", () => void symbols("definition")),
    viewButton("引用", state.symbol === "references", () => void symbols("references")),
  );
  bar.append(kicker, row);
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = state.mode === "impact"
    ? "方法画在所属类里面。同一起点的边先并成一条，再按终点分开，平行的边之间留出间隔。"
    : "点行号多选，按住左键拖动同一侧的行。滑过已选中的行会取消选中。连续选区的正下方展开解释栏，一个文件里可以有多条。";
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
    num.title = "点选或拖动。滑过已选中的行会取消选中。";
    num.addEventListener("mousedown", (event) => startLineDrag(event, row));
    num.addEventListener("click", (event) => pickLine(event, row));
  }
  row.append(num, code);
  return row;
}

function lineKey(row) {
  return `${row.dataset.path}\0${row.dataset.side}\0${row.dataset.line}`;
}

let lineDrag = null;

function sideLines(row) {
  return [...document.querySelectorAll(`#diff .line[data-side="${row.dataset.side}"]`)].filter((item) => item.dataset.line && item.dataset.path === row.dataset.path);
}

function keysBetween(row, fromKey, toKey) {
  const rows = sideLines(row);
  const start = rows.findIndex((item) => lineKey(item) === fromKey);
  const end = rows.findIndex((item) => lineKey(item) === toKey);
  if (start < 0 || end < 0) return null;
  const [from, to] = start < end ? [start, end] : [end, start];
  return rows.slice(from, to + 1).map(lineKey);
}

function startLineDrag(event, row) {
  if (event.button !== 0) return;
  lineDrag = { origin: row, moved: false, base: [...state.picked] };
  document.body.classList.add("line-drag");
  event.preventDefault();
}

function moveLineDrag(event) {
  if (!lineDrag?.origin) return;
  if (event.buttons !== 1) {
    finishLineDrag();
    return;
  }
  const current = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".line");
  if (!current?.dataset.line) return;
  if (current.dataset.side !== lineDrag.origin.dataset.side || current.dataset.path !== lineDrag.origin.dataset.path) return;
  if (lineKey(current) === lineKey(lineDrag.origin) && !lineDrag.moved) return;
  const keys = keysBetween(lineDrag.origin, lineKey(lineDrag.origin), lineKey(current));
  if (!keys) return;
  lineDrag.moved = true;
  const range = new Set(keys);
  const base = new Set(lineDrag.base);
  state.picked = [
    ...lineDrag.base.filter((key) => !range.has(key)),
    ...keys.filter((key) => !base.has(key)),
  ];
  paintPicked();
}

function finishLineDrag() {
  if (!lineDrag) return;
  const moved = lineDrag.moved;
  lineDrag = null;
  document.body.classList.remove("line-drag");
  if (!moved) return;
  placeExplainBars();
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.removeEventListener("click", swallow, true);
  };
  document.addEventListener("click", swallow, true);
  setTimeout(() => document.removeEventListener("click", swallow, true), 0);
}

function pickLine(event, row) {
  event.preventDefault();
  event.stopPropagation();
  if (!row.dataset.line) return;
  const key = lineKey(row);
  if (state.picked.includes(key)) {
    state.picked = state.picked.filter((item) => item !== key);
  } else {
    state.picked = [...state.picked, key];
  }
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
    bars.set(anchorKey(thread), { ...thread, lines: thread.lines ?? [], modes: thread.modes ?? {} });
  }
  for (const group of contiguousGroups(selectedLines())) {
    const key = anchorKey(group);
    const existing = bars.get(key) ?? { ...group, turns: [], modes: {} };
    existing.lines = group.lines;
    existing.modes = existing.modes ?? {};
    bars.set(key, existing);
  }
  for (const group of bars.values()) {
    const row = [...document.querySelectorAll("#diff .line")].find((item) => item.dataset.path === group.path && item.dataset.side === group.side && Number(item.dataset.line) === group.end);
    if (row) row.after(explainDock(group));
  }
}

function explainDock(group) {
  const key = anchorKey(group);
  const folded = Boolean(state.explainFolded[key]);
  const dock = document.createElement("div");
  dock.className = folded ? "inline-comment folded" : "inline-comment";
  dock.dataset.anchor = key;
  const head = document.createElement("div");
  head.className = "explain-head";
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = group.start === group.end ? `第 ${group.start} 行` : `第 ${group.start}–${group.end} 行`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "explain-fold";
  toggle.textContent = folded ? "展开" : "收起";
  toggle.setAttribute("aria-expanded", String(!folded));
  toggle.addEventListener("click", () => {
    state.explainFolded[key] = !folded;
    placeExplainBars();
  });
  head.append(kicker, toggle);
  const body = document.createElement("div");
  body.className = "explain-body";
  for (const turn of group.turns ?? []) {
    const item = document.createElement("p");
    item.className = turn.role === "assistant" ? "explain" : "ask";
    item.textContent = turn.content;
    body.append(item);
  }
  const pending = state.pendingExplain[key];
  if (pending === "comment") body.append(explainPending(key));
  const text = document.createElement("textarea");
  text.rows = 2;
  text.placeholder = "写下对这段代码的评论。";
  text.value = state.drafts[key] ?? "";
  text.disabled = Boolean(pending);
  const comment = document.createElement("button");
  comment.type = "button";
  comment.textContent = "评论";
  comment.disabled = Boolean(pending);
  comment.addEventListener("click", () => void sendComment(group, text).catch(showError));
  const explain = document.createElement("button");
  explain.type = "button";
  explain.textContent = "解释";
  explain.disabled = Boolean(pending);
  explain.addEventListener("click", () => void openExplain(group).catch(showError));
  const actions = document.createElement("div");
  actions.className = "explain-actions";
  actions.append(comment, explain);
  body.append(text, actions);
  if (state.explainOpen[key]) body.append(explainBubble(group, state.explainOpen[key]));
  dock.append(head, body);
  return dock;
}

function explainBubble(group, mode) {
  const key = anchorKey(group);
  const bubble = document.createElement("div");
  bubble.className = "explain-bubble";
  const switcher = document.createElement("div");
  switcher.className = "explain-switch";
  for (const [value, label] of [["pseudo", "伪代码"], ["line", "按行解释"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.classList.toggle("active", mode === value);
    button.disabled = Boolean(state.pendingExplain[key]);
    button.addEventListener("click", () => void chooseExplain(group, value).catch(showError));
    switcher.append(button);
  }
  bubble.append(switcher);
  if (state.pendingExplain[key] === mode) bubble.append(explainPending(key));
  const content = group.modes?.[mode] || threadModes(key)?.[mode] || "";
  if (content) {
    const body = document.createElement("p");
    body.className = "explain";
    body.textContent = content;
    bubble.append(body);
  }
  return bubble;
}

function threadModes(key) {
  return state.explainThreads.find((item) => anchorKey(item) === key)?.modes;
}

function restoreExplainBubbles() {
  for (const thread of state.explainThreads) {
    const key = anchorKey(thread);
    if (state.explainOpen[key]) continue;
    if (thread.modes?.pseudo) state.explainOpen[key] = "pseudo";
    else if (thread.modes?.line) state.explainOpen[key] = "line";
  }
}

async function openExplain(group) {
  const key = anchorKey(group);
  if (!state.explainOpen[key]) state.explainOpen[key] = "pseudo";
  const mode = state.explainOpen[key];
  if (threadModes(key)?.[mode] || state.pendingExplain[key]) {
    placeExplainBars();
    return;
  }
  await requestExplain(group, mode);
}

async function chooseExplain(group, mode) {
  const key = anchorKey(group);
  if (state.pendingExplain[key]) return;
  state.explainOpen[key] = mode;
  if (threadModes(key)?.[mode]) {
    placeExplainBars();
    return;
  }
  await requestExplain(group, mode);
}

async function requestExplain(group, mode) {
  const lines = group.lines?.length ? group.lines : linesBetween(group);
  if (!lines.length) {
    showNotice("先点行号选中要解释的代码。");
    return;
  }
  const key = anchorKey(group);
  state.pendingExplain[key] = mode;
  state.explainProgress[key] = "正在回答";
  showNotice("正在回答");
  placeExplainBars();
  try {
    const result = await api(`/repos/${state.repoId}/explain`, {
      method: "POST",
      body: JSON.stringify({
        lines,
        mode,
        sessionId: state.loadedExplainSession,
        anchor: { path: group.path, side: group.side, start: group.start, end: group.end },
      }),
    });
    rememberThread(result, group);
    delete state.pendingExplain[key];
    delete state.explainProgress[key];
    placeExplainBars();
  } catch (error) {
    delete state.pendingExplain[key];
    delete state.explainProgress[key];
    placeExplainBars();
    throw error;
  }
}

function rememberThread(result, group) {
  const anchor = result.anchor ?? group;
  const anchorId = anchorKey(anchor);
  const current = state.explainThreads.find((item) => anchorKey(item) === anchorId);
  const modes = { ...(current?.modes ?? group.modes ?? {}) };
  if (result.modes) Object.assign(modes, result.modes);
  if (result.mode && result.reply) modes[result.mode] = result.reply;
  state.explainThreads = state.explainThreads.filter((item) => anchorKey(item) !== anchorId);
  state.explainThreads.push({
    path: anchor.path,
    side: anchor.side,
    start: anchor.start,
    end: anchor.end,
    turns: result.turns ?? current?.turns ?? [],
    modes,
  });
  if (result.sessionId) state.loadedExplainSession = result.sessionId;
}

function paintAppliedEdit() {
  const edit = state.appliedEdit;
  if (!edit?.path) return;
  const rows = [...document.querySelectorAll("#diff .line")].filter((row) => row.dataset.path === edit.path && row.dataset.side === "head");
  if (edit.code && edit.start) {
    const lines = String(edit.code).replace(/\s+$/, "").split("\n");
    const selected = rows.filter((row) => {
      const line = Number(row.dataset.line);
      return line >= edit.start && line <= edit.end;
    });
    selected.forEach((row, index) => {
      const code = row.querySelector("span:last-child");
      if (!code) return;
      if (index === selected.length - 1 && lines.length > selected.length) code.textContent = lines.slice(index).join("\n") || " ";
      else code.textContent = lines[index] ?? " ";
    });
  }
  const filePath = $("file-path");
  if (filePath.textContent.startsWith(edit.path) && !filePath.textContent.includes("已写入工作区")) {
    filePath.textContent = `${filePath.textContent} · 已写入工作区`;
  }
}

function explainPending(key) {
  const row = document.createElement("p");
  row.className = "explain-pending";
  const icon = document.createElement("span");
  icon.className = "spinner";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = state.explainProgress[key] || "正在回答";
  row.append(icon, label);
  return row;
}

function readEvent(data) {
  if (typeof data !== "string") return null;
  try {
    const payload = JSON.parse(data);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function showExplainProgress(payload) {
  if (payload.repoId && state.repoId && payload.repoId !== state.repoId) return;
  const key = anchorKey({
    path: payload.path,
    side: payload.side,
    start: Number(payload.start),
    end: Number(payload.end),
  });
  const text = String(payload.text || "");
  if (!text) return;
  if (!state.pendingExplain[key] && payload.phase !== "fail") return;
  state.explainProgress[key] = text;
  if (state.pendingExplain[key] || payload.phase === "fail") showNotice(text);
  placeExplainBars();
}

async function sendComment(group, text) {
  const lines = group.lines?.length ? group.lines : linesBetween(group);
  if (!lines.length) {
    showNotice("先点行号选中要评论的代码。");
    return;
  }
  const key = anchorKey(group);
  const comment = text.value.trim();
  if (!comment) {
    showNotice("先写下评论。");
    return;
  }
  state.drafts[key] = comment;
  state.pendingExplain[key] = "comment";
  state.explainProgress[key] = "正在理解评论";
  showNotice("正在理解评论");
  placeExplainBars();
  try {
    const result = await api(`/repos/${state.repoId}/explain`, {
      method: "POST",
      body: JSON.stringify({
        lines,
        comment,
        sessionId: state.loadedExplainSession,
        anchor: { path: group.path, side: group.side, start: group.start, end: group.end },
      }),
    });
    rememberThread(result, group);
    delete state.drafts[anchorKey(result.anchor ?? group)];
    delete state.pendingExplain[key];
    delete state.explainProgress[key];
    if (result.edited) {
      const written = result.edit?.path || group.path;
      state.appliedEdit = { path: written, start: 0, end: 0, code: "" };
      const notice = written ? `已写入 ${written}` : "已写入工作区";
      showNotice(notice);
      state.signature = "";
      await refresh();
      showNotice(notice);
    } else {
      placeExplainBars();
    }
  } catch (error) {
    delete state.pendingExplain[key];
    delete state.explainProgress[key];
    placeExplainBars();
    const message = error instanceof Error ? error.message : String(error);
    showNotice(message.startsWith("失败：") ? message : `失败：${message}`);
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
  state.viewBranch = item.current ? "" : item.development;
  state.scope = item.current ? "slice" : "session";
  state.sliceId = "";
  state.fileId = "";
  state.picked = [];
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
      state.viewBranch = "";
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

document.addEventListener("mousemove", moveLineDrag);
document.addEventListener("mouseup", finishLineDrag);

document.addEventListener("click", (event) => {
  const scope = event.target.closest?.("[data-scope]");
  if (scope) {
    state.scope = scope.dataset.scope;
    state.sliceId = "";
    state.fileId = "";
    state.viewSession = "";
    state.viewBranch = "";
    state.picked = [];
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
        showNotice("门禁已装到本机 Cursor 智能体。之后任意项目里的 Agent 写文件都会先过这道门。请新开一个对话后生效。");
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
