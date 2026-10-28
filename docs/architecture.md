# 代码评审插件架构方案

macOS 上的本机评审服务，外加可被所有 Agent 通用的应用面板。服务做两件事：按 `master` 与当前开发分支算出差异；按工作切片管理 Agent 的写代码过程。

一次只允许一小段编辑。Agent 先写下这段代码的作用，人在面板放行后才可以改文件。这一小段提交后，门禁重新锁上。人核对通过之前，下一次编辑不会开始。

人手在编辑器里打字不经过 Agent 工具，不受这道门禁影响。

## 结论

| 事项 | 决定 |
| --- | --- |
| 形态 | 本机 Node 服务 + Cursor 面板。门禁协议与具体 Agent 分开 |
| 管理单位 | 工作切片：一段作用说明、一次放行、一组编辑、一个提交、一次核对 |
| 阻塞点 | 有前置钩子的 Agent，在写文件和会改工作区的命令上同步拒绝。钩子失败时拒绝写操作 |
| 跨 Agent | 同一 CLI `review-gate`。Cursor、Claude Code 用各自钩子调用它；其余 Agent 读取仓库里的约束段 |
| 记录 | 每段的作用说明、Agent、放行与核对时间、提交 sha、文件差异，写入本机 SQLite |
| 差异 | 切片内看未提交或该提交；整分支仍用 `master...HEAD` |
| 语言 | TypeScript。面板、服务、CLI 共用 `packages/protocol` |
| 连接 | 面板只与扩展宿主 `postMessage`。钩子和 CLI 访问 `127.0.0.1` |

一个用户一个服务进程，可登记多个仓库。未结束切片的唯一键是工程和分支：同一工程、同一分支同时只有一个未结束切片，别的分支可以各有自己的一段。同一 Git 仓库要并行做多条需求时，每条需求用一个 worktree，检出自己的开发分支；这些检出仍由这一个服务接待，不另起进程。工程按 Git 公共目录识别，多个 worktree 属于同一个工程，而不是互不相干的两套登记。

## 工作切片

切片是人能读完的一小段工作。服务要求四件事同时成立，才允许下一段开始：

1. 作用说明已经写明，并显示在面板上。
2. 人按过「放行」。
3. 这段改动已经形成一个提交，提交说明就是这段作用。
4. 人按过「核对通过」。

作用说明由 Agent 在编辑前提交，一两句人话，说明这段代码做什么。面板把它放在差异上方。空说明不能进入待放行。

### 粒度

评审单位是一个切片，不是固定行数。一个切片对应一个作用说明和一个提交。里面可以是一个函数、一次行为变化，或跨几个文件的同一件事。面板展示该提交的全部文件和补丁，人按这份完整差异核对。

待放行时通常还没有代码差异，面板只显示作用说明。编辑中显示尚未提交的全部文件。待核对显示该提交的全部文件。图上的短差异只说明布局，实现时不会把评审裁成两三行。

### 状态

```text
锁定
  │  Agent：review-gate intend "这段代码的作用"
  ▼
待放行
  │  人：放行
  ▼
编辑中
  │  Agent 改文件并提交；提交说明等于作用说明
  ▼
待核对
  │  人：核对通过
  ▼
锁定
```

退回可以从「待放行」或「待核对」回到「锁定」。退回原因记在切片上。待核对被退回时，服务再开一个只允许撤回该提交的窄租约：Agent 只能把该提交撤销，不能夹带新功能。撤销提交后回到锁定。

编辑中若 `HEAD` 向前正好一个提交，且提交说明与作用说明一致、工作区干净，服务自动关上门禁并进入待核对。`review-gate complete` 走同一条校验。说明不一致时也关上门禁，切片标成「说明与提交不一致」，下一次放行要等人处理完这条记录。

### 锁定时什么可以做

可以读文件、搜索、跑测试，以及只读 git：`status`、`diff`、`log`、`show`、`rev-parse`、`merge-base`。

