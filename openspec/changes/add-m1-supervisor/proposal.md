# Proposal

## Why

变更 ①–③ 让任务能在后台运行、卡住时推送到手机，但"该做什么"仍要用户自己拆任务、派发、盯 PR、找人审查、合并、看流水线。本变更补上 PRD §7.1、§19 第 5 条的 **supervisor**，并让 M1 验收场景跑通：用户在 Telegram 给 product-res 下一条指令 → supervisor 拆成任务 → Codex 执行 → 卡住时 supervisor 代为回复（拿不准才转给用户）→ 提 PR → Claude 审查 → 合并 → 验证 main 的发布流水线 → 写 journal，全程用户只操作两次手机。

## What Changes

- **supervisor 是内核监督的一类任务**：每个 workspace 一个逻辑 supervisor。中枢在下列事件发生时为该 workspace 排一个 supervisor 唤醒任务（新会话，claude-sdk 执行器）：
  - 用户指令（Telegram `/ask`、CLI `flow ask`）；
  - 该 workspace 中由 supervisor 派生的任务结束、失败或卡住；
  - 用户回答了 supervisor 的提问；
  - 每日巡检（`config/schedules.yaml`，默认每天一次）；
  - 决策到期回看；
  - 任务卡住被委托给 supervisor（只能回复的唤醒，可与上述唤醒并行）。

  同一 workspace 同时最多一个唤醒在运行（另可并行一个只能回复的代回复唤醒），期间到达的事件合并到下一次唤醒。唤醒失败按普通任务进入收件箱，可重试。
- **workspace 简报**：supervisor 每次唤醒先读简报，结束前写回。简报 = 中枢生成的部分（进行中的任务、待处理条目、近期决策、近期 journal）+ supervisor 维护的笔记（当前状态、关注点、进行中的计划），笔记保存在 `brain/briefs/<ws>.md`。
- **supervisor 的 MCP 工具**（只能通过这些行动）：读知识和简报、更新自己的简报笔记、建任务、提任务提案、问用户、写 journal、发起合并、写决策回看、回复委托给它的卡住。
- **建任务的权限按来源区分**：
  - 由用户指令派生的工作（包括其后续的审查、修改）可以直接建任务；
  - 由巡检、回看发现的问题只能提**任务提案**，用户在收件箱点"接受"后才建任务；
  - 只读类角色（triage、新的 pr-reviewer）不受此限；合并任务 supervisor 一律不能直接建。
  - 来源由中枢在创建时计算并固化，不取自合同字段；所有身份的 `parent` 都要校验存在且同一 workspace。
  - 中枢强制硬性上限：每次唤醒建任务数、每日唤醒次数、链深度、同一 PR 的修改轮数、未回答提问数。
- **任务提案与决策回看**：任务提案可以带预期效果、衡量指标和回看日期。用户接受时，中枢以用户身份建任务，并在 `brain/` 写入一条 `decision` 条目（status `approved`）。到回看日期，中枢唤醒 supervisor 回看，它把结论追加到该决策的"回看"一节，并把状态改为 `reviewed`。
- **卡住时由 supervisor 代用户回复**：本 workspace 的任务（包括用户手动建的；合并任务、审查任务、唤醒任务自身除外）出现以下卡住时，先交给 supervisor：
  - 提问（`question`）：它在任务目标范围内选方案回答，拿不准就转给用户；
  - 授权请求（`awaiting_approval`）：只有策略判定为新档位 `supervisor` 的才交给它，可以批准、拒绝或转给用户；合并、发布、密钥、看不透的 shell、改策略或配置等受保护动作永远不交给它；`git push` 只有单段、推到登记 remote 上任务自己的分支才可能委托；
  - 这类唤醒只能回复，不能建任务、提案或请求合并；
  - 委托期间收件箱条目不推送；超时（默认 10 分钟）、唤醒起不来或失败时自动转给用户；supervisor 回复前用户随时可以直接回复，用户优先。
