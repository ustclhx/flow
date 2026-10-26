# Spec Delta

## Purpose

让 supervisor 把巡检、回看中发现的问题以任务提案提交给用户决定；接受即建任务，并可同时记录一条带预期效果、指标和回看日期的决策，到期由 supervisor 回看（PRD §6 核心闭环）。

## ADDED Requirements

### Requirement: 提交任务提案
supervisor SHALL 能用 `task_propose` 提交任务提案，包括合同草稿、理由，以及可选的决策字段（标题、预期效果、衡量指标、回看日期）。合同草稿 MUST 通过与建任务相同的校验且角色存在；回看日期 MUST 晚于当天且不超过 180 天。提案落账为 `task_proposal.created`，并生成收件箱 Decide 条目，动作为"接受""驳回"。

#### Scenario: 提交带决策的提案
- **WHEN** supervisor 提交一个 dev 任务提案，附预期效果"注册转化率提升"、指标"注册/访问"、回看日期 30 天后
- **THEN** 收件箱出现一条提案条目，展示目标、理由与决策字段

#### Scenario: 草稿不合法
- **WHEN** 合同草稿的 `cwd` 是相对路径
- **THEN** 返回校验错误，不生成提案

### Requirement: 接受与驳回
只有 user SHALL 能接受或驳回任务提案。接受时中枢 MUST 以 user 身份创建任务（`parent` 为提出提案的唤醒任务，便于来源追踪），并落账 `task_proposal.accepted`；驳回落账 `task_proposal.rejected`，可附理由。两者都关闭收件箱条目并唤醒 supervisor。Web 上接受前 SHALL 允许修改目标文本。

#### Scenario: 手机上接受
- **WHEN** 用户在 Telegram 点"接受"
- **THEN** 任务被创建，`created_by` 为 user，条目关闭，supervisor 被唤醒

#### Scenario: supervisor 不能自己接受
- **WHEN** supervisor 尝试接受自己的提案
- **THEN** 返回 403 `user_only`

### Requirement: 接受时记录决策
提案带决策字段时，接受 SHALL 以 user 身份在 `brain/decisions/` 写入一条 `type: decision`、`status: approved` 的条目，记录 workspace、预期效果、指标、回看日期，`sources` 引用任务 id；任务合同的 `context` MUST 引用该决策。

#### Scenario: 生成决策条目
- **WHEN** 用户接受一个带决策字段的提案
- **THEN** brain 中新增决策条目并提交，任务合同 `context` 包含其路径

### Requirement: 决策到期回看
中枢 SHALL 在 `status: approved` 的决策到达 `review_date` 时写入 `decision.review_due` 并唤醒对应 workspace 的 supervisor（origin `decision_review`）；中枢停机错过的回看 MUST 在启动后补发，每条决策只发一次。supervisor SHALL 能用 `decision_review` 为本次唤醒关联的决策追加 `## 回看 YYYY-MM-DD` 一节，并把状态改为 `reviewed`；其他字段和其他决策 MUST NOT 被修改。

#### Scenario: 到期回看
- **WHEN** 一条决策的回看日期到达
- **THEN** supervisor 被唤醒，调用 `decision_review` 后该决策正文多出回看一节，`status` 为 `reviewed`

#### Scenario: 只能改关联的决策
- **WHEN** 回看唤醒中 supervisor 对另一条决策调用 `decision_review`
- **THEN** 返回 `workspace_mismatch` 或 `not_review_target`，文件不变

#### Scenario: 回看后的行动只能提案
- **WHEN** 回看唤醒中 supervisor 想建 dev 任务
- **THEN** 返回 `proposal_required`