不可以写文件，也不可以执行会改工作区的命令，包括 `git add`、`git commit`、`git checkout`、`git restore`、`git reset`、`git apply`、`git stash`。`review-gate` 自身的命令始终允许，否则 Agent 无法登记下一段。

编辑中允许写文件和恰好一次对得上说明的提交。下面这些路径即使在编辑中也拒绝 Agent 修改，避免 Agent 拆掉门禁：

- `~/.cursor/hooks.json`
- `~/.cursor/hooks/review-gate.sh`
- `.claude/settings.json`
- `AGENTS.md` 与 `CLAUDE.md` 中的门禁标记段

这些文件只由人在面板里通过「安装门禁」写入。Cursor 的钩子写在用户目录，一次安装覆盖本机所有项目。

## 阻塞与多 Agent

门禁的判定只在本机服务里做一次。各 Agent 的适配器负责在写操作发生前调用判定，并把同一段约束放进该 Agent 会读的说明里。

| Agent | 约束注入 | 阻塞方式 |
| --- | --- | --- |
| Cursor | 用户钩子 `~/.cursor/hooks.json` | `preToolUse` 拦截写入类工具；`beforeShellExecution` 拦截会改工作区的命令。对本机所有项目生效。`failClosed: true`。拒绝时返回 `permission: deny`，`agent_message` 告诉它先 `intend` 再 `wait`。钩子按这次编辑的文件或工作区定位 Git 仓库 |
| Claude Code | `.claude/settings.json` 的 PreToolUse | 调用同一个 `review-gate check-tool`。未放行时退出码 2 |
| 其他会读仓库说明的 Agent | `AGENTS.md`、`CLAUDE.md` 标记段 | 说明要求编辑前调用 `review-gate intend` 和 `review-gate wait` |

钩子脚本只做转发：读 stdin，请求本机服务，按结果允许或拒绝。超时或服务不可用时拒绝写操作，读操作仍然允许。

没有前置钩子的 Agent，服务无法在写入瞬间拦住它。锁定期间工作区若出现新差异，面板把这段差异标为「待归属」。下一次放行前，人要把它标成自己的修改，或要求 Agent 撤回。有钩子的 Agent 与人手编辑可以分开：钩子只包住 Agent 工具，编辑器里的键入不会触发钩子。

CLI 安装在：

`~/Library/Application Support/CodingReviewAssistant/bin/review-gate`

命令：

| 命令 | 行为 |
| --- | --- |
| `intend "作用说明"` | 登记切片，状态变为待放行。同一工程、同一分支已有未结束切片时返回该切片，不另开一段。其他分支不受影响 |
| `wait` | 长轮询，直到本段变为编辑中，或被退回。供 Agent 在放行前停住 |
| `complete` | 校验提交后进入待核对 |
| `check-tool` | 钩子专用。从 stdin 读工具调用，向 stdout 写允许或拒绝 |

`wait` 默认最长 30 分钟。超时后 Agent 进程结束等待，门禁仍停在待放行，人稍后放行时 Agent 需再次 `wait`。

### 安装到 Cursor 用户目录

「安装门禁」写入 `~/.cursor/hooks.json` 和 `~/.cursor/hooks/review-gate.sh`，并保留文件里已有的其他钩子。用户钩子的工作目录是 `~/.cursor/`，判定时改用这次工具调用里的文件路径、`cwd` 或 `workspace_roots` 找到对应仓库。不再按项目写入 `.cursor/hooks.json`。

已经写在仓库 `AGENTS.md`、`CLAUDE.md` 里的约束段仍然有效。标记为 `<!-- review-gate:start -->` 与 `<!-- review-gate:end -->`。

约束正文：

