# Design

## Context

- **M0 留下的基础**：
  - 操作注册表：CLI 与 MCP 由同一份定义生成；
  - 统一的 `Result` / 退出码契约；
  - `openDatabase` 封装：兼容 Bun 与 Node；
  - 跨进程写锁：只保护 brain 和 raw；
  - JSON Schema 导出流水线：`scripts/gen-schemas.ts`。
- **账本与知识库是两套存储**：
  - 知识库是 git 中的文件，每个 CLI 进程都能直接读写；
  - 账本是 SQLite，只由中枢一个进程写入，其他进程一律通过 HTTP 访问。
- **运行环境**：用户的 Mac 会合盖睡眠。睡眠期间中枢和节点同时暂停，唤醒后墙钟时间会突然前跳。
- 动机见 proposal.md；整体设计见 PRD §19。

## Goals / Non-Goals

**Goals：**
- 中枢崩溃、被杀、Mac 睡眠之后，都不丢任务、不重复执行、不误判节点掉线。
- 协议与语言无关：节点可以用 Rust 重写，并直接复用 `schemas/protocol/`。
- 不引入外部服务：不用 Redis、消息队列或工作流引擎。

**Non-Goals：**
- 远程节点、TLS、多用户认证。M1 只监听回环地址，使用单一 token。
- 任务优先级与公平调度。M1 按创建时间先后分配即可。
- Linux 的 systemd 托管。等中枢迁到服务器时再做。

## Decisions

### D1 中枢独占账本
- 中枢启动时先取得 `state/hub.pid` 文件锁（复用 M0 写锁的"临时文件 + link 原子创建 + 陈旧 pid 接管"实现），取得后才打开 `flow.db`。
- 其他进程不直接打开 `flow.db`。CLI 的任务操作一律走 HTTP；`flow hub rebuild` 也只是请求中枢执行重建。
- **备选方案**：每个进程都直接写 SQLite，靠 WAL 和 busy_timeout 处理并发。这样会让租约、long-poll 这些"内存中的协调状态"分散到多个进程，所以放弃。

### D2 事件溯源，投影与事件同事务写入
- **表结构**：
  - `events`：`seq INTEGER PRIMARY KEY AUTOINCREMENT`，字段包括 `ts, type, workspace, task_id, actor, payload_json`；
  - 投影表：`tasks`、`nodes`、`leases`、`schedule_fires`。
- **写入流程**：校验事件 → 检查状态机 → 在同一个事务里插入事件并更新投影。事务失败就两者都不写。
- **事件类型**集中在 `packages/core/src/ledger/events.ts`，每种类型都用 zod 定义载荷，并导出到 `schemas/events/`。
- **重建**：清空投影表，按 seq 重放全部事件，用同一个 `apply(event)` 函数，保证重建与增量维护一致。测试中用随机生成的事件序列做"增量结果等于重建结果"的性质测试。
- 租约令牌、long-poll 等待者这类纯内存状态不进投影。中枢重启后，租约按 `leases` 表中的到期时间恢复。

### D3 HTTP 层用 Hono，并隔离运行时
- 选择 Hono 是因为它在 Bun 和 Node 上都能运行，并原生支持 SSE。
- 启动入口只在 `packages/hub/src/serve.ts` 中区分运行时（`Bun.serve` 或 `@hono/node-server`），业务路由不感知运行时。
- 请求体用 zod 校验，与 `schemas/protocol/*.json` 由同一份定义生成。
- **备选方案**：直接用 `Bun.serve` 手写路由，代码更少，但违反 Node 兼容约束（AGENTS.md）。

### D4 租约与 long-poll
- **领取**：节点调用 `POST /v1/leases`，携带能力列表与等待秒数。
  - 中枢在事务中选出第一个满足能力的 `queued` 任务，写入 `task.started` 和 `lease.granted`；
  - 没有可领取的任务时，把请求挂到内存中的等待队列，有新任务入队时唤醒。
- **续约**：`POST /v1/leases/:id/renew`，带上活动事件（批量）。响应中包含 `cancel_requested`。
- **过期检查**：每 5 秒扫一次 `leases` 表，按合同处理过期租约（见 node-protocol spec）。
- **令牌**：领取时生成随机令牌，后续续约和提交都必须带上，以此识别"持有当前租约的节点"。

### D5 睡眠与时钟跳变
- **问题**：Mac 睡眠后唤醒，墙钟前跳，所有租约看起来都已过期，但节点其实也只是刚刚恢复，马上就会续约。
- **对策**：中枢用一个 1 秒间隔的计时器同时记录单调时钟和墙钟。如果两次检查之间墙钟前进的时间比单调时钟多出 30 秒以上，就判定发生了睡眠：
  - 把所有活动租约的到期时间顺延一个 TTL；
  - 记录一条 `hub.resumed` 事件，载荷中包含睡眠时长。
- 节点侧同理：唤醒后立即续约，不等下一个周期。
- **测试**：通过注入可控的时钟来验证。

