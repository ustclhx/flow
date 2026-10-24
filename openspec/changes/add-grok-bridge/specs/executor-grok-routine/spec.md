# Spec Delta

## Purpose

规定 `grok-routine` 执行器：通过 routine webhook 把任务派给 Grok Bot，并由 Grok 经远程 MCP 交回结果，使云端智能体能像本机执行器一样承接 Flow 的任务。

## ADDED Requirements

### Requirement: 经 webhook 派发任务
`grok-routine` 执行器 SHALL 从角色的 `permissions` 中读取 `webhook`（routine 的 webhook 地址）与 `key`（`secret://` 引用），向该地址发送 `POST` 请求，正文包含任务 id、目标、workspace、上下文摘要和交付要求。正文 MUST 经过密钥脱敏。webhook 返回非 2xx 时，任务 SHALL 以 `failed` 结束并记录状态码；网络错误按可重试处理。

#### Scenario: 成功派发
- **WHEN** 节点领取一个角色为 `grok-research` 的任务，webhook 返回 200 和一个运行 id
- **THEN** 任务保持 `running`，活动记录中出现"已派发到 Grok，运行 id 为 …"

#### Scenario: key 未配置
- **WHEN** 角色引用的 `secret://grok/webhook-key` 不存在
- **THEN** 任务以 `failed` 结束，错误码为 `secret_missing`，不发出任何请求

### Requirement: 经 task_report 收回结果
派发后，执行器 SHALL 等待该任务的结果回报。Grok 通过远程 MCP 调用 `task_report`（任务 id、状态 `done` 或 `failed`、摘要、可选的提案 id 列表）后，执行器 MUST 按回报完成任务。超过角色配置的 `report_timeout_minutes`（默认 60）仍未回报时，任务以 `failed` 结束，原因为 `report_timeout`。

#### Scenario: Grok 交回结果
- **WHEN** Grok 对正在运行的任务调用 `task_report`，状态为 `done`，并附一段摘要
- **THEN** 任务进入后续的验收或 `done`，结果摘要为 Grok 提交的内容，结果中记录提交者 `grok`

#### Scenario: 超时未回报
- **WHEN** 派发后 60 分钟内没有收到回报
- **THEN** 任务以 `failed` 结束，原因为 `report_timeout`，收件箱生成相应条目（变更 ③）

### Requirement: 回报的约束
`task_report` MUST 只接受以下情况：调用方的 actor 与任务派发时绑定的 actor 一致；任务当前由 `grok-routine` 执行器持有且处于 `running`；该任务尚未回报过。其他情况返回 `forbidden` 或 `not_running`，不改变任务状态。

#### Scenario: 为别人的任务回报
- **WHEN** `grok` 对一个由 `codex-orca` 执行的任务调用 `task_report`
- **THEN** 返回 `forbidden`，任务状态不变

#### Scenario: 重复回报
- **WHEN** `grok` 对已经回报过的任务再次调用 `task_report`
- **THEN** 返回 `not_running`，第一次的结果保持不变

### Requirement: 取消
任务被取消时，执行器 SHALL 停止等待并以 `cancelled` 结束；之后到达的 `task_report` 返回 `not_running`。Grok 侧的运行无法被 Flow 停止，这一点 MUST 在取消结果中注明。

#### Scenario: 运行中取消
- **WHEN** 用户取消一个已派发给 Grok 的任务
- **THEN** 任务变为 `cancelled`，结果注明"Grok 侧的运行仍可能继续，其回报将被忽略"
