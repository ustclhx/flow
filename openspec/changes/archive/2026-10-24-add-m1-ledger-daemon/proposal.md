# Proposal

## Why

M0 做好了共享知识，但 Flow 还不会"自己干活"：所有任务都靠用户手动启动 harness、盯着终端、记住进度。M1 的目标是让任务可以被托管执行。本变更是 M1 四个变更中的第一个，提供其余三个都依赖的地基：

- 一个持久化的**任务账本**；
- 一个常驻的**中枢守护进程**；
- 中枢与执行节点之间的**协议**。

依据见 PRD §19 第 1、2、8 条。

## What Changes

- **任务账本**：在 `state/flow.db` 中保存只追加的事件流，任务的当前状态由事件投影得到。
  - 任务状态机：`queued → running → verifying → done / failed / blocked / cancelled`。
  - 任务合同（spec）与结果（result）的格式用 zod 定义，并导出为 JSON Schema。
- **中枢守护进程 `flowd`**：在本机回环地址提供 HTTP API，用 token 认证，并提供 SSE 事件流。
  - `flow daemon install / uninstall / status` 负责通过 launchd 托管中枢与本机节点。
  - 支持可选的外部心跳 URL，例如 healthchecks.io。
  - 每天自动备份账本。
- **节点协议**：节点启动时注册自己的能力，然后用 long-poll 领取任务租约，执行期间续约并上报活动事件，最后提交完成、失败或卡住。
  - 租约过期时，任务默认转为 `blocked`（原因 `node_lost`）；只有明确标记可重试的任务才会重新排队。
- **节点进程 `flow node`**：定义执行器插件接口，并内置一个仅用于测试的 `fake` 执行器。真实执行器在变更 ② 中实现。
- **任务操作**：`task_create`、`task_list`、`task_show`、`task_cancel` 加入操作注册表，CLI 与 MCP 自动获得对应入口，需要中枢在运行。
- **定时触发**：`config/schedules.yaml` 中的 cron 规则到点时向账本写入 `schedule.fired` 事件，供变更 ④ 的 supervisor 唤醒使用。
- **不在本次范围**：
  - 真实执行器与卡住检测（变更 ②）；
  - 收件箱、Telegram、Web 页面、策略引擎（变更 ③）；
  - supervisor 与 sops 密钥（变更 ④）；
  - 远程节点加入、中枢部署到服务器（M1 之后）。

## Capabilities

### New Capabilities

- `task-ledger`：事件账本、任务合同与结果、任务状态机及其投影、任务的创建、查询与取消。
- `hub-daemon`：中枢进程的 HTTP API、认证、事件流、launchd 托管、外部心跳与账本备份。
- `node-protocol`：节点注册、租约领取与续约、活动上报、结果提交、租约过期处理，以及执行器插件接口。
- `scheduler`：基于 cron 规则的定时事件。

### Modified Capabilities

- `knowledge-access`：操作注册表新增需要中枢的任务操作。中枢不可用时，这些操作返回可重试的错误。

## Impact

- **代码**：
  - 新增 `packages/hub`（中枢）和 `packages/node`（节点）；
  - `packages/core` 新增任务与事件的 schema，以及中枢客户端；
  - `packages/cli` 新增 `flow daemon ...`、`flow node`、`flow hub` 等命令；
  - `schemas/` 新增任务、事件与协议的 JSON Schema。
- **依赖**：新增 HTTP 框架 Hono（兼容 Bun 与 Node）和一个 cron 表达式解析库。
- **用户机器**：在 `~/Library/LaunchAgents/` 安装两个 plist，分别对应中枢和本机节点；`state/` 下新增 `flow.db`、`hub.token`、`backups/`、`logs/`。
- **外部服务**：可选，配置了才会使用外部心跳 URL。
