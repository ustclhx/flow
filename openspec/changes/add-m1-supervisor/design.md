# Design

## Context

现状（2026-10-26，① 已归档，②、③ 代码完成待归档）：

- 中枢有只追加账本（`state/flow.db`）、进程内订阅 `ledger.subscribe`、SSE `/v1/events`、基于 croner 的调度器。`schedule.fired` 和 `user.instruction`（Telegram `/ask` 写入）已经落账，但**没有消费者**。
- 任务合同已有 `parent`、`idempotency_key`；角色有 `creatable_by`，非 user 身份建任务受它限制；策略引擎把 `task.create`、`inbox.act` 等列为受保护动作。
- claude-sdk 执行器给会话注入 `flow mcp --actor <角色名>`，并设置 `FLOW_ACTOR=<角色名>`；MCP 只走 stdio。
- 收件箱来源里 `supervisor` 和关闭原因 `answered` 已预留，但没有任何身份能创建 supervisor 条目，也没有把回复送给非任务对象的路径。
- 简报 `ws_brief` 是即时拼出来的（workspace 描述、项目卡片、资源、近期 journal、过期事实），没有可写的部分。
- `decision` 条目类型已存在（status、expected_outcome、metric、review_date），AI 不能写。
- 知识修改提案（`kb_propose`）基于文件，在 `state/proposals/`；没有"任务提案"。
- 节点按 `concurrency` 限制同时持有的租约，卡住的任务一直占着槽位。

## Goals / Non-Goals

**Goals**

- 跑通 PRD §19 的 M1 验收场景，用户只在手机上操作两次（下指令、回答一次卡住）；`auto_merge` 关闭时多一次合并批准。
- supervisor 只能经过内核提供的工具行动，所有动作落账、可审计；越权由中枢强制拒绝，而不是只靠提示词。
- 每次唤醒都是新会话，靠简报恢复记忆。
- 合并这一类不可逆外部动作由确定性代码执行，条件由代码核对。

**Non-Goals**

- 参谋长、跨 workspace 协作、资源归属迁移。
- 与 supervisor 的实时多轮对话（Web 工作台）。
- 预算上限与巡检频率的自适应。
- 远程节点上的 supervisor（⑤ 之后再评估）。

## Decisions

### D1. supervisor 是一类任务，不是常驻进程

每次唤醒，中枢创建一个任务：`role: supervisor`、`executor: claude-sdk`、`workspace: <ws>`，`inputs.wake` 描述唤醒原因与关联事件。这样直接复用现有的租约、心跳、卡住检测、审批挂起、收件箱、重试和审计，满足"supervisor 本身是被内核监督、可以重启的 worker"。

备选：中枢内常驻一个 Agent SDK 会话。放弃原因：要重做监督、会话越来越长、违背"每次唤醒都是新会话"。

唤醒任务由中枢以身份 `hub` 创建（不走 `creatable_by`，因为 `hub` 是保留身份，只有中枢内部能用）。用户也可以手动 `flow task create --role supervisor`。

### D2. 唤醒调度器：事件 → 唤醒，按 workspace 串行并合并

中枢新增 supervisor 调度器，订阅账本：

| 事件 | 唤醒原因 `wake.kind` |
| --- | --- |
| `user.instruction`（`/ask`、`flow ask`） | `instruction` |
| 由 supervisor 派生的任务的 `task.done` / `task.failed` / `task.blocked` / `task.cancelled` | `task_update` |
| `supervisor.answered` | `answer` |
| `task_proposal.accepted` / `rejected` | `proposal_update` |
| `schedule.fired`，且 `payload.kind = supervisor_patrol` | `patrol` |
| `decision.review_due` | `decision_review` |

"由 supervisor 派生"= 任务的 `parent` 链上有 supervisor 唤醒任务。supervisor 唤醒任务自己的结束不触发唤醒（避免自激）。

规则：

