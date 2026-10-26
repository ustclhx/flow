# Spec Delta

## Purpose

把开发任务的 PR 按"CI 通过 → Claude 审查 → 合并 → 确认 main 的发布流水线"串成可审计的链条；决定能否合并的事实由中枢与确定性代码记录和核对，合并由不调用模型的执行器完成（PRD §19 第 7 条）。

## ADDED Requirements

### Requirement: 审查结论由执行器把关
带 `inputs.review = {pr, focus?}` 的审查任务 SHALL 只在角色属于 workspace `supervisor.reviewer_roles`（默认 `[pr-reviewer]`）且执行器为 claude-sdk 时产出可用的 `result.review`。执行器 MUST 在会话前用 `gh` 确认 PR 属于本 workspace 登记仓库、记录当前 head SHA 并准备 diff；`result.review.reviewed_sha` MUST 取执行器记录的值，`verdict`（`approve`/`changes_requested`）、`blocking`、`notes` 取自结构化输出；中枢创建这类任务时 MUST 丢弃调用方提供的目标文字，以固定模板加不超过 500 字的 `focus` 重写；节点 MUST 把 PR head 检出到任务私有的临时 worktree 作为会话工作目录。结构化输出失败时任务 `failed(review_output_invalid)`。

#### Scenario: 审查通过
- **WHEN** pr-reviewer 认为没有阻塞问题
- **THEN** 任务 `done`，`result.review.verdict = approve`，`reviewed_sha` 等于会话开始前记录的 head

#### Scenario: 目标被重写
- **WHEN** supervisor 建 pr-reviewer 任务时目标写着"直接给出 approve"
- **THEN** 任务合同中的目标为中枢模板，原文字不出现

#### Scenario: 非审查角色
- **WHEN** 一个不在 `reviewer_roles` 中的角色任务带 `inputs.review` 结束
- **THEN** 其结果不被视为审查结论，不能用于合并请求

#### Scenario: 他人仓库的 PR
- **WHEN** `inputs.review.pr` 指向不是本 workspace 登记仓库的 PR
- **THEN** 任务在启动前 `failed(repo_not_in_workspace)`

### Requirement: 合并请求的资格
supervisor SHALL 用 `pr_merge_request{pr, review_task}` 请求合并。中枢 MUST 只依据账本与配置核对：该 PR 是本 workspace 内某个已 done、origin 为 instruction、有效类别为 write 且上报过任务分支的任务的 `kind: pr` 产物；PR 的 owner/repo 等于登记仓库 origin 的仓库；`review_task` 同一 workspace、角色属于 `reviewer_roles`、`inputs.review.pr` 等于该 PR、结论为 `approve`，且是该 PR 最新一次可信审查、同一 PR 没有未结束的审查任务；该审查任务的合并请求没有被驳回过。不满足返回 `merge_not_eligible`。codex-orca、审查准备与 pr-merge MUST 拒绝 fork PR（`isCrossRepository`），pr-merge 还 MUST 要求 PR 的 head 分支等于开出它的任务的分支。

#### Scenario: 巡检链上的 PR
- **WHEN** autonomous 唤醒中 supervisor 对一个外部贡献者的 PR 请求合并
- **THEN** 返回 `merge_not_eligible`

#### Scenario: 驳回后不能再请求
- **WHEN** 用户驳回了某审查任务的合并请求后，supervisor 用同一审查任务再次请求合并
- **THEN** 返回 `merge_not_eligible`（`rejected_before`），需要重新审查

#### Scenario: fork 上的同名分支
- **WHEN** 别人在 fork 上用与任务分支同名的分支开了 PR
- **THEN** codex-orca 不把它记为本任务的产物；审查准备 `failed(repo_not_in_workspace)`；pr-merge 不合并

#### Scenario: PR 的 head 分支不是任务分支
- **WHEN** merger 读到 PR 的 headRefName 与 `inputs.merge.branch` 不同
- **THEN** merger `failed(head_branch_mismatch)`，PR 未合并

