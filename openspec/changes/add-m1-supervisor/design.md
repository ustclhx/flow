# Design

## Context

现状（2026-10-26，①、③ 已归档，② 待归档）：

- 中枢有只追加账本（`state/flow.db`）、进程内订阅 `ledger.subscribe`、SSE `/v1/events`、基于 croner 的调度器。`schedule.fired` 和 `user.instruction`（Telegram `/ask` 写入，`via` 已支持 `cli`）已经落账，但**没有消费者**。
- 任务合同已有 `parent`、`idempotency_key`，但中枢**不校验 `parent` 是否存在、是否同一 workspace**；`inputs` 是创建者可任意填写的松散对象。
- 角色有 `creatable_by`，所有非 user 身份（包括 `hub`）建任务都经过它（`packages/hub/src/ledger/tasks.ts` 约 183–204 行）；策略引擎把 `task.create`、`inbox.act` 等列为受保护动作。
- claude-sdk 执行器注入 `flow mcp --actor <角色名>`，并设置 `FLOW_ACTOR=<角色名>`；MCP 只走 stdio。`allowedTools` 中的工具跳过 canUseTool；只有配置了 `writable_paths` 时才有 PreToolUse 钩子，读文件没有边界。
- `brief`、`kb_journal` 这类写 brain 的操作在 MCP 进程里本地执行（经写入层），不经过中枢。
- 收件箱来源：`task`、`proposal`（知识修改提案，动作路由到 `kb_proposals_accept/reject`）、`policy`、`supervisor`（预留）、`digest`。关闭原因 `answered` 已预留。没有任何身份能创建 supervisor 条目，也没有把回复送给非任务对象的路径。
- `ws_brief` 是即时拼出来的，默认预算 4000 字符。
- `decision` 条目类型已存在（status、expected_outcome、metric、review_date），AI 不能写。
- 节点按 `concurrency` 限制租约；`acquireLeaseRequest` 是严格对象，没有槽位字段；卡住的任务一直占着槽位。
- 默认 reviewer 模板有 `writable_paths` 和 `Bash(gh pr comment/review:*)`，不是只读角色。
- 策略档位为 `auto`、`auto-report`、`draft-approve`、`notify`（判定结果另有 `user`），合并次序 `notify > user > draft-approve > auto-report > auto`；没有命中 auto 的审批请求和所有 `question` 卡住都直接进用户收件箱并推送。
- Agent SDK 0.3.310 支持 `outputFormat: {type: 'json_schema'}`，结果带 `structured_output`，失败时 subtype 为 `error_max_structured_output_retries`。

## Goals / Non-Goals

**Goals**

- 跑通 PRD §19 的 M1 验收场景：用户在手机上下指令；中途的卡住由 supervisor 在委托范围内代为回复（D15），只有转交给用户的才需要用户处理；`auto_merge` 关闭时多一次合并批准。
- supervisor 只能经过内核提供的工具行动，所有动作落账、可审计；**凡是决定权限的事实（来源、身份、workspace、PR 归属、审查结论）都由中枢或确定性代码记录和核对**，不取自 supervisor 或模型可控的字段。
- 每次唤醒都是新会话，靠简报恢复记忆。
- 合并这一类不可逆外部动作由确定性代码执行。

**Non-Goals**

- 参谋长、跨 workspace 协作、资源归属迁移。
- 与 supervisor 的实时多轮对话（Web 工作台）。
- 预算上限与巡检频率的自适应（只做硬性次数上限，见 D7）。
- 远程节点上的 supervisor（⑤ 之后再评估）。

## Decisions

### D1. supervisor 是一类只能由中枢创建的任务

每次唤醒，中枢以身份 `hub` 创建一个任务：`role: supervisor`、`executor: claude-sdk`、`workspace: <ws>`、`inputs.wake` 描述唤醒原因与事件（只供提示词使用，**不作为权限依据**）。复用现有的租约、心跳、卡住检测、审批挂起、收件箱、重试和审计。

- 同时写入账本事件 `supervisor.wake_started{task_id, workspace, origin, events, generation}`。**唤醒任务的身份以这条事件为准**，不以角色名或 `inputs` 判断。
- 角色新增类别 `kind: supervisor`（见 D9）。`kind: supervisor` 的任务只能由 `hub` 创建；user 想手动唤醒用 `flow supervisor wake <ws> [<说明>]`，它写一条 `user.instruction`，走正常调度，origin 为 `instruction`。
- `createTask` 增加显式分支：actor `hub` 跳过 `creatable_by`。`hub` 是保留身份，HTTP 请求头和 MCP 都不能声明（已有 `checkMcpActor` 与中枢鉴权保证，实现时补测试）。

备选：中枢内常驻一个 Agent SDK 会话。放弃原因：要重做监督、会话越来越长、违背"每次唤醒都是新会话"。

### D2. 来源（origin）由中枢计算并固化

origin 只有两类：

- `instruction`：用户的决定直接或间接引出的工作；
- `autonomous`：巡检、决策回看等 supervisor 自发的工作。

计算规则（全部在中枢，基于账本）：

| 唤醒事件 | origin |
| --- | --- |
| `user.instruction`，且该事件的账本 actor 是 `user` | instruction |
| `schedule.fired`（`payload.kind = supervisor_patrol`） | autonomous |
| `decision.review_due` | autonomous |
| 派生任务状态变化 | 该任务的 origin |
| `supervisor.answered`（用户回答提问） | 提问所在唤醒的 origin |
| `task_proposal.accepted` / `rejected` | instruction（接受）/ 提案所在唤醒的 origin（驳回） |
| `merge_request.rejected`（用户驳回合并请求） | 请求所在唤醒的 origin（`merge_request.created.wake_task_id`，与 `task_proposal.rejected` 一致） |
| `task.reply_delegated` | `reply`：进 reply 队列，唤醒只能回复（D15）；reply 不会传给任何任务 |

任务的 origin 在创建时由中枢写入任务投影，之后不可变：

- 接受任务提案所建的任务 → instruction（接受就是用户的决定）；
- `parent` 是唤醒任务 → 该唤醒的 origin；只有 hub、user 与绑定该唤醒的 supervisor 能以唤醒任务为 parent，其他身份返回 `parent_required`；
- `parent` 是有 origin 的任务 → 继承它的 origin；hub、user、supervisor 以外的 AI 身份只在 parent **未结束**时继承，否则无 origin；
- 其他（包括用户手动建、没有挂到 supervisor 链上的任务）→ **无 origin**：不属于 supervisor 链，它的状态变化不唤醒 supervisor（D15 的委托卡住除外，那是 origin 为 `reply`、只能回复的唤醒），它的 PR 也不能被 supervisor 请求合并。

**所有身份**建任务时，中枢都校验 `parent`：必须存在、与新任务同一 workspace，否则 `parent_not_found` / `workspace_mismatch`。这堵住"把任意任务挂到唤醒任务或用户任务下面伪造来源"。剩余的已接受风险：持有 user token 降级或绑定 token 的 AI 身份可以挂到**未结束**的 instruction 任务下继承 origin（见 `docs/hub-auth.md`）。

`flow ask` 与 `flow supervisor wake` 走 user-only 路由；`user.instruction` 与 `supervisor.release` 只接受 user 身份写入。

**已接受的风险**：能读到 `hub.token` 的进程就是 user（例如 dev 任务里的 Codex `env -u FLOW_ACTOR flow task create ...`），它建的任务如果挂在 instruction 链上，会继承 instruction origin。这与 ①–③ 的信任边界一致（`docs/hub-auth.md`），在 docs 中写明；把 `hub.token` 从执行器可读范围移走留到后续变更。

### D3. 唤醒调度：按 workspace × origin 分队列，串行、合并、限流

调度器订阅账本，识别上表中的唤醒事件。"派生任务状态变化"指 origin 不为空的任务进入 `done`、`failed`、`cancelled`，或进入 `blocked` 且原因是 `crashed`、`node_lost`、`no_progress`、`other`（同一任务同一原因只唤醒一次）。`awaiting_approval`、`question` 不走这条规则：委托给 supervisor 的卡住按 D15 进入独立的 reply 队列（范围是本 workspace 全部任务，不限于有 origin 的任务），未委托的直接进用户收件箱，不唤醒。唤醒任务自身的状态变化不触发唤醒。