- 每个 workspace 同时最多一个未结束的唤醒任务。期间到达的事件进入该 workspace 的待处理队列（投影自账本，中枢重启不丢）；当前唤醒结束后，把队列里的事件**合并**成下一次唤醒，`inputs.wake.events` 列出全部事件 id。
- 唤醒任务的 `idempotency_key = supervisor:<ws>:<首个事件 id>`，中枢重放时不会重复创建。
- 唤醒任务 `blocked`（例如等审批）时仍算"未结束"，新事件继续排队；用户可以取消它来放行队列。
- 唤醒任务 `failed`：按任务的重试设置重试一次；仍失败则进收件箱（Interrupt），队列保留，下一个事件到来或用户手动 `flow supervisor wake <ws>` 时重新开始。
- workspace 没有 `supervisor` 角色或 `supervisor.enabled: false` 时不唤醒；`/ask` 回复"该 workspace 未启用 supervisor"。

### D3. 来源链与建任务权限

每个唤醒任务记录 `inputs.wake.origin`：

- `instruction`：本次唤醒由用户指令触发，或者沿 `parent` 链回溯先遇到用户指令或由 user 创建的任务（例如指令派生的 dev 任务结束后的 `task_update` 唤醒；用户接受任务提案后创建的任务，因为接受本身就是用户的决定）；
- `patrol`、`decision_review`：沿链回溯的根是巡检或回看；
- `answer`、`proposal_update`：继承提问或提案所在唤醒的 origin。

中枢在 `TaskService.createTask` 中，对 `created_by = supervisor` 且 `parent` 指向唤醒任务的请求增加检查：

- 目标角色是 dev 这类"可写"角色（角色模板标注 `kind: write`，见 D9），且 origin 不是 `instruction` → 拒绝，403 `proposal_required`，提示改用 `task_propose`；
- 只读角色（`kind: read`，reviewer、triage）和 `pr-merge` 角色不受 origin 限制；
- 原有 `creatable_by` 检查照旧，先于本检查执行。

supervisor 建的任务必须带 `parent = 当前唤醒任务 id`。MCP 会话从 `FLOW_TASK_ID` 读取当前任务 id 并自动填入 `parent`；缺少时中枢拒绝（`parent_required`）。这样来源链不能被 supervisor 省略。

策略引擎：`task.create` 是受保护动作。`flow init` 生成的默认 `policies.yaml` 增加按 workspace 精确匹配、`role: supervisor`、动作 `task.create` 的 `auto` 规则模板（注释形式，用户按 workspace 启用）。未启用时，supervisor 建任务会走审批（canUseTool 挂起），流程仍能走通，只是多一次批准。

### D4. MCP 会话按 workspace 绑定

claude-sdk 为 supervisor 会话注入 `flow mcp --actor supervisor --workspace <ws> --task <id>`（同时设置 `FLOW_WORKSPACE`、`FLOW_TASK_ID`）。绑定后：

- 写类操作（简报笔记、任务、提案、提问、journal、合并、回看）只能作用于该 workspace，参数里写别的 workspace 返回 `workspace_mismatch`；
- 读类操作不限制（简报、知识可以跨 workspace 读）。

与 `FLOW_ACTOR` 一样，这是默认绑定而非隔离：能读 `hub.token` 的进程仍是 user。中枢侧对 supervisor 身份的写请求同样校验 workspace 与 `parent` 唤醒任务一致（唤醒任务的 workspace 是权威来源），所以 MCP 层只是第一道防线。

### D5. 新增操作（`packages/core/src/ops/`）

