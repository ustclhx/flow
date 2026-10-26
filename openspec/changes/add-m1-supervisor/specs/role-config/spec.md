# Spec Delta

## ADDED Requirements

### Requirement: 角色有效类别
角色 SHALL 支持可选字段 `kind: read | write | merge | supervisor`；中枢同时按配置推断类别：codex-orca 为 write；codex-exec 只读沙箱且 `permissions.config` 为空或只含白名单键（`model`、`model_reasoning_effort`）时为 read，否则 write；claude-sdk 只有在 `setting_sources` 显式为 `[]`、`disallowedTools` 列出 Bash、Edit、Write、MultiEdit、NotebookEdit、没有 `writable_paths`、`allowedTools` 中没有 Edit/Write/MultiEdit/NotebookEdit 与任何 `Bash` 规则、权限模式不是 acceptEdits/bypassPermissions/auto 时为 read，否则 write；pr-merge 为 merge；其他执行器为 write；codex-exec、claude-sdk 的 `permissions` 含推断不认识的键时为 write。read 的只读最终由执行器强制。有效类别 MUST 取声明与推断中更严格者，声明只能收紧。`kind: supervisor` MUST 显式声明、只能用于 claude-sdk、角色名 MUST 是 `supervisor`；名为 `supervisor` 但类别不是 supervisor 的角色 MUST 加载报错。supervisor 角色按配置推断不是 read 时，doctor MUST 报错，中枢不唤醒 supervisor。`flow doctor` MUST 显示每个角色的有效类别。

#### Scenario: 多个 supervisor 角色
- **WHEN** 除 `supervisor.yaml` 外，另一个角色也声明 `kind: supervisor`
- **THEN** 多出的那个角色（名字不是 `supervisor`）加载报错，doctor 报错；合法的 `supervisor` 角色照常唤醒。`findSupervisorRole` 的 `multiple_supervisor_roles` 只是兜底（角色集合不经文件加载时）

#### Scenario: supervisor 角色可写
- **WHEN** supervisor 角色有 `Bash` 允许规则、`writable_paths`，未禁用 Bash/Edit/Write/MultiEdit/NotebookEdit，或 `setting_sources` 不是 `[]`
- **THEN** doctor 报错并给出只读片段，中枢不唤醒 supervisor

#### Scenario: claude-sdk 加载项目设置
- **WHEN** claude-sdk 角色没有写 `setting_sources`，或其中包含 project、local、user
- **THEN** 有效类别为 write

#### Scenario: claude-sdk 未禁用写工具
- **WHEN** claude-sdk 角色 `setting_sources: []`，只允许 Read/Grep/Glob，但 `disallowedTools` 没有列出 MultiEdit
- **THEN** 有效类别为 write

#### Scenario: codex-exec 带 config
- **WHEN** codex-exec 角色沙箱为只读，`permissions.config` 含白名单以外的键（例如 `notify`、`mcp_servers.*`）
- **THEN** 有效类别为 write；只含 `model`、`model_reasoning_effort` 时仍为 read

#### Scenario: 未知权限键
- **WHEN** claude-sdk 或 codex-exec 角色的 `permissions` 含推断不认识的键
- **THEN** 有效类别为 write

#### Scenario: 保留名
- **WHEN** 名为 `supervisor` 的角色没有声明 `kind: supervisor`，或 `kind: supervisor` 的角色名字不是 `supervisor`
- **THEN** 角色加载报错，doctor 显示该错误

#### Scenario: 默认 reviewer
- **WHEN** reviewer 配有 `writable_paths`
- **THEN** 有效类别为 write

#### Scenario: 声明不能放宽
- **WHEN** codex-orca 角色声明 `kind: read`
- **THEN** 有效类别仍为 write，doctor 给出警告

### Requirement: supervisor、pr-reviewer 与 merger 默认角色
`flow init` SHALL 生成 `supervisor`（claude-sdk，`kind: supervisor`，只有读文件工具与 Flow MCP，`read_scope: cwd`，不加载项目设置）、`pr-reviewer`（claude-sdk，只读，`read_scope: cwd`）与 `merger`（pr-merge 执行器）模板，不覆盖已有文件；`dev` 模板的 `creatable_by` 包含 `supervisor`。已有 `dev.yaml` 缺少该值且存在 supervisor 角色时，doctor MUST 给出提示和可复制的片段。

#### Scenario: 已有用户升级
- **WHEN** 用户的 `dev.yaml` 没有 `creatable_by`，并存在 supervisor 角色
- **THEN** doctor 提示"supervisor 无法创建 dev 任务"，附 yaml 片段
