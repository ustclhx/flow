# 中枢鉴权与操作者身份

（add-m1-inbox design D9；hub-daemon spec "Token 认证""只有用户能做的操作"）

## 两种 token

| token | 位置 | 身份 |
|---|---|---|
| user token | `state/hub.token`（0600，首次启动生成） | `user`；可用 `X-Flow-Actor` 降级为非 user 身份 |
| 绑定 token | `flow hub token issue <actor>` 签发，`fht_` 前缀 | 固定为签发时绑定的 actor |

绑定 token 的记录保存在 `state/hub-tokens.json`（0600），每条只有：
`id`（`tok_` + 12 位十六进制）、`actor`、`sha256`（token 的摘要）、`issued_at`、`note`（可选）、
`last_used_at`、`revoked_at`、`remote`（可选，供变更 ⑤ 的远程入口标注；本变更不实现远程入口）。
token 明文只在签发时输出一次，中枢不保存。文件损坏时中枢拒绝启动（错误码 `invalid_hub_tokens`），
不会静默清空记录。最近使用时间在内存中更新，最多每 30 秒、以及中枢停止时落盘。

绑定 token 的 actor 不能是 `user`，也不能是中枢内部身份 `hub`、`scheduler`、`policy` 或占位的 `unknown`。

## 鉴权判定

| token | `X-Flow-Actor` | 结果 |
|---|---|---|
| 缺失 / 不认识 / 已撤销 | 任意 | 401 `unauthorized` |
| user token | 不带或为空 | `user` |
| user token | `user` | `user` |
| user token | 其他合法身份 | 该身份（只能降级） |
| 任意有效 token | 格式不合法 | 400 `invalid_arguments` |
| 绑定 token | 不带、为空或等于绑定身份 | 绑定身份 |
| 绑定 token | 其他（包括 `user`） | 403 `actor_mismatch` |

摘要比较为常数时间：user token 与每一条绑定记录都比较，不提前退出。撤销立即生效（先在内存中撤销再写盘）。

## 只有用户能做的操作

中枢按身份校验，非 user 返回 403 `user_only`，在读取请求体之前拒绝，不产生任何事件：

- `POST /v1/tasks/:id/reply`（`task_reply`）；
- `POST /v1/hub/tokens`、`GET /v1/hub/tokens`、`POST /v1/hub/tokens/:id/revoke`（token 管理）；
- 以后的 `inbox_act`（除"忽略自己发起的条目"）与读取密钥接口，也使用同一个 `userOnly` 中间件。

MCP 层的限制（`flow mcp` 的 actor 不能是 user、没有读取密钥的工具）保留，作为第一道防线。

## 命令

```sh
flow hub token issue grok --note "Grok Bot"   # 只输出一次 token
flow hub token list                            # id、身份、状态、签发时间、最近使用、备注
flow hub token revoke tok_0123456789ab         # 立即生效
```

三个命令都经中枢 HTTP 接口执行（中枢需在运行），并且只能由 user 执行。CLI 的身份规则与
`flow secrets get` 一致：`--actor` 或环境变量 `FLOW_ACTOR` 声明了非 user 身份时，`--actor user` 不能覆盖。

## 各进程怎么带身份

- **CLI**：读 `state/hub.token`，默认身份 `user`。
- **本机节点**：读 `state/hub.token`，声明 `node:<id>`（降级）。
- **本机 MCP**：`flow mcp --actor <name>` 用 `state/hub.token` 并声明该身份（降级）。
- **用绑定 token 的进程**：设置环境变量 `FLOW_HUB_TOKEN=<token>`；`HubClient` 与节点都会优先用它，
  声明的身份必须与绑定身份一致（例如 `flow mcp --actor codex` 配签发给 `codex` 的 token）。
- **中枢内部渠道**（Telegram、Web，后续任务）：运行在中枢进程内，不经过 HTTP 鉴权，直接以 user 写事件并附 `via`。

## 信任边界

**本机上以同一系统用户运行、能读取 `state/hub.token` 的任何进程，都可以获得 `user` 身份。**
这一点是有意保留的：CLI 本身就靠读这个文件工作，同一用户的进程也能读 age 私钥、改配置。
本设计防的是：

- 远程调用方（变更 ⑤ 经 tailnet 访问中枢）只能拿到绑定 token，无法自称 user；
- 绑定 token 泄露后，持有者只能以绑定身份操作，且可以随时撤销；
- 本机 AI 进程误把自己声明成 user（MCP 层拒绝，绑定 token 时中枢也拒绝）。

它**不防**本机同一用户下的恶意进程。需要更强的隔离时，应让 AI 进程以不同系统用户运行，
使其读不到 `state/hub.token`，只发给它绑定 token。
