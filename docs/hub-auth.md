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
| `POST /v1/tasks`（创建任务） | ✓（任意角色） | 仅 `creatable_by` 匹配的角色，否则 403 `role_not_allowed` | 403 `scope_denied` | 403 |
| `GET /v1/tasks`、`POST /v1/tasks/:id/cancel`、`GET /v1/events`、`GET /v1/nodes`、`GET /v1/hub/status` | ✓ | ✓ | 403 `scope_denied` | 403 |
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

## 角色创建权限（`creatable_by`）

任务合同的 `role` 决定节点用哪个角色配置执行（`config/roles/<role>.yaml`）。dev 默认跳过 Codex 审批和沙箱，
如果只读的 reviewer / triage 能创建 `role: dev` 的任务，就等于借 dev 提权。所以中枢在**创建任务时**按身份校验角色：

- `user` 永远可以创建任何角色的任务，`creatable_by` 不影响 user；中枢也沿用原来的做法，不替 user 校验角色是否存在
  （`flow task create` 与 MCP 的 `task_create` 在本机先查角色，未定义时返回 `unknown_role`）。
- 其他身份（实际能到达这个接口的是 user token 降级的 AI 身份）：角色必须已定义且加载成功，否则 422 `unknown_role`
  （语法或字段有错、未能加载的角色文件同样视为未定义，`flow doctor` 会报出错误）；身份必须匹配该角色的 `creatable_by`，
  否则 403 `role_not_allowed`，信息中写明角色与身份，`details` 为 `{ field: "role", role, actor }`。拒绝时不产生事件。
- `creatable_by` 缺省或为 `[]`：只有 user 可以创建（默认拒绝 AI 与节点）。
- 用户在收件箱批准 AI 的 `task_create`（策略审批）不能覆盖 `creatable_by`；身份不匹配时，中枢仍返回 `role_not_allowed`。
- 模式：精确值（`reviewer`、`agent:claude`、`remote:grok`、`node:n-abc`，区分大小写），`<前缀>:*`（`node:*`、`remote:*`，
  匹配以 `<前缀>:` 开头且后面非空的身份），以及 `*`（任意身份）。写在列表中的 `user` 没有额外作用。
- 校验在幂等键查找之前：被拒绝的身份不能凭幂等键拿到已有任务。
- 生效时机：中枢在每次创建请求时用 core 的 `loadRoles` 重新读取 `config/roles/`（与 workspace 检查一样），
  改完角色文件后下一次请求即生效，不需要重启中枢。

默认模板中 dev 不写（只有 user），只读的 reviewer、triage 为 `["*"]`。

**本机 AI 的实际身份**：claude-sdk、codex-exec 与 codex-orca 执行器均为新启动的 AI 子进程设置
`FLOW_ACTOR=<角色名>`；claude-sdk 另注入 `flow mcp --actor <角色名>`。所以 reviewer 会话经 MCP 或 Bash 中的 CLI
访问中枢时，身份都是 `reviewer`（triage 等其他角色同理用各自名字），不能通过 CLI 的 `--actor user` 覆盖。
执行器内进程若 unset `FLOW_ACTOR` 或将它改写为 `user`，CLI 会回到 user 身份；这是默认身份，不是强制隔离，见下文“信任边界”。
角色名必须是合法且可声明的 AI 身份；`user` 等保留身份在角色加载时拒绝，doctor 报 error，执行器也会在启动前校验，不会静默替换名字。
codex-orca 通过 Flow 生成的 Orca 终端启动命令设置环境变量；升级前已启动并被复用的会话需要重新启动才会获得它。
它们**不匹配** `node:*`。只想放开特定身份时写精确名字，例如只允许 reviewer 执行器拆出分诊任务：

```yaml
# config/roles/triage.yaml
creatable_by:
  - reviewer
```

注意：

- `*` 只覆盖能到达本机端口 `/v1/tasks` 的非 user 身份，即 user token 降级的本机 AI 身份。节点 token（`node:<id>`）
  属于可信计算基，只能走节点协议，创建任务一律 403 `scope_denied`；remote token 在本机端口一律 403 `remote_not_allowed`。
  变更 ⑤ 的远程入口另有自己的能力控制，不因为角色写了 `*` 就能创建任务。`node:*`、`remote:*` 模式先保留，供以后的入口使用。
- `flow init` 不覆盖已有文件，**已存在的角色文件不会自动获得 `creatable_by`**，升级后这些角色只有 user 能创建；
  `flow doctor` 对字段缺省或为空数组的角色给出“仅 user 可创建”的 info 提示。需要时手动加上，例如 `creatable_by: ["*"]` 或 `["reviewer"]`。
- 定时规则（`schedules.yaml` 与中枢内部规则）目前只写 `schedule.fired`（身份 `hub`）或回调收件箱，不创建任务，
  不经过这项校验。以后若由定时规则创建任务，必须经同一个任务服务，并且明确以哪个身份创建。
- 和其他检查一样，这只约束经中枢创建的任务；能读 `state/hub.token` 的本机同用户进程仍可以 user 身份创建任何角色（见"信任边界"）。

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
  其中去掉了 `FLOW_HUB_TOKEN`，任务里运行的代码拿不到节点的凭证。执行器再通过 `executorRoleEnv()`
  校验角色身份并设置 `FLOW_ACTOR`，验收命令也使用合同的角色身份；codex-orca 在终端启动命令中设置它，同时移除 `FLOW_HUB_TOKEN`。
- **中枢内部渠道**（Telegram、Web）：运行在中枢进程内，不经过 `/v1` 的 HTTP 鉴权，直接以 user 写事件并附 `via`。
  Web 页面先经过自己的会话与 Origin 校验（见上文"Web 页面"）。

## 信任边界

**本机上以同一系统用户运行、能读取 `state/hub.token` 的任何进程，都可以获得 `user` 身份。**
例如，直接读取 `hub.token` 并用 curl 携带该 token、且不声明 AI 身份的进程仍是 `user`。
这一点是有意保留的：CLI 本身就靠读这个文件工作，同一用户的进程也能读 age 私钥、改配置。
本设计防的是：

- 远程调用方只能拿到绑定 token：remote token 在本机端口完全不可用，`node:` token 只能走节点协议；
- 绑定 token 泄露后，持有者只能在绑定身份的权限范围内操作，且可以随时撤销；
- 本机 AI 进程误把自己声明成 user 或中枢内部身份（MCP 层与中枢都会拒绝）。

它**不防**本机同一用户下的恶意进程。需要更强的隔离时，应让 AI 进程以不同系统用户运行，
使其读不到 `state/hub.token`。
