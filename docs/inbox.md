# 收件箱与 Telegram 上线

本文记录变更 ③（add-m1-inbox）在真实环境上线的步骤（任务 7.1）和端到端验证结果（任务 7.2）。
渠道的安全边界见 `docs/telegram.md`，密钥命令见 `docs/secrets.md`，身份与接口见 `docs/hub-auth.md`。

## 任务重试通知

任务重试由事件驱动：用户或 supervisor 重试符合条件的 blocked 或 failed 任务时，中枢根据已提交的重试事件生成
`source: task_retry` 的收件箱条目。条目记录重试派工、发起者、上次结局与理由；任务此时已回到
`queued`，等待下一次派工，通知不代表执行器已经开始执行。supervisor 发起重试必须提供理由，
用户发起时理由可选。

`reason` 表示重试发起者：`supervisor` 默认使用 `interrupt`，通过已有通知渠道推送，并遵循
静默时段规则；`user` 默认使用 `digest`，不单独推送。每日摘要展示 Digest 级重试条目的标题和
正文，写入摘要后以 `digested` 关闭；未降级的 Interrupt 重试条目不会被摘要提前关闭。
摘要沿用现有条数与正文长度上限，完整内容可在原条目查看。
任务进入 done、failed 或 cancelled 终态时，自动关闭该任务此前生成的所有重试条目，
关闭原因分别是 `task_done`、`task_failed`、`task_cancelled`；之后再次重试生成的新条目不受旧终态影响。
此规则也包括尚未汇总的 Digest 条目：它们关闭后不会再进入每日摘要，原始通知与关闭记录仍可查询。

可以在 `config/inbox.yaml` 按来源、发起者和 workspace 覆盖级别。例如：

```yaml
levels:
  - source: task_retry
    reason: supervisor
    level: digest
  - source: task_retry
    reason: user
    workspace: ws/product-res
    level: interrupt
```

规则中列出的条件必须全部命中；条件更多的规则优先，同样多时后写的覆盖先写的。
来源、发起者或字段拼写错误，以及不匹配的 source/reason 组合，都会被报告，该规则不生效。
例如 `source: task` 不能使用 `reason: user`，`source: task_retry` 只能使用 `reason: user` 或 `reason: supervisor`。
重试条目的标识由源事件确定，重复处理或重启回放不会重复生成；每日摘要也按计划日期幂等生成，
重启补发与重复触发不会再次汇总已关闭的重试条目。

## 上线步骤

按顺序执行，全部在用户本人的终端里完成；AI 不参与读取或输入密钥。

1. 安装依赖：`brew install sops age gitleaks`。
2. 初始化密钥：`raindown secrets init`。生成 `~/.config/sops/age/keys.txt`（0600）以及 config 仓库里的
   `.sops.yaml`、`secrets.sops.yaml`。
3. **立即离线备份** `~/.config/sops/age/keys.txt`（纸质或密码管理器）。丢失后已有密文无法恢复。
4. 在 Telegram 里找 @BotFather，`/newbot` 创建 bot，拿到 bot token。
5. `raindown secrets set telegram/bot-token`，在不回显的提示里粘贴 token。不要把 token 写在命令行参数里。
6. 重启中枢，让它解析新密钥：`launchctl kickstart -k gui/$(id -u)/dev.raindown.hub`。
   `raindown hub status` 的"推送渠道"一行应变为 `telegram：正常`（绑定前会提示尚未绑定 chat）。
7. `raindown telegram link`，点它输出的链接，或把绑定码发给 bot。绑定后 `config/channels.yaml`
   记录 chat 与用户 id，并自动提交到 config 仓库。
8. （可选）`raindown doctor`，确认全部检查通过。

## 端到端验证记录（2026-10-25 / 26）

环境：macOS，launchd 托管的中枢与节点，sops 3.13.3、age 1.3.2。中枢经本机透明代理访问 Telegram。

| 场景 | 做法 | 结果 |
|---|---|---|
| 手机批准 | claude-sdk reviewer 任务请求执行 `git show …`，用户在 Telegram 点批准 | `task.replied{kind: approve, via: telegram}`，条目以 `task_running` 关闭，任务完成 |
| 手机回复提问 | fake 执行器 `blocked(question)`，用户直接回复推送消息 | `task.replied{kind: text, via: telegram}` → `requeued_with_reply` → done；推送消息被改为已处理（`inbox.pushed{op: update}`），bot 回"已回复" |
| `/capture` | 直接给 bot 发 `/capture test` | 写入 `raw/inbox/<时间>-<id>.md`（`source: telegram`），raw 仓库自动提交，bot 回"已记下" |
| 网页批准 | fake 执行器 `blocked(awaiting_approval)`，`raindown ui` 登录后在网页批准 | `task.replied{kind: approve, via: web}`，条目关闭，任务完成 |

排查记录：第一次测试时 bot 没有任何回应，账本与 `state/telegram.json` 的 offset 也没有变化。
原因是手机端消息没有发出去，不是中枢的问题。判断入站是否到达，可以看
`state/telegram.json` 的 `offset` 是否前进、账本里是否出现对应事件。
