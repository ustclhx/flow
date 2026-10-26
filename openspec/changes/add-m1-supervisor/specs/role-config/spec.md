# Spec Delta

## ADDED Requirements

### Requirement: 角色有效类别
角色 SHALL 支持可选字段 `kind: read | write | merge | supervisor`；中枢同时按配置推断类别（codex-orca 为 write；codex-exec 只读沙箱为 read，否则 write；claude-sdk 有 `writable_paths`、允许 Edit/Write/NotebookEdit 或任何 `Bash(...)` 规则时为 write，否则 read；pr-merge 为 merge）。有效类别 MUST 取声明与推断中更严格者，声明只能收紧。`kind: supervisor` MUST 显式声明且只能用于 claude-sdk。`flow doctor` MUST 显示每个角色的有效类别。

#### Scenario: 多个 supervisor 角色
- **WHEN** 有两个角色声明 `kind: supervisor`
- **THEN** doctor 报错，中枢不唤醒 supervisor

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
