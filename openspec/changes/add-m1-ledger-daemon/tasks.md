# Tasks

> 依赖与并行：第 1 组完成后，第 2 组和第 3 组可以并行；第 4 组依赖第 2 组；第 5 组依赖第 2、3 组；第 6 组依赖第 4、5 组；第 7 组最后进行。

## 1. 契约与骨架

- [x] 1.1 在 `packages/core/src/ledger/` 中用 zod 定义任务合同、任务结果、全部事件类型（task.*、lease.*、node.*、schedule.fired、hub.*）及其载荷，以及 HTTP 协议的请求和响应体；接入 `jsonSchemas()`，导出到 `schemas/{tasks,events,protocol}/`；验证 `bun run schemas:check` 通过，每种类型都有合法和非法的样例测试
- [x] 1.2 新建 `packages/hub` 与 `packages/node` 包，加入依赖 `hono`、`@hono/node-server`、`croner`；建立 `serve.ts` 运行时隔离层，以及 `config/hub.yaml`、`config/node.yaml` 的 zod 配置加载（全部字段可选，有默认值）；验证空中枢能在 Bun 下启动，`GET /v1/health` 返回 200

## 2. 账本核心（packages/hub）

- [x] 2.1 实现 `events` 表与投影表结构、`apply(event)`、事件和投影的同事务写入，以及状态机校验（不合法的转换返回 `invalid_transition`）；验证状态机的每一条合法和非法转换都有测试
- [x] 2.2 实现投影重建（`flow hub rebuild` 对应的 API），并用随机事件序列做性质测试，证明"增量维护的结果等于重建结果"；验证该性质测试运行至少 200 组随机序列都通过
- [x] 2.3 实现任务的创建（含 workspace 存在性校验和幂等键）、列表、详情、取消；验证 task-ledger spec 中"任务合同""幂等创建""取消"的全部场景

## 3. 中枢进程与 API（packages/hub）

- [x] 3.1 实现 `state/hub.pid` 单实例锁、token 的生成与 0600 权限，以及 Bearer 认证中间件（health 接口免认证）；验证重复启动以非零状态退出并给出已有 pid，缺少 token 时返回 401
- [x] 3.2 实现 SSE 事件流 `GET /v1/events?after=`，支持断线续传；验证断开后补发的事件不丢失、不重复
- [x] 3.3 实现外部心跳（可选的 `heartbeat_url`）与每日 `VACUUM INTO` 备份，按保留份数轮换，错过时补做；验证注入时钟的测试覆盖"心跳失败不影响 API"和"备份可恢复"

## 4. 节点协议（packages/hub + packages/node）

- [x] 4.1 中枢侧：节点注册、按能力领取租约（long-poll 与内存唤醒）、续约（返回取消标记）、提交结束（校验租约令牌）、每 5 秒检查过期租约；验证 node-protocol spec 中"能力不匹配""同一任务不会被分配两次""过期租约的迟到提交""节点掉线"四个场景
- [x] 4.2 实现睡眠检测（单调时钟与墙钟对比，顺延租约，记录 `hub.resumed`）；验证注入时钟模拟一小时睡眠后，任务保持 running
- [x] 4.3 节点侧：`flow node` 进程，包括节点 id 持久化、注册、领取循环、续约循环、批量上报活动、取消处理、唤醒后立即续约，以及执行器插件注册表和 `fake` 执行器（不执行任何外部命令）；验证用 fake 执行器完成 done、failed、blocked（question）、取消四种端到端路径

## 5. CLI 与操作

- [x] 5.1 在 core 中实现 `HubClient`；新增操作 `task_create`、`task_list`、`task_show`、`task_cancel` 并加入操作注册表；中枢不可用时返回 `hub_unavailable`（可重试）；验证 knowledge-access delta 的两个场景，且 M0 的 CLI 与 MCP 一致性测试自动覆盖这四个新操作
- [x] 5.2 新增 `flow hub start|status|rebuild` 与 `flow node start|list` 命令，表格化的人类可读输出复用 `renderTable`；验证 `flow hub status` 显示版本、运行时长、账本序号、定时规则的加载错误和最近一次备份

## 6. 定时触发与托管

- [x] 6.1 实现 `config/schedules.yaml` 的加载（单条规则出错不影响其他规则）、到点写入 `schedule.fired`（用唯一约束去重）、重启或唤醒后只补发最近一次并标记 `missed`；验证 scheduler spec 的全部场景（注入时钟）
- [x] 6.2 实现 `flow daemon install|uninstall|status`：生成两个 plist（bun 绝对路径、FLOW_HOME、KeepAlive、日志路径），通过 `launchctl bootstrap/bootout` 加载和卸载，日志按大小轮转，`flow doctor` 增加对 plist 中路径有效性的检查；验证 plist 快照测试和注入后的 launchctl 命令序列测试

## 7. 端到端与上线

- [x] 7.1 CI 中的端到端测试：在临时 FLOW_HOME 中启动真实中枢和节点进程，经 CLI 创建 fake 任务，覆盖完成、卡住、取消、节点被杀后的 `node_lost`，以及中枢被杀后重启时账本完整；验证在 GitHub Actions 上通过
- [ ] 7.2 在用户的 Mac 上运行 `flow daemon install`，用 `kill -9` 验证中枢会被 launchd 自动拉起、`flow daemon status` 状态正常；把实际步骤和结果记录到 `docs/daemon.md`
