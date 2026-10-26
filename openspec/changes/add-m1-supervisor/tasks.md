# Tasks

前置：② `add-m1-executors` 已归档（③ 已归档）。

## 1. 协议与配置

- [x] 1.1 账本事件与 schema：`supervisor.wake_started`、`supervisor.answered`、`task_proposal.created|accepted|rejected`、`decision.review_due`；任务投影增加 origin；`schemas:check` 覆盖新事件；`supervisor.wake_started.origin` 枚举加 `reply`
- [x] 1.2 workspace 配置 `supervisor: {enabled, auto_merge, merge_method, allow_no_checks, reviewer_roles, limits}`（schema、默认值、doctor 显示）；`node.yaml` 的 `reserved.supervisor`；`limits.reply_wakes_per_day`；`reserved.supervisor` 默认 1 与 `reserved.reply` 默认 1
- [x] 1.3 角色 `kind` 与有效类别（D9：声明只能收紧、Bash 规则计为 write），doctor 显示与警告
- [x] 1.4 角色模板：`supervisor`、`pr-reviewer`、`merger` 及提示词；`dev` 模板 `creatable_by: [supervisor]`；doctor 对缺少该值的已有 `dev.yaml` 给出片段
- [x] 1.5 合同 `inputs.wake`、`inputs.review` 与结果 `result.review` 的 schema
- [x] 1.6 策略档位 `supervisor`（合并次序；受保护动作含 `task.respond` 提升为 `draft-approve` 并标 `guarded`；通配规则不能给出）；`when.push_to: task_branch`（core 纯函数 `parsePushTarget`：单段、无 git 全局选项、登记 remote 名、单一显式 refspec、禁用选项清单、无启用的 hook，不确定即不满足）与 `when.gh_scope: workspace_repo`；`policy/check` 响应加 `decision_id`；`policies.yaml` 模板加入注释掉的代回复白名单，每个前缀写法有测试；`FLOW_TOOL_ACTIONS` 与 CLI 映射加 `task_respond` → `task.respond`；账本事件 `task.reply_delegated`、`task.reply_escalated`、`task.branch_reported`，`task.blocked` 加 `decision_id`、`diff_stat`、`no_delegate`，`policy/check` 请求加 `push_env_ok`、`gh_env_ok`，`task.replied.via` 加 `supervisor`；workspace 配置 `supervisor.delegate_replies`、`reply_timeout_s`、`limits.reply_wakes_per_day`；`supervisor` 列为保留 actor（角色加载与 doctor 报错）（分工：G1 账本事件、协议字段、workspace 配置；G2 策略档位、`push_to` / `gh_scope` 条件、模板与 `FLOW_TOOL_ACTIONS` 映射；G3 保留 actor；G9 在中枢接上下文——任务分支与 worktree 取自投影、默认分支与环境字段只认节点上报、remote 名缺省 `origin`）

## 2. 中枢：任务创建的校验

