# Design

## Context

- **依赖的前置变更**：
  - ①：账本、事件总线、SSE、定时触发；
  - ②：`blocked` 原因与审批请求的载荷、`task_reply` 与回复送达、执行器的 `deliver`。
- **M0 中已有的**：
  - 修改提案是 `state/proposals/` 下的文件，不在账本中；
  - 写入前用 gitleaks 扫描；
  - 已约定 `secret://` 的引用语法。
- **用户的网络环境**：可能需要代理才能访问 api.telegram.org。
- **本机工具**：age 1.3.2 已安装，sops 需要用 brew 安装（当前 stable 为 3.13.3）。
- 动机见 proposal.md。

## Goals / Non-Goals

**Goals：**
- 用户在手机上完成 M1 验收场景中的两次操作：下指令、回复卡住的任务。
- 任何外发内容都不含密钥；只有用户本人的 chat 能操作 Flow。
- 用户在电脑上处理过的条目，手机上会同步显示为已处理，避免重复处理。

**Non-Goals：**
- 多用户、群组 chat。
- 富交互的 Web 工作台：本变更只做一页，以服务端渲染为主。
- 策略的可视化编辑。

## Decisions

### D1 收件箱是账本的投影，由反应器驱动
- **事件**：新增 `inbox.item_created`、`inbox.item_updated`、`inbox.item_closed`、`inbox.pushed`；投影表 `inbox_items`、`channel_messages`。
- **反应器**：中枢中的"反应器"订阅事件总线，把底层事件转换成收件箱事件。例如 `task.blocked` 生成条目，`task.unblocked` 或任务进入终态则关闭条目。反应器以源事件的 seq 作为幂等键，投影重建时不会产生重复的条目。
- **提案**：提案不在账本中，中枢用"文件监听 + 每分钟扫描"监控 `state/proposals/`，发现变化后写入对应的收件箱事件。
- **备选方案**：把收件箱单独存一张可变表。这样做无法重建，也无法审计，所以放弃。

### D2 策略在节点侧预检，避免"卡住又立刻恢复"
- 执行器发起审批请求时，节点先调用 `POST /v1/policy/check`，携带任务、角色、workspace 和请求内容：
  - 结果为 `auto` 或 `auto-report`：执行器在本地直接放行，任务不进入 `blocked`。中枢记录 `policy.decided`，`auto-report` 还会生成 Digest 条目。
  - 其他结果：照常上报 `blocked(awaiting_approval)`，进入收件箱。
- 节点调不通中枢时按"需要用户"处理，即保守的一侧。
- 这需要修改 ② 中节点处理审批请求的流程，本变更的任务中包含这一步。
- **动作识别**（命令前缀映射表）放在 core 中，节点和中枢共用。

### D3 操作者身份
- 策略自动放行时，记为操作者 `policy`。
- 经 Telegram 或 Web 发起的操作，记为 `user`，并在事件中附带 `via: telegram | web | cli`。
- `inbox_act` 对 MCP 调用方（AI）只开放"忽略自己发起的条目"，其余操作返回 `user_only`。

### D4 Telegram 的实现
- **直接用 fetch 调用 Bot API**：
  - `getUpdates?timeout=50&offset=<n>&allowed_updates=["message","callback_query"]`；
  - `sendMessage`（使用 `parse_mode=HTML`，所有动态文本都做 HTML 转义）；
  - `editMessageText`；
  - `answerCallbackQuery`。
- **按钮**：`callback_data` 限制为 64 字节，格式为 `i:<条目短 id>:<操作>`，条目短 id 用 base36。
- **回复与消息的对应**：`channel_messages(item_id, chat_id, message_id)` 用来把用户回复（`reply_to_message.message_id`）映射回条目。
- **进度**：offset 保存在 `state/telegram.json`，每处理完一条更新就持久化。
- **代理**：`config/channels.yaml` 的 `telegram.proxy` 字段可选；同时识别 `HTTPS_PROXY` 环境变量。实现时用运行时支持的方式传入代理，保持 Bun 与 Node 兼容。
- **失败处理**：指数退避（最长 5 分钟）；推送失败的条目保留 `pending` 状态，恢复后补推。
- **绑定**：绑定码随机生成，只在内存中保存，10 分钟过期；绑定成功后，chat_id 写入 `config/channels.yaml`。chat_id 不是密钥，但也不必公开，config 仓库本身是私有的。

### D5 Web 页面使用服务端渲染
- 用 Hono 的 JSX 在服务端渲染一页，操作按钮通过少量原生 JS 调用 `POST /v1/inbox/:id/act`，然后局部刷新。不引入前端构建链；完整的 React 工作台放到 M5。
- **登录**：`flow ui` 向中枢申请一次性登录码，并打开 `http://127.0.0.1:7477/ui/login?code=...`；中枢返回会话 cookie（HttpOnly、SameSite=Strict，有效期 7 天）。
- **CSRF 防护**：写操作检查 `Origin` 必须为本机地址，并依靠 SameSite=Strict。