| 操作 | 谁能调用 | 作用 |
| --- | --- | --- |
| `ws_brief`（扩展） | 所有 | 增加"进行中的任务""待处理收件箱条目""近期决策""supervisor 笔记"几节；预算不变 |
| `brief_update` | supervisor | 整体替换 `brain/briefs/<ws>.md` 的正文（带 `base_hash` 防覆盖） |
| `task_propose` | supervisor | 提交任务提案（合同草稿 + 理由 + 可选决策字段） |
| `ask_user` | supervisor | 发一条提问，可带 2–4 个选项 |
| `pr_merge_request` | supervisor | 请求合并某个 PR：中枢按 `auto_merge` 建 pr-merge 任务或生成合并审批条目 |
| `decision_review` | supervisor | 对本次回看唤醒关联的决策追加回看结论、把状态改为 `reviewed` |
| `flow ask <ws> <text>` | user（CLI） | 与 `/ask` 相同，写 `user.instruction` |

`kb_journal`、`task_create`、`task_list`、`task_show` 沿用。MCP 自动放行清单（`FLOW_MCP_AUTO_ALLOWED`）加入 `brief_update`、`ask_user`、`task_propose`、`decision_review`：它们只产生需要用户后续处理的内容或写 supervisor 自己的笔记，不产生外部副作用。`task_create`、`pr_merge_request` 仍走策略。

supervisor 不能调用 `task_reply`、`inbox_act`（除忽略自己的条目）、`kb_proposals_accept/reject`：替用户审批不在 supervisor 的权限内。

### D6. 简报笔记存放在 `brain/briefs/<ws>.md`

- 新的 brain 路径类别 `brief`：只有 `supervisor` 身份（以及 user）能写，只能写 `briefs/<workspace id>.md`，且 workspace 必须与会话绑定一致；整体替换，不是条目（不进 `index.md`，无 frontmatter 校验以外的 schema）。
- 经 `commitWrite` 写入，走 gitleaks 和脱敏。
- 长度上限 8000 字符，超出拒绝（`brief_too_long`），逼 supervisor 自己精简。
- `ws_brief` 的输出把笔记放在最前面，其余由中枢从账本和 brain 生成。

备选：只用 journal 恢复记忆。放弃原因：journal 只追加，越来越长，"当前状态"需要覆盖写。

### D7. 问用户：非阻塞的提问条目

`ask_user` 让中枢创建收件箱条目（`source: supervisor`，默认 Decide，`source_ref` = 唤醒任务 id，`actions: reply`，有选项时附按钮）。

- 用户回复（Telegram 回复消息、按钮、Web、`flow inbox reply`）→ 条目关闭为 `answered`，写 `supervisor.answered{item_id, text, via}` → 调度器唤醒（D2）。
- 唤醒任务提问后照常结束，不挂起：答复会在下一次唤醒里处理，期间不占执行槽。
- 同一 workspace 未回答的提问最多 3 条，超出返回 `too_many_questions`，防止刷屏。
- 提问条目 7 天未回答自动关闭为 `expired`，并唤醒 supervisor 一次（`wake.kind = answer`，内容为过期）。

`inbox_act` 中 `reply` 动作的路由从"只接受 task 来源"扩展到 `supervisor` 来源；仍然只有 user 能执行。

### D8. 任务提案与决策

任务提案存在账本里（不是文件）：`task_proposal.created{proposal_id, workspace, contract, reason, decision?}`、`task_proposal.accepted{task_id, decision_path?}`、`task_proposal.rejected{reason?}`。

- 合同草稿必须通过与 `task_create` 相同的校验（`createTaskRequest`），角色存在；不检查 `creatable_by`，因为接受后以 user 身份创建。
- 收件箱条目 `source: proposal`、`source_ref: tp.<id>`，动作"接受""驳回"。接受时用户可以在 Web 上改目标文本后再接受（Telegram 只能原样接受）。
- `decision` 可选字段：`title`、`expected_outcome`、`metric`、`review_date`（必须晚于今天，最多 180 天）。接受时中枢以 user 身份经 `writeEntry` 写 `brain/decisions/<YYYY-MM-DD>-<slug>.md`（`type: decision`、`status: approved`、`workspace`、`sources` 指向任务 id），并在任务合同的 `context` 中引用该决策。
- 回看：中枢调度器注册内部规则 `decision-review:<path>`，在 `review_date` 当天 09:00（中枢时区）写 `decision.review_due{path}`，唤醒 supervisor（`origin: decision_review`）。中枢重启时从 brain 中 `status: approved` 且到期未回看的决策补发。
- `decision_review` 只允许操作本次唤醒关联的那条决策：在正文末尾追加 `## 回看 YYYY-MM-DD` 一节（结论、指标观察、建议），frontmatter 只改 `status: reviewed` 和 `last_verified`。由中枢以 `hub` 身份代写，写入层增加这一条窄例外，其余字段仍只能用户改。
- 回看如果建议后续行动，只能再提任务提案（origin 为 `decision_review`，不能直接建写任务）。