- 每个 workspace 有三条队列：instruction、autonomous、reply（reply 只用于代回复，规则见 D15）。同一 workspace 同时最多一个未结束（含 `blocked`）的**普通唤醒**（instruction 或 autonomous），空闲时**先处理 instruction 队列**；另可并行最多一个 reply 唤醒。一次唤醒只合并同一条队列里的事件，所以每次唤醒恰好有一个 origin（`instruction`、`autonomous` 或 `reply`）。
- 队列与代数（generation，每创建一次唤醒加一）由账本投影，中枢重启后恢复。唤醒任务的幂等键为 `supervisor:<ws>:<generation>`；`supervisor:` 前缀保留给 `hub`，其他身份使用返回 `reserved_idempotency_key`。
- 唤醒任务 `blocked` 时新事件继续排队；用户取消它即放行队列。
- 普通唤醒任务失败（reply 唤醒见 D15）：重试一次；仍失败则进收件箱（Interrupt），该队列暂停：新事件继续排队但不触发唤醒，直到用户 `--release`，或暂停满 1 小时后自动恢复一次（再失败则回到暂停，退避时间翻倍，最长 24 小时）。
- 重试只有一层：唤醒失败（`failed`）后由调度器用同一批事件新建一次唤醒（不计入每日上限）。唤醒任务合同不带 `retry.max_attempts`，租约过期不重新排队；进入 `blocked(node_lost)` 的唤醒由中枢直接转为 `failed`，交给调度器这一层重试（reply 唤醒不重试），避免与执行器重试叠加，也不必等用户取消。
- 合并时取队列中最新的 200 个事件（更早的留在队列，下一次唤醒处理）；同一条巡检规则的多次触发只保留最新一次（新到达与失败退回的事件都去重；放行范围内的旧事件不被去重删除）。`inputs.wake.events` 有总字符预算（16000），超出时逐级降级：先去掉结构化上下文（终端末尾、diff_stat 等），再只保留 `user.instruction` 的原文（从新到旧装满预算），其余只带事件引用。
- 放行（`supervisor.release`）只作用于放行当时队列里已有的事件；放行时队列为空则只解除暂停，不保留"通行证"；放行范围内的事件都已不在队列中时放行作废，队列照常处理。
- 唤醒任务创建失败（例如角色或配置临时不可读）：按退避（30 秒起翻倍、最长 1 小时）重试；连续 3 次失败写一条 Interrupt（每天每 workspace 一条）。
- 手动控制（user-only）：`flow supervisor wake <ws> <说明>` 写一条 `user.instruction`；`flow supervisor wake <ws> --release <instruction|autonomous>` 写 `supervisor.release{queue}`，立刻用该队列现有事件创建一次唤醒，origin 保持该队列的类别。手动放行不计入每日上限。
- 一个 workspace 只能有一个 `kind: supervisor` 角色可用（全局最多一个，doctor 对多个报错）；唤醒任务使用它。
- workspace 配置 `supervisor.enabled: false`、没有（或有多个、可写的）`kind: supervisor` 角色、或**没有登记仓库**（唤醒任务以登记仓库为工作目录，节点不会回退到 flow-home）时视为不可唤醒，`/ask` 回复未启用；doctor 对启用了 supervisor 却没有仓库的 workspace 给 warning。
- 不可唤醒期间不无限积压：调度器发现某 workspace 不可唤醒而普通队列里有事件时，由 hub 写 `supervisor.queue_dropped{queue, up_to_seq, reason}`，投影据此清掉该队列中不大于 `up_to_seq` 的事件，重放结果确定，之后重新启用不会带出旧事件。稳定的原因（`disabled`、`global`、`no_repo`、没有 supervisor 角色 `no_role`、workspace 文件已不存在 `unknown_workspace`）立即静默丢弃（doctor 另有提示）；只有暂时性的原因（角色文件有错或有多个、可写的 supervisor 角色 `role_invalid`，该 workspace 的定义文件存在但有错误 `workspaces_invalid`——YAML 写到一半、校验失败、supervisor 段写错被降级为未启用，按文件判断，不看配置整体是否加载成功）先保留队列、按退避（1 分钟起翻倍、最长 1 小时）重查，持续超过 24 小时才丢弃早于宽限期的事件，并写一条 Interrupt；暂时不可用期间普通队列为空且没有委托时不再重查，等下一个事件触发。
- 调度器首次启动时写一次初始化标记 `supervisor.scheduler_initialized{up_to_seq}`（取当时的账本 seq，可为 0，只能由 hub 写、只写一次）；只丢弃标记之前的普通队列事件（调度器上线前写下的 `user.instruction` 等），是否已初始化只看这条标记。之后即使首次唤醒还没建成就重启，指令也不会丢。
- `ws/global` 固定不启用 supervisor（`supervisor.enabled` 恒为 false）：不唤醒，也不代回复其中任务的卡住；doctor 显示"global 不启用 supervisor"。workspace 文件的 `supervisor` 段校验失败时，该 workspace 照常加载，supervisor 视为未启用，问题由 doctor 报告。
- 是否代回复统一由 `delegationEnabled(workspace)`（`enabled && delegate_replies`）判断。

### D4. 硬性上限（中枢强制）

workspace 配置 `supervisor.limits`，默认值：

| 上限 | 默认 | 超出时 |
| --- | --- | --- |
| 每次唤醒创建的任务数 | 5 | `limit_exceeded` |
| 每个 workspace 每天的普通唤醒次数（不含 reply 唤醒） | 24（其中 autonomous 最多 4） | 事件留在队列，收件箱出现一条 Decide："今日唤醒已达上限"，用户可以用 `--release` 放行一次 |
| 每个 workspace 每天的 reply 唤醒次数（`reply_wakes_per_day`） | 48 | 委托立即转交用户（`wake_unavailable`） |
| `parent` 链深度 | 8 | `limit_exceeded` |
| 同一 PR 的 `changes_requested` 轮数 | 2 | 对该 PR 再建 write 任务返回 `review_rounds_exceeded` |
| 同一 workspace 未回答的提问 | 3 | `too_many_questions` |

审查轮数由中枢按 PR URL 统计 reviewer 任务的 `result.review.verdict`。新写类任务关联到哪些 PR 全部由中枢从账本推出，不按合同全文匹配链接：

- 这次唤醒的 `supervisor.wake_started.events` 引用的任务涉及的 PR（审查任务的 `inputs.review.pr`、写类任务的 `inputs.pr`、结果中 `kind: pr` 的产物）；本次唤醒建的所有 write 任务都计入这些 PR；
- 合同结构化的 `inputs.pr`（PR 链接，`prUrl` schema）也计入，鼓励修改任务带上它。

数量、轮数与链深度在写入前的同步段里再检查一次（与 append 之间没有 await），并发请求不能各自通过检查后一起写入。

### D5. supervisor 建任务的检查

`TaskService.createTask` 对 `created_by = supervisor` 的请求，在 `creatable_by` 之后依次检查：

0. 调用方是 reply 唤醒 → 403 `reply_only_wake`；
1. `parent` 必须是本 workspace 未结束的普通唤醒任务（由 `supervisor.wake_started` 判定），否则 `parent_required`；
2. 目标角色的有效类别（D9）为 `write` 且唤醒 origin 为 `autonomous` → 403 `proposal_required`；
3. 目标角色类别为 `merge` 或 `supervisor` → 403 `role_not_allowed`；
4. 合同 `cwd` / `inputs.repo` 必须位于本 workspace 登记的仓库内，否则 `repo_not_in_workspace`：必须是绝对路径或 `~/`；executor 为 codex-orca 时必须恰好是登记仓库（与节点一致），其他执行器允许子目录；先按节点的方式词法 `resolve`，再 `realpath` 比较（避免 `链接/../..` 在中枢与节点解释不同）；通过后把规范化路径（登记仓库写法加 realpath 中仓库以下部分，不含 `..` 与符号链接）写回合同；节点执行前仍须再核对一次（tasks 5.6）；
5. 验收命令（`verify`）：非 user 身份建任务时，每条命令在**创建时**经策略引擎判定——动作取 `tool:Verify` 加 `classifyAction` 的结果，scope 为新任务的 workspace 与角色，`command_prefix` 严格匹配；只有 `auto` / `auto-report` 放行，否则 403 `verify_not_allowed`，错误中列出未通过的命令；命令的每个词都必须在白名单内，否则不放行：普通词（含 `--name=` 的值）先按 `,`、`=` 切段，每段是可带 `./` 开头的相对路径，各 `/` 分隔段以字母数字或 `_` 开头和结尾、中间只含 `_ . + -` 与字母数字，且不含 `..`；选项为 `-x`、`--name`、`--name.sub` 或 `--name=<普通词>`；单独的 `--` 作为分隔符；选项与值分开写时分别校验。因此 `:`、`@`、`~`、`%`、空格、glob、绝对路径、`-r/tmp/x.js`、`--require=a,/tmp/x.js` 都不放行。白名单只校验形态、不校验选项含义，启用 pnpm 以外的前缀前须确认该命令没有执行程序或写配置的选项（如 `go test -exec`、`cargo --config`）。`tool:Verify` 列为受保护的工具（通配规则最多 draft-approve）。验收命令由节点在执行器沙箱之外直接运行，不经运行时审批，这一步堵住"建一个只读任务、借 verify 外传 `hub.token`"。`flow init` 的 `policies.yaml` 带一组注释掉的 `tool:Verify` auto 模板（`pnpm check`、`pnpm test`、`pnpm lint` 前缀）；不启用时 supervisor 建的任务不能带 verify。所有非 user 身份都受此限（不只 supervisor）；
6. D4 的数量和深度上限。