### D6 节点进程
- **身份与连接**：`flow node` 的节点 id 保存在 `state/node-id`，首次启动时生成。中枢地址与 token 从 `config/hub.yaml` 和 `state/hub.token` 读取。本机节点与中枢共用同一个 flow-home。
- **能力**：由节点配置声明，例如 `config/node.yaml` 中的 `capabilities`；执行器插件自动贡献 `executor:<type>`。
- **执行器接口**：`run(contract, ctx) → AsyncIterable<ActivityEvent>`，最终结果为 `Result`，并提供 `cancel()`。节点负责续约循环、把活动事件批量上报、处理取消。
- **并发**：每个节点默认同时执行 1 个任务，可配置。
- **执行器标记**：变更 ② 的执行器在声明能力时打上 `interactive` 或 `headless` 标记，本变更只定义这个字段。

### D7 任务操作的客户端
- `packages/core` 提供一个 `HubClient`，基于 fetch，读取 token 与地址。
- 任务操作（`task_create` 等）在 `run` 中调用 `HubClient`，操作者身份经请求头 `X-Flow-Actor` 传给中枢，并记入事件。
- 连接被拒绝或超时时返回 `fail('retryable', 'hub_unavailable')`。
- MCP 侧沿用 M0 的规则（不允许 `user` 身份），中枢以请求头中的操作者为准。由于 token 只存在于本机，这只是记录用途，不构成安全边界（与 M0 的 D8 一致）。

### D8 launchd
- `flow daemon install` 写入两个 plist：`dev.flow.hub` 和 `dev.flow.node`。
  - `ProgramArguments` 使用安装时解析出的 bun 绝对路径，加上 `packages/cli/src/main.ts`，再加子命令；
  - 设置 `EnvironmentVariables.FLOW_HOME`、`KeepAlive=true`、`ThrottleInterval=5`；
  - 标准输出和错误输出写入 `state/logs/{hub,node}.log`。
- 安装后用 `launchctl bootstrap gui/<uid>` 加载；卸载时用 `bootout`。
- 日志由进程自己按大小轮转（超过 10MB 就切换，保留 3 份），不依赖 newsyslog。
- 测试只校验 plist 的生成内容和命令序列（注入 `launchctl` 执行器），不在 CI 中真正加载。

### D9 定时规则
- 使用 `croner` 解析 cron 表达式。它没有依赖，支持时区，并能算出"下一次"和"上一次"的触发时间。
- 去重依靠 `schedule_fires(rule_id, planned_at)` 上的唯一约束。
- 中枢启动或从睡眠中恢复时，对每条规则计算"上一次计划时间"，如果它还没有触发记录，就补发一次，并标记 `missed: true`。

### D10 账本备份
- 使用 `VACUUM INTO 'state/backups/flow-<ts>.db'` 生成一致的在线副本，Bun 与 Node 的 SQLite 都支持。
- 每天在本地时间 03:30 执行；如果当天错过了，就在启动后补做一次。超出保留份数的旧备份按时间删除。
- 备份路径与时间记入 `hub.backup_done` 事件。

### D11 fake 执行器
- 合同中的 `inputs.fake` 字段（`outcome: done|failed|blocked`、`delay_ms`、`blocked_reason`、`activity`）只在 `executor === 'fake'` 时被接受。
- fake 执行器只处理定时器和事件，不执行任何外部命令，所以可以安全地在 CI 中运行端到端测试：启动真实中枢 → 启动节点 → 建任务 → 断言状态与事件。

## Risks / Trade-offs

- **[风险] launchd 使用的 bun 路径在 bun 升级或移动后失效，进程会一直启动失败。**
  对策：`flow daemon status` 检查 plist 中的路径是否还存在；`flow doctor` 也加入这一项。重新运行 `flow daemon install` 即可修复。
- **[风险] 单写者模型下，中枢宕机期间无法创建任务。**
  对策：launchd 会自动重启；CLI 返回可重试的错误，agent 按约定重试。
- **[风险] 睡眠判定的阈值不准，短暂卡顿可能被误判为睡眠。**
  影响：误判的后果只是租约多顺延一个 TTL，代价可以接受。
- **[权衡] 默认不重试，节点掉线后需要人或 supervisor 处理。**
  这是有意的选择：执行器有副作用，比如推送分支、发 PR，自动重试的风险高于打扰用户一次。
- **[权衡] 只监听回环地址，手机无法直接访问 Web 页面。**
  M1 的手机交互走 Telegram（变更 ③），不需要访问 Web 页面。

## Migration Plan

- 这是全新组件，不需要迁移。M0 的知识库命令不依赖中枢，行为不变。
- **回滚**：运行 `flow daemon uninstall`，然后删除 `state/flow.db*`、`state/hub.*`、`state/backups/`。

## Open Questions

- 中枢的默认端口暂定为 7477。如果与本机已有服务冲突，可以在 `config/hub.yaml` 中修改，不影响设计。