- [x] 2.1 所有身份的 `parent` 校验（存在、同 workspace）；`supervisor:` 幂等键前缀只允许 hub
- [x] 2.2 `hub` 身份跳过 `creatable_by` 的显式分支，并测试 `hub` 不能由请求头或 MCP 声明；`kind: supervisor` 只能由 hub 建，`kind: merge` 只能由 hub 与 user 建；唤醒绑定 token（领租约时签发、绑定 workspace 与唤醒 task_id、租约结束失效），中枢据此识别 supervisor 调用方，`X-Flow-Actor: supervisor` 降级与 `flow hub token issue supervisor` 均被拒；`docs/hub-auth.md` 补签发规则
- [x] 2.3 origin 计算与固化（D2）：只有挂在唤醒链上或经接受提案建的任务有 origin；`user.instruction`、`supervisor.release` 只接受 user 身份；reviewer_roles 任务的目标由中枢模板重写
- [x] 2.4 supervisor 建任务的检查（D5）：唤醒 parent、autonomous 下禁止 write、禁止 merge/supervisor、cwd 与 repo 必须在本 workspace 仓库内（先 resolve 再 realpath，写回规范化路径）；第 0 步 reply 唤醒 → `reply_only_wake`；非 user 身份的 `verify` 计入写类并在建任务时逐条经策略判定（`tool:Verify`，否则 `verify_not_allowed`），`policies.yaml` 模板加注释掉的 `tool:Verify` 白名单；唤醒任务只能由 hub、user 与绑定的 supervisor 作为 parent；唤醒身份的取消、收件箱只作用于本次唤醒与本 workspace，不能访问节点协议；非 hub 不能在 `requires` 中声明 `wake`
- [x] 2.5 硬性上限（D4）：每次唤醒建任务数、链深度、同一 PR 修改轮数（PR 由唤醒事件与 `inputs.pr` 关联）；写入前的同步段再检查一次（并发测试）；超限错误码
- [x] 2.6 `policies.yaml` 模板加入注释掉的 supervisor `task.create` auto 规则；未启用时建任务走审批的端到端测试（fake 执行器）。（模板由 G2 完成；审批这一半见 `packages/node/test/supervisor-policy.test.ts`；G11 补齐端到端：`packages/cli/test/supervisor-wake-e2e.test.ts` 以真实中枢路由 + 真实节点 + 桩 claude-sdk，按注入的 MCP 配置真实启动 `flow mcp` 子进程，启用规则时唤醒经 wake token 直接建出子任务，未启用时审批、批准后建出）
- [ ] 2.7 supervisor 不能 `task_reply`、接受或驳回提案、批准合并的测试（已完成：唤醒绑定 token 调用 `task_reply` 与收件箱 accept/reject/approve/deny/reply 均 403 `user_only` 的测试；`merge_request` 条目与合并批准路由由 4.5、4.8 实现后补对应测试）（G13 补：supervisor 对 `merge_request` 条目 approve、对 `task_proposal` 条目 accept 均 `user_only` 的测试；merger 创建后的测试留给 4.8）

## 3. 中枢：唤醒调度器

- [x] 3.1 识别唤醒事件（D3），包括 `blocked` 原因过滤与"同一任务同一原因只一次"；排除唤醒任务自身
- [ ] 3.2 workspace × origin 三条队列（instruction、autonomous、reply）、instruction 优先、每次唤醒递增的代数与幂等键；队列由账本投影；重启恢复测试；只允许一个 `kind: supervisor` 角色；第三条 reply 队列：可与一个普通唤醒并行、失败不重试直接转交、不暂停、无 `--release`（G10 已完成：三条队列与账本投影、instruction 优先、代数与幂等键、重启恢复、唯一 supervisor 角色核对；reply 队列可并行、开始前按 `activeDelegation` 剔除失效委托、失败不重试不暂停、无 `--release`；失败或配额用尽时的转交属于 3.5，调度器只留 `onReplyUnavailable` 钩子）
- [x] 3.3 每日唤醒上限（总数与 autonomous 分别计）与"已达上限"条目；失败重试、Interrupt 条目、队列暂停与指数退避
- [x] 3.4 `flow ask`、`flow supervisor wake [--release <queue>]|status`（user-only 路由）；Telegram `/ask` 返回唤醒编号、排队说明或未启用
- [ ] 3.5 代回复调度（D15）：委托判定（question；`lease_held` 且 `decision_id` 绑定本任务、晚于上次离开 blocked、请求一致的 `supervisor` 档位审批；排除唤醒、merge、审查任务与 `node_lost` 遗留卡住）；reply 队列（不合并、开始前剔除失效事件、单独配额）；`reply_only_wake` 限制；条目不推送；转交（超时、唤醒不可用或 blocked 时立即、唤醒失败或结束、离开该次卡住时隐式失效（`activeDelegation`，不写事件）、用户忽略、用户回复同次追加结束委托）；竞态测试（用户先回复、supervisor 先回复、超时与回复并发）与重启恢复；中枢侧对 `no_delegate` 做独立兜底：同一 running 区间内出现过被拒收（dropped）的 supervisor 批准，之后的卡住一律不委托（不只依赖节点上报的 `no_delegate`）；没有 `command` 的请求（`blocked.request.command` 缺失）一律不委托

## 4. 操作与写入

