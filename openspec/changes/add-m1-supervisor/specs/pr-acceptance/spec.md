# Spec Delta

## Purpose

把开发任务的 PR 按"CI 通过 → Claude 审查 → 合并 → 确认 main 的发布流水线"串成可审计的链条，合并这一不可逆动作由确定性执行器在条件核对后完成（PRD §19 第 7 条）。

## ADDED Requirements

### Requirement: 结构化审查结论
带 `inputs.review = {pr, head_sha}` 的审查任务 SHALL 产出 `result.review`：`verdict`（`approve` 或 `changes_requested`）、`reviewed_sha`、`blocking` 列表与说明。结论缺失或不符合 schema 时任务 MUST 以 `failed(review_output_invalid)` 结束。

#### Scenario: 审查通过
- **WHEN** reviewer 审查 PR 后认为没有阻塞问题
- **THEN** 任务 `done`，`result.review.verdict = approve`，`reviewed_sha` 为所审 head

#### Scenario: 输出不合规
- **WHEN** 会话结束时没有合规的结构化结论
- **THEN** 任务 `failed(review_output_invalid)`

### Requirement: 合并请求按开关分流
supervisor SHALL 用 `pr_merge_request{pr, review_task}` 请求合并。workspace `supervisor.auto_merge` 为 true 时，中枢直接创建 pr-merge 任务；否则（默认）生成收件箱 Decide 条目，用户批准后中枢以 user 身份创建 pr-merge 任务，驳回则唤醒 supervisor。supervisor MUST NOT 能直接创建 pr-merge 任务。

#### Scenario: 默认需要批准
- **WHEN** `auto_merge` 未配置，supervisor 请求合并
- **THEN** 收件箱出现"批准合并"条目，未批准前不创建 pr-merge 任务

#### Scenario: 开启自动合并
- **WHEN** `ws/product-res` 配置 `supervisor.auto_merge: true`，supervisor 请求合并
- **THEN** 直接创建 pr-merge 任务

### Requirement: 合并前的条件核对
pr-merge 执行器 SHALL 不调用任何模型，在合并前核对：PR 为 open 且 base 是默认分支；PR 当前 head 等于审查的 `reviewed_sha`；所有检查成功且没有进行中的检查；关联审查任务为 `done`、结论 `approve`、workspace 一致。任一不满足 MUST NOT 合并，任务以 `failed` 结束并给出原因码（如 `head_moved`、`checks_not_green`、`review_not_approved`）。

#### Scenario: 审查后又有新提交
- **WHEN** 审查完成后 PR 推了新提交
- **THEN** pr-merge 以 `failed(head_moved)` 结束，PR 未合并

#### Scenario: CI 未通过
- **WHEN** PR 有一项检查失败或仍在运行
- **THEN** pr-merge 以 `failed(checks_not_green)` 结束

### Requirement: 合并后确认发布流水线
合并成功后，pr-merge SHALL 等待默认分支上该合并提交触发的 workflow runs 结束（默认最长 30 分钟）：全部成功为 `done` 并在结果中附 run 链接；有失败为 `failed(pipeline_failed)`；超时为 `blocked(other)`；没有任何 run 时为 `done` 并注明未发现发布流水线。合并方式取 `supervisor.merge_method`，默认 `squash`。

#### Scenario: 流水线失败
- **WHEN** 合并后 main 上的部署 workflow 失败
- **THEN** pr-merge `failed(pipeline_failed)`，supervisor 被唤醒，收件箱出现 Interrupt 条目

### Requirement: 验收链收尾
pr-merge 结束后 supervisor SHALL 被唤醒，写一条 journal 记录 PR、合并提交与流水线结果，并更新简报。审查结论为 `changes_requested` 时，supervisor 对同一 PR 发起的修改任务 MUST 不超过 2 轮，超出后改为向用户提问。

#### Scenario: 第三次要求修改
- **WHEN** 同一 PR 第三次得到 `changes_requested`
- **THEN** supervisor 不再建修改任务，而是 `ask_user`
