# Spec Delta

## ADDED Requirements

### Requirement: `/ask` 唤醒 supervisor
`/ask <workspace> <内容>` SHALL 写入 `user.instruction` 并触发 supervisor 唤醒，回复唤醒任务编号或"已排队，前面有一次唤醒在运行"；workspace 未启用 supervisor 时回复未启用。替换此前"已记录，supervisor 尚未启用"的回复。

#### Scenario: 发送指令
- **WHEN** 用户发送 `/ask product-res 补 README`
- **THEN** bot 回复包含唤醒任务编号
