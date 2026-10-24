# Telegram 渠道的安全边界

（add-m1-inbox 5.1、5.2，design D4；telegram-channel spec。上线步骤见 7.1 补写的 `docs/inbox.md`。）

Telegram 是手机上的审批入口：在这里点"批准"，等同于用户本人批准。本文写明它能防什么、不能防什么。

## 配置：`config/channels.yaml`

```yaml
telegram:
  bot_token: secret://telegram/bot-token   # 缺省即为这个引用；只接受 secret:// 引用
  proxy: http://127.0.0.1:7890             # 可选，只接受 http/https
  chat_id: 123456789                       # 绑定时写入
  user_id: 123456789                       # 绑定时写入
  # enabled: false                         # 完全停用（重启中枢后生效）
```

## 绑定、改绑与解除绑定

- `flow telegram link` 申请一次性绑定码（仅 user）：约 79 位随机，10 分钟内有效，只能用一次，中枢内存里只存摘要。
  把 `/link <码>` 发给 bot，或打开输出里的 t.me 链接。
- 绑定码按 chat 限流：同一个 chat 每分钟最多 5 次错误尝试，超出后忽略该 chat 10 分钟。一个 chat 刷错误码
  不影响别的 chat，也不会清掉已发出的码；格式不合法的码（例如路人点开旧链接）不计数，直接忽略。
- **已绑定时**，`flow telegram link` 必须加 `--rebind` 才会发码。改绑兑换成功后：
  1. 先给原 chat 发通知："渠道已改绑到另一个 Telegram 账号，若非本人操作请立即运行 `flow telegram unlink`
     并吊销 bot token"；
  2. 再切换绑定；
  3. 写一条账本事件 `channel.rebound`（actor `user`，via `telegram`），只记旧、新 chat id 的摘要，不记明文 id；
     `flow hub status` 显示最近一次改绑的时间。
- `flow telegram unlink`（仅 user）删除 `chat_id` 与 `user_id` 并提交，立即生效，并写 `channel.unlinked`。
- 绑定后，只处理该**私聊**里该**用户**的消息和按钮；其他 chat、群聊、from.id 不符、bot 账号一律忽略
  （不回复），只计数并记日志。

### 已知边界：本机进程都能申请改绑码

`/v1/telegram/link-code` 与 `/v1/telegram/unlink` 只接受 user 身份，用 user token 降级声明的 AI 身份
（`X-Flow-Actor`）返回 `user_only`。但本机上能读 `state/hub.token` 的进程（包括 worker）都能以 user 身份
申请改绑码（见 `docs/hub-auth.md` 的信任边界）。所以改绑**一定**先通知原 chat：收到不是自己发起的改绑通知时，
立即运行 `flow telegram unlink`，并按下一节处理。

## bot token 泄露

拿到 bot token 的人可以：

- **篡改消息内容**：用 editMessageText 改写 bot 已发出的消息，同时保留原来的按钮。你看到的说明可能是假的，
  而按钮点下去仍然执行原来的操作；
- **劫持送达**：自己调用 getUpdates 或设置 webhook，抢走你的回复和按钮点击，或者冒充 bot 给你发消息。

所以一旦怀疑泄露，必须**立即在 @BotFather 吊销 token**（`/revoke`），再用 `flow secrets set telegram/bot-token`
换上新的。

中枢会报告泄露的迹象（`flow hub status` 中 telegram 渠道的 ⚠ 警告），但只告警，不会自动删除 webhook：

- getUpdates 返回 409，并区分两种情况：另一个程序也在用这个 token 轮询；或 bot 被设置了 webhook；
- 启动时 getWebhookInfo 发现 bot 设置了 webhook。

token 被 Telegram 拒绝（401 / 404）时，渠道停用并在状态中报告，之后每 30 分钟用 getMe 重试一次；
换了 token（密钥变化）时会立即重新创建渠道。

## 入站与外发的脱敏

- 外发：所有文字先经 `redactSecrets`（已知密钥名单 + 疑似密钥正则），再做 HTML 转义。
- 入站：回复、`/capture`、`/ask` 的文字在交给收件箱、写入 `raw/` 或入账之前，先经 `redactSecrets`。
- `/ask` 拒绝转发来的消息（`forward_origin`）和经 inline bot 发出的消息（`via_bot`），指令必须是本人直接输入的。

## 代理

`telegram.proxy` 优先，其次是 `HTTPS_PROXY` 环境变量。

- **Bun**：fetch 的 `proxy` 选项，只作用于 Telegram 的请求。`HTTPS_PROXY` 同样生效。
- **Node**：内置 fetch 没有按请求的代理选项，改用 `http.setGlobalProxyFromEnv`。这是**进程级**的：
  中枢进程内的全部出站请求都会走这个代理（回环地址除外）。所以只有 `channels.yaml` 里**显式写了**
  `telegram.proxy` 时才启用；单独的 `HTTPS_PROXY` 环境变量不会触发（中枢会告警）。也可以用 Node 自己的
  `NODE_USE_ENV_PROXY=1` 启动，让它按环境变量处理。