非 hub 身份不能在 `requires` 中声明保留能力（`wake`），否则 `invalid_arguments`。

策略引擎：`task.create` 仍是受保护动作。`flow init` 生成的 `policies.yaml` 带一条注释掉的模板（角色 scope `supervisor`、动作 `task.create`、`auto`；workspace 由本节的 parent、仓库检查约束；同一 workspace 的 ws 级 `task.create` 规则会覆盖它，偏保守。不用 ws scope，因为它会同时放行该 workspace 内其他角色建任务），用户启用；不启用时 supervisor 建任务走审批，流程能走通但多一次批准。验收（7.1）要求先启用它。

### D6. MCP 会话绑定与读边界

claude-sdk 为 `kind: supervisor` 的任务注入 `flow mcp --actor supervisor --workspace <ws> --task <id>`，并设置 `FLOW_WORKSPACE`、`FLOW_TASK_ID`。**中枢以唤醒绑定 token 认定调用方**：节点领到唤醒任务的租约时，中枢签发只对这次唤醒有效的 token（actor `supervisor`、绑定 workspace 与唤醒 task_id、租约结束或任务结束即失效），节点把它注入 MCP 环境；中枢据此判定调用方是哪个唤醒、origin 是什么，**不信任** `--task`、`FLOW_TASK_ID` 或 `X-Flow-Actor`。`supervisor` 因此成为保留 actor：user token 加 `X-Flow-Actor: supervisor` 的降级请求、`flow hub token issue supervisor` 都被拒绝，只有中枢按租约内部签发（`docs/hub-auth.md` 补签发与失效规则）。

- 写类操作只能作用于该 workspace（否则 `workspace_mismatch`）；`task_create` 自动以绑定的任务为 `parent`（MCP 填写，中枢不代填）。唤醒身份的写类路由：取消任务只能取消本次唤醒自己建的任务（`parent` 为该唤醒、`created_by = supervisor`；其他 workspace → `workspace_mismatch`，否则 `scope_denied`）；收件箱只能忽略本 workspace 中自己发起的条目；节点协议接口（注册、领取、续约、提交、ack）一律 `scope_denied`；回复任务、处理收件箱等 user-only 接口返回 `user_only`。
- 节点协议的写接口（注册、领取、续约、完成、ack-reply）只接受 user（本机节点）与 `node:*`，其他身份（含绑定 AI token、唤醒 token）`scope_denied`；唤醒 token 只在调用方是 user 或 `node:<node_id>` 时下发。
- 节点身份被信任：领到唤醒租约的节点获得该唤醒的 supervisor token（与节点本身就能以 `node:*` 身份执行任务的信任边界一致）。token 只存于中枢内存，中枢重启即失效。
- 经中枢的写（建任务、提案、提问、合并请求、简报、决策回看）由中枢独立校验（D5、D8）。
- `kb_journal` 仍在本地经写入层执行（只追加），**只有 MCP 绑定这一层检查**；风险是写错 workspace 的 journal，可接受。
- 绑定的 supervisor 仍可以对其他 workspace 的条目提交 `kb_propose`（输入不含 workspace，本地与中枢都不按绑定拦截）：提案需要用户接受才生效，属于已接受风险。
- 唤醒 token 不经 argv 或 env 传递：节点写入 `state/wake/<task>.token`（0700/0600），MCP 进程以 `FLOW_HUB_TOKEN_FILE` 读取，任务结束即删除（见 `docs/hub-auth.md`）。

读边界：claude-sdk 新增权限字段 `read_scope: cwd`。设置后 PreToolUse 钩子（匹配全部工具，与 `writable_paths` 共用路径判定）只允许读合同工作目录与任务私有目录（见 D10 的 diff 文件）内的路径，拒绝 `.` 开头的路径段、`..`、符号链接越界。检查的字段包括 `file_path`、`path`、`notebook_path`，以及 Glob 的 `pattern`、Grep 的 `glob`（这两个不得是绝对路径、不得含 `..`）；输入中含其他路径类字段的非 MCP 工具一律拒绝。Flow MCP 不受影响。supervisor 与 pr-reviewer 模板都设 `read_scope: cwd`，防止读取 `state/hub.token`、密钥存储、`~/.config/gh`、`~/.ssh` 后经任务目标外传。

实现细节（按 Claude Code 2.1.310 核实）：只认白名单工具与字段，其余工具（含 Bash、WebFetch、非 Flow 的 MCP）一律拒绝；路径拒绝 `~` 开头与首尾空白，读取目标必须已存在，通过后以 `updatedInput` 改写为校验过的真实绝对路径；Glob/Grep 缺省目录显式补为 cwd；Grep 的 `glob` 末尾追加 `!.*`（CLI 固定带 `--hidden`，rg 以最后命中的 glob 为准），Glob 以 `CLAUDE_CODE_GLOB_HIDDEN=false`、`CLAUDE_CODE_GLOB_NO_IGNORE=false` 运行；Flow MCP 只在 SDK 报告的来源为 `flow`/`dynamic`（或 `sdk`）时豁免。**残余风险**：Glob 的模式本身是 rg 的正向 glob，可能列出 cwd 内隐藏文件的名称（内容不可读）；检查与使用之间的并发替换无法排除。

### D7. 新增操作（`packages/core/src/ops/`）

| 操作 | 谁能调用 | 执行位置 | 作用 |
| --- | --- | --- | --- |
| `ws_brief`（扩展） | 所有 | 本地 | 增加 supervisor 笔记、近期决策；启用 supervisor 时再向中枢取进行中的任务、待处理条目与代回复记录（未启用时不请求中枢） |
| `brief_update` | supervisor、user | 中枢 | 整体替换本 workspace 的笔记（带 `base_hash`） |
| `task_propose` | supervisor | 中枢 | 提交任务提案 |
| `ask_user` | supervisor | 中枢 | 发一条提问，可带 2–4 个选项 |
| `pr_merge_request` | supervisor | 中枢 | 请求合并（D10） |
| `decision_review` | supervisor | 中枢 | 为本次回看唤醒关联的决策追加结论 |
| `task_respond` | supervisor | 中枢 | 回复委托给它的一次卡住：批准、拒绝、回答或转交用户（D15） |
| `flow ask` / `flow supervisor wake\|status` | user | 中枢 | 下指令、手动唤醒、查看状态 |

MCP 自动放行清单加入 `brief_update`、`ask_user`、`task_propose`、`decision_review`（只产生等待用户处理的内容或写 supervisor 自己的笔记），以及 `task_respond`（权限由中枢按 D15 核对，不再经策略审批，否则会自我阻塞）。`task_create`、`pr_merge_request` 走策略。除 `task_respond` 外，supervisor 不能 `task_reply`、`inbox_act`（除忽略自己的条目）、接受或驳回任何提案、批准合并：委托范围以外替用户决定不在它的权限内。

### D8. 简报笔记

- 路径 `brain/briefs/<id>.md`，`<id>` 是 workspace id 去掉 `ws/` 前缀（`ws/product-res` → `briefs/product-res.md`）。
- 新的 brain 路径类别 `brief`：由中枢以 supervisor 身份经 `commitWrite` 写入（走 gitleaks 与脱敏）；AI 不能本地直写；整体替换。
- `briefs/` 不是条目：从 `readBrainEntries`、`validateBrain`、索引生成和搜索中排除。
- 笔记上限 3000 字符（`brief_too_long`）；`ws_brief` 把笔记放在最前面，最多占预算的 40%，其余各节分享剩余预算。supervisor 提示词以 8000 预算调用。

### D9. 角色有效类别

角色可以声明 `kind: read | write | merge | supervisor`，中枢也会按配置推断，**有效类别取两者中更严格的**（声明只能收紧，不能放宽；严格程度 supervisor、merge > write > read）：