```text
本仓库的代码编辑经过本机评审门禁。每次只写一小段。

1. 编辑前执行 review-gate intend，用一两句话说明这一小段代码的作用，然后执行 review-gate wait，停住等待人放行。
2. 放行之后才可以改文件。这一小段结束后立刻提交，提交说明使用刚才登记的作用说明。
3. 提交后执行 review-gate complete，再次停住。人核对通过之前，不再登记下一段，也不再改文件。
4. 读文件、搜索、测试和只读 git 可以在锁定时进行。
```

## 面板

面板是管理面，差异视图为当前切片服务。

顶栏：仓库名、`基准分支...当前分支`、门禁状态（锁定 / 待放行 / 编辑中 / 待核对）。

主区上方：当前切片的作用说明、来源 Agent、等待了多久。说明下面是结论栏，只放这一段的两个决定，同一行、同一权重。待放行是「放行」和「退回」。待核对是「核对通过」和「退回」。编辑中不出现结论栏。

主区中间：这一小段的全部文件。待放行时这里为空。编辑中看未提交的全部文件。待核对时看该提交的全部文件。

当前文件差异的上方是查看栏，和结论栏分开。同一行里是「单文件」「双文件」「定义」「引用」。前两项切换界面，后两项按光标所在的函数或对象名向宿主查询。四项都不改变门禁。查询结果列在查看栏下面。切换单文件或双文件不重新向服务要补丁。

在单文件界面、双文件的任一栏，以及「引用」结果的每一条上，按住 Command 再点左键，跳到该符号的实现。普通左键只移动光标或选中条目，不跳转。

### 编辑快捷键

mac 面板由 `apps/mac/Panel.swift` 打开网页。复制、粘贴、剪切、全选、撤销和重做走窗口的「编辑」菜单，菜单项保持启用，选区交给网页处理。页面自身的按键逻辑不占用这些组合键。

自测：改完宿主后重新打开面板（`Panel.swift` 比二进制新时会自动重新编译）。点进登记路径、评论框或差异正文，依次按 Command+A、Command+C、Command+X、Command+V、Command+Z 和 Command+Shift+Z。放行、退回、核对通过仍用面板上的按钮。

同一面板上会遇到三种画面：只有作用说明的待放行；一个函数规模的单文件提交；同一件事穿过接口、领域服务和测试的多文件提交。三者都是一个切片。

主区下方：工作记录。每行是一段的时间、Agent、作用说明、提交 sha、核对结果。点开一行可以看到当时的完整差异，并沿用当前的单文件或双文件界面。

整分支差异仍可切换，计算方式不变：`git diff master...HEAD`。仓库没有 `master` 时用 `main`，面板里可改基准分支。未提交分成已暂存和未暂存。二进制文件只显示状态。子模块显示为一条记录。

## 差异界面与引用跳转

服务保存的仍是 unified hunk。单文件和双文件是面板上的两种渲染。引用跳转由扩展宿主完成，评审服务不做语法分析。

### 单文件界面

一个界面里交错显示同一文件的上下文、删除行和新增行。适合顺着读一段逻辑。行号用改后文件的行号；删除行保留基准行号，供跳转时区分左右内容。

### 双文件界面

左右两个界面，同一 hunk 对齐：

- 左栏是基准版本，标题为旧路径。删除行和上下文出现在这里。
- 右栏是改后版本，标题为新路径。新增行和上下文出现在这里。
- 一侧没有对应行时留空行，使两侧同一 hunk 对齐。

重命名时左栏用 `oldPath`，右栏用 `path`。人在文件列表里选中哪个文件，两种界面都只展示这个文件的补丁。

### 函数与对象跳转

查看栏的「定义」「引用」用来列出位置。真正跳进代码用 macOS 手势：在差异或引用列表里按住 Command 再点左键。

手势作用的范围：

- 单文件界面里的函数名、对象名。
- 双文件界面左栏或右栏里的函数名、对象名。
- 「引用」结果中的每一条。

