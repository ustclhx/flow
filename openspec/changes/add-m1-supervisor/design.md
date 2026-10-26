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
- Agent SDK 0.3.310 支持 `outputFormat: {type: 'json_schema'}`，结果带 `structured_output`，失败时 subtype 为 `error_max_structured_output_retries`。

## Goals / Non-Goals

**Goals**

- 跑通 PRD §19 的 M1 验收场景：用户在手机上下指令、回答一次卡住；`auto_merge` 关闭时多一次合并批准。
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

任务的 origin 在创建时由中枢写入任务投影，之后不可变：

- 接受任务提案所建的任务 → instruction（接受就是用户的决定）；
- `parent` 是唤醒任务 → 该唤醒的 origin；
- `parent` 是有 origin 的任务 → 继承它的 origin；
- 其他（包括用户手动建、没有挂到 supervisor 链上的任务）→ **无 origin**：不属于 supervisor 链，它的状态变化不唤醒 supervisor，它的 PR 也不能被 supervisor 请求合并。

**所有身份**建任务时，中枢都校验 `parent`：必须存在、与新任务同一 workspace，否则 `parent_not_found` / `workspace_mismatch`。这堵住"把任意任务挂到唤醒任务或用户任务下面伪造来源"。

`flow ask` 与 `flow supervisor wake` 走 user-only 路由；`user.instruction` 与 `supervisor.release` 只接受 user 身份写入。

**已接受的风险**：能读到 `hub.token` 的进程就是 user（例如 dev 任务里的 Codex `env -u FLOW_ACTOR flow task create ...`），它建的任务如果挂在 instruction 链上，会继承 instruction origin。这与 ①–③ 的信任边界一致（`docs/hub-auth.md`），在 docs 中写明；把 `hub.token` 从执行器可读范围移走留到后续变更。

### D3. 唤醒调度：按 workspace × origin 分队列，串行、合并、限流

调度器订阅账本，识别上表中的唤醒事件。"派生任务状态变化"指 origin 不为空的任务进入 `done`、`failed`、`cancelled`，或进入 `blocked` 且原因是 `crashed`、`node_lost`、`no_progress`、`other`（同一任务同一原因只唤醒一次；`awaiting_approval`、`question` 已经直接进用户收件箱，不唤醒）。唤醒任务自身的状态变化不触发唤醒。

- 每个 workspace 有两条队列：instruction、autonomous。同一 workspace 同时最多一个未结束（含 `blocked`）的唤醒任务；空闲时**先处理 instruction 队列**。一次唤醒只合并同一条队列里的事件，所以每次唤醒恰好有一个 origin。
- 队列与代数（generation，每创建一次唤醒加一）由账本投影，中枢重启后恢复。唤醒任务的幂等键为 `supervisor:<ws>:<generation>`；`supervisor:` 前缀保留给 `hub`，其他身份使用返回 `reserved_idempotency_key`。
- 唤醒任务 `blocked` 时新事件继续排队；用户取消它即放行队列。
- 唤醒任务失败：按重试设置重试一次；仍失败则进收件箱（Interrupt），该队列暂停：新事件继续排队但不触发唤醒，直到用户 `--release`，或暂停满 1 小时后自动恢复一次（再失败则回到暂停，退避时间翻倍，最长 24 小时）。
- 手动控制（user-only）：`flow supervisor wake <ws> <说明>` 写一条 `user.instruction`；`flow supervisor wake <ws> --release <instruction|autonomous>` 写 `supervisor.release{queue}`，立刻用该队列现有事件创建一次唤醒，origin 保持该队列的类别。手动放行不计入每日上限。
- 一个 workspace 只能有一个 `kind: supervisor` 角色可用（全局最多一个，doctor 对多个报错）；唤醒任务使用它。
- workspace 配置 `supervisor.enabled: false` 或没有 `kind: supervisor` 角色时不唤醒，`/ask` 回复未启用。

### D4. 硬性上限（中枢强制）

workspace 配置 `supervisor.limits`，默认值：

| 上限 | 默认 | 超出时 |
| --- | --- | --- |
| 每次唤醒创建的任务数 | 5 | `limit_exceeded` |
| 每个 workspace 每天的唤醒次数 | 24（其中 autonomous 最多 4） | 事件留在队列，收件箱出现一条 Decide："今日唤醒已达上限"，用户可以用 `--release` 放行一次 |
| `parent` 链深度 | 8 | `limit_exceeded` |
| 同一 PR 的 `changes_requested` 轮数 | 2 | 对该 PR 再建 write 任务返回 `review_rounds_exceeded` |
| 同一 workspace 未回答的提问 | 3 | `too_many_questions` |

审查轮数由中枢按 PR URL 统计 reviewer 任务的 `result.review.verdict`。

