# Spec Delta

## ADDED Requirements

### Requirement: 已知密钥值的脱敏
中枢解析出的每个密钥值 SHALL 加入一份只在内存中的脱敏名单。账本事件载荷、任务结果、日志和渠道外发内容在写出前 MUST 把名单中的值替换为 `[secret:<路径>]`；这一步与 gitleaks 的疑似密钥扫描同时进行。

#### Scenario: worker 把 token 打印到了终端
- **WHEN** 一个任务的活动片段中出现了 Telegram bot token 的值
- **THEN** 写入账本的活动片段中，该值变为 `[secret:telegram/bot-token]`