普通左键只把光标放到该符号，或选中列表中的一条。Command 与左键同时按下时，面板把标识符、路径、行、列和所在侧发给扩展宿主，`kind` 为 `implementation`。宿主先向语言服务要实现；没有单独实现时，再用定义。

| 点击位置 | 宿主怎么定位 |
| --- | --- |
| 右栏、单文件里的新增行和仍存在于工作区的上下文 | 对工作区里的该文件调用实现提供器，没有结果时用定义提供器 |
| 左栏、只存在于基准版本的删除行 | 用基准 blob 的文本取出标识符，再按工作区符号查找实现。对不上当前工作区时，在已打开的仓库里按标识符列出候选 |
| 引用列表中的一条 | 以该条的路径和位置作为起点，解析它指向的实现 |

跳转结果：

- 只有一处实现，且目标文件在当前切片里：保持当前界面，滚到该行。
- 目标不在当前切片里：打开只读源码并停在该行，不把无关文件算进这段差异。
- 有多处实现：列在查看栏下面，再对其中一条使用 Command+左键才进入。
- 语言服务没有结果：面板说明未能定位，门禁状态不变。

跳转只读，不放行编辑，也不修改切片。

## 系统结构

```text
Agent
  │  intend / wait / complete
  │  写文件、改工作区的 shell
  ▼
review-gate CLI ──► 本机服务（门禁状态、切片记录、差异）
                         ▲
Cursor / Claude Code 钩子 ┘
                         │
                         ▼
                    SQLite + Git 仓库
                         ▲
                         │ postMessage
                    扩展宿主 ── 评审面板
                         │ 放行 / 核对通过 / 退回
```

差异引擎仍以仓库状态为准。服务监视 `.git` 和工作区，用固定 git 参数生成结构化差异，用来展示切片和整分支，也用来判断编辑中是否已经形成唯一提交。

### 目录

```text
packages/protocol                 切片、门禁、差异、宿主消息
apps/daemon/src/gate/machine.ts   状态流转与租约
apps/daemon/src/gate/policy.ts    工具与 shell 的允许规则、保护路径
apps/daemon/src/adapters/install.ts  写入钩子与约束标记段
apps/daemon/src/git/watcher.ts    FSEvents、400ms 合并、指纹
apps/daemon/src/git/runner.ts     git 白名单与超时
apps/daemon/src/git/diff.ts       numstat 与 unified diff
apps/daemon/src/session/store.ts  SQLite
apps/daemon/src/server.ts         127.0.0.1 上的 HTTP、长轮询与 WebSocket
apps/cli/review-gate.ts           intend、wait、complete、check-tool
apps/extension/src/extension.ts   拉起服务，转发放行与核对，并调用语言服务做跳转
apps/extension/src/panel          状态、作用说明、单文件与双文件差异、工作记录
```

运行时目录 `~/Library/Application Support/CodingReviewAssistant/`：

- `daemon.json`：`pid`、`port`、`token`，权限 `0600`
- `bin/review-gate`
- SQLite 与补丁缓存

令牌不写入仓库。钩子通过 CLI 读取 `daemon.json`。

## 差异计算

400ms 内的连续文件事件合成一次。指纹不变则不重算补丁。

| 变化 | 指纹 | 重算 |
| --- | --- | --- |
| 新提交 | `HEAD` sha | 当前切片的提交，以及 `master...HEAD` |
| 暂存区 | `git diff --cached --raw` 的内容哈希 | 已暂存 |
| 工作区 | `git status --porcelain=v1 -z` 的内容哈希 | 未暂存 |
| 三者都相同 | 沿用上一次快照 | 不推送 |

WebSocket 只推摘要。点开文件再取 `-U3` 补丁，按内容哈希缓存。单文件补丁超过 1MB 时只保留清单。

git 使用 `execFile` 参数数组，超时 15 秒。允许的子命令：`rev-parse`、`merge-base`、`status`、`diff`、`diff-index`。取提交说明时使用条数受限的 `log`。

