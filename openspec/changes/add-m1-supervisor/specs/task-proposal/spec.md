# Spec Delta

## Purpose

让 supervisor 把巡检、回看中发现的问题以任务提案提交给用户决定；接受即建任务，并可同时记录一条带预期效果、指标和回看日期的决策，到期由 supervisor 回看（PRD §6 核心闭环）。

## ADDED Requirements

### Requirement: 提交任务提案
supervisor SHALL 能用 `task_propose` 提交任务提案：合同草稿、理由，以及可选的决策字段（标题、预期效果、衡量指标、回看日期）。草稿 MUST 通过建任务的合同校验；workspace MUST 是会话绑定的 workspace；目标角色有效类别 MUST NOT 是 merge 或 supervisor；`cwd` 与 `inputs.repo` MUST 在本 workspace 登记仓库内；回看日期 MUST 晚于当天且不超过 180 天。提案落账为 `task_proposal.created`，并生成 `source: task_proposal` 的 Decide 条目。

#### Scenario: 提交带决策的提案
- **WHEN** supervisor 提交一个 dev 任务提案，附预期效果、指标和 30 天后的回看日期
- **THEN** 收件箱出现提案条目，展示角色、执行器、仓库与 cwd、验收命令、目标全文、理由与决策字段

#### Scenario: 提议合并任务
- **WHEN** 草稿角色为 merger
- **THEN** 返回 `role_not_allowed`，不生成提案

#### Scenario: 草稿不合法
- **WHEN** 草稿的 `cwd` 是相对路径
- **THEN** 返回校验错误，不生成提案

### Requirement: 接受与驳回
只有 user SHALL 能接受或驳回任务提案。接受时中枢 MUST 以 user 身份建任务（`parent` 为提案所在唤醒任务），落账 `task_proposal.accepted`；驳回落账 `task_proposal.rejected`，可附理由。两者都关闭条目并唤醒 supervisor。Web 上接受前 SHALL 允许修改目标文本；Web 页面只在本机可用，Telegram 消息 SHALL 注明这一点（从手机访问 Web 留作后续任务）。

#### Scenario: 手机上接受
- **WHEN** 用户在 Telegram 点"接受"
- **THEN** 任务被创建，`created_by` 为 user，origin 为 instruction，条目关闭，supervisor 被唤醒

#### Scenario: supervisor 不能自己接受
- **WHEN** supervisor 尝试接受自己的提案
- **THEN** 返回 403 `user_only`

### Requirement: 接受时记录决策
提案带决策字段时，接受 SHALL 以 user 身份在 `brain/decisions/` 写入 `type: decision`、`status: approved` 的条目，记录 workspace、预期效果、指标、回看日期，`sources` 引用任务 id；任务合同 `context` MUST 引用该决策。

#### Scenario: 生成决策条目
- **WHEN** 用户接受带决策字段的提案
- **THEN** brain 中新增决策条目并提交，任务合同 `context` 包含其路径

### Requirement: 决策到期回看
中枢 SHALL 每天扫描 `status: approved` 且回看日期已到、尚未发过的决策，写入 `decision.review_due`（每条只写一次，停机错过的在下一次扫描补发），并唤醒对应 workspace 的 supervisor（origin autonomous）；决策没有 workspace 或该 workspace 未启用 supervisor 时只生成 Digest 条目。supervisor SHALL 能用 `decision_review` 为本次唤醒关联的决策追加 `## 回看 YYYY-MM-DD` 一节，并把 `status` 改为 `reviewed`、`last_verified` 改为当天；其他字段和其他决策 MUST NOT 被修改。

#### Scenario: 到期回看
- **WHEN** 一条决策的回看日期到达
- **THEN** supervisor 被唤醒，调用 `decision_review` 后该决策多出回看一节，`status` 为 `reviewed`

#### Scenario: 只能改关联的决策
- **WHEN** 回看唤醒中 supervisor 对另一条决策调用 `decision_review`
- **THEN** 返回 `not_review_target`，文件不变

#### Scenario: 回看后的行动只能提案
- **WHEN** 回看唤醒中 supervisor 想建 dev 任务
- **THEN** 返回 `proposal_required`

#### Scenario: 无 supervisor 的决策
- **WHEN** 到期决策没有 workspace
- **THEN** 只生成一条 Digest 条目提醒用户回看