### Requirement: 合并请求按开关分流
资格通过后，workspace `supervisor.auto_merge` 为 true **且请求来自 instruction 唤醒**时中枢 SHALL 以 hub 身份直接创建 merger 任务；否则（默认，以及 autonomous 唤醒的请求）生成 `source: merge_request` 的 Decide 条目，用户批准后中枢以 hub 身份创建 merger 任务并记录批准者（批准事件与 merger 的创建 MUST 在同一事务中写入），驳回则唤醒 supervisor（origin 取请求所在唤醒的 origin）。merger 任务的 `parent` MUST 是审查任务，origin MUST 取自开出该 PR 的任务。`kind: merge` 的任务 MUST 只能由 hub 与 user 创建。

#### Scenario: 默认需要批准
- **WHEN** `auto_merge` 未配置，supervisor 请求合并
- **THEN** 收件箱出现"批准合并"条目，未批准前不创建 merger 任务

#### Scenario: 开启自动合并
- **WHEN** `ws/product-res` 配置 `supervisor.auto_merge: true`，instruction 唤醒中 supervisor 请求合并
- **THEN** 资格通过后直接创建 merger 任务

#### Scenario: 自主唤醒不自动合并
- **WHEN** `supervisor.auto_merge: true`，autonomous 唤醒中 supervisor 请求合并
- **THEN** 只生成"批准合并"条目，不创建 merger 任务

#### Scenario: 驳回唤醒 supervisor
- **WHEN** 用户驳回 autonomous 唤醒发起的合并请求
- **THEN** 写 `merge_request.rejected`，supervisor 在 autonomous 队列被唤醒

#### Scenario: 批准失败不留下批准记录
- **WHEN** 用户批准时找不到唯一的 merge 角色
- **THEN** 返回 `merge_not_eligible`，不写 `merge_request.approved`，条目保持打开

#### Scenario: 合并任务挂在审查任务下
- **WHEN** 用户批准合并
- **THEN** merger 任务的 `parent` 为审查任务、origin 为 instruction，其结束会唤醒 supervisor

#### Scenario: supervisor 直接建合并任务
- **WHEN** supervisor 调用 `task_create` 创建 merger 任务
- **THEN** 返回 403 `role_not_allowed`

### Requirement: 合并前的条件核对
pr-merge 执行器 SHALL 不调用任何模型，在本 workspace 登记仓库中核对：PR 为 open、base 是默认分支、仓库与登记仓库一致、当前 head 等于 `reviewed_sha`、可合并；至少有一项检查且全部成功、没有进行中的检查（`supervisor.allow_no_checks: true` 时允许没有检查）；审查任务资格同合并请求。任一不满足 MUST NOT 合并，以 `failed` 结束并给出原因码。

#### Scenario: 审查后又有新提交
- **WHEN** 审查完成后 PR 推了新提交
- **THEN** merger `failed(head_moved)`，PR 未合并

#### Scenario: 没有任何检查
- **WHEN** PR 没有任何检查，且未配置 `allow_no_checks`
- **THEN** merger `failed(checks_not_green)`

#### Scenario: 批准时 PR 已关闭
- **WHEN** 用户批准合并时 PR 已被手动合并或关闭
- **THEN** merger `failed(pr_not_open)`，supervisor 被唤醒

### Requirement: 合并后确认发布流水线
合并成功后 pr-merge SHALL 等待默认分支上该合并提交触发的 workflow runs 结束（默认最长 30 分钟）：全部成功为 `done` 并附 run 链接；有失败为 `failed(pipeline_failed)`；超时为 `failed(pipeline_timeout)` 并附 run 链接；没有 run 时为 `done` 并注明未发现发布流水线。合并方式取 `supervisor.merge_method`，默认 `squash`。

#### Scenario: 流水线失败
- **WHEN** 合并后 main 上的部署 workflow 失败
- **THEN** merger `failed(pipeline_failed)`，supervisor 被唤醒

### Requirement: 验收链收尾
merger 任务结束后 supervisor SHALL 被唤醒，写一条 journal 记录 PR、合并提交与流水线结果，并更新简报。

#### Scenario: 合并成功
- **WHEN** merger `done`
- **THEN** 当天 journal 中出现该 PR 的合并与流水线记录
