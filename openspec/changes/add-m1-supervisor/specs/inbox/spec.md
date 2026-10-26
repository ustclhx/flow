# Spec Delta

## ADDED Requirements

### Requirement: supervisor 提问条目
supervisor SHALL 能用 `ask_user` 创建 `source: supervisor` 的收件箱条目（默认 Decide），可附 2–4 个选项。用户回复或点选项后条目 MUST 关闭为 `answered` 并写入 `supervisor.answered`；7 天未回答关闭为 `expired` 并唤醒 supervisor 一次。同一 workspace 未回答的提问超过 3 条时 MUST 拒绝（`too_many_questions`）。只有 user 能回复。

#### Scenario: 选项回复
- **WHEN** 用户在 Telegram 点提问条目上的选项 "B"
- **THEN** 条目关闭为 `answered`，supervisor 被唤醒并在 `inputs.wake` 中看到答复 "B"

#### Scenario: 提问不占执行槽
- **WHEN** supervisor 提问后结束本次唤醒
- **THEN** 唤醒任务 `done`，不进入 `blocked`

### Requirement: 任务提案与合并审批条目
收件箱 SHALL 呈现任务提案条目（动作"接受""驳回"）和合并审批条目（动作"批准合并""驳回"），它们在被处理或底层对象失效（例如 PR 已关闭）时自动关闭。

#### Scenario: PR 已被手动合并
- **WHEN** 合并审批条目待处理期间，用户在 GitHub 上手动合并了该 PR
- **THEN** 条目在下次检查时关闭，supervisor 被唤醒
