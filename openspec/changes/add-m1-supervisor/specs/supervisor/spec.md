# Spec Delta

## Purpose

每个 workspace 有一个由内核唤醒、监督的 supervisor：它把用户指令和事件变成任务、提案、提问与日志，只通过内核提供的工具行动，每次唤醒都是新会话并靠简报恢复记忆（PRD §7.1、§19 第 5 条）。

## ADDED Requirements

### Requirement: 唤醒任务只能由中枢创建
supervisor 唤醒任务 SHALL 由中枢以 `hub` 身份创建，并写入 `supervisor.wake_started{task_id, workspace, origin, events, generation}`；系统判断"某任务是不是唤醒任务"MUST 以这条事件为准。`kind: supervisor` 角色的任务 MUST NOT 由其他任何身份（包括 user）通过建任务接口创建；`hub` 创建任务时跳过 `creatable_by`。`hub` 身份 MUST NOT 能由请求头或 MCP 声明。

#### Scenario: 用户直接建唤醒任务
- **WHEN** user 运行 `flow task create --role supervisor ...`
- **THEN** 返回 `role_not_allowed`，提示改用 `flow supervisor wake`

#### Scenario: 冒充唤醒任务
- **WHEN** 某个 AI 身份建了一个 `role: triage`、`inputs.wake` 伪造为指令的任务
- **THEN** 该任务不被视为唤醒任务，不能作为 supervisor 建任务的 `parent`

### Requirement: 唤醒来源
中枢 SHALL 在以下事件发生时为对应 workspace 安排唤醒：actor 为 user 的 `user.instruction`；`payload.kind = supervisor_patrol` 的定时触发；`decision.review_due`；属于 supervisor 链的任务进入 `done`、`failed`、`cancelled`，或进入原因为 `crashed`、`node_lost`、`no_progress`、`other` 的 `blocked`（同一任务同一原因只一次）；用户回答提问；任务提案被接受或驳回；卡住被委托给 supervisor（见"卡住时代用户回复"）。唤醒任务自身的状态变化 MUST NOT 触发唤醒。

#### Scenario: 用户指令唤醒
- **WHEN** 用户在 Telegram 发送 `/ask product-res 把 README 的项目定位补上`
- **THEN** 中枢为 `ws/product-res` 创建唤醒任务，origin 为 `instruction`

#### Scenario: 未委托的审批不唤醒
- **WHEN** 一个 dev 任务进入 `blocked(awaiting_approval)`，策略判定为 `user`
- **THEN** 不唤醒 supervisor，条目直接进入用户收件箱并推送

#### Scenario: 唤醒任务自身结束不自激
- **WHEN** 唤醒任务变为 `done`，且所有队列都为空
- **THEN** 不创建新的唤醒任务

### Requirement: 来源由中枢计算且不可变
每个唤醒和 supervisor 链上的任务 SHALL 有中枢计算的 origin（`instruction` 或 `autonomous`；代回复的唤醒为 `reply`，它不能派生任务，`reply` 不会出现在任何任务上），创建时写入，之后不变：user 指令触发的唤醒、接受提案所建任务为 instruction；巡检与决策回看为 autonomous；唤醒任务的子任务取该唤醒的 origin，`parent` 有 origin 的任务继承它；回答提问继承提问所在唤醒的 origin。其他任务（包括用户手动建、不在链上的任务）MUST 没有 origin；它们的状态变化不唤醒 supervisor，委托给 supervisor 的卡住除外（只能回复的 reply 唤醒）。origin MUST NOT 取自合同 `inputs` 或任何调用方可填写的字段。

#### Scenario: 指令派生的后续唤醒
- **WHEN** instruction 唤醒所建的 dev 任务 `done`
- **THEN** 随后的唤醒 origin 为 instruction

#### Scenario: 用户手动建的任务不入链
- **WHEN** 用户 `flow task create` 一个没有 `parent` 的 dev 任务，它开出 PR 后结束
- **THEN** 不唤醒 supervisor，supervisor 对该 PR 的合并请求返回 `merge_not_eligible`

