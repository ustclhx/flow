# Design

## Context

动机见 proposal.md。与设计相关的现状：
- 节点与所有 worker 以同一系统用户运行。`state/hub.token` 等文件是 0600，但同用户进程都能读。
- 三类 harness 进程的启动方式不同：
  - codex-orca：节点通过 Orca 在终端里执行一条 `cd … && exec env … codex …` 命令，进程属于 Orca 的 PTY。
  - codex-exec：节点直接 spawn `codex exec`。
  - claude-sdk：节点经 Agent SDK 启动 Claude Code 原生进程。
- harness 自带沙箱也用 macOS seatbelt：Codex 在 workspace-write / read-only 下每条命令都经 `sandbox-exec` 执行，Claude Code 的 bash 沙箱同理。
- **已实测**：在 seatbelt 内再调用 `sandbox-exec` 会失败（`sandbox_apply: Operation not permitted`，退出码 71）。所以外层 seatbelt 与 harness 自带沙箱不能嵌套。
- Codex 的 workspace-write 沙箱只限制写，不限制读，因此开了沙箱的角色同样能读到 `hub.token`。
- 任务绑定的 MCP（PR #81/#84）在 worker 侧进程里本地读取 raindown-home 来执行 kb 操作。
- 密钥私钥位于 `~/.config/sops/age/keys.txt`，拿到它就能解密 `config/secrets.sops.yaml`。

## Goals / Non-Goals

**Goals:**
- 受保护资源对 worker 不可读写，覆盖所有角色，不论 harness 自带沙箱开不开。
- 机制落在适配器契约里，与 harness 无关：节点生成隔离描述，适配器选择施加方式。
- 有可重复运行的探针证明隔离生效，失败时不静默降级。

**Non-Goals:**
- 不防御已经拿到内核或用户凭证（登录密码、sudo）的攻击者。
- 不在本变更中实现 Linux。
- 不处理 GitHub 身份共享（另立变更），也不限制 worker 的外网访问。

## Decisions

### D1. 统一的隔离描述，适配器选择施加层
节点为每次派工生成 `IsolationSpec{deny_read[], deny_write[], allow_read[], allow_write[], allow_unix_sockets[], allow_local_ports[]}`，路径一律规范化为 realpath。适配器把它落到三种施加层之一：
- **外层 seatbelt**：用于 harness 自带 OS 沙箱关闭的情况（danger-full-access、bypass）。节点生成 SBPL 配置，用 `sandbox-exec -f` 启动 harness。配置以 `allow default` 为基础，显式 deny 受保护资源，避免误伤 harness 的正常运行。
- **harness 原生的读限制**：用于 harness 自带沙箱开启、无法嵌套的情况。前提是该 harness 支持按路径禁止读取。是否支持（Codex 与 Claude Code 各自的配置项）由任务 1.1 实测确定，结果写入适配器能力。
- **独立系统用户**：最稳妥的退路，与 harness 沙箱完全正交。worker 以专用用户运行，受保护资源仍由主用户持有（0700）。代价有三：需要用户批准系统级改动（新建用户、sudoers 规则）；harness 凭证需要为该用户单独登录或经 Raindown 注入；worktree 需要共享组权限。只在前两层都不可行时启用，并且需要用户在实施时明确同意。
- 适配器能力 `credential_isolation` 取值为 `seatbelt | native | separate_user | none`，按角色的沙箱设置分别声明。中枢按能力派送。
- 备选：所有角色都关掉 harness 沙箱，由外层 seatbelt 同时承担 workspace-write 语义。否决：Codex 的授权弹窗（Raindown 的授权流程依赖它）取决于自身沙箱模式，关掉沙箱会改变授权语义。

### D2. 受保护资源清单由节点集中计算
节点在 core 中维护受保护资源清单：
- raindown-home 下的 `state/`、`config/`；
- 密钥私钥目录；
- `~/Library/LaunchAgents`；
- Orca 运行时的控制套接字（启动时由 `orca status` 解析）；
- 节点自己的锁文件与日志。