- **问用户**：supervisor 可以发一条提问（可带选项）到收件箱（Decide）。用户回复后条目关闭为 `answered`，并唤醒 supervisor 处理答复。提问不阻塞唤醒任务本身。
- **PR 验收链**：dev 任务开出 PR 后，supervisor 建 pr-reviewer（只读）任务；执行器在会话前核对 PR 属于本 workspace 仓库并记录 head SHA，会话输出结构化结论（是否通过、阻塞问题）。supervisor 的合并请求只对本 workspace 指令链上产出的 PR 有效。之后由一个确定性的 **pr-merge 执行器**（不调用模型）在节点上完成：
  - 核对 CI 全部通过、PR 当前 head 与审查的 SHA 一致、审查结论为通过；
  - 合并；
  - 等待 main 上对应提交的发布流水线结束，结果写入任务结果。

  是否自动合并由 workspace 配置 `supervisor.auto_merge` 决定，**默认关闭**：关闭时合并请求进收件箱等用户批准；开启时条件满足直接合并。条件不满足时一律不合并。
- **节点为 supervisor 预留执行槽**：长时间的 dev 任务或卡住的任务不再挡住 supervisor 唤醒。
- **claude-sdk 读边界** `read_scope: cwd`：supervisor 与 pr-reviewer 只能读仓库内文件，读不到 `hub.token`、密钥和 gh 凭证。
- **Telegram `/ask`** 从"已记录，supervisor 尚未启用"改为真正唤醒 supervisor，并回复唤醒任务的编号。
- **默认角色模板**新增 `supervisor`、`pr-reviewer`、`merger`，角色增加有效类别 `kind`；`dev` 模板的 `creatable_by` 加上 `supervisor`（已有用户需手动更新，doctor 给出提示）。
- **不在本次范围**：
  - 参谋长、跨 workspace 汇总与分发；
  - supervisor 与用户的多轮实时对话（Web 工作台，M5）；
  - 巡检频率与 token / 费用预算上限（PRD 标为待定；各 harness 走订阅）；
  - 资源归属迁移、订阅其他 workspace 的事件；
  - Grok 接入（变更 ⑤）。

## Capabilities

### New Capabilities

- `supervisor`：唤醒来源、唤醒任务合同、并发与合并、来源链与建任务权限、简报读写、失败处理。
- `task-proposal`：任务提案的提交、收件箱呈现、接受与驳回，以及接受时生成的决策和到期回看。
- `pr-acceptance`：结构化审查结论、pr-merge 执行器、合并条件、自动合并开关、发布流水线确认。

### Modified Capabilities

依赖 ② `add-m1-executors` 先归档到 `openspec/specs/`（③ 已归档）。

- `inbox`：supervisor 提问条目可回复并以 `answered` 关闭；任务提案条目的接受与驳回；合并审批条目；委托给 supervisor 的条目不推送、转交时推送。
- `policy-engine`：新档位 `supervisor`、`push_to: task_branch` 条件。
- `telegram-channel`：`/ask` 唤醒 supervisor。
- `scheduler`：巡检规则与决策回看到期事件。
- `knowledge-access`：新增 supervisor 相关操作，以及按 workspace 绑定的 MCP 会话。
- `role-config`：`supervisor` 角色、`dev` 默认模板的 `creatable_by`。
- `node-protocol`：supervisor 预留执行槽；卡住时附带工作区改动摘要。
- `task-ledger`：所有身份建任务时校验 `parent`。
- `executor-claude-sdk`：读边界、审查任务的准备与结构化输出、supervisor 会话绑定。

## Impact

- 代码：`packages/hub`（唤醒调度器、来源链校验、提问与提案的收件箱动作、决策回看定时）、`packages/core/src/ops/`（新操作）、`packages/core/src/write/`（简报笔记、决策回看追加）、`packages/node`（pr-merge 执行器、预留执行槽、claude-sdk 结构化输出）、`packages/mcp`（按 workspace 绑定）、CLI（`flow ask`、`flow supervisor status`）、`packages/core/src/policy/`（新档位与推送条件）。
- 协议与 schema：新的账本事件（`supervisor.*`、`task_proposal.*`、`decision.review_due`）、角色与 workspace 配置字段、结果中的审查结论。
- 用户数据：`brain/briefs/`、`brain/decisions/` 新增内容；`config/roles/{supervisor,pr-reviewer,merger}.{yaml,md}`；`dev.yaml` 需手动加 `creatable_by: [supervisor]`；`config/schedules.yaml` 增加巡检规则。
- 外部动作：pr-merge 会真实合并 PR，受默认关闭的开关和条件双重约束。