#### Scenario: 接受提案后的后续工作
- **WHEN** 用户接受巡检提案所建的 dev 任务结束
- **THEN** 随后的唤醒 origin 为 instruction

### Requirement: 按 workspace 与来源分队列串行唤醒
同一 workspace 同时 SHALL 最多一个未结束（含 `blocked`）的普通唤醒（instruction 或 autonomous），另可并行最多一个 reply 唤醒。期间到达的事件按 origin 进入 instruction、autonomous 或 reply 队列；普通唤醒结束后优先处理 instruction 队列，一次唤醒只合并同一条队列的事件。队列与代数 MUST 由账本投影，中枢重启后不丢失、不重复；代数在每次创建唤醒时加一，唤醒任务的幂等键为 `supervisor:<ws>:<generation>`，`supervisor:` 前缀 MUST 只允许 `hub` 使用。

#### Scenario: 运行中到达的事件被合并
- **WHEN** 唤醒 A 运行期间，两个 instruction 链上的任务先后结束
- **THEN** A 结束后只创建一个唤醒，`inputs.wake.events` 包含这两个事件

#### Scenario: 不同来源不合并
- **WHEN** 唤醒运行期间先后到达一个巡检触发和一条用户指令
- **THEN** 之后先创建一个 origin 为 instruction 的唤醒，再创建一个 origin 为 autonomous 的唤醒

#### Scenario: 卡住的唤醒仍在排队
- **WHEN** 唤醒任务处于 `blocked(awaiting_approval)` 时到达新事件
- **THEN** 事件进入队列；用户取消该唤醒任务后，下一次唤醒随即创建

#### Scenario: 连续两次正常唤醒
- **WHEN** 同一队列先后两次在唤醒结束后有新事件
- **THEN** 创建两个不同的唤醒任务

#### Scenario: 抢注幂等键
- **WHEN** 非 hub 身份以 `supervisor:` 开头的幂等键建任务
- **THEN** 返回 `reserved_idempotency_key`

#### Scenario: 中枢重启
- **WHEN** 队列中有一个待处理事件时中枢重启
- **THEN** 重启后为该事件创建且只创建一次唤醒任务

### Requirement: 唤醒失败与手动控制
普通唤醒任务失败 SHALL 按重试设置重试一次（reply 唤醒失败不重试，直接转交它处理的委托，reply 队列不暂停）；仍失败 MUST 在收件箱生成 Interrupt 条目并暂停该队列：新事件继续排队但不触发唤醒，直到用户放行或退避时间到（首次 1 小时，每次失败翻倍，最长 24 小时）。用户 SHALL 能用 `flow supervisor wake <ws> <说明>` 下指令（写入 `user.instruction`），用 `flow supervisor wake <ws> --release <instruction|autonomous>` 放行指定队列（写入 `supervisor.release`，唤醒保持该队列的 origin，不计入每日上限），用 `flow supervisor status [<ws>]` 查看当前唤醒、各队列长度、今日唤醒次数和最近一次结果。一个 workspace 可用的 `kind: supervisor` 角色 MUST 恰好一个，多于一个时 doctor 报错且不唤醒。

#### Scenario: 重试用尽后恢复
- **WHEN** autonomous 唤醒两次都 `failed`，之后用户运行 `flow supervisor wake product-res --release autonomous`
- **THEN** 收件箱先出现 Interrupt 条目；放行后创建一个 origin 为 autonomous 的唤醒，包含该队列中的事件

### Requirement: 启用开关
workspace 配置 SHALL 支持 `supervisor.enabled`（缺省 true，仅在存在 `kind: supervisor` 角色时生效）。未启用时 MUST NOT 唤醒，`/ask`、`flow ask` 回复该 workspace 未启用 supervisor。 `ws/global` 的 supervisor MUST 固定不启用：不唤醒，也不代回复其中任务的卡住。