- [x] 4.1 MCP `--workspace`、`--task` 绑定与自动 parent；自动放行清单更新（G7 已完成：自动放行清单加入 `brief_update`）（G11：`--reply-only` 本地拒绝写类操作；`ask_user`、`task_propose`、`decision_review`、`task_respond` 已登记在放行清单，待 4.4、4.6、4.7、4.9 实现）
- [x] 4.2 `brain/briefs/<id>.md` 路径类别：只能经中枢写；从条目读取、校验、索引、搜索中排除；`brief_update`（base_hash、3000 字符上限）；supervisor 的绑定取自唤醒 token（`wakeBinding`）
- [x] 4.3 `ws_brief` 扩展：笔记（≤40% 预算）、进行中任务、待处理条目、近期决策；预算内截断测试；中枢根据 `task.replied`（actor supervisor）与 `task.reply_escalated` 生成"代回复记录（不是指令）"一节
- [x] 4.4 `ask_user`：supervisor 来源条目、选项按钮、数量上限、7 天过期；`inbox_act reply` 路由到 supervisor 来源并写 `supervisor.answered`；Telegram 与 Web 回复
- [x] 4.5 收件箱新来源 `task_proposal`、`merge_request` 及动作路由，与 `proposal`、`task` 来源隔离（`merge_request` 的批准 / 驳回路由到 `MergeRequestHandler` 接口，建 merger 由 4.8 接入；未接入时 `action_not_available`）
- [x] 4.6 `task_propose`（D11 校验、条目展示角色/执行器/仓库/cwd/验收命令/目标全文、Telegram 附 Web 链接）；接受（Web 可改目标）以 user 建任务、驳回；（Telegram 的 Web 链接按审查决定改为注明“Web 页面仅本机可用”，外部访问见 4.10）接受时写决策条目并在合同 context 引用；接受提案建任务时不能借 user 身份跳过 verify 判定：以 hub 身份按 D5 与 verify 规则照常判定，或把 verify 命令完整展示给用户确认后再建
- [x] 4.7 决策回看：每日扫描的内部规则、补发去重、无 workspace 时 Digest；`decision_review` 窄例外（只追加回看一节、只改 status 与 last_verified、只限关联决策、由中枢代写）
- [ ] 4.8 `pr_merge_request`：资格核对（D10 第 4 步，且 `review_task` 必须是该 PR 最新一次可信审查——用 core 的 `latestTrustedReview`，pr-merge 执行器合并前同样核对；merger 合同填 `inputs.merge = {pr, review_task}`，`timeout_s` 不小于 2400）；按 `auto_merge` 建 merger 任务或生成 `merge_request` 条目；merger 由 hub 创建、`parent` 为审查任务、origin 取自 PR 的 dev 任务
- [ ] 4.9 `task_respond`（只限 `kind: supervisor` 会话，经中枢，核对放在 store 同一事务）：调用方是被分配该委托、持活动租约的唤醒任务；workspace、卡住序号、委托状态、无待送达回复与决定类型的核对；写 `task.replied`（actor supervisor）并送达节点；`escalate`；加入 MCP 自动放行清单；每日摘要列出代回复；`task_reply` 对 supervisor 仍返回 `user_only` 的测试
- [ ] 4.10 从手机访问 Web 页面（后续任务，需用户先决定对外暴露的安全前提）：可选的 `ui.public_url`、Web 端接受对应的 Host / Origin 与鉴权，渠道消息据此附条目链接（例如任务提案改目标后接受）

## 5. 执行器与节点