### D9. 角色 `kind`

角色新增可选字段 `kind: write | read | merge`，缺省按执行器推断：codex-orca → `write`，codex-exec 只读沙箱 → `read`，claude-sdk 有 `writable_paths` 或允许 Edit/Write → `write`、否则 `read`，pr-merge → `merge`。D3 的来源检查用它。doctor 显示每个角色的推断结果。

### D10. PR 验收链

1. dev 任务 `done` 且结果里有 `kind: pr` 产物 → supervisor 被唤醒（`task_update`），按提示词建 reviewer 任务：`inputs.review = {pr: <url>, head_sha: <sha>}`，`parent` 为当前唤醒任务。
2. **结构化审查结论**：claude-sdk 对 `inputs.review` 存在的任务启用 SDK 的结构化输出（JSON Schema），最终结果写入 `result.review = {verdict: approve | changes_requested, reviewed_sha, blocking: [{file?, line?, summary}], notes}`。结构化输出缺失或不合 schema → 任务 `failed(review_output_invalid)`。
3. `changes_requested` → supervisor 被唤醒，可以给原 dev 任务追加修改（新建 dev 任务，`inputs.repo` 与分支相同，origin 继承 instruction），最多 2 轮，超出则 `ask_user`。
4. `approve` → supervisor 调用 `pr_merge_request{pr, review_task}`：
   - `workspace.supervisor.auto_merge: true`：中枢直接建 `pr-merge` 任务；
   - 否则：生成收件箱条目（`source: supervisor`、Decide、动作"批准合并""驳回"），用户批准后中枢以 user 身份建 `pr-merge` 任务。
5. **pr-merge 执行器**（节点上，确定性，不调用模型）在合同 cwd 对应仓库中用 `gh`：
   - 读 PR：状态为 open、base 是默认分支、`headRefOid == reviewed_sha`、所有必需检查成功（`gh pr checks` 全部 pass，没有 pending）、可合并；
   - 审查任务必须是 `done`、`result.review.verdict == approve`、`reviewed_sha` 一致、workspace 一致；
   - 任一条件不满足 → `failed`，错误码说明原因（`head_moved`、`checks_not_green`、`review_not_approved`…），**不合并**；
   - 合并方式取 workspace 配置 `supervisor.merge_method`（默认 `squash`），不删除分支以外的任何东西；
   - 合并后找到 main 上该合并提交触发的 workflow runs，轮询到全部结束（默认最多 30 分钟）：全部成功 → `done`，结果带 run 链接；有失败 → `failed(pipeline_failed)`；超时 → `blocked(other)`；没有任何 run → `done` 并在结果中注明"未发现发布流水线"。
6. pr-merge 结束 → supervisor 被唤醒，写 journal（做了什么、PR、流水线结果），更新简报；失败时 `ask_user` 或进收件箱。

pr-merge 是 `kind: merge` 的内置角色 `merger`（模板），`creatable_by` 只有 `hub`（中枢内部）和 user，supervisor 不能直接建它，只能通过 `pr_merge_request`。

### D11. 节点为 supervisor 预留执行槽

