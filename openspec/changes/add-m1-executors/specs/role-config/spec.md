# Spec Delta

## Purpose

规定角色的定义方式。角色把"做什么样的工作"与"由哪个 harness 和模型来做"解耦，换引擎时不用改任务和工作流。

## ADDED Requirements

### Requirement: 角色定义
每个角色 SHALL 由 `config/roles/<name>.yaml` 定义，至少包括：`name`、`executor`（执行器类型），以及 `prompt`（角色提示词；可以内联，也可以引用同目录下的 Markdown 文件）。可选字段：`model`、`effort`、`permissions`（各执行器自己的权限设置）、`no_progress_minutes`。配置不合法时 MUST 报告文件和字段，不加载该角色。

#### Scenario: 引用 Markdown 提示词
- **WHEN** `dev.yaml` 中写有 `prompt: dev.md`，且同目录下存在 `dev.md`
- **THEN** 加载后的角色提示词是 `dev.md` 的内容

#### Scenario: 执行器未知
- **WHEN** 某个角色的 `executor` 是 `gpt-cli`，而节点上没有这个执行器插件
- **THEN** `flow doctor` 报告该角色引用了不存在的执行器

### Requirement: 默认角色
`flow init` SHALL 补齐三个默认角色，已存在的文件不覆盖：
- `dev`：`codex-orca`，权限沿用用户当前的做法，即跳过 Codex 的审批与沙箱；
- `reviewer`：`claude-sdk`，可写文档、不可改代码，可以评论 PR；文档限于 cwd 内 `docs/**`、`**/*.md`、`**/*.mdx`，禁止 NotebookEdit。提示词要求除非合同明确要求否则不提交、不推送，结论及所写文件列在最终回复；
- `triage`：`codex-exec`，沙箱为只读。

#### Scenario: 补齐默认角色
- **WHEN** 在已初始化但没有 `config/roles/` 的 flow-home 上运行 `flow init`
- **THEN** 新增 `dev.yaml`、`reviewer.yaml`、`triage.yaml`，并在 config 仓库中提交

### Requirement: 任务按角色解析执行参数
任务合同中的 `role` SHALL 决定使用哪个执行器、提示词、模型和权限。合同里的 `executor` 与角色不一致时，以合同为准，并记入 `task.started` 事件。合同引用了未定义的角色时，创建任务 MUST 失败。

#### Scenario: 引用未定义的角色
- **WHEN** 创建任务时 `role` 为 `designer`，而 `config/roles/` 中没有这个角色
- **THEN** 创建失败，错误码为 `unknown_role`
