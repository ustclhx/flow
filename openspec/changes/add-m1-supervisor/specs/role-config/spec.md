# Spec Delta

## ADDED Requirements

### Requirement: 角色类别 `kind`
角色 SHALL 支持可选字段 `kind: write | read | merge`；缺省时按执行器与权限推断（codex-orca 为 write；codex-exec 为 read；claude-sdk 配有 `writable_paths` 或允许 Edit/Write 为 write，否则 read；pr-merge 为 merge）。`flow doctor` MUST 显示每个角色的类别。

#### Scenario: 推断 reviewer
- **WHEN** reviewer 配有 `writable_paths`
- **THEN** doctor 显示其类别为 write

### Requirement: supervisor 与 merger 默认角色
`flow init` SHALL 生成 `supervisor`（claude-sdk，只有读文件工具与 Flow MCP，不加载项目设置）与 `merger`（pr-merge 执行器）角色模板，不覆盖已有文件；`dev` 模板的 `creatable_by` 包含 `supervisor`。已有 `dev.yaml` 没有该值且启用了 supervisor 时，doctor MUST 给出提示和可复制的片段。

#### Scenario: 已有用户升级
- **WHEN** 用户的 `dev.yaml` 没有 `creatable_by`，并存在 `supervisor` 角色
- **THEN** doctor 提示"supervisor 无法创建 dev 任务"，附 yaml 片段
