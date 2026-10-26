# Spec Delta

## ADDED Requirements

### Requirement: supervisor 操作
系统 SHALL 提供 `brief_update`、`task_propose`、`ask_user`、`pr_merge_request`、`decision_review` 操作，在 `packages/core/src/ops/` 中定义并自动生成 CLI 与 MCP 工具，均由中枢执行；除 `brief_update` 允许 user 外，只有 supervisor 身份能调用。`ws_brief` SHALL 增加 supervisor 笔记、进行中的任务、待处理条目、近期决策几节，总长度仍受预算限制。

#### Scenario: 其他 AI 身份调用
- **WHEN** reviewer 身份调用 `ask_user`
- **THEN** 返回 403 `role_not_allowed`

### Requirement: MCP 会话按 workspace 绑定
`flow mcp` SHALL 接受 `--workspace <ws>` 与 `--task <id>`。绑定后写类操作只能作用于该 workspace（否则 `workspace_mismatch`），建任务时自动以绑定的任务为 `parent`。经中枢执行的写操作 MUST 由中枢独立校验；本地执行的 `kb_journal` 只受 MCP 绑定约束。

#### Scenario: 自动填 parent
- **WHEN** 绑定 `--task t-1` 的会话调用 `task_create` 未写 `parent`
- **THEN** 请求以 `parent: t-1` 发送

### Requirement: 简报笔记路径
brain 中 `briefs/<id>.md` SHALL 是一类独立路径：只能经中枢写入（user 或 supervisor 身份），整体替换；MUST NOT 被当作条目读取、校验、索引或搜索；写入其他 workspace 的笔记 MUST 被拒绝。

#### Scenario: 写别的 workspace
- **WHEN** 绑定 `ws/product-res` 的 supervisor 写 xuanxue-saas 的笔记
- **THEN** 返回 `workspace_mismatch`

#### Scenario: 不进索引
- **WHEN** `briefs/product-res.md` 存在时运行 brain 校验与索引生成
- **THEN** 校验不报错，`index.md` 中没有该文件
