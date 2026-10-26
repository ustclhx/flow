# executor-codex-exec Specification

## Purpose
通过 `codex exec` 无头运行 Codex，用于分诊、整理这类短任务，比交互模式更省资源。

## Requirements

### Requirement: 无头运行
执行器 SHALL 以 `codex exec --json` 在任务的工作目录中运行，沙箱模式取自角色设置（默认只读）。输出的 JSONL 事件作为活动上报，最后一条代理消息作为结果摘要，会话 id 记入结果。

#### Scenario: 只读分诊
- **WHEN** 一个 triage 任务被执行
- **THEN** Codex 在只读沙箱中运行，结果摘要是它的最后一条消息

### Requirement: 提问后恢复
运行结束时，如果最后一条消息是在向用户提问，且没有完成目标，执行器 SHALL 以 `blocked(question)` 结束这一轮执行，并保留会话 id。收到回复后，以 `codex exec resume <会话 id> <回复>` 继续执行。

#### Scenario: 回复后恢复
- **WHEN** triage 任务以提问结束，用户回复了答案
- **THEN** 执行器用同一个会话 id 恢复，任务回到 `running`
