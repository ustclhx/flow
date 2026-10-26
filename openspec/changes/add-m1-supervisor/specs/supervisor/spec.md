# Spec Delta

## Purpose

每个 workspace 有一个由内核唤醒、监督的 supervisor：它把用户指令和事件变成任务、提案、提问与日志，只通过内核提供的工具行动，每次唤醒都是新会话并靠简报恢复记忆（PRD §7.1、§19 第 5 条）。

## ADDED Requirements

### Requirement: 唤醒来源
中枢 SHALL 在以下事件发生时为对应 workspace 安排一次 supervisor 唤醒：用户指令（`user.instruction`）；由 supervisor 派生的任务进入 `done`、`failed`、`blocked` 或 `cancelled`；用户回答了 supervisor 的提问；任务提案被接受或驳回；`payload.kind = supervisor_patrol` 的定时规则触发；决策到期回看。supervisor 唤醒任务自身的状态变化 MUST NOT 触发唤醒。

#### Scenario: 用户指令唤醒
- **WHEN** 用户在 Telegram 发送 `/ask product-res 把 README 的项目定位补上`
- **THEN** 中枢为 `ws/product-res` 创建一个 `role: supervisor` 的任务，`inputs.wake.kind = instruction`，并引用该指令事件

#### Scenario: 派生任务结束唤醒
- **WHEN** 一个 `parent` 链上有 supervisor 唤醒任务的 dev 任务变为 `done`
- **THEN** 中枢为同一 workspace 安排一次 `wake.kind = task_update` 的唤醒

#### Scenario: 唤醒任务自身结束不自激
- **WHEN** 一个 supervisor 唤醒任务变为 `done`，且队列中没有待处理事件
- **THEN** 不创建新的唤醒任务

### Requirement: 每个 workspace 串行唤醒并合并事件
同一 workspace 同时 SHALL 最多有一个未结束（含 `blocked`）的 supervisor 唤醒任务。期间到达的唤醒事件 MUST 排队，当前唤醒结束后合并为下一次唤醒，`inputs.wake.events` 列出全部事件。队列 MUST 由账本投影得到，中枢重启后不丢失；唤醒任务的幂等键 MUST 保证重放不会重复创建。

#### Scenario: 运行中到达的事件被合并
- **WHEN** 唤醒任务 A 运行期间，该 workspace 先后有两个派生任务结束
- **THEN** A 结束后只创建一个新唤醒任务，其 `inputs.wake.events` 包含这两个事件

#### Scenario: 中枢重启
- **WHEN** 队列中有一个待处理事件时中枢重启
- **THEN** 重启后仍为该事件创建且只创建一次唤醒任务

### Requirement: 唤醒失败处理
唤醒任务失败 SHALL 按任务重试设置重试；重试用尽后 MUST 在收件箱生成 Interrupt 条目，并保留待处理队列。用户 SHALL 能用 `flow supervisor wake <ws>` 手动唤醒，用 `flow supervisor status [<ws>]` 查看当前唤醒、队列长度和最近一次结果。

#### Scenario: 重试用尽
- **WHEN** 唤醒任务两次都 `failed`
- **THEN** 收件箱出现一条 Interrupt 条目，队列中的事件仍在，`flow supervisor status` 显示最近一次失败原因

### Requirement: 启用开关
workspace 配置 SHALL 支持 `supervisor.enabled`（缺省为 true，但仅在存在 `supervisor` 角色时生效）。未启用时 MUST NOT 唤醒，`/ask` 与 `flow ask` 回复该 workspace 未启用 supervisor。

#### Scenario: 关闭后不唤醒
- **WHEN** `ws/xuanxue-saas` 配置 `supervisor.enabled: false`，用户发送 `/ask xuanxue-saas 看看支付`
- **THEN** 不创建唤醒任务，用户收到"该 workspace 未启用 supervisor"

