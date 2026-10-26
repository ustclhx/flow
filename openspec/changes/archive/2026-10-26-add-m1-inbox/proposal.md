# Proposal

## Why

变更 ① 和 ② 让任务能在后台运行，卡住时也能被识别出来，但用户仍然要自己去问"有没有什么在等我"。本变更补上注意力这一侧（PRD 原则 3、§10、§19 第 6 条）：

- 需要用户的事情汇成一个**收件箱**，按紧急程度分级推送到用户手机（Telegram）；
- 用户在手机上点一下或回一句，就能完成审批和答复；
- 能被**策略**自动处理的事情不再打扰用户。

Telegram bot token 是 Flow 需要保管的第一个密钥，所以 sops + age 密钥提供器也放在本变更中。

## What Changes

- **收件箱**：任务卡住、提案待确认、supervisor 的提问（变更 ④ 接入）等都生成收件箱条目，分三级：
  - **Interrupt**：立即推送，静默时段内顺延；
  - **Decide**：成批推送；
  - **Digest**：写进每日摘要。

  条目会随底层状态自动关闭，例如任务已经继续执行、提案已经处理。每个条目可以携带操作：批准、驳回、回复、接受提案、忽略。
- **策略引擎**：`config/policies.yaml` 采用"范围 × 动作 × 档位"的统一模型。
  - 执行器发出的审批请求先经过策略判断：
    - `auto`：直接放行；
    - `auto-report`：放行，并记入 Digest；
    - `draft-approve` 或 `notify`：生成收件箱条目，等待用户；
    - 没有配置：生成收件箱条目，等待用户。到这一步之前，harness 自带的自动审批已经处理过一轮。
  - 每次判断都记入账本，便于审计。
- **推送渠道插件接口**，以及首个渠道 **Telegram Bot**：
  - 用 long polling 收取消息，中枢不需要对外开放端口；
  - 用一次性绑定码把 bot 绑定到用户本人的 chat，其他 chat 的消息一律忽略；
  - 内联按钮用于审批；直接回复条目消息，就等于回复对应的任务；
  - `/inbox`、`/status`、`/capture <内容>`（随手记）、`/ask <ws> <内容>`（给 supervisor 的指令，先写入账本，由变更 ④ 处理）。
  - 所有外发内容都要先经过密钥脱敏。
- **Web 页面"需要我的"**：中枢在本机提供一个页面，列出待处理的条目，可以直接操作。用 `flow ui` 打开，打开时自动完成一次性登录。
- **密钥提供器**：sops + age 的实现。
  - `flow secrets init`：生成 age 密钥，并在 `config/` 中建立 `.sops.yaml` 和加密的 `secrets.sops.yaml`；
  - `flow secrets set` / `flow secrets get`；
  - 配置中用 `secret://<路径>` 引用密钥，由中枢在运行时解析；
  - 已知的密钥值会加入脱敏名单。
- **按 token 绑定操作者身份**：现在中枢只有一个 token，操作者由请求头 `X-Flow-Actor` 自报，拿到 token 的调用方可以自称 `user`。改为每个 token 绑定一个操作者：
  - `state/hub.token` 仍是 `user` 的 token，它可以在请求头中声明一个非 `user` 的 AI 身份（只能降级，供本机 MCP 进程使用）；
  - `flow hub token issue|list|revoke` 为节点和远程 AI（变更 ⑤ 接入 Grok Bot）签发绑定身份的 token，中枢只保存摘要；这类 token 的身份由中枢强制，忽略请求头；
  - 回复任务、处理收件箱条目、读取密钥等只有用户能做的操作，由中枢按 token 的身份校验，不再只靠 MCP 层的限制。
- **不在本次范围**：
  - supervisor 消费 `/ask` 指令、提问和定时巡检（变更 ④）；
  - 其他推送渠道（ntfy、Grok Bot 等）；
  - 完整的 Web 工作台（M5）。

## Capabilities

### New Capabilities

- `inbox`：条目的来源、分级、生命周期、操作和推送节奏。
- `policy-engine`：策略模型、匹配与判定、审计。
- `notify-channel`：推送渠道插件接口。
- `telegram-channel`：Telegram Bot 渠道的绑定、推送、交互与安全。
- `inbox-web`：本机"需要我的"页面。
- `secret-provider`：sops + age 密钥的初始化、读写、解析与脱敏。

### Modified Capabilities

- `secret-hygiene`：密钥引用从"只约定语法"扩展为"由中枢在运行时解析"；已解析的密钥值加入写入前扫描与外发内容的脱敏。

## Impact

- **代码**：
  - `packages/hub` 新增 inbox、policy、channels（telegram）、ui、secrets 模块；
  - `packages/core` 新增策略与收件箱的 schema，以及 `inbox_list`、`inbox_act` 操作。
- **依赖**：sops（brew 安装），age 已安装；Telegram Bot API 直接用 fetch 调用，不引入 SDK。
- **用户需要做的**：
  1. 在 Telegram 中通过 @BotFather 创建 bot，拿到 token；
  2. 运行 `flow secrets init`；
  3. 运行 `flow secrets set telegram/bot-token`；
  4. 运行 `flow telegram link`，然后在手机上给 bot 发送绑定码。

  另外需要离线备份 age 私钥（PRD §18）。
- **外部服务**：Telegram Bot API（api.telegram.org）。
