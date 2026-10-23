# Spec Delta

## Purpose

用 Telegram Bot 作为 Flow 的首个手机渠道：推送、审批和回复都在同一个对话里完成，而且不需要中枢暴露公网端口。

## ADDED Requirements

### Requirement: 绑定用户本人
`flow telegram link` SHALL 生成一个 10 分钟内有效的一次性绑定码。用户在 Telegram 中向 bot 发送 `/start <绑定码>` 后，该 chat 被记录为唯一的用户 chat。来自其他 chat 的任何消息和按钮操作 MUST 被忽略，并记入日志。

#### Scenario: 陌生人给 bot 发消息
- **WHEN** 一个未绑定的 Telegram 账号向 bot 发送 `/inbox`
- **THEN** bot 不回复任何内容，中枢日志记录一次被忽略的访问

### Requirement: 长轮询收取
渠道 SHALL 通过 long polling 从 Telegram 收取更新，不使用 webhook；处理进度保存在 `state/` 中，重启后不重复处理同一条更新。

#### Scenario: 中枢重启
- **WHEN** 中枢在处理完第 100 条更新后重启
- **THEN** 重启后从第 101 条继续，第 100 条不会被再处理一次

### Requirement: 条目消息与交互
每个推送的条目 SHALL 是一条消息，包括：workspace、标题、正文、截断后的输出片段，以及与可用操作对应的内联按钮（批准、驳回、接受、拒绝、忽略）。
- 用户点击按钮：执行对应的操作，然后把消息改为处理结果。
- 用户直接回复这条消息的文字：作为该条目的"回复"操作。

#### Scenario: 回复卡住的 Codex
- **WHEN** 用户在 Telegram 中直接回复一条 `blocked(question)` 的条目消息："用方案 A"
- **THEN** 对应任务收到这条回复，消息被改为"已回复"

### Requirement: 命令
bot SHALL 支持以下命令：
- `/inbox`：列出未关闭的条目；
- `/status`：中枢与节点状态，以及运行中和卡住的任务数；
- `/capture <内容>`：随手记，写入 `raw/inbox/`，来源为 `telegram`；
- `/ask <workspace> <内容>`：写入一条 `user.instruction` 事件，由变更 ④ 的 supervisor 处理；在 ④ 上线之前，回复"已记录，supervisor 尚未启用"。

#### Scenario: 手机上随手记
- **WHEN** 用户发送 `/capture 东方站可以加日语`
- **THEN** `raw/inbox/` 新增一条来源为 `telegram` 的记录，bot 回复确认