### Requirement: 来源链决定建写任务的权限
每个唤醒任务 SHALL 记录 `origin`：由用户指令触发、或沿 `parent` 链先回溯到用户指令或由 user 创建的任务（含接受提案所建的任务）的为 `instruction`；根为巡检或决策回看的分别为 `patrol`、`decision_review`；回答与提案处理继承原唤醒的 origin。supervisor 创建 `kind: write` 角色的任务时，origin 不是 `instruction` 的请求 MUST 被中枢拒绝（403 `proposal_required`）；`kind: read` 角色不受此限。

#### Scenario: 指令派生可以直接建 dev 任务
- **WHEN** origin 为 `instruction` 的唤醒中，supervisor 调用 `task_create` 创建 dev 任务
- **THEN** 中枢在 `creatable_by` 与策略检查通过后创建任务

#### Scenario: 巡检发现只能提案
- **WHEN** origin 为 `patrol` 的唤醒中，supervisor 调用 `task_create` 创建 dev 任务
- **THEN** 返回 403 `proposal_required`，提示改用 `task_propose`

#### Scenario: 接受提案后的后续修改
- **WHEN** 用户接受巡检提案所建的 dev 任务被审查要求修改，supervisor 被唤醒后建修改任务
- **THEN** 该唤醒的 origin 为 `instruction`，任务被创建

#### Scenario: 巡检可以直接建只读任务
- **WHEN** origin 为 `patrol` 的唤醒中，supervisor 创建 triage 任务
- **THEN** 任务被创建

### Requirement: supervisor 建任务必须挂在唤醒任务下
supervisor 身份创建的任务 MUST 带 `parent`，且指向同一 workspace 中一个未结束的 supervisor 唤醒任务；否则中枢 MUST 拒绝（`parent_required` 或 `workspace_mismatch`）。

#### Scenario: 缺少 parent
- **WHEN** supervisor 身份调用 `POST /v1/tasks` 且没有 `parent`
- **THEN** 返回 `parent_required`，不创建任务

#### Scenario: 跨 workspace
- **WHEN** `ws/product-res` 的唤醒中，supervisor 尝试给 `ws/xuanxue-saas` 建任务
- **THEN** 返回 `workspace_mismatch`

### Requirement: 简报读写
supervisor 每次唤醒 SHALL 能用 `ws_brief` 读取简报，内容包括 supervisor 笔记、进行中的任务、待处理的收件箱条目、近期决策和近期 journal。supervisor SHALL 能用 `brief_update` 整体替换本 workspace 的笔记 `brain/briefs/<ws>.md`：写入带 `base_hash`，内容变化时 MUST 拒绝（`conflict`）；超过 8000 字符 MUST 拒绝（`brief_too_long`）；写入经过写入层的脱敏与 gitleaks 检查。

#### Scenario: 更新笔记
- **WHEN** supervisor 以读到的 `base_hash` 调用 `brief_update`
- **THEN** `brain/briefs/product-res.md` 被替换并提交到 brain 仓库，下一次 `ws_brief` 的第一节是新笔记

#### Scenario: 并发覆盖
- **WHEN** `base_hash` 与当前文件不一致
- **THEN** 返回 `conflict`，文件不变

### Requirement: supervisor 不能替用户决定
supervisor 身份 MUST NOT 能回复任务、批准或驳回审批、接受或驳回任何提案，也不能直接创建合并任务；这些请求 MUST 由中枢按身份拒绝（`user_only` 或 `role_not_allowed`）。

#### Scenario: 尝试批准
- **WHEN** supervisor 调用 `task_reply --approve`
- **THEN** 返回 403 `user_only`

### Requirement: 用户指令入口
用户 SHALL 能通过 Telegram `/ask <ws> <内容>` 和 CLI `flow ask <ws> <内容>` 下达指令；两者都写入 `user.instruction` 并返回唤醒任务编号（若被排队，返回排队说明）。

#### Scenario: CLI 下指令
- **WHEN** 用户运行 `flow ask product-res 修一下 README`
- **THEN** 账本新增 `user.instruction`，命令输出唤醒任务 id 或"已排队"
