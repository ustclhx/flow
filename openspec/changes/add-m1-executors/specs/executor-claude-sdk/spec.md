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

#### Scenario: worker 写 journal
- **WHEN** reviewer 任务中的 Claude 调用 `kb_journal`
- **THEN** journal 记录的操作者是 `reviewer`

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
