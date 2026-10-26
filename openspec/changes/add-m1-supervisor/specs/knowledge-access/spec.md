# Spec Delta

## ADDED Requirements

### Requirement: supervisor 操作
系统 SHALL 提供 `brief_update`、`task_propose`、`ask_user`、`pr_merge_request`、`decision_review` 操作，均在 `packages/core/src/ops/` 中定义，自动生成 CLI 与 MCP 工具；只有 `supervisor` 身份（以及 user 用于调试）能调用。`ws_brief` SHALL 增加 supervisor 笔记、进行中的任务、待处理条目、近期决策几节，总长度仍受预算限制。

#### Scenario: 其他 AI 身份调用
- **WHEN** `reviewer` 身份调用 `ask_user`
- **THEN** 返回 403 `role_not_allowed`

### Requirement: MCP 会话按 workspace 绑定
`flow mcp` SHALL 接受 `--workspace <ws>` 与 `--task <id>`。绑定后写类操作只能作用于该 workspace（否则 `workspace_mismatch`），建任务时自动以绑定的任务为 `parent`；读类操作不受限。中枢对 supervisor 身份的写请求 MUST 独立校验 workspace 与 `parent`，MCP 层的绑定只作为第一道防线。

#### Scenario: 自动填 parent
- **WHEN** 绑定 `--task t-1` 的会话调用 `task_create` 未写 `parent`
- **THEN** 请求以 `parent: t-1` 发送

### Requirement: 简报笔记路径
brain 中 `briefs/<workspace id>.md` SHALL 是一类独立路径：只有 user 与 `supervisor` 身份能写，整体替换，不作为条目进入 `index.md`；AI 写入其他 workspace 的笔记 MUST 被拒绝。

#### Scenario: 写别的 workspace
- **WHEN** 绑定 `ws/product-res` 的 supervisor 写 `briefs/xuanxue-saas.md`
- **THEN** 返回 `workspace_mismatch`
