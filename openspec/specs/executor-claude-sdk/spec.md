# executor-claude-sdk Specification

## Purpose
通过 Claude Agent SDK 无头运行 Claude Code，用于审查、分析这类不需要人一直盯着的任务，并让工具审批进入 Flow 的审批流程。

## Requirements

### Requirement: 按角色运行
执行器 SHALL 以任务的工作目录、角色的提示词（追加在 Claude Code 预设提示词之后）、模型和权限运行 Claude Agent SDK。默认只加载项目级设置，不加载用户级全局设置，避免把用户个人的协调规则带入 worker。执行过程中的助手消息与工具调用摘要作为活动上报。

#### Scenario: 审查一个 PR
- **WHEN** 一个 reviewer 任务的目标是审查某个 PR
- **THEN** Claude 在该仓库目录中运行，账本中可以看到它的活动，结束时结果包含审查摘要

### Requirement: 注入 Flow MCP
执行器 SHALL 为每次运行注入 `flow` MCP 服务（`flow mcp --actor <角色名>`），使 worker 可以检索知识库、写 journal、提交提案，且受 AI 写入边界约束。

只有一份固定清单中的 flow 工具不经审批放行：`kb_search`、`kb_get`、`kb_query`、`kb_journal`、`capture`、`kb_propose`、`ws_brief`、`task_list`、`task_show`。其余 flow 工具 MUST 走工具审批，包括 `task_create`、`task_cancel` 和以后新增的工具。原因是 `task_create` 可以创建其他角色的任务（例如 `dev` 角色以 `danger-full-access` 运行），受限角色借此就能提权。

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

### Requirement: 文档文件写入边界
仅 claude-sdk 角色 MAY 配置 `permissions.writable_paths`，其他执行器配置时 MUST 报字段错误；codex-orca、codex-exec 执行器也 MUST 在运行前拒绝该字段。该字段使用 cwd 相对路径 glob，支持 `*`、`**`、`?`，不支持花括号。配置后，执行器 MUST 对 Write、Edit、MultiEdit 的原路径与符号链接解析后的真实路径都做匹配，并限制在合同 cwd 内；任何 `..` 路径段、cwd 外路径、任意层级的隐藏路径段、代理指令文件（CLAUDE.md、CLAUDE.local.md、AGENT.md、AGENTS.md、AGENTS.override.md、CONVENTIONS.md、GEMINI.md、copilot-instructions.md，每个路径段先 normalize('NFKC') 再 toUpperCase().toLowerCase() 比较）与 NotebookEdit MUST 直接拒绝，不进入策略预检或用户审批。新文件 MUST 校验最近已存在祖先；无法可靠解析时拒绝。

默认 reviewer 白名单 SHALL 为 `docs/**/*.{md,mdx,txt,png,svg,jpg,jpeg,gif,webp}`（模板展开为多条）、`**/*.md`、`**/*.mdx`。空白名单禁止文件工具写入；字段缺省时不新增写入授权，沿用既有 SDK 权限与审批。执行器 SHALL 在 canUseTool 与 PreToolUse hook 中使用同一校验，避免 SDK 权限模式、允许规则或会话批准绕过边界。PreToolUse MUST 省略 matcher 以匹配所有工具；未知的非 MCP 工具带 file_path、notebook_path 或 path 字段时 MUST 拒绝，已知只读工具和 mcp__ 前缀工具沿用原有权限流程，不因 path 字段直接放行或拒绝。成功 PostToolUse 的文件路径 SHALL 去重写入 result.artifacts，授权本身不算产物。

#### Scenario: 写审查报告
- **WHEN** reviewer 在合同 cwd 中通过 Write 创建 `docs/reviews/report.md` 或通过 Edit/MultiEdit 修改根目录 Markdown
- **THEN** 调用无需审批，成功后结果产物包含该文件的绝对路径

#### Scenario: 禁止代码与越界写入
- **WHEN** reviewer 请求修改 `src/main.ts`、`.git/report.md`、`../report.md`、指向 cwd 外的符号链接路径或使用 NotebookEdit
- **THEN** 调用直接拒绝，即使 SDK 允许规则或 Flow 自动策略原本会放行

#### Scenario: 不可信 PR 诱导改写代理指令或执行配置
- **WHEN** reviewer 请求写入任意层级的隐藏文件、CLAUDE.md 等代理指令文件或指向这些路径的符号链接
- **THEN** 即使角色将 writable_paths 放宽为 **，也直接拒绝；默认模板另拒绝 docs/conf.py 等可执行配置

指令文件清单仅是尽力而为的防护，不能阻止代理经 @引用 间接读取普通文档。敏感仓库可将白名单收窄到 docs/** 范围，移除全仓库 Markdown 规则，仍保留文档扩展名限制。

#### Scenario: Unicode 折叠与中文文档
- **WHEN** reviewer 请求写入 AGENTſ.md、copilot-instructionſ.md 或全角指令文件名、隐藏路径名
- **THEN** 即使白名单为 ** 也拒绝；普通中文文档名仍按白名单允许，实际路径不被规范化改写

#### Scenario: 新增路径工具与 MCP 资源读取
- **WHEN** 配置 writable_paths 后，一个未知非 MCP 工具携带 file_path、notebook_path 或 path 字段
- **THEN** 在 PreToolUse 直接拒绝；同样带 path 的 MCP 工具仍走原有策略与审批，不能因兜底误拒绝或直接放行

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
