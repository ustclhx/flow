# Spec Delta

## Purpose

通过 Claude Agent SDK 无头运行 Claude Code，用于审查、分析这类不需要人一直盯着的任务，并让工具审批进入 Flow 的审批流程。

## ADDED Requirements

### Requirement: 按角色运行
执行器 SHALL 以任务的工作目录、角色的提示词（追加在 Claude Code 预设提示词之后）、模型和权限运行 Claude Agent SDK。默认只加载项目级设置，不加载用户级全局设置，避免把用户个人的协调规则带入 worker。执行过程中的助手消息与工具调用摘要作为活动上报。

#### Scenario: 审查一个 PR
- **WHEN** 一个 reviewer 任务的目标是审查某个 PR
- **THEN** Claude 在该仓库目录中运行，账本中可以看到它的活动，结束时结果包含审查摘要

### Requirement: 注入 Flow MCP
执行器 SHALL 为每次运行注入 `flow` MCP 服务（`flow mcp --actor <角色名>`），使 worker 可以检索知识库、写 journal、提交提案，且受 AI 写入边界约束。

只有一份固定清单中的 flow 工具不经审批放行：`kb_search`、`kb_get`、`kb_query`、`kb_journal`、`capture`、`kb_propose`、`ws_brief`、`task_list`、`task_show`。其余 flow 工具 MUST 走工具审批，包括 `task_create`、`task_cancel` 和以后新增的工具。原因是 `task_create` 可以创建其他角色的任务（例如 `dev` 角色以 `danger-full-access` 运行），只读角色借此就能提权。

#### Scenario: worker 写 journal
- **WHEN** reviewer 任务中的 Claude 调用 `kb_journal`
- **THEN** journal 记录的操作者是 `reviewer`

#### Scenario: worker 创建任务需要审批
- **WHEN** reviewer 任务中的 Claude 调用 `task_create`
- **THEN** 任务以 `blocked(awaiting_approval)` 上报，用户批准之前不会创建任务

### Requirement: 设置来源与权限模式
角色的 `permissions.setting_sources` SHALL 决定加载哪些 Claude Code 设置来源，默认 `['project']`。

加载项目设置时，被操作仓库的 `.claude/settings.json` 会生效：其中的 hooks 会直接执行命令，`permissions.allow` 会在审批之前放行调用，从而绕过 Flow 的审批。因此：
- 审查他人仓库的 `reviewer` 默认角色 MUST 设为 `[]`；
- `setting_sources` 不含 `project` 时，执行器 SHALL 把工作目录下 `CLAUDE.md`、`AGENTS.md` 的纯文本（限长、经脱敏）追加到系统提示词，保留项目约定，但不加载 hooks 和权限规则。

权限模式默认 `default`，即所有未被允许列表放行的调用都进入 Flow 审批。`auto` 模式下，分类器有把握的调用不会进入审批，所以只在角色显式写出时使用；角色显式写出的 `auto`、`bypassPermissions` 照原样传递。

#### Scenario: 审查不受被审查仓库的设置影响
- **WHEN** reviewer 任务的工作目录中有 `.claude/settings.json`（含 hooks 与 `permissions.allow`）和 `CLAUDE.md`
- **THEN** Claude 运行时不加载该设置文件，`CLAUDE.md` 的文本出现在系统提示词中，权限模式为 `default`

### Requirement: 工具审批挂起等待
工具调用落到需要审批的环节时（即角色的允许列表和 SDK 的权限模式都没有放行），执行器 SHALL 上报 `blocked(awaiting_approval)`，附带工具名和输入摘要，并保持会话等待。
- 收到 `--approve`：放行这次调用，任务回到 `running`；
- 收到 `--deny`：拒绝这次调用，并把附带的文字作为拒绝理由交给 Claude。

等待超过角色设定的时限（默认 24 小时）时，任务以 `failed`（`approval_timeout`）结束。

#### Scenario: 审批后继续
- **WHEN** Claude 请求执行一条不在允许列表中的 Bash 命令，用户随后 `--approve`
- **THEN** 该命令被执行，任务从 `blocked` 回到 `running`

### Requirement: 结果
运行结束时 SHALL 以 `done` 结束（如有验收命令则先进入 `verifying`），结果摘要取最后一条助手文本，并记录会话 id 与费用信息；SDK 报告错误或达到轮次上限时，以 `failed` 结束并附带原因。

#### Scenario: 轮次耗尽
- **WHEN** 运行因为达到最大轮次而结束
- **THEN** 任务为 `failed`，原因中注明轮次上限