允许资源包括：
- 本任务工作目录；
- 本任务私有目录中的派工令牌文件；
- 适配器声明的 harness 目录，例如 Raindown 管理的 CODEX_HOME，以及 Codex/Claude 登录所需的路径；
- 中枢监听的本机端口。

seatbelt 的规则后者优先，允许项写得最窄（具体文件，而不是整个私有目录）。

### D3. 任务绑定的 kb 读取改经中枢
中枢新增只读路由，只接受任务绑定令牌，执行 kb_search / kb_get / kb_query。任务绑定的 MCP 改为调用这些路由。可见范围按 knowledge-access 现有规则计算该任务所属 workspace 可见的条目：本 workspace 加 global，其他 workspace 拥有的条目不返回，这比现在本地读取更严。这样 worker 侧进程无需读取 raindown-home，D2 可以整体 deny raindown-home 下的 `state/` 与 `config/`，`brain/` 也可以一并 deny。

### D4. 控制通道
- 中枢访问只允许本机端口，凭证只有派工令牌。
- Orca 控制套接字在受保护清单内：worker 不能操作其他终端，也不能批准自己的弹窗。codex-orca 的 harness 运行在 Orca 终端里，这不需要访问控制套接字。
- `launchctl`：不单独拦截，因为 plist 目录不可写，无法安装持久服务。

### D5. 角色的隔离要求与默认值
- `isolation` 默认 `preferred`。任务 1.1 的实测通过后，升级说明建议把 dev 类角色改为 `required`。之后的版本在 doctor 通过时把写类角色的默认值改为 `required`。
- `required` 不满足时，任务以 `blocked(other)` 并带原因 `isolation_unavailable` 停下，不启动 harness。

### D6. 自检探针
探针与 worker 走同一个施加层，运行节点自带的检查程序，逐项尝试：
- 读取 hub.token、账本数据库、他人任务令牌（临时造一个）和私钥；
- 写入 config；
- 连接 Orca 控制套接字。

全部失败才算通过；同时确认工作目录可写、派工令牌可读、中枢端口可连。
- 运行时机：节点启动时、每 6 小时一次，以及 macOS 版本变化后。
- 结果随节点注册上报，`doctor` 与 `hub status` 读取。

## Risks / Trade-offs

- [`sandbox-exec` 已被 Apple 标记弃用] → 继续可用，且 Codex、Claude Code 自身都依赖它。探针定期验证。一旦失效，`required` 角色停止派工而不是静默放行。
- [外层 seatbelt 的 deny 规则遗漏新增的敏感文件] → 以目录为单位 deny（`state/`、`config/` 整体），只开放具体文件。新增敏感位置要求同时更新清单与探针。
- [harness 原生读限制不存在或不可靠] → 回退到独立系统用户，需要用户批准，在任务 1.1 后决定。
- [隔离破坏 harness 的正常功能，比如读取全局 git 配置、凭证助手] → 允许清单中显式列出 harness 需要的路径。各适配器跑一次真实任务作为验收。
- [同用户仍能通过 ptrace 或调试接口观察节点进程] → seatbelt 默认拒绝跨进程调试。独立用户方案天然隔离。在文档中写明边界。

## Migration Plan

1. 先合并 D3（kb 经中枢）与探针（不施加隔离，只报告），观察一周。
2. 外层 seatbelt 以 `preferred` 对 danger-full-access 角色启用。验收通过后，dev 角色改为 `required`。
3. 根据任务 1.1 的结论启用 harness 原生读限制，或者提出独立用户方案并请用户批准。
4. 回滚：角色改回 `isolation: off` 即恢复旧行为。D3 的路由保留，不影响旧节点（旧节点继续本地读取）。

## Open Questions

- 探针的运行周期与失败通知方式（Interrupt 还是 Digest），以真实运行中的误报情况为准。
