# 收件箱与 Telegram 上线

本文记录变更 ③（add-m1-inbox）在真实环境上线的步骤（任务 7.1）和端到端验证结果（任务 7.2）。
渠道的安全边界见 `docs/telegram.md`，密钥命令见 `docs/secrets.md`，身份与接口见 `docs/hub-auth.md`。

## 上线步骤

按顺序执行，全部在用户本人的终端里完成；AI 不参与读取或输入密钥。

1. 安装依赖：`brew install sops age gitleaks`。
2. 初始化密钥：`flow secrets init`。生成 `~/.config/sops/age/keys.txt`（0600）以及 config 仓库里的
   `.sops.yaml`、`secrets.sops.yaml`。
3. **立即离线备份** `~/.config/sops/age/keys.txt`（纸质或密码管理器）。丢失后已有密文无法恢复。
4. 在 Telegram 里找 @BotFather，`/newbot` 创建 bot，拿到 bot token。
5. `flow secrets set telegram/bot-token`，在不回显的提示里粘贴 token。不要把 token 写在命令行参数里。
6. 重启中枢，让它解析新密钥：`launchctl kickstart -k gui/$(id -u)/dev.flow.hub`。
   `flow hub status` 的"推送渠道"一行应变为 `telegram：正常`（绑定前会提示尚未绑定 chat）。
7. `flow telegram link`，点它输出的链接，或把绑定码发给 bot。绑定后 `config/channels.yaml`
   记录 chat 与用户 id，并自动提交到 config 仓库。
8. （可选）`flow doctor`，确认全部检查通过。

## 端到端验证记录（2026-10-25 / 26）

环境：macOS，launchd 托管的中枢与节点，sops 3.13.3、age 1.3.2。中枢经本机透明代理访问 Telegram。

| 场景 | 做法 | 结果 |
|---|---|---|
| 手机批准 | claude-sdk reviewer 任务请求执行 `git show …`，用户在 Telegram 点批准 | `task.replied{kind: approve, via: telegram}`，条目以 `task_running` 关闭，任务完成 |
| 手机回复提问 | fake 执行器 `blocked(question)`，用户直接回复推送消息 | `task.replied{kind: text, via: telegram}` → `requeued_with_reply` → done；推送消息被改为已处理（`inbox.pushed{op: update}`），bot 回"已回复" |
| `/capture` | 直接给 bot 发 `/capture test` | 写入 `raw/inbox/<时间>-<id>.md`（`source: telegram`），raw 仓库自动提交，bot 回"已记下" |
| 网页批准 | fake 执行器 `blocked(awaiting_approval)`，`flow ui` 登录后在网页批准 | `task.replied{kind: approve, via: web}`，条目关闭，任务完成 |

排查记录：第一次测试时 bot 没有任何回应，账本与 `state/telegram.json` 的 offset 也没有变化。
原因是手机端消息没有发出去，不是中枢的问题。判断入站是否到达，可以看
`state/telegram.json` 的 `offset` 是否前进、账本里是否出现对应事件。
