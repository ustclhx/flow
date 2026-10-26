# Tasks

前置：② `add-m1-executors`、③ `add-m1-inbox` 已归档。

## 1. 协议与配置

- [ ] 1.1 账本事件与 schema：`supervisor.wake_queued`、`supervisor.answered`、`task_proposal.created|accepted|rejected`、`decision.review_due`；`user.instruction` 增加 `via: cli`；`schemas:check` 覆盖新事件
- [ ] 1.2 workspace 配置 `supervisor: {enabled, auto_merge, merge_method}`（schema、默认值、doctor 显示）；`node.yaml` 的 `reserved.supervisor`
- [ ] 1.3 角色 `kind` 字段与推断规则（D9），doctor 显示；`supervisor`、`merger` 角色模板与提示词，`dev` 模板 `creatable_by: [supervisor]`；doctor 对缺少该值的已有 `dev.yaml` 给出提示与片段
- [ ] 1.4 合同 `inputs.wake`、`inputs.review` 的 schema；结果 `result.review` 的 schema

## 2. 唤醒调度器（hub）

- [ ] 2.1 账本订阅：识别六类唤醒事件，按"parent 链上有唤醒任务"判断派生任务；排除唤醒任务自身
- [ ] 2.2 按 workspace 串行与合并：队列由账本投影，幂等键 `supervisor:<ws>:<首个事件 id>`；重启恢复测试
- [ ] 2.3 origin 计算（D3），沿 parent 链遇到用户指令或 user 创建的任务即为 instruction
- [ ] 2.4 失败重试与 Interrupt 条目；`flow supervisor status|wake` 命令；`flow ask`
- [ ] 2.5 Telegram `/ask` 改为返回唤醒编号或排队说明；未启用时的回复

## 3. 中枢侧权限

- [ ] 3.1 `TaskService.createTask`：supervisor 身份必须带 parent 且指向本 workspace 未结束的唤醒任务（`parent_required`、`workspace_mismatch`）；write 类角色在非 instruction origin 下返回 `proposal_required`；merger 角色只能由 hub 与 user 创建
- [ ] 3.2 supervisor 不能 `task_reply`、接受或驳回提案、批准合并的测试
- [ ] 3.3 `policies.yaml` 模板加入注释掉的 supervisor `task.create` auto 规则；未启用时建任务走审批的端到端测试（fake 执行器）

## 4. 操作与写入（core）

- [ ] 4.1 MCP `--workspace`、`--task` 绑定与自动 parent；claude-sdk 对 supervisor 角色注入参数与 `FLOW_WORKSPACE`、`FLOW_TASK_ID`；自动放行清单更新
- [ ] 4.2 `brain/briefs/<ws>.md` 路径类别、写入策略、长度上限、`brief_update`（base_hash）
- [ ] 4.3 `ws_brief` 扩展：笔记、进行中任务、待处理条目、近期决策；预算内截断测试
- [ ] 4.4 `ask_user`：创建 supervisor 条目、选项按钮、数量上限、7 天过期；`inbox_act reply` 路由到 supervisor 来源并写 `supervisor.answered`；Telegram 与 Web 回复
- [ ] 4.5 `task_propose` 与提案条目；接受（Web 可改目标）以 user 建任务、驳回；接受时写 `brain/decisions/` 条目并在合同 context 引用
- [ ] 4.6 决策回看：内部定时规则、启动补发、`decision_review` 窄例外写入（只追加回看一节、只改 status 与 last_verified、只限关联决策）
- [ ] 4.7 `pr_merge_request`：按 `auto_merge` 建 merger 任务或生成合并审批条目；条目在 PR 关闭或已合并时自动关闭

## 5. 执行器（node）

- [ ] 5.1 claude-sdk 审查结构化输出：`inputs.review` 存在时启用 SDK 结构化结果，写 `result.review`，不合规 `failed(review_output_invalid)`
- [ ] 5.2 pr-merge 执行器：条件核对（open、默认分支、head 等于 reviewed_sha、检查全绿且无进行中、审查任务一致）、合并、等待 main 上该提交的 workflow runs；`gh` 可注入，测试不调用真实 gh
- [ ] 5.3 节点预留 supervisor 执行槽（D11）：卡住的 dev 任务持有租约时仍能领取唤醒任务

## 6. 文档

- [ ] 6.1 `docs/supervisor.md`：唤醒来源、origin 与权限、简报、提问、提案与决策、PR 验收链、自动合并的风险与开关、巡检配置、费用说明；`docs/executors.md` 增加 pr-merge；升级步骤（已有用户需改 `dev.yaml`、启用策略规则与巡检）

## 7. 真实环境验收

- [ ] 7.1 product-res 跑通 M1 验收场景：Telegram `/ask` → supervisor 建 dev 任务 → Codex 开 PR（中途回复一次卡住）→ reviewer 结构化审查 → 合并（先在 `auto_merge: false` 下批准一次，再开启验证自动合并）→ main 流水线确认 → journal 与简报更新；记录用户在手机上的操作次数
- [ ] 7.2 巡检一次：启用 product-res 的巡检规则，确认日报进入 journal 与每日摘要，发现的问题以提案出现；接受一个带回看日期的提案，用临时把回看日期设为当天的方式验证回看唤醒与 `decision_review`
