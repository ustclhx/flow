# task-verification Specification

## Purpose
规定执行器完成后的验收步骤，确保"没有验证就不算完成"（PRD 原则 4）由内核执行，而不是靠 worker 的自我报告。

## Requirements

### Requirement: 运行验收命令
合同带有 `verify` 命令时，执行器报告完成后，节点 SHALL 把任务转为 `verifying`，在任务的工作目录中按顺序执行每一条命令。命令以 argv 方式执行，不经过 shell；每条命令都有超时（默认 10 分钟）。全部退出码为 0 时，任务为 `done`；任何一条失败，任务即为 `failed`（`verify_failed`），后续命令不再执行。

#### Scenario: 测试失败
- **WHEN** 合同的验收命令是 `bun test`，执行器完成后测试有失败
- **THEN** 任务为 `failed`，结果中包含这条命令的退出码和输出末尾

### Requirement: 验收结果入账
每条验收命令的 argv、退出码、耗时和输出末尾 SHALL 记入任务结果；输出写入前 MUST 经过密钥脱敏。

#### Scenario: 输出里有疑似密钥
- **WHEN** 验收命令的输出中出现一个疑似 API key
- **THEN** 记入结果的输出中，该值已被替换为脱敏标记
