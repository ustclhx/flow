# 中枢鉴权与操作者身份

（add-m1-inbox design D9；hub-daemon spec "Token 认证""只有用户能做的操作"）

## 两种 token

| token | 位置 | 身份 |
|---|---|---|
| user token | `state/hub.token`（0600，首次启动生成） | `user`；可用 `X-Flow-Actor` 降级为 AI 身份 |
| 绑定 token | `flow hub token issue <actor>` 签发，`fht_` 前缀 | 固定为签发时绑定的 actor |

绑定 token 的记录保存在 `state/hub-tokens.json`（0600），每条只有：
`id`（`tok_` + 12 位十六进制）、`actor`、`sha256`（token 的摘要）、`issued_at`、`note`（可选）、
`last_used_at`、`revoked_at`、`remote`（可选）。token 明文只在签发时输出一次，中枢不保存。

- 文件损坏时中枢拒绝启动（`invalid_hub_tokens`），不会静默清空记录。
- 撤销先在内存中生效（立即拒绝），再写盘；签发只有写盘成功才生效，失败时只撤下这一条。
- 最近使用时间在内存中更新，最多每 30 秒、以及中枢停止时落盘。

### 能签发什么

目前只签发两类：

- `node:<id>`：本机以外的节点（变更 ⑤ 起）；
- 带 `--remote` 标注的 token：给变更 ⑤ 的远程入口（例如 Grok Bot）。**它们在本机端口 7477 的 `/v1`
  上一律返回 403 `remote_not_allowed`**，只能用于以后的远程端口。

保留身份不能签发，比较时不区分大小写：`user`、`hub`、`scheduler`、`policy`、`unknown`（`User`、`HUB`
等变体同样拒绝）；`node:` 前缀必须小写并后接合法的节点 id。

## 保留身份

| 身份 | 谁能用 |
|---|---|
| `user` | 只有 user token（不声明或声明恰好为 `user`） |
| `hub`、`scheduler`、`policy` | 只由中枢内部写事件时使用 |
| `unknown` | 历史占位，任何人都不能声明 |
| `node:*` | 中枢在节点注册与租约流程中按 `node_id` 设置，或签发给 `node:<id>` 的绑定 token |

user token 降级时不能声明上述任何一个（不区分大小写，包括 `node:*`），否则 403 `reserved_actor`。
`flow mcp --actor` 也拒绝这些名字。

## 鉴权判定

| token | `X-Flow-Actor` | 结果 |
|---|---|---|
| 缺失 / 不认识 / 已撤销 | 任意 | 401 `unauthorized` |
| 任意有效 token | 格式不合法 | 400 `invalid_arguments` |
| user token | 不带、为空或 `user` | `user` |
| user token | 保留身份（不分大小写）或 `node:*` | 403 `reserved_actor` |
| user token | 其他合法身份 | 该 AI 身份（只能降级） |
| 绑定 token | 与绑定身份不一致（包括 `user`） | 403 `actor_mismatch` |
| 绑定 token（remote） | 不带或一致 | 403 `remote_not_allowed` |
| 绑定 token（`node:<id>`） | 不带或一致 | `node:<id>`，限节点权限范围 |

摘要比较为常数时间：user token 与每一条绑定记录都比较，不提前退出。

## 身份 × 接口

| 接口 | user | AI（user token 降级） | `node:<id>`（绑定 token） | remote token |
|---|---|---|---|---|
| `GET /v1/health` | ✓（不鉴权） | ✓ | ✓ | ✓ |
| `POST /v1/nodes`（注册）、`POST /v1/leases`（领取） | ✓ | ✓ | 仅 `node_id` 为自己 | 403 |
| `POST /v1/leases/:id/renew`、`complete`、`ack-reply` | ✓ | ✓ | ✓（凭 lease_token） | 403 |
| `GET /v1/tasks/:id` | ✓ | ✓ | 仅自己持有活动租约的任务 | 403 |
| `POST /v1/policy/check` | ✓（人工调试） | 403 `scope_denied` | 仅自己持有未过期活动租约的任务 | 403 |
| `GET/POST /v1/tasks`、`POST /v1/tasks/:id/cancel`、`GET /v1/events`、`GET /v1/nodes`、`GET /v1/hub/status` | ✓ | ✓ | 403 `scope_denied` | 403 |
| `GET /v1/inbox` | ✓ | ✓ | 403 `scope_denied` | 403 |
| `POST /v1/inbox/:id/act` | 全部操作 | 仅 dismiss 且条目 `created_by` 为自己；其余 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/tasks/:id/reply` | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/hub/rebuild` | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `/v1/hub/tokens`（签发、列出、撤销） | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |
| `POST /v1/ui/login-code`（`flow ui` 申请 Web 登录码） | ✓ | 403 `user_only` | 403 `scope_denied` | 403 |

remote token 一列的 403 都是 `remote_not_allowed`。`inbox_act` 先校验 action，再检查身份与条目的
`created_by`；拒绝时不调用底层操作、不产生事件。via 只接受 cli、web、telegram，省略时为 cli；
CLI 固定传 cli。读取密钥等只有用户能做的接口使用 `userOnly`，在读取请求体、调用服务之前拒绝；
策略检查的节点 scope 需要读取请求体中的 `task_id`，加载策略后在入账前再次校验租约。
策略检查的 `dry_run` 默认 false；user 可传 true 只判定不入账。节点只能省略或传 false，
传 true 返回 400 `invalid_arguments`，不产生事件。CLI 默认 dry run，只有 `--record` 才入账。
所有权限拒绝均不产生事件。任务不存在时，策略检查返回 404 `not_found`。
MCP 层的限制（`flow mcp` 的 actor 不能是 user 或保留身份、没有读取密钥的工具）保留，作为第一道防线。