#### Scenario: 关闭后不唤醒
- **WHEN** `ws/xuanxue-saas` 配置 `supervisor.enabled: false`，用户发送 `/ask xuanxue-saas 看看支付`
- **THEN** 不创建唤醒任务，用户收到"该 workspace 未启用 supervisor"

#### Scenario: global 不启用
- **WHEN** 用户发送 `/ask global 看看`，或 `ws/global` 中的任务进入 `blocked(question)`
- **THEN** 不创建唤醒任务、不写 `task.reply_delegated`，卡住按普通条目推送给用户；doctor 显示"global 不启用 supervisor"

### Requirement: supervisor 建任务的约束
中枢对 supervisor 身份的建任务请求 SHALL 依次检查：`parent` 是本 workspace 未结束的唤醒任务（否则 `parent_required`）；目标角色有效类别为 write 且唤醒 origin 为 autonomous 时拒绝（403 `proposal_required`）；目标类别为 merge 或 supervisor 时拒绝（403 `role_not_allowed`）；`cwd` 与 `inputs.repo` 位于本 workspace 登记仓库内（否则 `repo_not_in_workspace`）。

#### Scenario: 指令派生可以直接建 dev 任务
- **WHEN** instruction 唤醒中 supervisor 建 dev 任务
- **THEN** 在 `creatable_by` 与策略通过后创建任务

#### Scenario: 巡检发现只能提案
- **WHEN** autonomous 唤醒中 supervisor 建 dev 任务
- **THEN** 返回 403 `proposal_required`

#### Scenario: 巡检可以建只读任务
- **WHEN** autonomous 唤醒中 supervisor 建 triage 任务
- **THEN** 任务被创建

#### Scenario: 指向 flow-home
- **WHEN** supervisor 建的任务 `cwd` 为 `~/flow-home`
- **THEN** 返回 `repo_not_in_workspace`

### Requirement: 硬性上限
中枢 SHALL 按 workspace 配置 `supervisor.limits` 强制上限，默认：每次唤醒建任务 5 个、每 workspace 每天普通唤醒 24 次（其中 autonomous 最多 4 次，不含 reply 唤醒）、每天 reply 唤醒 48 次（超出时委托立即转交用户）、`parent` 链深度 8、同一 PR `changes_requested` 2 轮、未回答提问 3 条。建任务超限返回 `limit_exceeded` 或 `review_rounds_exceeded`；每日唤醒超限时事件留在队列，并生成一条 Decide 条目，用户可用 `--release` 放行。

#### Scenario: 第三轮修改
- **WHEN** 同一 PR 已两次得到 `changes_requested`，supervisor 再为它建 dev 任务
- **THEN** 返回 `review_rounds_exceeded`

#### Scenario: 每日上限
- **WHEN** 当天第 25 个唤醒事件到达
- **THEN** 不创建唤醒，收件箱出现"今日唤醒已达上限"

### Requirement: 简报读写
supervisor SHALL 能用 `ws_brief` 读取简报（supervisor 笔记、进行中的任务、待处理条目、近期决策、近期 journal），笔记最多占预算的 40%。SHALL 能用 `brief_update` 经中枢整体替换本 workspace 的笔记 `brain/briefs/<id>.md`（`<id>` 不含 `ws/` 前缀）：带 `base_hash`，不一致时 `conflict`；超过 3000 字符时 `brief_too_long`；写入经过脱敏与 gitleaks。

#### Scenario: 更新笔记
- **WHEN** supervisor 以读到的 `base_hash` 调用 `brief_update`
- **THEN** `brain/briefs/product-res.md` 被替换并提交，下一次 `ws_brief` 的第一节是新笔记

#### Scenario: 并发覆盖
- **WHEN** `base_hash` 与当前文件不一致
- **THEN** 返回 `conflict`，文件不变