编辑中自动收口时再读取：

```text
git rev-parse HEAD
git status --porcelain=v1 -z
git log -1 --format=%s
git merge-base <baseRef> HEAD
```

分支清单与单文件补丁仍是：

```text
git diff --numstat --find-renames <baseRef>...HEAD
git diff -U3 --find-renames <baseRef>...HEAD -- <path>
git diff --cached --numstat --find-renames
git diff HEAD --numstat --find-renames
```

## 协议

请求头 `Authorization: Bearer <token>`。`/health` 只报告进程是否存活。

### 门禁

| 方法 | 路径 | 调用者 | 说明 |
| --- | --- | --- | --- |
| GET | `/repos/:id/gate` | 面板、CLI | 当前状态、切片 id、作用说明、Agent |
| POST | `/repos/:id/gate/intent` | CLI | body `{ "agent", "purpose" }`。空说明返回 400 |
| GET | `/repos/:id/gate/wait?sliceId=` | CLI | 长轮询，直到编辑中或退回 |
| POST | `/repos/:id/gate/release` | 面板 | body `{ "sliceId" }`。人放行，进入编辑中 |
| POST | `/repos/:id/gate/ack` | 面板 | 人核对通过，进入锁定 |
| POST | `/repos/:id/gate/reject` | 面板 | body `{ "sliceId", "reason" }`。退回 |
| POST | `/repos/:id/gate/complete` | CLI、内部监视 | 校验提交并进入待核对 |
| POST | `/repos/:id/gate/check` | 钩子 | body 为工具名和参数。返回 `allow` 或 `deny` 加给 Agent 的说明 |
| GET | `/repos/:id/slices` | 面板 | 工作记录，按时间倒序 |

钩子检查是同步的，服务应在百毫秒级返回。`wait` 挂起，不占住检查接口。

### 差异

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | pid、版本、已登记仓库数 |
| POST | `/repos` | body `{ "path" }`。同一路径幂等 |
| GET | `/repos/:id/status` | 分支、基准、是否脏、门禁状态 |
| GET | `/repos/:id/diff?scope=` | `branch`、`staged`、`unstaged`，或 `slice` 加 `sliceId` |
| GET | `/repos/:id/files/:fileId/patch` | hunk 列表 |
| WS | `/repos/:id/events` | `gate.updated` 与 `snapshot.updated` |

```ts
type GateState = "locked" | "awaiting_release" | "editing" | "awaiting_review";

type GateEvent = {
  type: "gate.updated";
  repoId: string;
  state: GateState;
  sliceId: string | null;
  purpose: string | null;
  agent: string | null;
};

type WorkSlice = {
  sliceId: string;
  repoId: string;
  agent: string;
  purpose: string;
  state: GateState | "approved" | "rejected";
  baseSha: string | null;
  commitSha: string | null;
  mismatch: boolean;
  createdAt: string;
  releasedAt: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
};

type DiffMode = "unified" | "split";

type SourceLocation = {
  path: string;
  line: number;
  character: number;
  preview: string;
};

type HostToPanel =
  | { type: "gate"; state: GateState; slice: WorkSlice | null }
  | { type: "fileList"; scope: string; files: FileChange[] }
  | { type: "patch"; fileId: string; hunks: DiffHunk[] }
  | { type: "slices"; items: WorkSlice[] }
  | { type: "locations"; kind: "definition" | "references" | "implementation"; identifier: string; items: SourceLocation[] }
  | { type: "source"; path: string; line: number; text: string }
  | { type: "error"; message: string };

type PanelToHost =
  | { type: "release"; sliceId: string }
  | { type: "ack"; sliceId: string }
  | { type: "reject"; sliceId: string; reason: string }
  | { type: "openFile"; fileId: string }
  | { type: "setBaseRef"; baseRef: string }
  | {
      type: "navigate";
      kind: "definition" | "references" | "implementation";
      path: string;
      line: number;
      character: number;
      side: "base" | "head";
      identifier: string;
    };
```

