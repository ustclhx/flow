# Spec Delta

## ADDED Requirements

### Requirement: 续约携带待送达的回复
续约响应 SHALL 在 `cancel_requested` 之外，带上该任务待送达的回复（如有）。节点送达后，在下一次续约或单独的确认请求中报告送达结果，中枢据此写入 `task.unblocked`，并把这条回复标记为已送达。同一条回复 MUST 只被送达一次。

#### Scenario: 续约时取得回复
- **WHEN** 任务处于 `blocked(question)` 且用户已回复，节点发起续约
- **THEN** 续约响应中包含这条回复；节点确认后，后续续约不再返回它