- codex-orca → write；
- codex-exec：`sandbox` 为 `read-only`（缺省即只读），且 `permissions.config` 为空或只含白名单键（`model`、`model_reasoning_effort` 这类不会启动进程的键，白名单为 core 常量）→ read；否则 write；
- claude-sdk：以下**全部**满足才是 read，否则 write：
  - `setting_sources` 显式写成 `[]`（缺省时执行器用 `['project']`；含 project、local、user 中任何一项时，仓库 `.claude/settings.json` 的 `permissions.allow` 与 hooks 都会生效）；
  - `disallowedTools` 逐项列出 Bash、Edit、Write、MultiEdit、NotebookEdit（没有禁用的工具会进入审批，可能被 auto 规则或代回复放行）；
  - 没有 `writable_paths`；`allowedTools` 中没有 Edit/Write/MultiEdit/NotebookEdit 与任何 `Bash` 规则；权限模式不是 acceptEdits、bypassPermissions、auto；
- pr-merge → merge；其他执行器（含 fake）→ write；
- codex-exec、claude-sdk 的 `permissions` 中出现推断不认识的键 → write（方向保守）；
- `kind: supervisor` 必须显式声明，且只能用 claude-sdk，角色名必须是 `supervisor`（保留 actor）；名为 `supervisor` 但类别不是 supervisor 的角色同样加载报错。supervisor 角色按配置推断必须是 read，否则 doctor 报错、中枢不唤醒。

**非 user 身份**建的任务只要合同带 `verify`，有效类别至少为 write（验收命令在沙箱外执行，D5 第 5 步另做策略判定）；user 建的任务不受此影响。

推断只是配置层判断，不能覆盖执行器之外的配置来源（用户级或项目级 `.codex/config.toml`、未在 `disallowedTools` 中的工具等）；有效类别为 read 的角色最终由执行器强制只读（tasks 5.7）：codex-exec 使用隔离的 `CODEX_HOME`（实测 Codex 0.164 的 `-c mcp_servers={}` 与用户级配置的表合并，不能阻止其中的 MCP 服务器启动，故不用 `-c`；`auth.json` 链接到用户凭证，见 `docs/executors.md`）；claude-sdk 用 SDK `tools` 选项把可用工具限定为 Read/Grep/Glob 与 Flow MCP，canUseTool 对非只读工具一律拒绝、不进审批。

因此默认 reviewer 是 write（它能写文档、能评论 PR），triage 是 read。PR 验收链使用新的只读模板 `pr-reviewer`（D10）。doctor 显示每个角色的有效类别。

### D10. PR 验收链

1. dev 任务（origin instruction）`done`，结果有 `kind: pr` 产物 → supervisor 被唤醒，调用 `task_create` 建 pr-reviewer 任务：`inputs.review = {pr: <url>, focus?: <补充关注点，≤500 字>}`。
2. **审查结论由执行器把关**：
   - workspace 配置 `supervisor.reviewer_roles`（默认 `[pr-reviewer]`）；中枢只接受这些角色、执行器为 claude-sdk 的任务产出的 `result.review`。
   - 节点在启动会话前用 `gh` 读取 PR：确认 PR 的仓库是本 workspace 登记仓库的 origin，记录当前 `headRefOid`，把 `gh pr diff` 写入任务私有目录，传给会话；会话不需要 Bash。
   - 目标文字由中枢的固定模板生成：中枢创建 `reviewer_roles` 角色且带 `inputs.review` 的任务时，**丢弃调用方写的 goal**，用模板加 `focus` 重写；模板写明 focus 不改变判定标准。
   - 节点先 `git fetch origin pull/<n>/head`，再把 `headRefOid` 检出到任务私有目录下的临时 worktree（`git worktree add --detach`），会话的 cwd 就是它，`read_scope` 允许；任务结束后移除，节点启动时 `git worktree prune` 并清理残留的私有目录。
   - 在审查 worktree 内，`read_scope` 额外允许只读访问 `.github/`（CI 配置的改动风险最高）；其他 `.` 开头的路径仍拒绝。
   - SDK 结构化输出（`outputFormat: json_schema`）给出 `verdict`、`blocking`、`notes`；`reviewed_sha` 由执行器填入预先记录的 head，**不取自模型**。结构化输出失败（包括 `error_max_structured_output_retries`）→ `failed(review_output_invalid)`。
   - `pr-reviewer` 模板：claude-sdk，`setting_sources: []`，`allowedTools` 只有 Read、Grep、Glob 和 Flow 只读 MCP，`disallowedTools` 列出 Bash、Edit、Write、MultiEdit、NotebookEdit、WebFetch、WebSearch，`read_scope: cwd`，不设 `writable_paths`，有效类别 read。
3. `changes_requested` → supervisor 被唤醒，可以建修改任务（同一分支），受 D4 轮数上限。
4. `approve` → supervisor 调用 `pr_merge_request{pr, review_task}`。中枢核对（全部取自账本与配置，任一项拿不准即 `merge_not_eligible`，`details.reasons` 列出原因）：
   - 该 PR 是本 workspace 内某个已 done、origin 为 instruction、有效类别恰为 write 的任务的 `kind: pr` 产物（唤醒、审查、合并任务的产物不算）；该任务上报过任务分支（`task.branch_reported`，投影 `branch`），多个候选任务的分支必须一致；
   - PR 链接的 host/owner/repo 等于 merger 所用登记仓库 `remote.origin.url` 的仓库（纵深核对；pr-merge 合并前再核对一次）；
   - `review_task` 属于同一 workspace、角色在 `reviewer_roles` 中、`inputs.review.pr` 等于该 PR、`verdict = approve`，且是该 PR 最新一次可信审查（core `latestTrustedReview`）；同一 PR 没有未结束的审查任务；
   - 该审查任务的合并请求没有被驳回过（`rejected_before`：驳回后必须重新审查才能再请求）；
   - merger 的工作目录与唯一的 merge 角色能确定；
   - 否则 `merge_not_eligible`。

   通过后：`supervisor.auto_merge: true` **且请求来自 instruction 唤醒** → 中枢以 `hub` 身份建 merger 任务；否则（包括 autonomous 唤醒的请求）生成 `source: merge_request` 的收件箱条目（Decide，动作"批准合并""驳回"）。用户批准时中枢再核对一次资格、先解析 merge 角色并构造完整的 merger 合同（失败则不写任何事件），然后 `merge_request.approved`（actor user）、merger 的 `task.created`（actor hub）与条目关闭（actor user）在**同一事务**中写入；条目已被并发关闭时整个事务回滚。有批准事件就一定有 merger，之后不能再驳回。驳回写 `merge_request.rejected` 并唤醒 supervisor（origin 取请求所在唤醒，见 D2）。merger 任务的 `parent` 是审查任务，origin 由中枢直接取自开出该 PR 的 dev 任务（资格要求它是 instruction），不继承审查任务；`inputs.merge = {pr, review_task, branch}`，`branch` 取自 dev 任务投影；幂等键 `merge:<审查任务>`（hub 保留前缀）。它结束时按 origin 进入 instruction 队列唤醒 supervisor。supervisor 停用后，已生成的合并审批条目仍可由用户批准（资格的其余各项照常核对）。
   - **fork PR**：codex-orca 只把本仓库（`isCrossRepository == false`）且 `headRefName` 等于任务分支的 PR 记为产物；审查准备拒绝 fork PR（`repo_not_in_workspace`）；pr-merge 要求 `isCrossRepository == false` 且 `headRefName == inputs.merge.branch`（否则 `repo_not_in_workspace` / `head_branch_mismatch`）。
5. **pr-merge 执行器**（节点上，不调用模型；`gh` 可注入）在本 workspace 登记仓库中执行：
   - 读 PR（一次 GraphQL 读取同一时刻的 head、可合并性、合并队列与 head 提交的检查）：open、base 为默认分支、仓库与登记仓库一致、不是 fork PR、`headRefName == inputs.merge.branch`、`headRefOid == reviewed_sha`、可合并、未启用合并队列（否则 `merge_queue_unsupported`）；合并前再读一次 head；
   - 检查：至少有一项检查且全部成功、没有进行中的检查（workspace 配置 `supervisor.allow_no_checks: true` 时允许没有检查）；
     检查完全 fail-closed：head 提交上的每一条 check run 与 status 都单独计入（只对同一 check run id 去重），不按名称合并重跑结果——同一 workflow 中同名的不同 job 无法与重跑可靠区分。有意的后果：flaky 检查重跑成功后旧的失败记录仍会阻止合并，需要推新提交或由用户手动合并；
   - 再次核对审查任务（同第 4 步）；
   - 任一不满足 → `failed`，原因码如 `pr_not_open`、`head_moved`、`checks_not_green`、`review_not_approved`，**不合并**；
   - 合并方式取 `supervisor.merge_method`（默认 `squash`）；
   - 合并后等待默认分支上该合并提交触发的 workflow runs 结束（默认最多 30 分钟）：全部成功 → `done`，结果附 run 链接；有失败 → `failed(pipeline_failed)`；超时 → `failed(pipeline_timeout)`，结果附 run 链接；没有 run → `done`，注明未发现发布流水线。