### D5. supervisor 建任务的检查

`TaskService.createTask` 对 `created_by = supervisor` 的请求，在 `creatable_by` 之后依次检查：

1. `parent` 必须是本 workspace 未结束的唤醒任务（由 `supervisor.wake_started` 判定），否则 `parent_required`；
2. 目标角色的有效类别（D9）为 `write` 且唤醒 origin 为 `autonomous` → 403 `proposal_required`；
3. 目标角色类别为 `merge` 或 `supervisor` → 403 `role_not_allowed`；
4. 合同 `cwd` / `inputs.repo` 必须位于本 workspace 登记的仓库内（realpath 比较），否则 `repo_not_in_workspace`；
5. D4 的数量和深度上限。

策略引擎：`task.create` 仍是受保护动作。`flow init` 生成的 `policies.yaml` 带一条注释掉的模板（精确 workspace、`role: supervisor`、动作 `task.create`、`auto`），用户按 workspace 启用；不启用时 supervisor 建任务走审批，流程能走通但多一次批准。验收（7.1）要求先启用它。

### D6. MCP 会话绑定与读边界

claude-sdk 为 `kind: supervisor` 的任务注入 `flow mcp --actor supervisor --workspace <ws> --task <id>`，并设置 `FLOW_WORKSPACE`、`FLOW_TASK_ID`：

- 写类操作只能作用于该 workspace（否则 `workspace_mismatch`）；`task_create` 自动以绑定的任务为 `parent`。
- 经中枢的写（建任务、提案、提问、合并请求、简报、决策回看）由中枢独立校验（D5、D8）。
- `kb_journal` 仍在本地经写入层执行（只追加），**只有 MCP 绑定这一层检查**；风险是写错 workspace 的 journal，可接受。

读边界：claude-sdk 新增权限字段 `read_scope: cwd`。设置后 PreToolUse 钩子（匹配全部工具，与 `writable_paths` 共用路径判定）只允许读合同工作目录与任务私有目录（见 D10 的 diff 文件）内的路径，拒绝 `.` 开头的路径段、`..`、符号链接越界。检查的字段包括 `file_path`、`path`、`notebook_path`，以及 Glob 的 `pattern`、Grep 的 `glob`（这两个不得是绝对路径、不得含 `..`）；输入中含其他路径类字段的非 MCP 工具一律拒绝。Flow MCP 不受影响。supervisor 与 pr-reviewer 模板都设 `read_scope: cwd`，防止读取 `state/hub.token`、密钥存储、`~/.config/gh`、`~/.ssh` 后经任务目标外传。

### D7. 新增操作（`packages/core/src/ops/`）

| 操作 | 谁能调用 | 执行位置 | 作用 |
| --- | --- | --- | --- |
| `ws_brief`（扩展） | 所有 | 本地 | 增加 supervisor 笔记、进行中的任务、待处理条目、近期决策 |
| `brief_update` | supervisor、user | 中枢 | 整体替换本 workspace 的笔记（带 `base_hash`） |
| `task_propose` | supervisor | 中枢 | 提交任务提案 |
| `ask_user` | supervisor | 中枢 | 发一条提问，可带 2–4 个选项 |
| `pr_merge_request` | supervisor | 中枢 | 请求合并（D10） |
| `decision_review` | supervisor | 中枢 | 为本次回看唤醒关联的决策追加结论 |
| `flow ask` / `flow supervisor wake\|status` | user | 中枢 | 下指令、手动唤醒、查看状态 |

MCP 自动放行清单加入 `brief_update`、`ask_user`、`task_propose`、`decision_review`（只产生等待用户处理的内容或写 supervisor 自己的笔记）。`task_create`、`pr_merge_request` 走策略。supervisor 不能 `task_reply`、`inbox_act`（除忽略自己的条目）、接受或驳回任何提案：替用户审批不在它的权限内。

### D8. 简报笔记

- 路径 `brain/briefs/<id>.md`，`<id>` 是 workspace id 去掉 `ws/` 前缀（`ws/product-res` → `briefs/product-res.md`）。
- 新的 brain 路径类别 `brief`：由中枢以 supervisor 身份经 `commitWrite` 写入（走 gitleaks 与脱敏）；AI 不能本地直写；整体替换。
- `briefs/` 不是条目：从 `readBrainEntries`、`validateBrain`、索引生成和搜索中排除。
- 笔记上限 3000 字符（`brief_too_long`）；`ws_brief` 把笔记放在最前面，最多占预算的 40%，其余各节分享剩余预算。supervisor 提示词以 8000 预算调用。

### D9. 角色有效类别

角色可以声明 `kind: read | write | merge | supervisor`，中枢也会按配置推断，**有效类别取两者中更严格的**（声明只能收紧，不能放宽；严格程度 supervisor、merge > write > read）：

