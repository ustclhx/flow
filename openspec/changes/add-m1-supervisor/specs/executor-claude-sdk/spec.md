# Spec Delta

## ADDED Requirements

### Requirement: 审查任务的结构化输出
合同含 `inputs.review` 时，claude-sdk 执行器 SHALL 要求会话以符合审查结论 schema 的结构化结果结束，并写入 `result.review`；不合规时任务 `failed(review_output_invalid)`。

#### Scenario: 写入结论
- **WHEN** 审查会话返回合规结论
- **THEN** `result.review` 与 schema 一致，`summary` 仍为可读文字

### Requirement: supervisor 会话绑定
执行 `role: supervisor` 的任务时，执行器 SHALL 以 `--actor supervisor --workspace <ws> --task <id>` 注入 Flow MCP，并设置 `FLOW_WORKSPACE`、`FLOW_TASK_ID`。

#### Scenario: 注入参数
- **WHEN** 节点运行 `ws/product-res` 的唤醒任务 `t-1`
- **THEN** MCP 进程参数包含 `--workspace ws/product-res --task t-1`
