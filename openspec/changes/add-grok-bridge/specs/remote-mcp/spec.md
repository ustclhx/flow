# Spec Delta

## Purpose

规定远程 MCP 入口：云端或其他机器上的 AI 智能体（首个是 Grok Bot）如何经私有网络访问 Flow，以及它们能看到什么、能做什么，使远程接入不扩大用户本人的权限面。

## ADDED Requirements

### Requirement: 独立的远程监听端口
中枢 SHALL 在一个独立的本机回环端口（默认 `127.0.0.1:7478`，可在 `config/hub.yaml` 中配置或关闭）上提供远程 MCP 入口，使用 MCP streamable HTTP 传输，路径为 `/mcp`。该端口 MUST NOT 提供中枢的 `/v1` API、Web 页面或事件流。`config/remote.yaml` 中没有任何远程调用方时，该端口 MUST NOT 监听。

#### Scenario: 远程端口不暴露中枢 API
- **WHEN** 向 `127.0.0.1:7478/v1/tasks` 发送带合法远程凭证的请求
- **THEN** 返回 404，不返回任何账本内容

#### Scenario: 没有远程调用方
- **WHEN** `config/remote.yaml` 不存在或为空，此时启动中枢
- **THEN** 7478 端口不被监听，`flow remote status` 显示"未启用"

### Requirement: 远程调用方配置
每个远程调用方 SHALL 在 `config/remote.yaml` 中定义：`id`、`actor`（不能是 `user`）、`workspaces`（可访问的 workspace 白名单，默认空）、`capabilities`（`read`、`propose`、`report` 的子集）、`include_global`（默认 false）。配置不合法时 MUST 报告文件和字段，并只停用出错的调用方。

#### Scenario: actor 写成 user
- **WHEN** `remote.yaml` 中某个调用方的 `actor` 为 `user`
- **THEN** 该调用方不被加载，`flow doctor` 报告"远程调用方不能使用 user 身份"

### Requirement: 远程认证
远程 MCP 入口的每个请求 MUST 携带有效凭证，凭证 SHALL 绑定到 `remote.yaml` 中的一个调用方；请求的操作者身份由凭证决定，请求自报的身份一律忽略。凭证缺失、无效或已撤销时返回 401。凭证可以是 `flow hub token issue` 签发的 Bearer token，或经本机用户确认后签发的 OAuth 访问令牌。

#### Scenario: 用中枢的 user token 访问远程入口
- **WHEN** 用 `state/hub.token` 的值作为 Bearer token 请求远程入口
- **THEN** 返回 401，user token 不能用于远程入口

#### Scenario: OAuth 授权需要用户本人确认
- **WHEN** 远程调用方发起 OAuth 授权
- **THEN** 只有在用户本人于本机 Web 页面上点击确认后才签发令牌，令牌绑定的 actor 与 `remote.yaml` 中的配置一致

### Requirement: 按调用方裁剪工具
远程调用方的工具列表 SHALL 只包含其 `capabilities` 允许的操作：`read` 对应知识检索、读取、查询、workspace 简报、任务列表与详情；`propose` 对应写提案和随手记；`report` 对应 `task_report`。回复任务、处理收件箱、读取密钥、建任务、取消任务、journal 写入和接受提案 MUST NOT 对远程调用方开放。所有结果 MUST 只包含白名单 workspace 内的条目；不属于任何 workspace 的条目只有在调用方配置了 `include_global: true` 时才返回；`scope: personal` 的条目 MUST NOT 返回给任何远程调用方。

#### Scenario: 调用未授权的工具
- **WHEN** 只有 `read` 能力的 `grok` 直接调用 `kb_propose`
- **THEN** 返回 `forbidden`，不产生任何写入

#### Scenario: 检索不会越过白名单
- **WHEN** `grok` 的白名单只有 `product-res`，它检索一个只在 `xuanxue-saas` 中出现的词
- **THEN** 结果为空

#### Scenario: 个人条目不外流
- **WHEN** `grok` 检索一个只出现在 `scope: personal` 条目中的词
- **THEN** 结果为空

#### Scenario: 远程调用方不能审批
- **WHEN** `grok` 试图调用 `task_reply` 或 `inbox_act`
- **THEN** 工具列表中没有这两个工具；直接调用时返回 `forbidden`

### Requirement: 远程调用审计
每次远程工具调用 SHALL 记入账本：调用方 id、actor、工具名、涉及的 workspace、结果（成功、被拒、出错），不记录检索返回的正文。`flow remote status` MUST 显示每个调用方最近一次调用的时间、过去 24 小时的调用数与被拒次数。

#### Scenario: 被拒的调用可追溯
- **WHEN** `grok` 调用了一个未授权的工具
- **THEN** 账本中有一条 `remote.call` 事件，结果为 `forbidden`，`flow remote status` 中被拒次数加一

### Requirement: 发布方式检查
`flow doctor` SHALL 在启用远程入口时检查 Tailscale 的发布配置：远程端口 MUST 只经 `tailscale serve` 发布到 tailnet 内，MUST NOT 开启 Funnel，中枢的 `/v1` 端口 MUST NOT 被发布。检测到违规时报错并给出修正命令。

#### Scenario: 误开了 Funnel
- **WHEN** 用户对远程端口执行了 `tailscale funnel`
- **THEN** `flow doctor` 报错"远程 MCP 入口被发布到了公网"，并提示 `tailscale funnel reset` 等修正方式
