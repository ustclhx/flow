# Spec Delta

## Purpose

规定定时触发的配置方式与行为，让巡检、日报这类周期性工作由中枢按时发起，而不依赖用户记得去做。

## ADDED Requirements

### Requirement: 定时规则配置
定时规则 SHALL 写在 `config/schedules.yaml` 中，每条规则包括：id、cron 表达式、时区（默认本机时区）、所属 workspace，以及触发时写入事件的载荷。配置不合法时，中枢 MUST 拒绝加载该规则并记录错误，其余规则照常生效。

#### Scenario: 一条规则写错
- **WHEN** `schedules.yaml` 中有两条规则，其中一条的 cron 表达式不合法
- **THEN** 合法的那条照常触发，`flow hub status` 中报告另一条的错误

### Requirement: 到点写入事件
规则到点时，中枢 SHALL 向账本写入一条 `schedule.fired` 事件，其中包含规则 id、计划时间和载荷。同一规则的同一个计划时间 MUST 只触发一次，即使中枢在这期间重启。

#### Scenario: 重启不重复触发
- **WHEN** 规则在 09:00 触发后，中枢在 09:00:30 重启
- **THEN** 账本中这条规则在 09:00 的 `schedule.fired` 只有一条

### Requirement: 错过的触发
中枢停机期间错过的触发，重启后 SHALL 只补发最近一次，并在事件中标记 `missed: true`，不逐次补发。

#### Scenario: Mac 合盖一夜
- **WHEN** 一条每小时触发的规则在中枢停机的 8 小时内错过了 8 次
- **THEN** 中枢恢复后只写入一条带 `missed: true` 的 `schedule.fired`
