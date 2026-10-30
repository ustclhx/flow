# Design

## Context

**调研结论**（2026-10-25，来源见 proposal 的讨论记录和 Cursor 文档 `docs/grok-bot/{security,private-networks,computers,settings}.md`、`help/grok-bot/{routines,plans,mobile,secrets}.md`、cursor/plugins#533、#774）：
- **MCP 连接从哪里发起**：Grok Bot 的远程 MCP 连接由 Cursor 后端发起，不经过 Bot 的云电脑。命令型（stdio）MCP 可以跑在云电脑上，但云电脑连不到用户 Mac 的回环地址。
- **Tailscale 插件**：官方插件让 Bot 以 `tag:grokbot` 设备加入用户的 tailnet，只能访问 ACL 授权的主机和端口。它只用于出站方向的 MCP，目前按开关灰度开放。在云电脑上自己装 tailscaled 也能连通，但每次更新、恢复或重置都会被清掉（#774），不作为方案。
- **传输与认证**：远程 MCP 支持 streamable HTTP 和 SSE；认证以 OAuth（含动态客户端注册）为主。能否填固定的 Bearer 请求头，尚未确认。
- **反方向**：Flow 只能单向触发 Grok。routine 可以由 webhook 触发：`POST https://api2.cursor.sh/automations/webhook/<id>`，带 `Authorization: Bearer <key>`，正文为 JSON；返回 200 和 `runUuid`，只表示已开始运行，结果写进 Bot 的聊天。没有接口可以往已有对话里发消息。每小时总计最多运行 300 次。
- **文档矛盾**：由 webhook 或 routine 发起的运行能不能用 tailnet MCP，两处官方材料说法相反，必须实测。

**Flow 现状**：
- MCP 只有 stdio（`packages/mcp/src/server.ts`）。工具由 core 的 `operations` 生成，每次调用经 `invokeOperation` 在 MCP 进程内直接读写 flow-home，不经过中枢。
- 中枢只监听 `127.0.0.1:7477`。按 token 绑定身份在变更 ③ D9 中实现。

## Goals / Non-Goals

**Goals:**
- Grok 能按授权范围查知识库和任务、写提案和随手记、为派给它的任务交结果。
- Flow 能把一类任务（调研、整理、需要浏览器的工作）派给 Grok，并像其他执行器一样跟踪结果。
- 远程接入不扩大权限面：Grok 拿不到 `user` 身份，看不到白名单之外的 workspace 和个人条目，中枢 API 不暴露到 tailnet。
- 设计对"远程调用方"通用，不写死 Grok。

**Non-Goals:**
- Grok 聊天内容同步到 Flow，或 Flow 收件箱推送到 Grok。
- Grok 在用户 Mac 上执行命令。
- 多用户、公网访问。

## Decisions

### D1 远程入口是中枢内的第二个监听端口
- 中枢进程内再起一个 Hono 应用，监听 `127.0.0.1:7478`，只挂 `/mcp`，以及 OAuth 方案下的 `/.well-known/oauth-*`、`/oauth/*`。用户用 `tailscale serve --bg --https=443 http://127.0.0.1:7478` 发布，tailnet 里只看得到这个端口。
- **为什么放在中枢内**：要统一做凭证校验、审计入账、`task_report` 与执行器的协作，这些本来就在中枢；另起进程还得再处理一套鉴权和单实例问题。
- **备选**：在 7477 上加 `/mcp` 路径，再用 `tailscale serve` 只代理这个路径。没有采用，原因是路径级代理一旦配错，`/v1` 就会暴露；分端口的隔离更直观，也便于 doctor 检查。

### D2 MCP 服务端与传输解耦
- 把 `packages/mcp` 中"由 operations 生成工具、调用、渲染结果"的部分抽成 `createFlowMcpServer({ actor, home, filter })`。stdio 入口和 HTTP 入口共用它。
- HTTP 入口使用 SDK 的 Web 标准 streamable HTTP 服务端传输，以无状态模式运行，每个请求新建一个 server 实例，便于和 Hono 集成，也不必维护会话。
- **一致性测试**：把现有的 CLI 与 MCP 一致性测试扩展到 HTTP 传输。

### D3 远程调用方与能力
- `config/remote.yaml` 的格式如下：

  ```yaml
  clients:
    - id: grok
      actor: grok
      workspaces: [product-res]
      capabilities: [read, propose, report]
      include_global: false
  ```

- **能力到操作的映射表**放在 core，按操作名写成白名单。新增的操作默认不开放给远程调用方，必须显式加入映射。
- **workspace 过滤**放在 core 的读取路径中（检索、读取、查询、简报、任务列表），以 `OpContext.visibility` 传入，取值为 `{ workspaces, includeGlobal, excludePersonal: true }`。
- 一个条目属于哪些 workspace，按以下字段判断：资源条目的 `owner`；其他条目的 `workspace` 或 `workspaces` frontmatter 字段；journal 按其所在 workspace。都没有的，视为 global。
- 实现时要先盘点现有条目的 frontmatter，确认这些规则能覆盖全部条目；盘点结果写进 tasks 的验证项。
- **过滤点**：过滤在检索的 SQL 层和读取前做，不在返回后裁剪，避免分页和计数泄露。

