# stuck-detection Specification

## Purpose
规定节点如何判断任务卡住、卡在哪里（等待授权、提问、无进展、崩溃或节点失联），让需要人的时刻被准确地识别出来并进入收件箱，而不是靠人去盯着终端。

## Requirements

### Requirement: 卡住的原因分类
任务卡住时 SHALL 被归入一个原因：
- `awaiting_approval`：等待授权；
- `question`：在向用户提问；
- `no_progress`：长时间没有新活动；
- `crashed`：进程意外退出；
- `other`。

每次上报 `blocked` 时都 MUST 附带原因、一句话说明和最近的输出片段（默认末尾 40 行）。判断依据是各执行器提供的识别规则，执行器无法识别时归为 `other`。

#### Scenario: 等待授权
- **WHEN** Codex 终端末尾显示一个需要用户确认的命令执行请求
- **THEN** 任务以 `blocked(awaiting_approval)` 上报，说明中包含该命令

### Requirement: 无进展超时
执行器在角色设定的时长内（默认 15 分钟）没有产生任何新活动，并且没有给出判定时，节点 SHALL 上报 `blocked(no_progress)`。

#### Scenario: 长时间没有输出
- **WHEN** 一个任务的终端连续 15 分钟没有新输出，也没有忙碌标记
- **THEN** 任务变为 `blocked(no_progress)`

### Requirement: 崩溃与超时
执行器进程意外退出时，节点 SHALL 上报 `blocked(crashed)`，附带退出码和末尾输出。任务运行时间超过合同的 `timeout_s` 时，节点 MUST 停止执行器，任务以 `failed`（`timeout`）结束。

#### Scenario: 超时
- **WHEN** 一个 `timeout_s` 为 600 的任务运行到第 601 秒仍未结束
- **THEN** 执行器被停止，任务为 `failed`，原因为 `timeout`