### D6 密钥提供器
- **调用 sops 命令行**，环境变量显式设置 `SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt`。macOS 上 sops 的默认路径不在这里，显式设置可以避免找不到私钥。
- **读取**：`sops -d --output-type json config/secrets.sops.yaml`。
- **写入**：选用不把值放在 argv 上的方式，避免它出现在进程列表中。实现时在本机的 sops 3.13 上确认可用的方式（例如解密到内存、修改后经标准输入重新加密），并把结论写进文档。
- **路径映射**：`telegram/bot-token` 对应 YAML 中的嵌套键 `telegram: { bot-token: ... }`。
- **解析时机**：中枢启动时，以及配置文件变化时，重新解析一次。
- **gitleaks**：`secrets.sops.yaml` 的内容是密文，gitleaks 不会误报；为保险起见，在 `.gitleaks.toml` 中为 sops 文件的元数据字段加入放行规则。

### D7 脱敏名单
- 中枢内存中维护"已知密钥值 → 路径"的名单。账本写入前、日志输出前和渠道发送前，都对字符串字段做替换。
- 长度小于 8 的值不加入名单，避免误替换。
- 节点进程不持有密钥，它上报的活动片段到中枢后统一脱敏。

### D8 摘要与成批推送
- 内部的定时规则使用 ① 的定时触发机制，规则 id 以 `inbox:` 开头，不写在 `schedules.yaml` 中。
- **每日摘要**：昨天完成和失败的任务、`auto-report` 记录、待处理的 Decide 条目数量、可能过时的知识条目数量。
- **静默时段**：Interrupt 条目在静默时段生成时，写入 `deferred_until`，到时间后推送。

### D9 按 token 绑定操作者身份
- **背景**：变更 ① 的中枢只有一个 token，操作者取自请求头 `X-Flow-Actor`。本机进程彼此信任时这样可以接受；但收件箱让"谁批准的"变得重要，变更 ⑤ 还会让远程 AI 经 tailnet 访问中枢，所以身份必须由凭证决定，不能由调用方自报。
- **token 种类**：
  - `user` token：即 `state/hub.token`（0600），沿用现有文件，CLI 读取它。持有者可以在 `X-Flow-Actor` 中声明一个非 `user` 的身份（只能降级），供本机 `flow mcp --actor <name>` 进程使用；不声明时身份为 `user`。
  - 绑定 token：`flow hub token issue <actor> [--note ...]` 生成，只在签发时输出一次。中枢在 `state/hub-tokens.json`（0600）中只保存 sha256 摘要、actor、签发时间和备注。用这类 token 的请求，身份固定为绑定的 actor，请求头中的 `X-Flow-Actor` 与之不一致时返回 403 `actor_mismatch`。actor 不允许是 `user`。
  - `flow hub token list` 显示 id、actor、签发时间、最近使用时间；`flow hub token revoke <id>` 立即生效。三个命令都只能由 `user` 执行。
- **只有用户能做的操作**（由中枢按身份校验，MCP 层的限制保留作为第一道防线）：`task_reply`、`inbox_act` 中除"忽略自己发起的条目"以外的操作、`flow secrets get`、token 管理。违反时返回 403 `user_only`。supervisor 能否回复，在变更 ④ 中再定。
- **节点**：本机节点继续使用 `user` token 并声明 `node:<id>`；变更 ⑤ 起，远程节点使用绑定 token。
- **中枢内部渠道**：Telegram 和 Web 运行在中枢进程内，不经过 HTTP 鉴权，直接以 `user` 身份写事件，并附 `via`。
- **信任边界**：本机上以同一系统用户运行、能读 `state/hub.token` 的进程，都可以获得 `user` 身份；这一点不变，在 `docs/` 中写明。本设计防的是远程调用方和凭证泄露后的冒充，不防本机同用户进程。
- **角色创建权限**（后续补充）：角色 YAML 新增可选的 `creatable_by`（精确身份或 `node:*`、`remote:*`、`*` 前缀通配）。中枢在创建任务时对非 `user` 身份校验角色存在（`unknown_role`）与 `creatable_by`（403 `role_not_allowed`）；字段缺省时只有 `user` 可以创建。默认 dev 不写（AI 不能借 dev 提权），reviewer、triage 为 `["node:*"]`；`POST /v1/tasks` 因此对 `node:*` 开放。说明见 `docs/hub-auth.md`"角色创建权限"。

## Risks / Trade-offs

- **[风险] Telegram 在用户的网络中不稳定，推送延迟。**
  对策：代理配置加退避重试，条目不会丢；Web 页面作为电脑前的备用入口；`/status` 可以快速确认渠道是否正常。
- **[风险] 输出片段中有敏感但不是密钥的内容（客户数据、内部 URL），会发到 Telegram。**
  对策：截断长度可以配置；`config/inbox.yaml` 支持按 workspace 关闭输出片段；默认只发送末尾 1500 字符。
- **[风险] 策略写得过宽，导致危险操作被自动放行。**
  对策：`pr.merge` 和 `deploy` 需要具体 scope 才能自动放行（spec）；每次判定都入账，`/status` 中显示过去 24 小时自动放行的次数。
- **[权衡] 节点侧预检多了一次 HTTP 调用。**
  这只发生在审批请求时，频率很低，代价可以忽略。

## Migration Plan

- 上线前，用户按 proposal 的 Impact 部分完成 bot 创建、密钥初始化和绑定。
- 没有配置 Telegram 时，收件箱照常工作，可以用 `flow inbox` 和 Web 页面查看。
- **回滚**：从 `config/channels.yaml` 中删除 telegram 配置，渠道即停止；收件箱数据保留在账本中。

## Open Questions

- Decide 的默认推送时间点（09:00、18:00）和静默时段（23:00–08:00），使用一周后按体感调整。