6. merger 任务结束 → supervisor 被唤醒，写 journal、更新简报；失败时提问或进收件箱。

`kind: merge` 的任务只能由 `hub` 和 user 创建，按类别判定（用户自建的其他 pr-merge 角色同样受限）。合并审批条目不做 PR 状态轮询；批准时 PR 已关闭或已合并，merger 以 `pr_not_open` 结束，supervisor 下次唤醒时处理。

### D11. 提问、任务提案与决策

**提问**：`ask_user` 创建 `source: supervisor` 条目（默认 Decide，`source_ref` 为唤醒任务 id，动作 `reply`，有选项时附按钮）。用户回复 → 条目关闭为 `answered`，写 `supervisor.answered{item_id, text, via}` → 唤醒。提问不挂起唤醒任务。7 天未回答 → 关闭为 `expired`，唤醒一次：唤醒事件就是这条 `inbox.item_closed{reason: expired}`（`source: supervisor` 的条目，actor hub，每小时由内部规则 `questions:expire` 检查），origin 取条目 `source_ref` 所指唤醒的 origin。`inbox_act reply` 的路由扩展到 `supervisor` 来源，仍只有 user 能执行；Telegram 的选项按钮（`i:<短 id>:o<序号>`）以条目上保存的选项原文答复，不取 callback 中的文字。

**任务提案**：账本事件 `task_proposal.created|accepted|rejected`，收件箱新来源 `task_proposal`（不复用知识提案的 `proposal` 来源，避免动作路由与 `proposal_removed` 自动关闭的冲突）。

- 草稿必须通过 `createTaskRequest` 校验；workspace 必须是绑定的 workspace；目标角色有效类别不能是 merge 或 supervisor；cwd / repo 必须在本 workspace 登记仓库内。
- 条目展示角色、执行器、仓库与 cwd、验收命令、目标全文；Web 上可以修改目标后再接受。Web 页面只接受本机访问（Host 与 Origin 必须是 127.0.0.1 / localhost），Telegram 消息因此不附链接，只注明“Web 页面仅本机可用（在电脑上运行 flow ui）”；从手机访问 Web 见 Open Questions。
- 接受 → 中枢以 user 身份建任务（`parent` 为提案所在唤醒任务，origin instruction，幂等键 `task-proposal:<id>`，重试安全）。`task-proposal:` 与 `supervisor:` 一样是保留前缀，任何身份经 HTTP / MCP 使用都返回 `reserved_idempotency_key`，只有中枢接受提案时内部放行；幂等命中时还要核对已有任务 `created_by=user`、`parent` 为该唤醒、origin instruction（不比较目标与合同：保留前缀已能证明任务来自某次接受，目标可能在 Web 上被改过），否则 `conflict`。决策路径在提交时确定并记入 `task_proposal.created.decision_path`；草稿 `context` 不得引用 `decisions/`。接受已建出任务但收尾未完成时不能驳回，只能重新接受。
- supervisor（非 reply 唤醒）可以忽略本 workspace 中由某次唤醒发起的提问条目（撤回提问）；任务提案的撤回只留给用户。
- **验收命令不借 user 身份跳过判定**（二选一中选了更简单的一种）：接受时以 `enforceVerify` 建任务，`verify` 按非 user 身份的 D5 第 5 步规则逐条经策略判定，只有 `auto` / `auto-report` 放行，否则接受失败（`verify_not_allowed`），条目保持打开；提交提案时也先按同样规则预判，注定建不出来的提案直接拒绝。没有选"在 Web 上完整展示 verify 让用户确认"：Telegram 上的一键接受无法保证用户看过命令，且两条路径的行为会不一致。
- 接受时再核对一次角色类别与仓库（配置可能在提交之后改动过）；`merge_request` 的批准 / 驳回经 `MergeRequestHandler` 接口路由（4.8 接入），未接入时返回 `action_not_available`。

**决策**：提案可带 `title`、`expected_outcome`、`metric`、`review_date`（晚于当天，≤180 天）。接受时中枢以 user 身份写 `brain/decisions/<YYYY-MM-DD>-<slug>.md`（`type: decision`、`status: approved`、`workspace`、`sources` 引用任务 id），任务合同 `context` 引用它。

**回看**：中枢注册一条每天 09:00（中枢时区）的内部规则（`decisions:review`），并在启动时扫描一次，扫描 `status: approved` 且回看日期已到（早于今天，或就是今天且已过 09:00）、尚未发过的决策，写 `decision.review_due{path, review_date}`（同一决策同一回看日期只写一次，以账本去重；停机错过的在启动或下一次扫描补发）。决策没有 workspace 或该 workspace 未启用 supervisor → 不写 `decision.review_due`，只生成一条 Digest 级的 `source: decision` 条目提醒用户（同样只生成一次，每日摘要列出）。修改 `review_date` 会重新到期；过期 14 天仍是 approved 的补一条 Digest（兜底 supervisor 没完成回看；与“到期回看”提醒共用同一个条目 id，同一决策同一回看日期最多一条）；决策被改为非 approved 后提醒条目自动关闭（本次读取有问题的文件跳过，不误关）。回看结论整段写成引用块，策略层拒绝追加段中的标题行，防止伪造新的一节。`decision_review` 的"关联决策"以本次唤醒 `supervisor.wake_started.events` 中的 `decision.review_due` 为准，否则 `not_review_target`。supervisor 用 `decision_review` 追加 `## 回看 YYYY-MM-DD` 一节，并把 `status` 改为 `reviewed`、`last_verified` 改为当天；由中枢以 `hub` 身份代写，只允许本次唤醒关联的那条决策，其他字段与其他决策不可改。这是写入层"AI 不能写 decision"的唯一窄例外。

### D12. 节点为 supervisor 预留执行槽

- 协议：`acquireLeaseRequest` 增加可选字段 `slots: {general: n, supervisor: m, reply: k}`；中枢只把普通唤醒分给 supervisor 空位、只把 reply 唤醒分给 reply 空位，普通空位两者都能接。没有该字段的旧节点视为全部是普通空位（版本兼容）。
- 节点：`node.yaml` 的 `reserved.supervisor`（默认 1，给普通唤醒）与 `reserved.reply`（默认 1，只给 reply 唤醒，D15）；领取循环在普通槽满时仍为 supervisor 与 reply 空位发起领取。
- pr-merge 很短，用普通空位。

### D13. 巡检

- `flow init` 在 `config/schedules.yaml` 生成注释掉的示例（`0 9 * * *`、`payload.kind: supervisor_patrol`，每个 workspace 一条，`ws/<id>` 占位）。默认不启用；已有文件不覆盖。
- 巡检提示词：读简报 → 看进行中/卡住/失败任务、未合并 PR、过期事实、近期 raw/inbox → 写日报（journal，并作为 Digest 条目进入每日摘要）→ 写类工作只能提案（D5 强制）→ 更新简报。巡检唤醒的 `inputs.wake.events` 带 `type: schedule.fired` 与"定时巡检（规则 …）"说明，提示词据此区分巡检。以上流程是**提示词引导**的，不是确定性保证；确定性的只有下面的日报通道与 D5 的写类限制。
- **日报通道**（确定性）：新增只限 supervisor 的 `patrol_report{workspace, text ≤3500}`，经中枢执行。中枢核对调用方是非 reply 唤醒（`reply_only_wake`）、绑定 workspace 一致、本次唤醒合并的事件中有 `schedule.fired{payload.kind: supervisor_patrol}`（否则 `not_patrol_wake`）、本次唤醒尚未提交（否则 `patrol_already_reported`）；然后对正文做 `redactSecrets`（已登记的密钥值与正则兜底）并转义行首的 `#` 标题标记（防止伪造 journal 记录标题），以 supervisor 身份经写入层追加一条 journal（首行 `巡检日报（唤醒 <id>）`，账本写入失败后重试时按唤醒 id 去重，不重复追加），并写一条 Digest 级、`source: supervisor`、无动作的条目 `patrol.<唤醒任务 id>`（固定 Digest，不推送）。每日摘要生成时列入"supervisor 巡检日报"一节，并以 `digested` 关闭。选它而不是"`kb_journal` 带标记"：`kb_journal` 在 MCP 进程本地执行、中枢看不到，标记也可被任何能写 journal 的身份伪造。**不扩大权限**：journal 本来就允许 supervisor 写，条目只是摘要里的展示，没有可执行动作；每次巡检唤醒最多一份，巡检本身受 `autonomous_wakes_per_day` 限制。`patrol_report` 加入 supervisor 会话的 MCP 自动放行清单。
- **花费汇总**（确定性）：只统计唤醒任务本身（含 reply 唤醒）结果中的 `result.cost.usd`（claude-sdk 的估算），按时间范围查询 `supervisor.wake_started`、按唤醒开始时间归入日期，只计其中已结束的唤醒，按 workspace 汇总次数、金额（6 位小数）与未上报费用的次数；派生任务与未结束的唤醒不计入。每日摘要加"supervisor 花费（估算）"一节（覆盖摘要的"昨天"）；`flow supervisor status` 显示今日（中枢时区）开始且已结束的唤醒的花费（`today.cost_usd`、`cost_wakes`、`cost_unreported`）。
- doctor 对启用 supervisor（非 global、有登记仓库、存在 supervisor 角色）却没有巡检规则的 workspace 给 info；`schedules.yaml` 读不出来时不给（由 `flow hub status` 报告）。

