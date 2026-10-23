# Design

## Context

- 本变更建立在 `add-m1-ledger-daemon` 之上，用到的有：账本、租约协议、执行器插件接口、`blocked` 原因枚举和 fake 执行器。**归档时必须先归档 ①**，因为本变更修改了 ① 新增的 `node-protocol`。
- **用户现在的做法**（`~/.claude/scripts/orca-codex/`）：
  - `orca worktree create --base-branch origin/main --setup run`；
  - Orca 终端中运行 `codex -m <model> -c model_reasoning_effort=<effort> --dangerously-bypass-approvals-and-sandbox "<spec>"`；
  - 每 45 秒执行一次 `orca terminal read`，连续两次读不到 `Working (` 或 `esc to interrupt` 就视为停止；
  - 已知的坑：Orca 的 `tui-idle` 等待在 Codex 停下提问时不会触发；新仓库的文件夹信任提示只能用"只发回车"来答复（见 memory）。
- **Claude Agent SDK（TypeScript）**：
  - `query({ prompt, options })` 返回一个异步迭代器，迭代出 `SDKMessage`；
  - `options` 中有 `cwd`、`allowedTools`、`disallowedTools`、`permissionMode`（`default | acceptEdits | bypassPermissions | plan | dontAsk | auto`）、`canUseTool`、`mcpServers`（stdio：`{ command, args, env }`）、`abortController`、`resume`、`systemPrompt`（`{ type: 'preset', preset: 'claude_code', append }`）、`model`、`maxTurns`、`settingSources`；
  - `canUseTool` 只在权限流程落到"需要询问"时才被调用；它返回 Promise，在 resolve 之前，这次工具调用会一直等待；
  - 只有 prompt 是 `AsyncIterable<SDKUserMessage>` 的流式输入时，才能 `interrupt()`；`close()` 用于强制结束。
- **Codex CLI**：`codex exec --json -C <dir> -s <sandbox>`，以及 `codex exec resume <SESSION_ID> <PROMPT>`。

## Goals / Non-Goals

**Goals：**
- 替换掉用户手写的 dispatch 和 watch 脚本，行为不倒退：信任提示、提问停下、开完 PR 都能被正确识别。
- 三种执行器对节点暴露同一个接口，节点侧的卡住检测、回复送达和验收与具体执行器无关。
- 审批请求在 ③ 的策略引擎接入之前，就能完整地走"挂起 → 用户答复 → 继续"。

**Non-Goals：**
- 不解析 Codex TUI 的完整状态，只靠末尾文本和忙碌标记。
- 不在本变更中合并 PR，也不清理 worktree。

## Decisions

### D1 执行器接口的扩展
在 ① 的 `run / cancel` 之上增加两个方法：
- `deliver(reply)`：把回复送给正在运行的 worker，返回 `delivered` 或 `not_running`；
- `classify(snapshot)`：可选，给出卡住原因。

节点的通用循环只调用这四个方法，再加上一个活动流。

### D2 codex-orca 复用 Orca CLI，不嵌入脚本
- 执行器直接调用 `orca worktree create`、`orca terminal create --command ...`、`orca terminal read --json`、`orca terminal send`、`orca terminal close`，并用 zod 校验 JSON 输出。
- 启动 Codex 的命令由角色参数拼成，与 `run-codex.sh` 等价；任务说明写入 `state/tasks/<id>/spec.md`，通过文件传给 Codex，避免过长的命令行参数。
- 不调用 `~/.claude/scripts` 里的脚本，那是用户的个人工具，Flow 不依赖它。
- **备选方案**：直接调用 tmux 或 pty。这样会失去 Orca 的 worktree 管理和 UI，也会与用户现有的工作方式脱节，所以放弃。

### D3 Codex 的审批模式由角色决定，默认沿用现状
- 默认的 `dev` 角色保持 `--dangerously-bypass-approvals-and-sandbox`，与用户现在的做法一致，避免一上线就被大量授权请求打扰。
- 角色可以改成 `-a on-request -s workspace-write`。这时 Codex 的授权请求会被识别为 `awaiting_approval`，并进入回复流程。M1 验收时可以用这种角色演示授权闭环。
- 这是用户可以调整的配置，不是平台规定。

### D4 停止判定沿用"连续两次无忙碌标记"
- 轮询间隔默认 30 秒，比现在的 45 秒稍快，可以配置。
- 停止后的判定顺序：
  1. 末尾输出是信任提示：自动发回车（只对已注册 workspace 的仓库），继续监控；
  2. 本任务分支上已有 PR（`gh pr list --head <branch> --json url`）：`done`；
  3. 末尾输出匹配授权请求的特征：`awaiting_approval`；
  4. 末尾输出在提问（以问号结尾，或出现"请确认""是否""which/should I"等）：`question`；
  5. 以上都不是：`other`。
- 识别规则集中放在 `codex-orca/classify.ts`，用真实终端片段做 fixture 测试，以后补规则只改这一处。

