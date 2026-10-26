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

### Requirement: 委托给 supervisor 的条目
任务卡住被委托给 supervisor 时，收件箱条目 SHALL 照常生成并标明"supervisor 处理中"，MUST NOT 推送到通知渠道；用户仍可在 Web、CLI 或 Telegram 上直接处理。supervisor 回复后条目仍按现有自动关闭规则在任务离开 `blocked` 时关闭，并记录回复者为 supervisor（`task.replied.via: supervisor`）；回复未送达、任务仍卡着时条目 MUST 保持打开。转交用户时条目 MUST 按原级别推送；用户忽略委托中的条目视为转交并结束委托。

#### Scenario: 委托期间不打扰
- **WHEN** 一个 `awaiting_approval` 条目被委托给 supervisor
- **THEN** Telegram 不发消息，Web 收件箱显示该条目与"supervisor 处理中"

#### Scenario: 转交后推送
- **WHEN** supervisor 对该条目 `escalate`
- **THEN** Telegram 按条目级别推送，条目注明 supervisor 给出的理由
