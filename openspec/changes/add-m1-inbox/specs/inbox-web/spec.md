# Spec Delta

## Purpose

在本机提供一个"需要我的"页面，作为 Web 工作台的第一屏，供用户在电脑前批量处理条目。

## ADDED Requirements

### Requirement: 页面内容
中枢 SHALL 在 `/ui` 提供一个页面，按级别分组列出未关闭的条目。每个条目显示：workspace、标题、正文、输出片段、时间，以及操作按钮。用户的操作通过同一套收件箱操作执行，执行后页面局部刷新。

#### Scenario: 在页面上批准
- **WHEN** 用户在页面上点击某个审批条目的"批准"
- **THEN** 对应任务收到批准，条目从列表中移除，Telegram 中的消息同步更新

### Requirement: 本机登录
页面 SHALL 只能通过回环地址访问。`flow ui` 生成一个一次性登录链接，并在浏览器中打开；打开后写入一个 HttpOnly 会话 cookie。没有有效会话的请求 MUST 被拒绝。

#### Scenario: 直接访问页面
- **WHEN** 不经过 `flow ui`，直接在浏览器中打开 `http://127.0.0.1:7477/ui`
- **THEN** 页面提示运行 `flow ui` 登录，不显示任何条目
