# Spec Delta

## MODIFIED Requirements

### Requirement: Token 认证
除健康检查外，所有 API 都 MUST 携带 `Authorization: Bearer <token>`。认证失败返回 401，且不泄露任何账本内容。请求的操作者身份 SHALL 由 token 决定：
- `state/hub.token`（首次启动时生成，权限 0600）是 `user` 的 token；持有者可以用 `X-Flow-Actor` 声明一个非 `user` 的身份，不声明时身份为 `user`；
- `flow hub token issue <actor>` 签发的 token 绑定一个非 `user` 的操作者，中枢只保存其摘要；使用这类 token 时身份固定为绑定的操作者，`X-Flow-Actor` 与之不一致时 MUST 返回 403，错误码为 `actor_mismatch`；
- 被 `flow hub token revoke` 撤销的 token MUST 立即失效。

#### Scenario: 缺少 token
- **WHEN** 不带 token 请求 `GET /v1/tasks`
- **THEN** 返回 401，错误码为 `unauthorized`

#### Scenario: 绑定 token 冒充用户
- **WHEN** 使用签发给 `grok` 的 token 请求，并在请求头中声明 `X-Flow-Actor: user`
- **THEN** 返回 403，错误码为 `actor_mismatch`，不产生任何事件

#### Scenario: 撤销后失效
- **WHEN** 用户运行 `flow hub token revoke <id>` 之后，再用该 token 请求 `GET /v1/tasks`
- **THEN** 返回 401，错误码为 `unauthorized`

## ADDED Requirements

### Requirement: 只有用户能做的操作
回复任务、处理收件箱条目（"忽略自己发起的条目"除外）、读取密钥、管理 token 这几类接口，中枢 SHALL 校验请求身份为 `user`，否则 MUST 返回 403，错误码为 `user_only`，并且不产生任何事件。

#### Scenario: AI 批准自己的审批请求
- **WHEN** 一个以 `codex` 身份运行的 worker 调用 `POST /v1/tasks/<自己的任务>/reply`，内容为批准
- **THEN** 返回 403，错误码为 `user_only`，任务仍处于 `blocked(awaiting_approval)`