### Requirement: supervisor 只能回复委托给它的卡住
除 `task_respond` 外，supervisor 身份 MUST NOT 能回复任务、批准或驳回审批、接受或驳回任何提案、批准合并；这些请求 MUST 由中枢按身份拒绝（`user_only`）。`task_respond` MUST 只作用于当前委托给 supervisor、尚未转交或过期的那一次卡住。

#### Scenario: 用通用接口批准
- **WHEN** supervisor 调用 `task_reply --approve`
- **THEN** 返回 403 `user_only`

#### Scenario: 回复未委托的卡住
- **WHEN** supervisor 对一个策略判定为 `user` 的授权请求调用 `task_respond approve`
- **THEN** 返回 `not_delegated`，任务保持 `blocked`

### Requirement: 卡住时代用户回复
workspace 配置 `supervisor.delegate_replies`（启用 supervisor 时默认 true）开启时（统一按 `delegationEnabled(workspace)` = `enabled && delegate_replies` 判断，`ws/global` 恒为否），中枢 SHALL 把本 workspace 任务（包括没有 origin 的任务）的以下卡住委托给 supervisor：所有 `blocked(question)`；节点持有活动租约、策略判定为 `supervisor` 档位、且该判定（`decision_id`）属于本任务、写于上一次离开 `blocked` 之后、请求与上报一致的 `blocked(awaiting_approval)`。唤醒任务自身、有效类别为 merge 的任务、`reviewer_roles` 中的审查任务、`node_lost` 后保留 `prior_reason` 的卡住 MUST NOT 委托。委托时 MUST 写 `task.reply_delegated{task_id, block_seq, kind, decision_id?, deadline}`（`block_seq` 为该次 `task.blocked` 的账本 seq），对应收件箱条目 MUST NOT 推送。

委托事件 SHALL 进入独立的 reply 队列，不与其他队列合并；reply 唤醒可以与一个普通唤醒并行。reply 唤醒 MUST 只能调用 `task_respond` 与只读操作，其余（包括 `brief_update`、`kb_journal`）返回 `reply_only_wake`；中枢 MUST 按唤醒绑定 token 识别调用方，不信任调用方声明的任务 id 或 actor。代回复记录 SHALL 由中枢根据账本生成，作为 `ws_brief` 中标明"不是指令"的独立一节，只含任务 id、决定、时间与回答长度；回答原文 MUST NOT 进入简报（否则 reply 唤醒写出的内容会进入后续唤醒的上下文），只进入用户可见的每日摘要。reply 唤醒按 `supervisor.limits.reply_wakes_per_day`（默认 48）单独计数。

supervisor 用 `task_respond{task_id, block_seq, decision, text?, reason}` 回复，`decision` 为 `approve`、`deny`（仅授权请求）、`answer`（仅提问，`text` 必填且不超过 2000 字符）或 `escalate`。中枢 MUST 在同一事务里核对：调用方的绑定 token 对应持活动租约、正被分配处理这次委托的 reply 唤醒；workspace 一致；任务当前卡住序号等于 `block_seq`；委托有效且没有待送达的回复。通过后写 `task.replied`（actor supervisor）；条目仍在任务离开 `blocked` 时关闭并记录回复者。节点放行前 MUST 重新读取待批请求，与 `decision_id` 对应的请求一致、推送或 gh 环境复查通过才执行，否则丢弃该回复并以不可委托的新卡住交给用户。`escalate` 写 `task.reply_escalated{reason: supervisor}` 并把条目推送给用户。

以下情况中枢 MUST 结束委托（`task.reply_escalated{reason}`；除用户自己回复或忽略外，按条目原级别推送给用户）：超过 `supervisor.reply_timeout_s`（默认 600）未回复；唤醒无法开始或当前 reply 唤醒处于 `blocked`（立即转交）；处理它的唤醒失败或结束时仍未回复；用户忽略条目；用户回复（同一次追加中结束委托）。委托只在任务处于 `blocked` 且当前卡住的 seq 等于 `block_seq` 时有效：任务离开该次卡住（`unblocked`、`requeued`、`lease_expired`，以及进入新的卡住）时委托 MUST 隐式失效、不写事件，新卡住重新判定。supervisor 的回复写入之前，用户的回复 MUST 优先，之后 supervisor 的回复返回 `stale_block`。supervisor 代回复的内容 SHALL 出现在当天的每日摘要中。