- codex-orca → write；
- codex-exec：`sandbox` 为 `read-only` → read，否则 write；
- claude-sdk：有 `writable_paths`、允许 Edit/Write/NotebookEdit、或 `allowedTools` 中有任何 `Bash(...)` 规则 → write；否则 read；
- pr-merge → merge；
- `kind: supervisor` 必须显式声明，且只能用 claude-sdk。

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
   - `pr-reviewer` 模板：claude-sdk，`allowedTools` 只有 Read、Grep、Glob 和 Flow 只读 MCP，`read_scope: cwd`，不设 `writable_paths`，有效类别 read。
3. `changes_requested` → supervisor 被唤醒，可以建修改任务（同一分支），受 D4 轮数上限。
4. `approve` → supervisor 调用 `pr_merge_request{pr, review_task}`。中枢核对：
   - 该 PR 是本 workspace 内某个 origin 为 instruction 的 write 任务的 `kind: pr` 产物；
   - `review_task` 属于同一 workspace、角色在 `reviewer_roles` 中、`inputs.review.pr` 等于该 PR、`verdict = approve`；
   - 否则 `merge_not_eligible`。

   通过后：`supervisor.auto_merge: true` → 中枢以 `hub` 身份建 merger 任务；否则生成 `source: merge_request` 的收件箱条目（Decide，动作"批准合并""驳回"），用户批准后中枢同样以 `hub` 身份建 merger 任务，批准者记录在 `merge_request.approved` 事件中；驳回则唤醒 supervisor。merger 任务的 `parent` 是审查任务，origin 由中枢直接取自开出该 PR 的 dev 任务（资格要求它是 instruction），不继承审查任务；它结束时进入 instruction 队列唤醒 supervisor。
5. **pr-merge 执行器**（节点上，不调用模型；`gh` 可注入）在本 workspace 登记仓库中执行：
   - 读 PR：open、base 为默认分支、仓库与登记仓库一致、`headRefOid == reviewed_sha`、可合并；
   - 检查：至少有一项检查且全部成功、没有进行中的检查（workspace 配置 `supervisor.allow_no_checks: true` 时允许没有检查）；
   - 再次核对审查任务（同第 4 步）；
   - 任一不满足 → `failed`，原因码如 `pr_not_open`、`head_moved`、`checks_not_green`、`review_not_approved`，**不合并**；
   - 合并方式取 `supervisor.merge_method`（默认 `squash`）；
   - 合并后等待默认分支上该合并提交触发的 workflow runs 结束（默认最多 30 分钟）：全部成功 → `done`，结果附 run 链接；有失败 → `failed(pipeline_failed)`；超时 → `failed(pipeline_timeout)`，结果附 run 链接；没有 run → `done`，注明未发现发布流水线。
6. merger 任务结束 → supervisor 被唤醒，写 journal、更新简报；失败时提问或进收件箱。

`kind: merge` 的任务只能由 `hub` 和 user 创建，按类别判定（用户自建的其他 pr-merge 角色同样受限）。合并审批条目不做 PR 状态轮询；批准时 PR 已关闭或已合并，merger 以 `pr_not_open` 结束，supervisor 下次唤醒时处理。

### D11. 提问、任务提案与决策

**提问**：`ask_user` 创建 `source: supervisor` 条目（默认 Decide，`source_ref` 为唤醒任务 id，动作 `reply`，有选项时附按钮）。用户回复 → 条目关闭为 `answered`，写 `supervisor.answered{item_id, text, via}` → 唤醒。提问不挂起唤醒任务。7 天未回答 → 关闭为 `expired`，唤醒一次。`inbox_act reply` 的路由扩展到 `supervisor` 来源，仍只有 user 能执行。

**任务提案**：账本事件 `task_proposal.created|accepted|rejected`，收件箱新来源 `task_proposal`（不复用知识提案的 `proposal` 来源，避免动作路由与 `proposal_removed` 自动关闭的冲突）。

- 草稿必须通过 `createTaskRequest` 校验；workspace 必须是绑定的 workspace；目标角色有效类别不能是 merge 或 supervisor；cwd / repo 必须在本 workspace 登记仓库内。
- 条目展示角色、执行器、仓库与 cwd、验收命令、目标全文；Telegram 消息附 Web 链接，Web 上可以修改目标后再接受。
- 接受 → 中枢以 user 身份建任务（`parent` 为提案所在唤醒任务，origin instruction）。

**决策**：提案可带 `title`、`expected_outcome`、`metric`、`review_date`（晚于当天，≤180 天）。接受时中枢以 user 身份写 `brain/decisions/<YYYY-MM-DD>-<slug>.md`（`type: decision`、`status: approved`、`workspace`、`sources` 引用任务 id），任务合同 `context` 引用它。