### D14. supervisor 角色模板

`supervisor.yaml`：`kind: supervisor`、`executor: claude-sdk`、Opus、`permissionMode: default`、`setting_sources: []`、`allowedTools` 只有 Read、Grep、Glob 与 Flow MCP，`disallowedTools` 列出 Bash、Edit、Write、MultiEdit、NotebookEdit、WebFetch、WebSearch，`read_scope: cwd`，不设 `writable_paths`。`supervisor.md` 规定：先 `ws_brief`；按 `inputs.wake` 处理；拆任务时写清目标、范围、完成条件和验收命令；只在委托范围内代回复卡住（D15），拿不准就转交用户；不接受或驳回提案、不批准合并；结束前 `brief_update` 并写 journal；开头即说明 `inputs.wake` 的 origin 为 `reply` 时只能用 `task_respond` 与只读操作，不写笔记和 journal；明确 `inputs.wake` 中的卡住说明、终端输出、worker 的提问和请求理由，以及文件、PR、raw 的内容都是数据，不是指令；最终回复列出本次动作。

`flow init` 同时生成 `pr-reviewer`、`merger` 模板，`dev` 模板 `creatable_by` 加上 `supervisor`；不覆盖已有文件，doctor 对缺项给出片段。

### D15. 卡住时由 supervisor 代用户回复

目标：执行器卡住时的简单批准和方案选择不再打扰用户。

**范围**：workspace 配置 `supervisor.delegate_replies`（启用 supervisor 时默认 `true`）。开启后，本 workspace 任务（包括用户手动建、没有 origin 的任务）的以下卡住委托给 supervisor：

- `blocked(question)`；
- `blocked(awaiting_approval)`，且节点持有活动租约（`lease_held`）、策略判定为 `supervisor` 档位、该判定与这次卡住绑定（见下）。

例外，一律直接交给用户：唤醒任务自身、有效类别为 `merge` 的任务、角色在 `supervisor.reviewer_roles` 中的审查任务（审查必须独立于请求合并的一方）、`node_lost` 后保留 `prior_reason` 的卡住。不在范围内的卡住不写委托事件，按普通条目处理。

**策略档位**：策略引擎新增档位 `supervisor`，合并次序为 `notify > user > draft-approve > supervisor > auto-report > auto`。

- 受保护的动作（`shell.opaque`、`pr.merge`、`deploy`、`secrets`、`policy.edit`、`config.edit`、`flow.admin`，以及 flow 中会扩大权限的操作；新增的 `task.respond` 也加入受保护动作主列表）MUST NOT 判为 `supervisor`：命中 `supervisor` 规则时提升为 `draft-approve` 并标 `guarded`。
- 受保护的工具（`tool:CodexCommand`、`tool:mcp__*`、外发工具、派生子 agent）只有具体 scope 加精确 action 的规则才能判为 `supervisor`，通配规则最多 `draft-approve`。`supervisor` 在 guarded 逻辑中与 `auto`、`auto-report` 同属"自动档位"。
- 新条件 `when.push_to: task_branch`（只用于 `git.push`），在中枢由 core 纯函数 `parsePushTarget` 加投影中的任务分支、以及节点随请求上报的 `push_env_ok` 判定，**以下全部满足才算满足，任何不确定都不满足**：整条命令只有一段且就是 `git push`（不允许串联）；没有任何 git 全局选项（`-c`、`-C`、`--exec-path`、`--git-dir`、`--config-env` 等都会执行或改变配置）；远端是登记仓库的 remote 名（如 `origin`），不是 URL 或路径；恰好一个显式 refspec，目标 ref 等于任务分支，且任务分支不是仓库默认分支；不带 `--all`、`--mirror`、`--tags`、`--prune`、`--delete`、`--receive-pack`、`--exec`、`-o`、`--push-option`、`-f`、`--force*`，refspec 不以 `+` 或 `:` 开头，`HEAD` 视为不确定；命令前没有环境变量赋值。
- **推送环境检查**（节点，precheck 时；实现见 `packages/node/src/push-env.ts`、`safe-git.ts`）：节点在 worker 目录里运行任何 git 之前先校验 gitdir（`.git` 是指向 `<登记仓库 common dir>/worktrees/<name>` 的 gitfile 且反向指回本 worktree，或目录就是登记仓库本身），之后所有 git 都经"安全 git"（固定 `GIT_DIR`、中和 fsmonitor、hook、filter、外部 diff 与 textconv）；`remote.<r>.url` 恰好一个、`pushurl` 为 0 个或与 url 相同、`git remote get-url --push --all` 恰好一个值，三者都等于租约开始时的登记仓库快照（只认 github.com）；按 `--show-scope` 判定的配置禁用清单（所有作用域禁止：`include*`、`core.fsmonitor`、`core.hooksPath`、`core.sshCommand`、`hook.*`、`remote.*.receivepack|push|proxy|mirror|vcs`、`push.*` 等；只在 local / worktree 作用域禁止：`filter.*`、`diff.*`、`http.*`、`url.*`、`pager.*`、`gpg.*`、`protocol.*`、`core.pager`，system / global 由用户负责；local / worktree 作用域的任何 `credential.*`；global 配置取自节点的 HOME；Git LFS 仓库的 `.git/hooks/pre-push` 会被 hook 检查拒绝），清单为常量并有快照测试；hooks 目录只有 `.sample`；本地没有与任务分支同名的 tag；来源经 `rev-parse --symbolic-full-name` 解析为 `refs/heads/<任务分支>`。结果以 `push_env_ok` 字段随 `policy/check` 请求上报，缺失即不满足；节点在执行 supervisor 的 `approve` 前再查一次（委托最长可等 10 分钟，复核同样重新校验 gitdir），不通过则拒收。
- **任务分支**：只有自己创建任务分支的执行器（codex-orca 的 worktree 分支）在开始时写 `task.branch_reported{branch}`：只接受持有该任务活动租约的节点写入，每个任务只写一次、不可更改；中枢写入投影。没有上报分支的任务 `push_to` 永不满足。
- 新条件 `when.gh_scope: workspace_repo`（用于 `pr.create` 与只读的 `gh pr view` / `gh pr diff`）：不带 `-R` / `--repo`、命令前没有环境变量赋值（`GH_REPO`、`GH_HOST`、`GH_TOKEN` 等）；节点在 precheck 时用 `gh repo view --json nameWithOwner` 取得 gh 实际解析出的仓库（会考虑 `upstream` remote 与 `gh-resolved` 配置），与登记仓库一致时上报 `gh_env_ok`，缺失即不满足；不接受 `--body-file` / `-F`（核对与 gh 读取之间文件可能被替换，正文只能用 `--body`、`--fill` 等）；`pr create` 的 `--head` 只能缺省或等于任务分支（任务分支缺失时带 `--head` 不满足）；整条命令只能含空格与可见 ASCII。防止把凭证文件当 PR 正文外传、或读写其他仓库。gh 在有 TTY 时可能提示推送，批准 `pr create` 不等于批准推送。
- **命令执行目录**：`push_to` 与 `gh_scope` 都要求节点上报的命令实际执行目录（`command_cwd`）与投影记录的任务 worktree（`task_worktree`）都存在且相同，否则不满足（remote、分支与 gh 仓库都取决于命令在哪个仓库执行）。realpath 在节点侧完成，中枢只比较字符串；`command_cwd`、`push_env_ok`、`gh_env_ok` 只认节点（持有该任务活动租约的 node actor，或请求带的租约令牌匹配）上报的值。**只有执行器能可靠确定命令实际执行目录时节点才上报这三个字段**：codex-orca 拿不到 Codex 提权命令的实际 workdir（Codex 0.164 的 rollout 只记录模型给出的工具调用参数，无法可靠对应到终端弹窗），claude-sdk 的 Bash 会在调用之间保留 cwd，二者目前都不上报——**codex-orca 与 claude-sdk 的 push、`pr.create` 暂不委托给 supervisor**，交给用户。仓库默认分支取自登记仓库快照：任务首次上报分支时（codex-orca 在启动 Codex 之前），节点对执行器解析出的登记仓库（`resolveTaskRepo`）采集 origin 地址与默认分支，随 `task.branch_reported` 上报、中枢投影固定；之后的租约随 grant 下发快照，节点不再重新采集；补报只补 worktree、不补快照；不取每次请求上报的值，缺失即不满足。
- **重定向与展开**：`command_prefix`、`push_to`、`gh_scope` 对任一段中引号外的文件重定向（`>`、`>>`、`>|`、`N>`、`&>`、`<`、`<<`、`<<<`、`<(`）都判不满足，只允许独立的 `2>&1`；含引号外会展开的元字符（`$`、`{`、`[`、`*`、`?`、`~`）的词同样判不满足。`command_prefix` 还拒绝后台执行的单个 `&`。动作识别中，执行文件或用于匹配映射前缀的词含这些元字符时整段按 `shell.opaque` 处理；开头或中间的重定向整段按 `shell.opaque` 处理（默认拒绝），只有段末尾的重定向剥离后识别；剥离 shell 保留字前缀，复合命令与函数定义（`function`、`select`、`case`、`{`、`}`）按 `shell.opaque` 处理。
- **推送目标只能是分支**：refspec 的目标规范后必须是 `refs/heads/<任务分支>` 或等于任务分支的短名；来源不得是 `refs/tags/…` 等非分支 ref；目标写成短名时来源也必须是任务分支。
- **gh view / diff 不接受 `--jq` / `-q` / `--template` / `-t`**：jq 的 `env` / `$ENV` 能输出沙箱外进程的环境变量。
- **命令前缀严格匹配**（所有档位）：`command_prefix` 按原始词比较，不消去环境变量赋值、包装命令（sudo、env、exec、nohup、timeout、nice、xargs 等）或执行文件路径，首词必须与前缀首词完全相同，只接受空格与可见 ASCII；动作识别仍消去包装、保守识别。
- `flow init` 在 `policies.yaml` 中生成一组**注释掉的**白名单模板（按 workspace 启用）：`tool:CodexCommand` 与 `tool:Bash` 下的 `pnpm check`、`pnpm test`、`pnpm lint` 前缀（串联请求每段都须满足；前缀按上述严格规则匹配，模板中每个前缀在 1.6 的测试中覆盖 `pnpm test --x`、`pnpm test:e2e` 等写法）；带 `gh_scope` 的 `pr.create`、`gh pr view`、`gh pr diff`；带 `push_to` 的 `git.push`。

