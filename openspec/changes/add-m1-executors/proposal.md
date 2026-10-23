# Proposal

## Why

变更 ① 建好了账本、中枢和节点协议，但节点只有一个测试用的 fake 执行器。本变更接入真实的 harness，并把用户现在手动做的"盯着 Codex 有没有卡住、卡住了去回答"变成内核能力（PRD §19 第 3、4、7 条）。M1 验收场景中"Codex 在 worktree 中执行，卡住时用户回复后继续"这一段，由本变更实现执行侧，由变更 ③ 实现推送侧。

## What Changes

- **角色配置**：`config/roles/<name>.yaml`，包括提示词、执行器、模型、推理强度和权限设置。执行器和模型都可以随时替换（PRD §4 的 Role）。
- **三个执行器插件**（运行在节点上）：
  - `codex-orca`（交互模式）：按任务创建 Orca worktree，由合同和角色生成任务说明，在 Orca 终端中启动 Codex，轮询终端输出，自动处理文件夹信任提示，向终端送达用户回复，取消时关闭终端。它是现有 `dispatch-codex.sh`、`watch-codex.sh` 的插件化版本。
  - `claude-sdk`（无头模式）：通过 Claude Agent SDK 运行 Claude Code。
    - 工具权限经 `canUseTool` 转为审批请求，任务挂起等待答复；
    - 自动注入 `flow mcp`，让 worker 可以写 journal 和提交提案；
    - 支持在运行中送达用户回复。
  - `codex-exec`（无头模式）：通过 `codex exec --json` 运行。卡在提问时以 `blocked(question)` 结束；用户回复后用 `codex exec resume` 接着执行。
- **卡住检测**：节点按统一规则判断任务卡住的原因，包括等待审批、提问、长时间无进展、进程崩溃、超时；各执行器提供识别这些情况的判别规则。卡住时上报 `blocked`，并附带原因和终端末尾的输出。
- **回复与审批**：新增 `POST /v1/tasks/:id/reply` 和 `task_reply` 操作。CLI 用 `flow task reply <id> <文字>`，审批用 `--approve` 或 `--deny`。回复会在节点下一次续约时送达执行器；送达后，任务从 `blocked` 回到 `running`。
- **验收命令**：执行器完成后，节点在任务的工作目录中依次运行合同里的 `verify` 命令。此时任务处于 `verifying` 状态；任何一条命令失败，任务即为 `failed`，并附带命令输出。
- **不在本次范围**：
  - 策略引擎（变更 ③）。本变更中，所有审批请求一律交给用户答复。
  - Telegram 推送（变更 ③）。
  - supervisor 发起和拆分任务（变更 ④）。
  - 合并 PR、检查 main 发布流水线，以及合并后清理 worktree（变更 ④ 的开发工作流）。

## Capabilities

### New Capabilities

- `role-config`：角色定义的格式、校验和加载。
- `executor-codex-orca`：经 Orca 的交互式 Codex 执行器。
- `executor-claude-sdk`：经 Claude Agent SDK 的无头 Claude 执行器。
- `executor-codex-exec`：经 `codex exec` 的无头 Codex 执行器。
- `stuck-detection`：节点侧的卡住判定规则与上报。
- `task-interaction`：对卡住任务的回复、审批及其送达。
- `task-verification`：执行器完成后的验收命令。

### Modified Capabilities

- `node-protocol`：续约响应中新增"待送达的回复"；节点在送达回复后上报 `task.unblocked`。

## Impact

- **代码**：
  - `packages/node` 新增三个执行器插件，以及卡住检测和验收运行器；
  - `packages/hub` 新增回复 API 和相关事件；
  - `packages/core` 新增角色 schema 和 `task_reply` 操作。
- **依赖**：`@anthropic-ai/claude-agent-sdk`。Orca 和 Codex 使用本机已安装的 CLI。
- **用户机器**：
  - 新增 `config/roles/` 下的默认角色（`dev`、`reviewer`、`triage`）；
  - 执行器会在 Orca 中创建 worktree 和终端，并调用 Claude 和 Codex 订阅。
