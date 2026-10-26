# Spec Delta

## ADDED Requirements

### Requirement: supervisor 操作
系统 SHALL 提供 `brief_update`、`task_propose`、`ask_user`、`pr_merge_request`、`decision_review` 操作，在 `packages/core/src/ops/` 中定义并自动生成 CLI 与 MCP 工具，均由中枢执行；除 `brief_update` 允许 user 外，只有 supervisor 身份能调用。`ws_brief` SHALL 增加 supervisor 笔记与近期决策两节；workspace 启用 supervisor 时（`supervisor.enabled` 且存在 `kind: supervisor` 角色）SHALL 另向中枢取进行中的任务、待处理条目与代回复记录几节，未启用时不请求中枢、不出现这几节。总长度仍受预算限制。

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

#### Scenario: 保留目录的大小写变体
- **WHEN** 任何身份以 `Briefs/product-res`、`BRIEFS/x` 为标识写条目或提交修改提案
- **THEN** 以路径不合法拒绝（`invalid_entry_id` / `invalid_path`），brain 中不产生该文件；`ws_brief` 只读取 git 中已提交的 `briefs/<id>.md`

## MODIFIED Requirements

### Requirement: Workspace 简报
系统 SHALL 为指定的 workspace 输出一份简报，内容包括：supervisor 笔记、workspace 描述、项目卡片摘要、所拥有的资源列表、最近 N 条相关 journal、可能过时的事实，以及启用 supervisor 时由中枢提供的进行中的任务、待处理条目与代回复记录，和本 workspace 的近期决策。输出长度 MUST 受一个可配置的字符预算限制：笔记放在最前、最多占预算的 40%；其余各节分享剩余预算，放不下的节在行边界截断并标注；额度不足以保留一节的标题与少量内容时，从最低优先级的节开始整节省略，并在末尾注明省略了什么。

#### Scenario: 预算截断
- **WHEN** 以较小的预算请求 `ws/xuanxue-saas` 的简报
- **THEN** 输出不超过该预算，被截断的节带截断标注，整节省略的部分在末尾注明

#### Scenario: 长 journal 不挤掉其他节
- **WHEN** 最近 journal 远超预算，同时有进行中的任务
- **THEN** 两节都保留标题，各自截断