### D4 凭证：先用 Bearer，OAuth 作为条件分支
- **Bearer**：用 ③ D9 的 `flow hub token issue grok --remote grok` 签发，token 记录上标注它属于哪个远程调用方。远程入口只接受带这个标注的 token：user token 和节点 token 都返回 401。
- **OAuth**：仅在第 1 组验证出 Grok 不支持固定请求头时实现，做成最小的 OAuth 2.1 授权服务器：
  - **授权方式**：动态客户端注册（RFC 7591）、授权码加 PKCE（S256）、`/.well-known/oauth-authorization-server` 和 `oauth-protected-resource` 元数据。
  - **用户确认**：授权页挂在本机 7477 的 Web 页面上。用户必须已经用 `flow ui` 登录，才能看到"允许 grok 访问 product-res（只读、提案、回报）"并点确认。授权请求从远程端口发起，确认只能在本机完成。
  - **令牌**：访问令牌有效期 1 小时，刷新令牌有效期 30 天；两者在 `state/hub-tokens.json` 中都只存摘要，可以撤销。
- **为什么不直接上 OAuth**：OAuth 要实现的东西多，也多出不少安全面。如果 Bearer 可用，没必要承担这份成本。

### D5 grok-routine 执行器：派发后等待回报
- **派发**：节点领取任务后，渲染派发正文：任务 id、目标、workspace、上下文摘要，以及一段固定的交付说明："完成后调用 Flow MCP 的 `task_report`，任务 id 为 …；中间产物用 `kb_propose` 提交"。渲染结果经脱敏后 POST 到 webhook。
- **防重复**：请求带 `Idempotency-Key: <task id>:<attempt>`。webhook 是否认这个头，以实测为准；即使不认，也只会重复触发一次运行。
- **等待**：派发后，执行器在续约循环中等待回报。中枢收到 `task_report` 时写 `task.reported` 事件，并在续约响应中把回报交给节点。这复用 ② 1.3 "续约响应携带回复"的机制，执行器随后提交 complete。
- **回报只入账，不直接改任务状态**：任务的终态仍由持有租约的节点提交，状态机只有一条路径。如果节点在这期间掉线，任务按现有规则进入 node_lost；重新排队后，新的执行会先检查是否已经有 `task.reported`，有就直接完成，不再重复派发。
- **角色示例**：

  ```yaml
  name: grok-research
  executor: grok-routine
  prompt: grok-research.md
  permissions:
    webhook: https://api2.cursor.sh/automations/webhook/<id>
    key: secret://grok/webhook-key
    report_timeout_minutes: 60
  ```

### D6 审计
- 每次远程调用写一条 `remote.call` 事件，记录调用方、actor、工具、workspace、结果和耗时，不记正文。
- 高频的只读调用会让账本膨胀：同一调用方、同一工具在 1 分钟内的成功调用合并成一条，附带次数；被拒的调用每条都单独记。
- `flow remote status` 从投影读取数据。

### D7 发布检查
- `flow doctor` 运行 `tailscale serve status --json`，检查三点：只有 7478 被代理；`AllowFunnel` 为空；7477 没有出现在任何代理目标中。
- 找不到 `tailscale` 命令时，只给出警告。

## Risks / Trade-offs

- **[风险] 数据发到 xAI。** 对策：workspace 白名单默认为空；个人条目一律不外发；`flow remote status` 可以随时查看 Grok 读了哪些工具和 workspace。
- **[风险] Grok 被提示注入，滥用它有的权限。** 对策：它的写入只能走提案，必须经用户接受才生效；`task_report` 只能为派给它的任务提交，最坏情况是交回一份质量差的结果。
- **[风险] Tailscale 插件或 webhook 行为变化**（灰度功能，文档有矛盾）。对策：第 1 组先在用户账号里实测，结论写进 `docs/grok.md`；执行器对 webhook 的非 2xx 返回和超时都按失败处理，不会把任务卡死。
- **[权衡] 远程入口放在中枢进程内，中枢重启时 Grok 的调用会失败。** MCP 客户端会重试，这个代价可以接受。
- **[权衡] 无状态 HTTP 模式不支持服务端主动推送。** Flow 的工具都是一问一答，用不到推送。

## Migration Plan

- 默认不启用：没有 `config/remote.yaml`，就不监听远程端口，对现有用户没有影响。
- **上线顺序**：账号验证（第 1 组）→ 远程入口与裁剪 → 用户在 tailnet ACL 和 `tailscale serve` 中完成配置 → 在 Grok 中添加连接器 → `grok-routine` 执行器。
- **回滚**：删除 `config/remote.yaml` 中对应的调用方，并撤销其 token；在 Tailscale 中执行 `tailscale serve reset`。

## Open Questions

- 用户账号是否已开通 Tailscale 插件；用户的 tailnet 是个人的还是公司的。
- Grok 自定义 MCP 能否填固定请求头。这决定 D4 走哪个分支。
- 由 webhook 触发的运行能否调用 tailnet MCP。如果不能，`grok-routine` 只能退而要求 Grok 把结果写在聊天里，由用户手动转交。那样它就不再是一个能自动化的执行器，需要重新评估本变更第 4 组是否要做。
- Grok 的 Auto Review 会不会拦下 webhook 运行中调用 MCP 的动作。
