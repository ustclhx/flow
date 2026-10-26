# Spec Delta

## ADDED Requirements

### Requirement: supervisor 预留执行槽
`node.yaml` SHALL 支持 `reserved.supervisor`（默认 1）。节点领取任务时 MUST 在普通并发之外为 `role: supervisor` 的任务保留该数量的槽位；普通任务 MUST NOT 占用预留槽位。

#### Scenario: dev 任务卡住时仍能唤醒
- **WHEN** `concurrency: 1` 的节点上一个 dev 任务处于 `blocked` 并持有租约
- **THEN** 新的 supervisor 唤醒任务仍被该节点领取并运行