**判定与卡住绑定**：`POST /v1/policy/check` 的响应在判定为 `supervisor` 档位时返回 `decision_id`（对应 `policy.decided` 的 seq）；其他档位与 dry_run 不返回该字段（旧节点以 strict schema 解析响应，而旧节点不会遇到 `supervisor` 档位；新版响应 schema 改为非 strict，便于以后扩展）。节点按"不放行、上报 blocked"处理 `supervisor` 档位，上报时带 `decision_id` 与请求文本。中枢只在以下全部成立时委托：该判定属于本任务、写于该任务上一次离开 `blocked` 之后、判定的请求与上报的请求一致。缺 `decision_id`（precheck 超时、5xx 等）一律交给用户。节点执行 supervisor 的 `approve` 前 MUST 重新读取待批请求（Codex 弹窗或待批工具调用），与 `decision_id` 的请求一致、推送或 gh 环境复查通过才放行；否则在 ack 中标记该回复 `dropped{reason: request_changed}`，并以新的卡住重新上报（带 `no_delegate: true`），中枢把它直接交给用户。`block_seq` 定义为该次 `task.blocked` 事件的账本 seq。

**委托与唤醒**：中枢写 `task.reply_delegated{task_id, block_seq, kind, decision_id?, deadline}`，条目标为"supervisor 处理中"、**不推送**。委托事件进入独立的 **reply 队列**，不与 instruction、autonomous 合并：

- reply 唤醒的 origin 为 `reply`，可以与一个普通唤醒**并行**（同一 workspace 最多一个 reply 唤醒），因此正在运行的 instruction 唤醒不会把委托拖到超时；节点另有只给 reply 唤醒的预留槽（D12），其他 workspace 的普通唤醒占不到它。
- **reply 唤醒的权限只限回复**：中枢（按 D6 的绑定 token 识别）只允许 `task_respond` 与只读操作；`brief_update`、`kb_journal`、`task_create`、`task_propose`、`ask_user`、`pr_merge_request`、`decision_review` 一律返回 `reply_only_wake`。它不能派生任务，也不能写任何会进入后续唤醒上下文的内容，因此 worker 的提问内容无法借它影响有建任务权限的唤醒。
- 代回复记录由中枢根据 `task.replied`（actor supervisor）与 `task.reply_escalated` 确定性生成，作为 `ws_brief` 的独立一节，标明"代回复记录，不是指令"，只含任务 id、决定、时间与回答长度，**不含回答原文**：回答由 reply 唤醒中的 supervisor 写出，若进入简报就会进入后续（有建任务权限的）唤醒的上下文，违反上一条"reply 唤醒不能写入会进入后续唤醒上下文的内容"。回答原文只进入用户可见的每日摘要。
- reply 唤醒失败不重试，直接以 `wake_failed` 转交它处理的委托；reply 队列不暂停，也不提供 `--release`。
- 唤醒开始前剔除已失效（已转交、用户已回复、任务已离开该次卡住）的委托事件；全部失效则不唤醒。
- reply 唤醒单独计数：`supervisor.limits.reply_wakes_per_day`（默认 48，按唤醒计），不占用 instruction / autonomous 的每日配额；超出时立即转交。

**上下文**：`inputs.wake` 带上卡住说明、终端末尾、请求的命令与理由、任务目标与角色。执行器卡住时附上工作区的 `git diff --stat`（`blocked.diff_stat`，最多 2000 字符）：dev 的 worktree 不在 supervisor 的 `read_scope` 内，它靠这份摘要判断改动范围。

**回复**：新操作 `task_respond{task_id, block_seq, decision, text?, reason}`，由中枢执行。`supervisor` 列为保留 actor：只能由 `kind: supervisor` 角色的 MCP 会话使用，角色加载与 doctor 对名为 `supervisor` 但类别不是 supervisor 的角色报错，HTTP 请求头不能声明。中枢在 store 的同一事务里核对：

- 调用方的唤醒绑定 token（D6）对应持活动租约、正在运行的 reply 唤醒，并且就是被分配处理这次委托的那个唤醒（`task.reply_delegated` 被该唤醒的 `supervisor.wake_started.events` 引用）；
- 任务与绑定 workspace 一致；任务当前 `blocked` 且序号等于 `block_seq`；委托仍有效；该任务没有待送达的回复；
- `approve` / `deny` 只用于 `awaiting_approval`，`answer` 只用于 `question`（`text` 必填，≤2000 字符），`escalate` 两者都可。

不满足返回 `not_delegated`、`stale_block` 或 `invalid_arguments`。通过后写 `task.replied`（actor supervisor，`via: supervisor`，带 `reason`），回复按现有路径送达节点；条目仍按收件箱现有规则在任务离开 `blocked` 时关闭，并记录回复者为 supervisor。当天的每日摘要列出 supervisor 代回复的内容。`escalate` 写 `task.reply_escalated{reason: supervisor}`，条目按原级别推送给用户。

提示词边界：只在任务目标的范围内选方案；需要扩大范围、改变完成条件、涉及不可逆动作、或拿不准时一律 `escalate`。这一条只能靠提示词，中枢无法确定性强制；回答本身不扩大任何权限，worker 仍受沙箱与策略约束。

**转交与竞态**（中枢写 `task.reply_escalated{reason}`，委托随之结束；除 `user_replied`、`user_dismissed` 外，条目按原级别推送）：

- 超过 `supervisor.reply_timeout_s`（默认 600）仍未回复（`timeout`）；
- 唤醒无法开始：未启用、没有 supervisor 角色、reply 配额用尽、当前 reply 唤醒处于 `blocked`（`wake_unavailable`，立即转交，不等超时）；
- 处理该委托的唤醒失败或结束时仍未回复（`wake_failed`、`wake_ended`）；
- 用户忽略该条目（`user_dismissed`）。

**隐式失效**（不写事件）：委托只在任务处于 `blocked`、且当前这次卡住（最近一次 `task.blocked`）的 seq 等于委托的 `block_seq` 时有效。任务离开该次卡住（`task.unblocked`、`task.requeued`、`task.requeued_with_reply`、`task.lease_expired`，包括进入新的卡住）时委托隐式失效，新卡住重新判定是否委托。调度与 `task_respond` 统一用 core 的 `activeDelegation`（store 的 `activeDelegation(taskId)`）判断；失效后的 `task.reply_escalated` 被拒绝（`not_delegated`）。