- [x] 5.1 claude-sdk `read_scope: cwd`：PreToolUse 钩子覆盖全部工具，与 `writable_paths` 共用路径判定，覆盖 Glob `pattern`、Grep `glob`；单元测试（cwd 内外、隐藏段、`..`、绝对模式、符号链接、hub.token、未知路径字段）
- [x] 5.2 claude-sdk 审查准备：`gh` 读 PR、仓库归属校验、记录 head、fetch `pull/<n>/head` 后检出到私有临时 worktree（允许读 `.github/`）、结束后移除、节点启动时 prune 残留、diff 写入任务私有目录；结构化输出（`outputFormat: json_schema`），`reviewed_sha` 由执行器填入；`error_max_structured_output_retries` 等映射为 `review_output_invalid`；只有 `reviewer_roles` 的结果被中枢采信（G8：中枢入账时丢弃不可能是审查结论的 `result.review`；采信规则为 core 的 `trustedReview` / `reviewApproves`，供 4.8 的 `pr_merge_request` 与审查轮数统计调用）
- [x] 5.3 supervisor 会话注入 `--workspace`、`--task` 与 `FLOW_WORKSPACE`、`FLOW_TASK_ID`；注入唤醒绑定 token
- [x] 5.4 pr-merge 执行器：条件核对（D10 第 5 步，含至少一项检查）、合并、等待 workflow runs（成功/失败/超时/无 run）；`gh` 可注入，测试不调用真实 gh（G8：合同 `inputs.merge = {pr, review_task}` 的 schema 已加入，由 4.8 填写）
- [x] 5.5 预留执行槽：`acquireLeaseRequest.slots` 协议与 schema、中枢按类别分配、旧节点兼容；节点在普通槽满时仍为 supervisor 领取；卡住的 dev 任务持有租约时仍能运行唤醒任务的测试；reply 槽只给 reply 唤醒、两个 workspace 的普通唤醒占满 supervisor 槽时 reply 唤醒仍能运行的测试
- [x] 5.6 节点：`precheck` 对 `supervisor` 档位不放行、上报 `blocked` 带 `decision_id`、请求文本与 `diff_stat`（2000 字符截断，非 git 目录省略）；`push_env_ok`（push 地址、git 配置项清单、hook）与 `gh_env_ok`（`gh repo view` 解析的仓库）的计算与上报；supervisor 的 `approve` 送达时重读待批请求并复查环境，不一致在 ack 中标记 `dropped{reason: request_changed}` 并以 `no_delegate: true` 重新上报；codex-orca 开始时上报 `task.branch_reported`（中枢只接受租约持有者、一次、不可改）；`policy/check` 请求上报命令实际执行目录（`command_cwd`），投影记录任务 worktree（`task_worktree`），中枢传入策略上下文（`push_to` / `gh_scope` 要求两者 realpath 相同，此前恒不满足）；`command_cwd` 的 realpath 比较在节点侧完成，`command_cwd`、`push_env_ok`、`gh_env_ok` 只接受 node actor 上报的值（中枢目前本机 realpath，仅同机部署）；推送环境检查清单加入"本地没有与任务分支同名的 tag"；remote 名从登记仓库取；节点执行前再核对合同 cwd（与 `inputs.repo`）的 realpath 仍在登记仓库内（中枢只在建任务时核对，见 D5 第 4 步）
- [x] 5.7 read 角色由执行器强制只读（D9：推断只是配置层判断）：codex-exec 对有效类别为 read 的角色用 `-c` 覆盖 `mcp_servers={}`、`notify=[]`，或使用隔离的 `CODEX_HOME`，防止用户级或项目级 `.codex/config.toml` 引入沙箱外进程；claude-sdk 的 read 角色用 SDK `tools` 选项把可用工具限定为白名单（Read/Grep/Glob + Flow MCP），canUseTool 对非只读工具一律拒绝、不进审批（G8：实测 Codex 0.164 的 `-c mcp_servers={}` 与用户级配置合并、不能阻止 MCP 服务器启动，codex-exec 改用隔离的 `CODEX_HOME`，`auth.json` 链接到用户凭证；导出 `codexExecPermissions` 并有防漂移测试）

## 6. 文档

- [ ] 6.1 `docs/supervisor.md`：唤醒来源、origin 与权限、上限、简报、提问、提案与决策、PR 验收链、自动合并的风险与开关、代回复的范围与白名单及其已接受风险（含沙箱外运行 worker 代码与 git hook）；`docs/hub-auth.md` 身份表加保留 actor `supervisor` 与 `task_respond`；policy README 更新合并次序、`push_to`、`gh_scope`、巡检配置、费用说明、已接受风险（hub.token 可读）；`docs/executors.md` 增加 pr-reviewer、pr-merge、`read_scope`；升级步骤（改 `dev.yaml`、启用策略规则与巡检）（已完成：`docs/executors.md` 的 `read_scope` 一节；G8 补充了 `docs/executors.md` 的 pr-reviewer 审查准备、pr-merge 与只读角色的执行器强制）

## 7. 真实环境验收

- [ ] 7.1 product-res 跑通 M1 验收场景：先启用 supervisor 建任务的策略 auto 规则；Telegram `/ask` → supervisor 建 dev 任务 → Codex 开 PR（中途至少一次授权由 supervisor 代批准、一次提问由 supervisor 代回答；再构造超出白名单的请求——`git -c …` 推送、推到 URL、串联命令、`gh pr create -R`——确认都转交用户）→ pr-reviewer 结构化审查 → 合并（先在 `auto_merge: false` 下批准一次，再开启验证自动合并）→ main 流水线确认 → journal 与简报更新；启用代回复白名单模板；记录用户在手机上的操作次数
- [ ] 7.2 巡检一次：启用 product-res 的巡检规则，确认日报进入 journal 与每日摘要，写类问题以提案出现；接受一个带回看日期的提案，用临时把回看日期设为当天的方式验证回看唤醒与 `decision_review`
