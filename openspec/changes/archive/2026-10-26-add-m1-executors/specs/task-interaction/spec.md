# Spec Delta

## Purpose

规定用户（以及以后的 supervisor）怎样答复卡住的任务，以及答复怎样送达正在执行的 worker。这是"卡住 → 推送 → 回复 → 继续"闭环的执行侧。

## ADDED Requirements

### Requirement: 回复卡住的任务
系统 SHALL 提供 `task_reply` 操作。输入为任务 id，加上以下三者之一：回复文字、`approve`、`deny`（可以附带理由）。只有 `blocked` 状态的任务可以回复，对其他状态的任务回复返回 `not_blocked`。回复写入 `task.replied` 事件，记录回复者。

#### Scenario: 对运行中的任务回复
- **WHEN** 对一个 `running` 状态的任务执行 `flow task reply <id> 好的`
- **THEN** 返回 `not_blocked`，账本不新增任何事件

### Requirement: 送达与恢复
节点 SHALL 在下一次续约时取得待送达的回复，交给执行器处理。执行器确认送达后，节点上报 `task.unblocked`，任务回到 `running`。如果节点已经不再持有该任务（例如任务以 `blocked(question)` 结束了执行，或节点掉线），中枢 MUST 把任务重新排队，并把回复附在合同上，由下一次执行带上。

#### Scenario: 交互式任务的回复
- **WHEN** 用户回复一个由节点持有的 `blocked(question)` codex-orca 任务
- **THEN** 回复在下一次续约时送进终端，账本依次记录 `task.replied` 与 `task.unblocked`

#### Scenario: 无头任务的回复
- **WHEN** 用户回复一个已经结束执行的 `blocked(question)` codex-exec 任务
- **THEN** 任务重新排队，下一次执行时以该会话 id 和回复恢复

### Requirement: 审批答复不能用于提问
对 `blocked(question)` 的任务只接受文字回复，对 `blocked(awaiting_approval)` 的任务接受 `approve`、`deny` 或文字。不匹配时 MUST 返回 `reply_kind_mismatch`。

#### Scenario: 对提问点了批准
- **WHEN** 对一个 `blocked(question)` 的任务执行 `flow task reply <id> --approve`
- **THEN** 返回 `reply_kind_mismatch`
