# Spec Delta

## ADDED Requirements

### Requirement: 读边界 `read_scope`
claude-sdk 角色 SHALL 支持权限字段 `read_scope: cwd`。设置后执行器 MUST 对所有工具调用检查路径类参数（含 `file_path`、`path`、`notebook_path`、Glob 的 `pattern`、Grep 的 `glob`），只允许合同工作目录与本任务私有目录内的路径，拒绝 `.` 开头的路径段、`..`、绝对路径模式与符号链接越界；带无法识别的路径类参数的非 MCP 工具一律拒绝；Flow MCP 工具不受影响。

#### Scenario: 用 Glob 越界
- **WHEN** 会话调用 Glob，`pattern` 为 `/Users/x/.ssh/*`
- **THEN** 调用被拒绝

#### Scenario: 读取中枢 token
- **WHEN** 设有 `read_scope: cwd` 的会话尝试 Read `~/flow-home/state/hub.token`
- **THEN** 调用被拒绝

### Requirement: 审查任务的准备与结构化输出
合同含 `inputs.review` 时，执行器 SHALL 在会话前用 `gh` 读取 PR、确认仓库属于本 workspace、记录 head SHA、把该 head 检出到任务私有目录下的临时 worktree 作为会话工作目录、把 diff 写入任务私有目录，任务结束后移除 worktree；会话 MUST 以符合审查结论 schema 的结构化输出结束，执行器把它与记录的 head SHA 一起写入 `result.review`；结构化输出失败（含重试用尽）时任务 `failed(review_output_invalid)`。

#### Scenario: 写入结论
- **WHEN** 审查会话返回合规结论
- **THEN** `result.review.reviewed_sha` 为会话前记录的 head，`summary` 仍为可读文字

### Requirement: supervisor 会话绑定
执行 `kind: supervisor` 角色的任务时，执行器 SHALL 以 `--actor supervisor --workspace <ws> --task <id>` 注入 Flow MCP，并设置 `FLOW_WORKSPACE`、`FLOW_TASK_ID`。

#### Scenario: 注入参数
- **WHEN** 节点运行 `ws/product-res` 的唤醒任务 `t-1`
- **THEN** MCP 进程参数包含 `--workspace ws/product-res --task t-1`
