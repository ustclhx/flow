# Spec Delta

## ADDED Requirements

### Requirement: supervisor 提问条目
supervisor SHALL 能用 `ask_user` 创建 `source: supervisor` 的条目（默认 Decide），可附 2–4 个选项。用户回复或点选项后条目 MUST 关闭为 `answered` 并写入 `supervisor.answered`；7 天未回答关闭为 `expired` 并唤醒 supervisor 一次。同一 workspace 未回答的提问超过上限时 MUST 拒绝（`too_many_questions`）。只有 user 能回复。

#### Scenario: 选项回复
- **WHEN** 用户在 Telegram 点提问条目上的选项 "B"
- **THEN** 条目关闭为 `answered`，supervisor 被唤醒并在 `inputs.wake` 中看到答复 "B"

#### Scenario: 提问不占执行槽
- **WHEN** supervisor 提问后结束本次唤醒
- **THEN** 唤醒任务 `done`，不进入 `blocked`

#### Scenario: 提问过期
- **WHEN** 提问 7 天未回答
- **THEN** 条目关闭为 `expired`，supervisor 被唤醒一次

### Requirement: 任务提案与合并审批来源
收件箱 SHALL 新增来源 `task_proposal`（动作"接受""驳回"）与 `merge_request`（动作"批准合并""驳回"），动作路由到对应的处理，不复用知识提案（`proposal`）与任务（`task`）来源的路由和自动关闭规则。

#### Scenario: 不被知识提案规则误关
- **WHEN** 一个知识修改提案被删除
- **THEN** `task_proposal` 条目不受影响

#### Scenario: 批准合并
- **WHEN** 用户对 `merge_request` 条目点"批准合并"
- **THEN** 中枢创建 merger 任务，条目关闭
