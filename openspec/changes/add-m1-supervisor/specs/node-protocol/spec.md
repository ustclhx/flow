# Spec Delta

## ADDED Requirements

### Requirement: supervisor 预留执行槽
领取租约请求 SHALL 支持可选字段 `slots: {general, supervisor}`；中枢只把 `kind: supervisor` 的任务分给 supervisor 空位，普通空位也可以接。没有该字段的节点 MUST 被视为只有普通空位。`node.yaml` SHALL 支持 `reserved.supervisor`（默认 1），节点在普通槽位已满时仍为 supervisor 空位发起领取。

#### Scenario: dev 任务卡住时仍能唤醒
- **WHEN** `concurrency: 1` 的节点上一个 dev 任务处于 `blocked` 并持有租约
- **THEN** 新的唤醒任务仍被该节点领取并运行

#### Scenario: 旧节点
- **WHEN** 不带 `slots` 字段的节点领取任务
- **THEN** 中枢按原有并发语义分配，不报错
