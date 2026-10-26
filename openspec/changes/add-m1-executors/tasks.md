# Tasks

> 前置条件：`add-m1-ledger-daemon` 的第 1–5 组已合并到 main。
> 依赖与并行：第 1 组完成后，第 2、3、4、5 组可以并行；第 6 组依赖第 2–5 组；第 7 组最后进行。

## 1. 共享基础

- [x] 1.1 角色 schema（`config/roles/*.yaml`，提示词可以内联或引用 `.md`）、加载与校验；`flow init` 补齐 `dev`、`reviewer`、`triage` 三个默认角色；`task_create` 校验角色是否存在（`unknown_role`）；导出 JSON Schema；验证 role-config spec 的全部场景
- [x] 1.2 扩展执行器接口（`deliver`、`classify`），实现节点通用循环：活动上报、无进展计时、崩溃识别、超时停止；验证用 fake 执行器的扩展指令覆盖 stuck-detection spec 的全部场景
- [x] 1.3 中枢侧的回复：`task.replied`、`task.requeued_with_reply` 事件，`replies` 投影表，`POST /v1/tasks/:id/reply`，续约响应携带待送达的回复，`ack-reply` 接口（同事务写入 `task.unblocked`）；`task_reply` 操作（`--approve`、`--deny`、文字）；验证 task-interaction spec 和 node-protocol 增量的全部场景（用 fake 执行器）

## 2. codex-orca 执行器

- [x] 2.1 Orca CLI 封装：worktree create、terminal create、read、send、close，JSON 输出用 zod 校验；仓库必须属于已定义的 workspace；验证注入假 `orca` 二进制的单元测试
- [x] 2.2 任务说明渲染（目标、角色提示词、上下文摘要、范围、验收命令、完成标准、停下提问的约定），写入 `state/tasks/<id>/spec.md`；验证快照测试
- [x] 2.3 监控循环与 `classify.ts`（信任提示、PR 已开、授权请求、提问、其他），以及 `deliver`（终端发送）和 `cancel`（关闭终端）；验证 `test/fixtures/codex-tui/` 下的真实终端片段 fixture 测试，至少包括：信任提示、Working、提问、授权请求、开完 PR、无输出

## 3. claude-sdk 执行器

- [x] 3.1 接入 `@anthropic-ai/claude-agent-sdk`：流式输入、角色提示词追加到预设、`settingSources: ['project']`、注入 flow MCP、活动上报、结果（会话 id 与费用，字段以 SDK 类型为准）、`abortController` 加 `close()` 用于取消；验证用模拟的 SDK 迭代器做单元测试
- [x] 3.2 `canUseTool` 挂起审批：上报 `blocked(awaiting_approval)`（输入经脱敏）、approve 和 deny 的送达、审批超时导致失败；运行中的文字回复以用户消息推入；验证 executor-claude-sdk spec 的全部场景（模拟 SDK）

## 4. codex-exec 执行器

- [x] 4.1 `codex exec --json` 的运行、JSONL 解析（事件 schema 以本机 codex 实际输出为准，fixture 存档）、最后一条消息作为摘要、记录会话 id、提问识别（复用 2.3 的规则）、`blocked(question)` 结束一轮、带回复时用 `codex exec resume`；验证注入假 `codex` 二进制的测试覆盖 executor-codex-exec spec 的全部场景

## 5. 验收运行器

- [x] 5.1 `verifying` 阶段：argv 执行（不经过 shell）、每条命令的超时、失败即停、只保留输出末尾并做密钥脱敏后入账；验证 task-verification spec 的全部场景

## 6. 真实环境集成

- [x] 6.1 在 product-res 上用 `dev` 角色创建一个小任务（例如修正 README 中的一处模板残留），真实走一遍 codex-orca：自动建 worktree → 自动处理信任提示 → 开 PR → `done`；把过程和发现的识别问题记录到 `docs/executors.md`
- [x] 6.2 用 `on-request` 权限的临时角色重做一次，故意触发授权请求，用 `flow task reply --approve` 放行并完成；用 `reviewer` 角色审查 6.1 的 PR，验证 claude-sdk 的审批挂起与恢复；用 `triage` 角色做一次只读分诊，验证 codex-exec 的提问恢复

## 7. 收尾

- [x] 7.1 `flow doctor` 增加 Codex、Orca、Claude SDK 的版本与可用性检查；`docs/executors.md` 写明三种执行器的适用场景、角色配置示例，以及从 `~/.claude/scripts/orca-codex` 迁移的步骤；验证 doctor 测试与文档中的命令都能照着运行
