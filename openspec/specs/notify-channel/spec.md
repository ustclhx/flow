# notify-channel Specification

## Purpose
规定推送渠道插件的接口，使 Telegram 之外的渠道（ntfy、Grok Bot 等）以后只需要新增一个插件。

## Requirements

### Requirement: 渠道插件接口
推送渠道 SHALL 以插件形式实现，并提供以下能力：
- 发送一个条目或一条合并消息，返回渠道内的消息引用；
- 更新已发送的消息，例如标记为已处理；
- 把用户在渠道中的操作（按钮、回复、命令）转换为统一的操作请求，交给收件箱。

渠道在中枢进程内运行，渠道故障 MUST NOT 影响中枢的其他功能。

#### Scenario: 渠道暂时不可用
- **WHEN** Telegram API 连续请求失败
- **THEN** 中枢记录警告并按退避策略重试，条目保留在收件箱中，恢复后补推

### Requirement: 外发内容脱敏
所有发往渠道的文本 SHALL 先经过密钥脱敏：去掉已知密钥值，并做疑似密钥扫描。终端输出片段 MUST 截断到配置的长度（默认 1500 字符）。

#### Scenario: 终端片段里有 token
- **WHEN** 一个卡住任务的末尾输出中包含已知的 Cloudflare token 值
- **THEN** 推送到 Telegram 的消息中，该值已被替换为脱敏标记