用户回复：在用户 `task_reply` 的同一次追加里写 `task.reply_escalated{reason: user_replied}` 结束委托（用户忽略条目同理写 `user_dismissed`）。这两种原因的事件 actor 为 user，store 只接受 user 写入；其他原因（`supervisor`、`timeout`、`wake_*`）由中枢写入，只接受 hub。委托结束后，之后 supervisor 的 `task_respond` 返回 `stale_block`。**在 supervisor 的回复写入之前，用户的回复优先**；supervisor 的回复已写入但尚未送达时，用户再回复按现有语义得到 `reply_pending`。转交与 `task_respond` 并发时，以 store 事务的先后为准，后到者得到 `stale_block`。

**实现补充（G12）**：

- **委托范围**：workspace 没有唯一可用的 `kind: supervisor` 角色，或没有登记仓库（唤醒任务无法开始）时，视为不在委托范围内：不写 `task.reply_delegated`，条目直接交给用户，也不写 `wake_unavailable`。`wake_unavailable` 只用于已经委托、之后唤醒才起不来的情况（配额用尽、reply 唤醒卡住、配置在委托之后变化）。
- **请求一致的不确定**：任一侧的命令或路径达到 2000 字符上限、以截断符 `…` 结尾，或含脱敏标记（`[REDACTED:`、`[secret:`）时，判为不一致、不委托——两侧被同样改写时逐字比较仍会相等，但比较的已不是原始请求。store 另要求判定之后、卡住之前本任务没有别的 `policy.decided`，且判定晚于最近一次 `task.started` / `task.lease_expired`。
- **判定时限**：一次判定（读 workspace 与角色配置）最长 30 秒，超时即不委托并放开条目，不堵住串行处理链。
- **取消**：`task.cancel_requested` 结束这次卡住上的委托（不写转交事件），条目立即恢复标题并按原级别推送。
- **回复与送达**：supervisor 的授权批准只送给仍持有租约、正在等待的 worker；节点已不持有租约时 `task_respond` 返回 `stale_block`（不随任务重新排队）。supervisor 的回复待送达期间，用户忽略该条目被拒绝（`reply_pending`，提示回复正在送达）。store 只接受 user 与 supervisor 写 `task.replied`，并核对 supervisor 回复的类型与委托的卡住类型一致（提问只能文字，授权请求只能批准或拒绝）。
- **回答原文的边界**：回答原文（与 supervisor 的理由）不会自动进入任何后续唤醒的上下文（`inputs.wake`、`ws_brief` 都不含）；但它仍在账本与回复记录中，后续唤醒可以用只读工具（`task_show`、事件、收件箱）主动读到。这是已接受的边界：读到的内容仍是数据，不是指令，且后续唤醒的权限不因此扩大。每日摘要列出代回复并标注送达状态（已送达、被拒收、已随任务重新排队、待送达）。
- **已知行为**：
  - 中枢侧 `no_delegate` 兜底的窗口是"最近一次 `task.started` 之后"：同一租约内被拒收过一次，之后的卡住都交给用户，直到下一轮执行；
  - 委托判定时读取一次配置，之后不再重读：委托期间修改 `delegate_replies`、`reply_timeout_s` 或角色，不影响已有委托（超时仍按委托时写下的 `deadline`）；
  - `held` 对每个待推送条目查询一次委托状态，条目数量很大时有额外的查询开销；
  - supervisor 已回复、节点长期不 ack 时，条目一直被挡住不推送，直到任务离开这次卡住（送达、租约过期或用户取消）；超时转交不覆盖这种情况（回复已写入）。

备选：用确定性规则直接 `auto` 放行这些命令。保留为用户自己的选项（策略本来就支持），但它无法处理 `question`，也无法结合任务目标判断"这个请求是否合理"。

**已接受的风险（验收命令）**：D5 第 5 步对 `tool:Verify` 的参数只做词法白名单检查，拦不住仓库内指向仓库外的符号链接（例如 worker 提交的 `src/link-to-outside`，`pnpm test src/link-to-outside` 会加载仓库外的文件），也拦不住用仓库内相对路径加载代码（`--reporter x.js`）；与代回复白名单一样，放行 `pnpm test` 本来就等于在沙箱外执行仓库中（可能被 worker 改过）的脚本，这一项不额外扩大风险。

## Risks / Trade-offs

- **自动合并会真的改 main** → 默认关闭；PR 必须是本 workspace instruction 链上的产物；审查结论由执行器记录 head SHA；合并前确定性核对；merger 不能由 supervisor 直接建。
- **提示词注入**（PR、issue、raw 中的指令）→ supervisor 和 pr-reviewer 没有 shell 和写文件工具，读取限制在仓库内；supervisor 能产生外部效果的只有建任务（受 origin、仓库、上限、策略约束）和合并请求（受 D10 约束）；pr-reviewer 的判定可能被 PR 内容影响，这是残余风险，靠 CI、默认关闭的自动合并和用户批准兜底。
- **唤醒风暴** → 串行合并、D4 上限、唤醒任务不自激、`blocked` 只唤醒一次。
- **费用** → 合并事件、巡检默认关闭、每日唤醒上限；结果记录花费，日报汇总。
- **hub.token 可读** → 见 D2 的已接受风险。
- **代回复被诱导**（worker 的提问或请求理由里夹带指令）→ 授权请求先由确定性白名单限定，受保护动作永远不委托，推送只能是单段、无全局选项、推到登记 remote 的任务分支，gh 只能作用于登记仓库；判定与具体卡住绑定，节点放行前重读请求；reply 唤醒不能建任务、提案或请求合并；审查任务不委托。回答只能靠提示词约束，是残余风险。**已接受的风险**：批准在沙箱外运行 `pnpm check`、`pnpm test` 等于批准在沙箱外执行仓库中的脚本，包括 worker 改过的 `package.json` scripts、测试配置与 `--reporter`、`--preload` 等参数引入的代码，与用户直接点批准的风险相同；supervisor 需要结合 `diff_stat` 判断改动是否触及这些文件，写入文档。 **已接受的风险（节点复核的时间窗）**：节点在 supervisor 的批准送达前重读待批请求、重新校验 gitdir 与推送 / gh 环境，codex-orca 在复核之后、发回车之前再读一次终端确认弹窗全文未变（只比对终端上显示的弹窗文本，无法确认 Codex 内部待执行的请求与显示一致）；但从最后一次读取到 Codex 实际执行命令之间、以及从环境复查到 git / gh 真正读取配置之间仍有很短的时间窗，期间的改动无法排除。
- **决策回看例外** → 只追加、只改 status 与 last_verified、只限关联决策、由中枢代写。
- **单机假设**：中枢和节点读同一份 roles；⑤ 远程节点前需要重新评估。

## Migration Plan

1. 先归档 ②、③（③ 已归档）。
2. 合并代码后：`flow init` 补 `supervisor`、`pr-reviewer`、`merger` 角色；用户手动在 `dev.yaml` 加 `creatable_by: [supervisor]`；在 `policies.yaml` 启用 supervisor 建任务的 `auto` 规则，并按需启用代回复的白名单模板（D15）；按需在 workspace 配置里启用 `supervisor`、`auto_merge` 和巡检规则。
3. 重启中枢和节点（新旧节点协议兼容，D12）；`flow doctor` 检查。
4. 回滚：`supervisor.enabled: false` 即停止唤醒；已建任务不受影响。

## Open Questions

- 从手机访问 Web 页面（任务提案改目标后接受等）：Web 端目前只接受本机 Host / Origin，对外暴露（例如经 Tailscale 的 `ui.public_url`）涉及鉴权、CSRF 与暴露面的安全前提，需用户决定后作为单独任务实现（tasks 4.10）；在此之前 Telegram 只注明 Web 页面仅本机可用。
- 巡检日报是否同时推送 Telegram（目前只进 Digest）。
- `changes_requested` 后的修改任务复用原分支的方式，实现时以 codex-orca 现有能力为准。
- 修改任务的推送是否限定到该 PR 的 head 分支（目前审查轮数只约束建任务，不约束修改任务推到哪里）：留作后续问题。
- 其他 AI 身份借 parent 继承 instruction origin 的根治：要求建任务的调用方就是 parent 任务当前租约的执行者（例如执行器会话持有按租约签发的任务绑定 token），而不是任意持有绑定 token 的 AI；目前只限制 parent 未结束，残余风险写在 `docs/hub-auth.md`。
- 唤醒 token 目前以文件交给 stdio 的 Flow MCP 子进程，同 uid 进程仍可读。以后可改为 Agent SDK 的进程内 MCP（`type: 'sdk'`，在节点进程内实现 Flow 工具），token 只留在节点内存中。