**回看**：中枢注册一条每天 09:00（中枢时区）的内部规则，扫描 `status: approved` 且 `review_date ≤ 今天`、尚未发过的决策，写 `decision.review_due{path}`（同一决策只写一次，以账本去重；停机错过的在下一次扫描补发）。决策没有 workspace 或该 workspace 未启用 supervisor → 只生成一条 Digest 条目提醒用户。supervisor 用 `decision_review` 追加 `## 回看 YYYY-MM-DD` 一节，并把 `status` 改为 `reviewed`、`last_verified` 改为当天；由中枢以 `hub` 身份代写，只允许本次唤醒关联的那条决策，其他字段与其他决策不可改。这是写入层"AI 不能写 decision"的唯一窄例外。

### D12. 节点为 supervisor 预留执行槽

- 协议：`acquireLeaseRequest` 增加可选字段 `slots: {general: n, supervisor: m}`；中枢只把 `kind: supervisor` 的任务分给 supervisor 空位，普通空位也能接 supervisor 任务。没有该字段的旧节点视为全部是普通空位（版本兼容）。
- 节点：`node.yaml` 的 `reserved.supervisor`（默认 1）；领取循环在普通槽满时仍为 supervisor 空位发起领取。
- pr-merge 很短，用普通空位。

### D13. 巡检

- `flow init` 在 `config/schedules.yaml` 生成注释掉的示例（`0 9 * * *`、`payload.kind: supervisor_patrol`）。默认不启用。
- 巡检提示词：读简报 → 看进行中/卡住/失败任务、未合并 PR、过期事实、近期 raw/inbox → 写日报（journal，并作为 Digest 条目进入每日摘要）→ 写类工作只能提案（D5 强制）→ 更新简报。
- doctor 对启用 supervisor 却没有巡检规则的 workspace 给 info。

### D14. supervisor 角色模板

`supervisor.yaml`：`kind: supervisor`、`executor: claude-sdk`、Opus、`permissionMode: default`、`setting_sources: []`、`allowedTools` 只有 Read、Grep、Glob 与 Flow MCP，`disallowedTools` 列出 Bash、Edit、Write、NotebookEdit、WebFetch、WebSearch，`read_scope: cwd`，不设 `writable_paths`。`supervisor.md` 规定：先 `ws_brief`；按 `inputs.wake` 处理；拆任务时写清目标、范围、完成条件和验收命令；不替用户做决定；结束前 `brief_update` 并写 journal；最终回复列出本次动作。

`flow init` 同时生成 `pr-reviewer`、`merger` 模板，`dev` 模板 `creatable_by` 加上 `supervisor`；不覆盖已有文件，doctor 对缺项给出片段。

## Risks / Trade-offs

- **自动合并会真的改 main** → 默认关闭；PR 必须是本 workspace instruction 链上的产物；审查结论由执行器记录 head SHA；合并前确定性核对；merger 不能由 supervisor 直接建。
- **提示词注入**（PR、issue、raw 中的指令）→ supervisor 和 pr-reviewer 没有 shell 和写文件工具，读取限制在仓库内；supervisor 能产生外部效果的只有建任务（受 origin、仓库、上限、策略约束）和合并请求（受 D10 约束）；pr-reviewer 的判定可能被 PR 内容影响，这是残余风险，靠 CI、默认关闭的自动合并和用户批准兜底。
- **唤醒风暴** → 串行合并、D4 上限、唤醒任务不自激、`blocked` 只唤醒一次。
- **费用** → 合并事件、巡检默认关闭、每日唤醒上限；结果记录花费，日报汇总。
- **hub.token 可读** → 见 D2 的已接受风险。
- **决策回看例外** → 只追加、只改 status 与 last_verified、只限关联决策、由中枢代写。
- **单机假设**：中枢和节点读同一份 roles；⑤ 远程节点前需要重新评估。

## Migration Plan

1. 先归档 ②、③（③ 已归档）。
2. 合并代码后：`flow init` 补 `supervisor`、`pr-reviewer`、`merger` 角色；用户手动在 `dev.yaml` 加 `creatable_by: [supervisor]`；在 `policies.yaml` 启用 supervisor 建任务的 `auto` 规则；按需在 workspace 配置里启用 `supervisor`、`auto_merge` 和巡检规则。
3. 重启中枢和节点（新旧节点协议兼容，D12）；`flow doctor` 检查。
4. 回滚：`supervisor.enabled: false` 即停止唤醒；已建任务不受影响。

## Open Questions

- 巡检日报是否同时推送 Telegram（目前只进 Digest）。
- `changes_requested` 后的修改任务复用原分支的方式，实现时以 codex-orca 现有能力为准。
