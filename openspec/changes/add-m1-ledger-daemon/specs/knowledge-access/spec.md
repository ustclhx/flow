# Spec Delta

## ADDED Requirements

### Requirement: 依赖中枢的操作
操作注册表 SHALL 包含任务操作：`task_create`、`task_list`、`task_show`、`task_cancel`，CLI 与 MCP 都自动获得对应入口。这些操作通过本机中枢的 API 执行；中枢不可用时 MUST 返回可重试的错误 `hub_unavailable`（CLI 退出码 3），并提示用 `flow daemon status` 检查。知识库操作不依赖中枢，行为不变。

#### Scenario: 中枢未运行时建任务
- **WHEN** 中枢未运行，此时 agent 调用 `task_create`
- **THEN** 返回 `hub_unavailable`，且 `retryable` 为 true

#### Scenario: 中枢未运行时检索知识库
- **WHEN** 中枢未运行，此时 agent 调用 `kb_search`
- **THEN** 检索照常返回结果
