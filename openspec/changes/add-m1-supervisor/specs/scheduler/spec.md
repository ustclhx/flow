# Spec Delta

## ADDED Requirements

### Requirement: 巡检规则
`config/schedules.yaml` 中 `payload.kind = supervisor_patrol` 的规则 SHALL 在触发时唤醒对应 workspace 的 supervisor（origin `patrol`）。`flow init` MUST 只生成注释掉的示例，默认不启用任何巡检。

#### Scenario: 每日巡检
- **WHEN** 规则 `0 9 * * *` 在 09:00 触发
- **THEN** `schedule.fired` 落账，supervisor 被唤醒，巡检日报写入 journal 并进入每日摘要

### Requirement: 决策回看到期
中枢 SHALL 为每条 `status: approved` 的决策在回看日期当天 09:00（中枢时区）写入 `decision.review_due`，同一决策只写一次；停机期间错过的在启动后补写。

#### Scenario: 停机错过
- **WHEN** 回看日期当天中枢停机，次日启动
- **THEN** 启动后补写 `decision.review_due`