### D5 claude-sdk 用流式输入，审批用挂起的 Promise
- prompt 使用 `AsyncIterable<SDKUserMessage>`：首条消息是任务说明，之后 `deliver(reply)` 时再推入一条用户消息，从而支持运行中的回复和 `interrupt()`。
- `canUseTool` 被调用时：创建一个待决的审批对象 → 上报 `blocked(awaiting_approval)`，附带 toolName 和输入摘要（经脱敏）→ 返回一个 Promise。`deliver({ approve })` 时 resolve 为 `{ behavior: 'allow', updatedInput: input }`，`deliver({ deny, text })` 时 resolve 为 `{ behavior: 'deny', message: text }`。超时后 resolve 为 deny，并让任务失败。
- **权限模式**：`permissionMode` 默认取 `'auto'`，对应审批链中的"harness 自带的自动审批"这一层；`reviewer` 角色加上 `disallowedTools`（写文件类工具），并开放 `gh pr review` 的 Bash 规则。
- **设置来源**：`settingSources: ['project']`，原因见 spec。
- **MCP**：注入 `mcpServers: { flow: { command: 'flow', args: ['mcp', '--actor', <role>] } }`。
- **取消**：`abortController.abort()` 加 `close()`。
- **结果**：从结果消息中取会话 id 与费用；具体字段名在实现时以 SDK 的类型定义为准。

### D6 codex-exec 一轮执行即一次租约
- 每次执行是一次 `codex exec --json`，进程结束就是这一轮结束。
- 是否在提问用 D4 中同一套提问识别规则，作用于最后一条代理消息。
- 提问时以 `blocked(question)` 结束租约，会话 id 写入结果的 `session` 字段。
- 回复到达后，按 task-interaction spec 重新排队；下一次执行看到合同中的 `resume` 信息，就改用 `codex exec resume`。

### D7 回复的存放与送达
- 中枢新增 `task.replied` 事件和投影表 `replies`（`id`、`task_id`、`kind`、`text`、`by`、`delivered_at`）。
- 续约响应返回最早一条未送达的回复。节点调用执行器的 `deliver()` 后，通过 `POST /v1/leases/:id/ack-reply` 确认，中枢在同一个事务中写入 `task.unblocked` 并标记已送达，保证只送达一次。
- 任务没有租约时（无头执行器的 `blocked` 已经结束了这一轮），回复会把任务转为 `queued`，并把 `{ reply, session }` 并入下一次执行的上下文。这个动作通过一个新事件 `task.requeued_with_reply` 完成。

### D7a 交互式执行器在 blocked 期间继续持有租约（合并 ① 第 2 组时补充）
- ① 的账本在 `task.blocked` 时释放租约。这对无头执行器是对的：一轮执行到此结束。但交互式执行器（codex-orca、claude-sdk）在等待回复期间，worker 还活着，节点必须继续持有并续约这个任务。
- 因此 1.3 需要做两件事：
  - 给 `task.blocked` 载荷加 `lease_held: boolean`。交互式执行器上报为 true，此时租约不释放、续约照常进行，回复通过续约送达后写入 `task.unblocked`；无头执行器上报为 false，行为不变。
  - `task.unblocked` 时，如果任务没有活动租约（例如节点已经掉线），改为重新排队，以免出现"running 但无人持有"的任务。
- 这一条要和 ① 的 store 一起修改，对应的性质测试也要覆盖 `lease_held` 的两种取值。

### D8 验收运行器
- 用 `node:child_process` 的 `spawn(argv[0], argv.slice(1), { cwd, shell: false })` 执行，输出只保留末尾 200 行，经过 M0 的密钥扫描与脱敏后写入结果。
- 验收在节点上完成，所以节点必须具备合同所需的仓库能力。

### D9 默认角色
`flow init` 补齐三个默认角色：
- `dev.yaml`：`codex-orca`，`gpt-6.1-sol`、`high`，bypass；
- `reviewer.yaml`：`claude-sdk`，`claude-opus-5-5`，只读加 `gh pr review`；
- `triage.yaml`：`codex-exec`，只读沙箱。

提示词放在同名的 `.md` 文件中，用户可以直接改。

## Risks / Trade-offs

- **[风险] Codex 和 Orca 的 TUI 文本会随版本变化，忙碌标记或提示词改变后会误判。**
  对策：识别规则集中管理，并用 fixture 测试；`flow doctor` 记录 Codex 和 Orca 的版本；无法识别时归为 `other`，同样会通知用户，不会静默。
- **[风险] bypass 模式下，Codex 可以执行任意命令。**
  这是用户现状的延续。D3 提供了收紧的方式；M1 的策略引擎（③）上线后，再评估是否改变默认值。
- **[风险] claude-sdk 的审批挂起期间，进程和会话一直占用资源。**
  对策：审批有时限（默认 24 小时），节点并发默认为 1；必要时可以把挂起改为结束这一轮，之后用 `resume` 恢复，与 codex-exec 一致。
- **[权衡] 提问识别基于启发式规则，可能把普通的停止误判为提问，反之亦然。**
  两种误判的后果都只是多通知一次或少一次。漏判时，任务会落入 `other` 或 `no_progress`，用户仍然会收到通知。

## Migration Plan

- 安装本变更后，用户可以继续用原来的脚本，两者互不影响。
- 验收通过后，在 `~/.claude/CLAUDE.md` 中把 Codex 的派发流程改为 `flow task create --role dev ...`。这一步由用户确认后再做，不在本变更中自动修改。
- **回滚**：删除 `config/roles/` 中的默认角色，节点就不再加载这些执行器。

## Open Questions

- 默认轮询间隔（30 秒）和无进展阈值（15 分钟），在实际运行一周后再调整。
