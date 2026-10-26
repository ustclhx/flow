# Spec Delta

## Purpose

把开发任务的 PR 按"CI 通过 → Claude 审查 → 合并 → 确认 main 的发布流水线"串成可审计的链条；决定能否合并的事实由中枢与确定性代码记录和核对，合并由不调用模型的执行器完成（PRD §19 第 7 条）。

## ADDED Requirements

### Requirement: 审查结论由执行器把关
带 `inputs.review = {pr, focus?}` 的审查任务 SHALL 只在角色属于 workspace `supervisor.reviewer_roles`（默认 `[pr-reviewer]`）且执行器为 claude-sdk 时产出可用的 `result.review`。执行器 MUST 在会话前用 `gh` 确认 PR 属于本 workspace 登记仓库、记录当前 head SHA 并准备 diff；`result.review.reviewed_sha` MUST 取执行器记录的值，`verdict`（`approve`/`changes_requested`）、`blocking`、`notes` 取自结构化输出；目标文字由中枢固定模板生成，supervisor 只能补充不超过 500 字的 `focus`。结构化输出失败时任务 `failed(review_output_invalid)`。

#### Scenario: 审查通过
- **WHEN** pr-reviewer 认为没有阻塞问题
- **THEN** 任务 `done`，`result.review.verdict = approve`，`reviewed_sha` 等于会话开始前记录的 head

#### Scenario: 非审查角色
- **WHEN** 一个不在 `reviewer_roles` 中的角色任务带 `inputs.review` 结束
- **THEN** 其结果不被视为审查结论，不能用于合并请求

#### Scenario: 他人仓库的 PR
- **WHEN** `inputs.review.pr` 指向不是本 workspace 登记仓库的 PR
- **THEN** 任务在启动前 `failed(repo_not_in_workspace)`

### Requirement: 合并请求的资格
supervisor SHALL 用 `pr_merge_request{pr, review_task}` 请求合并。中枢 MUST 核对：该 PR 是本 workspace 内某个 origin 为 instruction 的 write 任务的 `kind: pr` 产物；`review_task` 同一 workspace、角色属于 `reviewer_roles`、`inputs.review.pr` 等于该 PR、结论为 `approve`。不满足返回 `merge_not_eligible`。

#### Scenario: 巡检链上的 PR
- **WHEN** autonomous 唤醒中 supervisor 对一个外部贡献者的 PR 请求合并
- **THEN** 返回 `merge_not_eligible`

### Requirement: 合并请求按开关分流
资格通过后，workspace `supervisor.auto_merge` 为 true 时中枢 SHALL 以 hub 身份直接创建 merger 任务；否则（默认）生成 `source: merge_request` 的 Decide 条目，用户批准后中枢创建 merger 任务，驳回则唤醒 supervisor。`kind: merge` 的任务 MUST 只能由 hub 与 user 创建。

#### Scenario: 默认需要批准
- **WHEN** `auto_merge` 未配置，supervisor 请求合并
- **THEN** 收件箱出现"批准合并"条目，未批准前不创建 merger 任务

#### Scenario: 开启自动合并
- **WHEN** `ws/product-res` 配置 `supervisor.auto_merge: true`
- **THEN** 资格通过后直接创建 merger 任务

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