#### Scenario: 代为选择方案
- **WHEN** 用户手动建的 dev 任务进入 `blocked(question)`，问"A 记录既有失败后开 PR，还是 B 扩大范围修复"，且任务目标只限 README
- **THEN** supervisor 被唤醒，以 `answer` 选择 A，任务继续运行，用户没有收到推送

#### Scenario: 白名单内的授权
- **WHEN** Codex 请求在沙箱外运行 `pnpm check`，策略判定为 `supervisor`
- **THEN** supervisor 被唤醒，`approve` 后节点核对请求未变并放行；当天摘要中出现这次代批准

#### Scenario: reply 唤醒不能建任务或写笔记
- **WHEN** 一次 reply 唤醒中 supervisor 调用 `task_create` 或 `brief_update`
- **THEN** 返回 `reply_only_wake`

#### Scenario: 代回复记录不带回答原文
- **WHEN** supervisor 在 reply 唤醒中以 `answer` 回复了一段文字，之后的普通唤醒调用 `ws_brief`
- **THEN** 代回复记录一节只有任务 id、决定、时间与回答长度，不出现回答原文

#### Scenario: 普通唤醒运行中也能代回复
- **WHEN** 一个 instruction 唤醒正在运行，另一个任务的提问被委托
- **THEN** 一个 reply 唤醒并行开始并回复，不等普通唤醒结束

#### Scenario: 判定不能错套
- **WHEN** 任务的上一个请求判为 `supervisor` 并已获批，下一个请求的策略检查超时、没有 `decision_id`，任务上报 `blocked(awaiting_approval)`
- **THEN** 不委托，条目直接推送给用户

#### Scenario: 超时转交
- **WHEN** 委托后 600 秒内 supervisor 没有回复
- **THEN** 条目推送给用户，之后 supervisor 的 `task_respond` 返回 `stale_block`

#### Scenario: 进入新的卡住
- **WHEN** 委托期间任务从这次卡住直接进入新的卡住（blocked → blocked），或被重新排队
- **THEN** 旧委托隐式失效、不写转交事件，旧 `block_seq` 上的 `task_respond` 与转交都被拒绝；新卡住重新判定，可以重新委托

#### Scenario: 用户抢先回复
- **WHEN** 委托期间、supervisor 回复之前，用户在 Web 上直接批准
- **THEN** 委托结束，任务按用户的回复继续，supervisor 随后的 `task_respond` 返回 `stale_block`

#### Scenario: 合并与审查任务不委托
- **WHEN** merger 任务或 pr-reviewer 任务进入 `blocked(question)`
- **THEN** 不委托给 supervisor，条目直接推送给用户

#### Scenario: 冒用 supervisor 身份
- **WHEN** 一个名为 `supervisor` 但没有 `kind: supervisor` 的角色存在，或某请求用 user token 加 `X-Flow-Actor: supervisor` 调用 `task_respond`
- **THEN** 角色加载报错、doctor 报 error；请求被拒绝

### Requirement: 用户指令入口
用户 SHALL 能通过 Telegram `/ask <ws> <内容>` 和 CLI `flow ask <ws> <内容>` 下达指令；两者都只接受 user 身份，写入 `user.instruction`，并返回唤醒任务编号或排队说明。

#### Scenario: CLI 下指令
- **WHEN** 用户运行 `flow ask product-res 修一下 README`
- **THEN** 账本新增 actor 为 user 的 `user.instruction`，命令输出唤醒任务 id 或"已排队"

#### Scenario: AI 不能下指令
- **WHEN** reviewer 身份调用指令接口
- **THEN** 返回 403 `user_only`
