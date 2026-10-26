# Tasks

前置：② `add-m1-executors` 已归档（③ 已归档）。

## 1. 协议与配置

- [ ] 1.1 账本事件与 schema：`supervisor.wake_started`、`supervisor.answered`、`task_proposal.created|accepted|rejected`、`decision.review_due`；任务投影增加 origin；`schemas:check` 覆盖新事件
- [ ] 1.2 workspace 配置 `supervisor: {enabled, auto_merge, merge_method, allow_no_checks, reviewer_roles, limits}`（schema、默认值、doctor 显示）；`node.yaml` 的 `reserved.supervisor`
- [ ] 1.3 角色 `kind` 与有效类别（D9：声明只能收紧、Bash 规则计为 write），doctor 显示与警告
- [ ] 1.4 角色模板：`supervisor`、`pr-reviewer`、`merger` 及提示词；`dev` 模板 `creatable_by: [supervisor]`；doctor 对缺少该值的已有 `dev.yaml` 给出片段
- [ ] 1.5 合同 `inputs.wake`、`inputs.review` 与结果 `result.review` 的 schema

## 2. 中枢：任务创建的校验

- [ ] 2.1 所有身份的 `parent` 校验（存在、同 workspace）；`supervisor:` 幂等键前缀只允许 hub
- [ ] 2.2 `hub` 身份跳过 `creatable_by` 的显式分支，并测试 `hub` 不能由请求头或 MCP 声明；`kind: supervisor` 只能由 hub 建，`kind: merge` 只能由 hub 与 user 建
- [ ] 2.3 origin 计算与固化（D2）：只有挂在唤醒链上或经接受提案建的任务有 origin；`user.instruction`、`supervisor.release` 只接受 user 身份；reviewer_roles 任务的目标由中枢模板重写
- [ ] 2.4 supervisor 建任务的检查（D5）：唤醒 parent、autonomous 下禁止 write、禁止 merge/supervisor、cwd 与 repo 必须在本 workspace 仓库内（realpath）
- [ ] 2.5 硬性上限（D4）：每次唤醒建任务数、链深度、同一 PR 修改轮数；超限错误码
- [ ] 2.6 `policies.yaml` 模板加入注释掉的 supervisor `task.create` auto 规则；未启用时建任务走审批的端到端测试（fake 执行器）
- [ ] 2.7 supervisor 不能 `task_reply`、接受或驳回提案、批准合并的测试

## 3. 中枢：唤醒调度器

- [ ] 3.1 识别唤醒事件（D3），包括 `blocked` 原因过滤与"同一任务同一原因只一次"；排除唤醒任务自身
- [ ] 3.2 workspace × origin 两条队列、instruction 优先、每次唤醒递增的代数与幂等键；队列由账本投影；重启恢复测试；只允许一个 `kind: supervisor` 角色
- [ ] 3.3 每日唤醒上限（总数与 autonomous 分别计）与"已达上限"条目；失败重试、Interrupt 条目、队列暂停
- [ ] 3.4 `flow ask`、`flow supervisor wake [--release <queue>]|status`（user-only 路由）；Telegram `/ask` 返回唤醒编号、排队说明或未启用

## 4. 操作与写入

- [ ] 4.1 MCP `--workspace`、`--task` 绑定与自动 parent；自动放行清单更新
- [ ] 4.2 `brain/briefs/<id>.md` 路径类别：只能经中枢写；从条目读取、校验、索引、搜索中排除；`brief_update`（base_hash、3000 字符上限）
- [ ] 4.3 `ws_brief` 扩展：笔记（≤40% 预算）、进行中任务、待处理条目、近期决策；预算内截断测试
- [ ] 4.4 `ask_user`：supervisor 来源条目、选项按钮、数量上限、7 天过期；`inbox_act reply` 路由到 supervisor 来源并写 `supervisor.answered`；Telegram 与 Web 回复
- [ ] 4.5 收件箱新来源 `task_proposal`、`merge_request` 及动作路由，与 `proposal`、`task` 来源隔离
- [ ] 4.6 `task_propose`（D11 校验、条目展示角色/执行器/仓库/cwd/验收命令/目标全文、Telegram 附 Web 链接）；接受（Web 可改目标）以 user 建任务、驳回；接受时写决策条目并在合同 context 引用
- [ ] 4.7 决策回看：每日扫描的内部规则、补发去重、无 workspace 时 Digest；`decision_review` 窄例外（只追加回看一节、只改 status 与 last_verified、只限关联决策、由中枢代写）
- [ ] 4.8 `pr_merge_request`：资格核对（D10 第 4 步）；按 `auto_merge` 建 merger 任务或生成 `merge_request` 条目；merger 由 hub 创建、`parent` 为审查任务

## 5. 执行器与节点

- [ ] 5.1 claude-sdk `read_scope: cwd`：PreToolUse 钩子覆盖全部工具，与 `writable_paths` 共用路径判定，覆盖 Glob `pattern`、Grep `glob`；单元测试（cwd 内外、隐藏段、`..`、绝对模式、符号链接、hub.token、未知路径字段）
- [ ] 5.2 claude-sdk 审查准备：`gh` 读 PR、仓库归属校验、记录 head、检出到私有临时 worktree 并在结束后移除、diff 写入任务私有目录；结构化输出（`outputFormat: json_schema`），`reviewed_sha` 由执行器填入；`error_max_structured_output_retries` 等映射为 `review_output_invalid`；只有 `reviewer_roles` 的结果被中枢采信
- [ ] 5.3 supervisor 会话注入 `--workspace`、`--task` 与 `FLOW_WORKSPACE`、`FLOW_TASK_ID`
- [ ] 5.4 pr-merge 执行器：条件核对（D10 第 5 步，含至少一项检查）、合并、等待 workflow runs（成功/失败/超时/无 run）；`gh` 可注入，测试不调用真实 gh
- [ ] 5.5 预留执行槽：`acquireLeaseRequest.slots` 协议与 schema、中枢按类别分配、旧节点兼容；节点在普通槽满时仍为 supervisor 领取；卡住的 dev 任务持有租约时仍能运行唤醒任务的测试

## 6. 文档

- [ ] 6.1 `docs/supervisor.md`：唤醒来源、origin 与权限、上限、简报、提问、提案与决策、PR 验收链、自动合并的风险与开关、巡检配置、费用说明、已接受风险（hub.token 可读）；`docs/executors.md` 增加 pr-reviewer、pr-merge、`read_scope`；升级步骤（改 `dev.yaml`、启用策略规则与巡检）

## 7. 真实环境验收

- [ ] 7.1 product-res 跑通 M1 验收场景：先启用 supervisor 建任务的策略 auto 规则；Telegram `/ask` → supervisor 建 dev 任务 → Codex 开 PR（中途回复一次卡住）→ pr-reviewer 结构化审查 → 合并（先在 `auto_merge: false` 下批准一次，再开启验证自动合并）→ main 流水线确认 → journal 与简报更新；记录用户在手机上的操作次数
- [ ] 7.2 巡检一次：启用 product-res 的巡检规则，确认日报进入 journal 与每日摘要，写类问题以提案出现；接受一个带回看日期的提案，用临时把回看日期设为当天的方式验证回看唤醒与 `decision_review`