`node.yaml` 新增 `reserved: {supervisor: 1}`（默认 1）。节点 long-poll 时声明两类空位：普通空位 = `concurrency - 普通任务数`，supervisor 空位 = 预留数 - 运行中的 supervisor 任务数；中枢只把 `role: supervisor` 的任务分给 supervisor 空位，普通空位也能接 supervisor 任务。pr-merge 很短，用普通空位。

### D12. 巡检

- `flow init` 在 `config/schedules.yaml` 生成注释掉的示例：`{id: patrol-product-res, cron: "0 9 * * *", workspace: ws/product-res, payload: {kind: supervisor_patrol}}`。用户启用后生效。
- 巡检唤醒的提示词要求：读简报 → 看进行中/卡住/失败任务、未合并 PR、过期事实、近期 raw/inbox → 写一份日报（journal，并作为 Digest 条目进入每日摘要）→ 发现的问题只提任务提案（D3 强制）→ 更新简报。
- 默认不配置任何巡检，避免一上线就产生费用；`flow doctor` 对启用 supervisor 却没有巡检规则的 workspace 给 info。

### D13. supervisor 提示词与角色模板

`supervisor.yaml`：`executor: claude-sdk`，模型 Opus，`permissionMode: default`，`setting_sources: []`（不加载项目设置），`allowedTools` 只有 Read、Grep、Glob 和 Flow MCP，`disallowedTools` 列出 Bash、Edit、Write、NotebookEdit、WebFetch、WebSearch；不设 `writable_paths`。supervisor 不直接碰代码和 shell。`cwd` 按合同工作目录规则（workspace 唯一仓库）。

`supervisor.md` 规定：先 `ws_brief`；按 `inputs.wake` 处理；拆任务时每个任务写清目标、范围、完成条件、验收命令；不替用户做决定；结束前 `brief_update` 并写 journal；最终回复简要列出本次动作。

## Risks / Trade-offs

- **自动合并会真的改 main** → 默认关闭；条件由确定性代码核对（head SHA 与审查一致、检查全绿）；任何不满足都不合并；pr-merge 角色 supervisor 不能直接建。
- **supervisor 提示词注入**（PR 内容、issue、raw 资料可能包含指令） → supervisor 没有 shell 和写文件工具；能产生外部效果的只有建任务（受来源链和策略约束）和合并请求（受 D10 条件约束）；巡检来源一律只能提案。
- **唤醒风暴**（大量任务事件） → 按 workspace 串行合并；唤醒任务自身结束不触发唤醒；changes_requested 最多 2 轮；提问上限。
- **费用**：每次唤醒都是一次 Opus 会话 → 合并事件降低次数；巡检默认关闭；结果里记录花费，日报汇总。
- **来源链依赖 `parent`** → 中枢强制 supervisor 建的任务必须带 `parent` 且指向本 workspace 的唤醒任务。
- **决策回看例外**放宽了"AI 不能写 decision" → 只允许追加回看一节和改 status，由中枢代写，且只针对本次唤醒关联的那条。
- **单机假设**：中枢和节点读同一份 roles；⑤ 远程节点前需要重新评估。

## Migration Plan

1. 先归档 ②、③，使 `inbox`、`role-config` 等进入 `openspec/specs/`。
2. 合并代码后：`flow init` 补 `supervisor`、`merger` 角色（不覆盖已有文件）；用户手动在 `dev.yaml` 加 `creatable_by: [supervisor]`；按需在 `policies.yaml` 启用 supervisor 建任务的 `auto` 规则、在 workspace 配置里启用 `supervisor`、`auto_merge`、巡检规则。
3. 重启中枢和节点；`flow doctor` 检查。
4. 回滚：workspace 配置 `supervisor.enabled: false` 即停止唤醒；已建任务不受影响。

## Open Questions

- 巡检日报是否同时推送 Telegram（目前只进 Digest）。
- `changes_requested` 后是复用原 worktree 继续改，还是新开 worktree 推同一分支；实现时以 codex-orca 现有能力为准，倾向新任务指定同一分支。