`FileChange` 与 `DiffHunk` 保持文件路径、增删行和 hunk 结构，供切片差异和整分支差异共用。`DiffMode` 只存在面板本地：`unified` 渲染单文件界面，`split` 用同一组 hunk 排出左右两栏。`navigate` 不访问评审服务。`kind: "implementation"` 只由差异或引用列表上的 Command+左键发出。

## 存储

`repos`：`id`，`path`（检出路径），`base_ref`，`created_at`。同一 Git 公共目录下的 worktree 记为同一个工程。

`work_slices`：`id`，`repo_id`，`branch`，`agent`，`purpose`，`state`，`base_sha`，`commit_sha`，`mismatch`，`reject_reason`，`created_at`，`released_at`，`reviewed_at`。未结束状态在同一工程、同一 `branch` 上至多一行。

`slice_attempts`：被拒绝或放行的工具调用摘要（Agent、工具名、路径、结果、时间），供工作记录说明「这段期间 Agent 试过什么」。不保存工具参数里的大段文件正文，正文以 Git 差异为准。

`snapshots`、`file_changes`、`patch_blobs`：切片差异和 `master...HEAD` 的清单与补丁。补丁按内容哈希去重。每个仓库保留最近 30 个分支快照；切片差异随切片保留。

待归属差异记在 `unclaimed_diffs`：`repo_id`，`fingerprint`，`detected_at`，`resolution`（未处理 / 标为人手 / 已撤回）。存在未处理记录时，`release` 返回 409。

## 本机边界

- 服务绑定 `127.0.0.1` 随机端口。
- 只接受登记过的仓库。检出路径必须与 `git rev-parse --show-toplevel` 一致。工程身份用 `git rev-parse --git-common-dir`：同一仓库的多个 worktree 归到同一个工程，门禁看该检出当前分支。
- 作用说明、差异、核对记录和令牌留在本机。
- 服务异常退出后，宿主拉起一次新进程。拉起前钩子拒绝 Agent 写操作。已处于编辑中的切片恢复为待放行，避免服务重启后租约丢失仍继续改。

## 分期

### 一、门禁、记录与 Cursor 阻塞

人可以在面板看到 Agent 申报的作用说明，放行后 Cursor 才能写这一小段，提交后必须再次核对。工作记录能按时间看每段做了什么。

完成标准：

- 锁定时，Cursor 的文件写入工具和 `git commit` 被拒绝，读文件和 `git diff` 仍可执行。
- `intend` 缺少作用说明时不能进入待放行。
- 放行后的提交说明与作用说明一致、工作区干净时，状态变为待核对，后续写入再次被拒绝。
- 核对通过后才能开始下一次 `intend`。
- 面板上的这段差异与该提交的 `git show --numstat` 一致。同一补丁可在单文件界面和双文件界面之间切换，文件列表与增删行不变。
- 在改后内容或引用列表上按住 Command 再点左键，跳到该符号的实现。只有一处时直接滚动或打开只读源码；有多处时先列出，再对其中一条使用同一手势。普通左键不跳转。
- 服务进程退出期间，写操作保持拒绝。

### 二、其他 Agent 与待归属

Claude Code 仍用各自项目里的 PreToolUse。仓库里已有的 `AGENTS.md` 与 `CLAUDE.md` 约束段继续有效。锁定期间没有钩子的写入显示为待归属，处理完才能放行下一段。退回后的窄租约只允许撤销该提交。

### 三、核对意见与导出

在切片差异上写评论、按文件接受或拒绝，并导出工作记录（作用说明、提交、核对结果）。再增加新的 Agent 适配器时，只新增钩子安装，不改状态机。

阶段一按本文的状态、协议和完成标准实现。阶段二、三沿用同一张 `work_slices` 表。