## Web 页面（`/ui`）

（add-m1-inbox 6.1，design D5；inbox-web spec）`/ui` 是与 `/v1` 完全分开的一条鉴权路径：页面用会话 cookie，
`/v1` 只认 `Authorization: Bearer`，**不读 cookie**，所以会话 cookie 拿不到任何 `/v1` 接口。

登录流程：

1. `flow ui` 用 user token 调用 `POST /v1/ui/login-code`，拿到一次性登录码（32 字节随机数），
   中枢只在内存中保存它的 sha256 摘要，60 秒内有效、只能使用一次（无论成功与否，提交即作废）。
2. `flow ui` 打开 `http://127.0.0.1:<端口>/ui/login?code=...`（macOS 用 `open`；`--print` 只输出链接）。
3. `/ui/login` 校验登录码，写入会话 cookie `flow_ui_session`（HttpOnly、SameSite=Strict、Path=/ui、
   Max-Age 7 天），303 跳转到 `/ui`，登录码不留在地址栏与历史记录中。会话同样只在内存中保存摘要；
   **中枢重启后会话全部失效，需要重新运行 `flow ui`**。

| 接口 | 无会话 | 有效会话 | 额外校验 |
|---|---|---|---|
| `GET /ui` | 401，只提示"请运行 flow ui 登录"，不含条目 | 页面 | Host |
| `GET /ui/login?code=` | 登录码无效或过期：401 | — | Host |
| `GET /ui/items`（局部刷新片段） | 401 | 片段 | Host |
| `POST /ui/items/:id/act` | 401 | 以 `user`、`via: web` 调用收件箱操作 | Host、Origin |
| `POST /ui/logout` | 303 | 撤销会话并清除 cookie | Host、Origin |
| `GET /ui/static/*`（脚本、样式、图标） | ✓ | ✓ | Host |

- **Host**：必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`，否则 421（防 DNS rebinding）；中枢本身只监听 127.0.0.1。
- **Origin**：写操作必须带 `Origin`，且为 `http://127.0.0.1:<端口>` 或 `http://localhost:<端口>`；缺少或不符时
  403 `origin_denied`，不产生事件。`Sec-Fetch-Site` 存在时必须为 `same-origin`。与 SameSite=Strict 一起防 CSRF。
- 页面的请求体只接受 `action` 与 `text`，不能声明身份或渠道。
- **安全头**（`/ui` 下所有响应）：`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`、
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、
  `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`、`Permissions-Policy`，
  以及 `Cache-Control: no-store`（静态资源为 `no-cache`）。页面没有内联脚本和内联样式；动态文本全部由 Hono JSX 转义，
  标题、正文和输出片段渲染前再做一次密钥脱敏。

## 命令

```sh
flow hub token issue node:mac-mini --note "书房的 Mac mini"   # 只输出一次 token
flow hub token issue grok --remote --note "Grok Bot"          # 给变更 ⑤ 的远程入口
flow hub token list                                           # id、身份、状态、签发时间、最近使用、备注
flow hub token revoke tok_0123456789ab                        # 立即生效
```

三个命令都经中枢 HTTP 接口执行（中枢需在运行），并且只能由 user 执行。

## 各进程怎么带身份

- **CLI**：读 `state/hub.token`，默认身份 `user`。环境变量 `FLOW_ACTOR` 声明了非 user 身份时，
  **所有命令**（包括走 HubClient 访问中枢的命令）都以该身份执行，`--actor user` 或其他 `--actor`
  不能覆盖它。这只是第一道防线：同一用户的进程可以清掉这个环境变量，信任边界不变（见下文）。
- **本机节点**：读 `state/hub.token`，**不声明身份**；中枢在注册与租约流程中按 `node_id` 记为 `node:<id>`。
- **本机 MCP**：`flow mcp --actor <name>` 用 `state/hub.token` 并声明该 AI 身份（降级）。
- **用绑定 token 的进程**：设置环境变量 `FLOW_HUB_TOKEN=<token>`；`HubClient` 与节点都会优先用它。
  节点此时声明 `node:<id>`，必须与绑定身份一致。
- **执行器与 worker 子进程**：节点 spawn 执行器、worker 与验收命令时，环境变量一律经
  `executorEnv()`（`packages/node/src/env.ts`，执行器从 `ExecutorContext.env` 拿到同一份），
  其中去掉了 `FLOW_HUB_TOKEN`，任务里运行的代码拿不到节点的凭证。
- **中枢内部渠道**（Telegram、Web）：运行在中枢进程内，不经过 `/v1` 的 HTTP 鉴权，直接以 user 写事件并附 `via`。
  Web 页面先经过自己的会话与 Origin 校验（见上文"Web 页面"）。

## 信任边界

**本机上以同一系统用户运行、能读取 `state/hub.token` 的任何进程，都可以获得 `user` 身份。**
这一点是有意保留的：CLI 本身就靠读这个文件工作，同一用户的进程也能读 age 私钥、改配置。
本设计防的是：

- 远程调用方只能拿到绑定 token：remote token 在本机端口完全不可用，`node:` token 只能走节点协议；
- 绑定 token 泄露后，持有者只能在绑定身份的权限范围内操作，且可以随时撤销；
- 本机 AI 进程误把自己声明成 user 或中枢内部身份（MCP 层与中枢都会拒绝）。

它**不防**本机同一用户下的恶意进程。需要更强的隔离时，应让 AI 进程以不同系统用户运行，
使其读不到 `state/hub.token`。
