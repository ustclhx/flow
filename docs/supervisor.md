# Supervisor：AI 主管

（变更 ④ add-m1-supervisor。设计依据见 `openspec/changes/add-m1-supervisor/design.md`，本文以 main 上的实际实现为准。）

supervisor 是每个 workspace 的 AI 主管：你在手机上说一句话（`/ask`），它拆成任务交给 worker（Codex 等），
PR 开出后安排只读审查，通过后请求合并；worker 中途卡住时，在你预先划定的范围内替你批准或回答，
拿不准就转交给你。它不是常驻进程，**每次唤醒都是一个全新的会话**，靠"简报"恢复记忆。

本文面向使用者。身份与接口权限见 [hub-auth.md](hub-auth.md)，策略规则语法见
`packages/core/src/policy/README.md`，执行器与角色见 [executors.md](executors.md)，简报细节见 [briefs.md](briefs.md)。

## 1. 概念与开关

- supervisor 是一个 `kind: supervisor` 的角色（`config/roles/supervisor.yaml`，`flow init` 生成），每次唤醒由**中枢**
  创建一个该角色的任务（执行器 claude-sdk）。全局只能有一个 `kind: supervisor` 角色，名字必须是 `supervisor`。
- supervisor 角色必须是只读配置：只有 Read、Grep、Glob 和 Flow MCP，没有 Bash 与写文件工具，并设 `read_scope: cwd`
  （只能读合同工作目录，读不到 `state/hub.token`、密钥与 `~/.ssh`）。配置被改成可写时 `flow doctor` 报错，中枢不唤醒。
- 它能产生的外部效果只有：建任务（受上限与策略约束）、提案、提问、请求合并、代回复。所有动作落账，可审计。

### workspace 配置（`config/workspaces/<id>.yaml` 的 `supervisor` 段）

整段可省略，全部取默认值；写错（未知字段、类型不对）时该 workspace 照常加载，但 supervisor 视为未启用，`flow doctor` 报告问题。

```yaml
id: product-res
kind: product
name: product-res
description: ...
repos:
  - /Users/me/workspace/product-res
supervisor:
  enabled: true            # 默认 true；还需要存在 supervisor 角色和登记仓库才会真正生效
  auto_merge: false        # 默认 false；见第 6 节
  merge_method: squash     # squash（默认）| merge | rebase
  allow_no_checks: false   # 默认 false：PR 至少要有一项检查且全部成功才合并
  reviewer_roles: [pr-reviewer]   # 审查结论被采信的角色，默认 [pr-reviewer]
  delegate_replies: true   # 卡住时先交给 supervisor 代回复，默认 true
  reply_timeout_s: 600     # 代回复等待秒数，超时转交你；默认 600，范围 30–86400
  limits:                  # 见第 3 节；均为非负整数，括号内为取值范围
    tasks_per_wake: 5               # 0–100
    wakes_per_day: 24               # 0–1000，普通唤醒（instruction + autonomous）
    autonomous_wakes_per_day: 4     # 0–1000，且不能超过 wakes_per_day
    reply_wakes_per_day: 48         # 0–1000，代回复唤醒单独计
    chain_depth: 8                  # 0–64
    review_rounds: 2                # 0–20
    open_questions: 3               # 0–20
```

`limits` 必须满足 `autonomous_wakes_per_day <= wakes_per_day`。违反这条约束、任一项超出取值范围或不是整数时，
**整段 `supervisor` 配置都会被降级为未启用**（不只是 `limits` 回到默认值）：该 workspace 不唤醒、不代回复，
`flow doctor` 给出指向文件与字段的 warning；改正后重跑 doctor 即恢复。

要点：

- **默认已启用**：`enabled` 缺省为 `true`。升级后只要某个 workspace 有登记仓库、又存在 supervisor 角色，它就会被唤醒
  （升级步骤见第 12 节，想先观察请显式写 `enabled: false`）。
- 唤醒任务以**登记仓库**为工作目录，没有登记仓库的 workspace 视为不可唤醒。
- **`ws/global` 固定不启用** supervisor：不唤醒，也不代回复其中任务的卡住；`flow doctor` 显示"global 不启用 supervisor"。
- 是否代回复 = `enabled && delegate_replies`。
- `flow doctor` 会逐个 workspace 显示 supervisor 设置（启用与否、是否缺仓库）。

### 节点预留槽（`config/node.yaml`）

```yaml
reserved:
  supervisor: 1   # 只给普通唤醒的预留槽，默认 1
  reply: 1        # 只给代回复唤醒的预留槽，默认 1
```

这样即使 dev 任务占满节点、或卡在审批上持有租约，唤醒仍能运行。旧节点二进制读不懂 `reserved`，升级顺序见 [daemon.md](daemon.md)。

## 2. 唤醒来源与 origin

中枢订阅账本，把下列事件放进 workspace 的队列，合并后创建一次唤醒：

| 事件 | origin |
| --- | --- |
| 你的指令（`flow ask`、`flow supervisor wake`、Telegram `/ask`） | `instruction` |
| 巡检定时规则触发（`payload.kind: supervisor_patrol`）、决策回看到期 | `autonomous` |
| supervisor 派生的任务 `done` / `failed` / `cancelled`，或卡住原因为 `crashed`、`node_lost`、`no_progress`、`other` | 继承该任务的 origin |
| 你回答了 supervisor 的提问 | 提问所在唤醒的 origin |
| 你接受任务提案 / 驳回提案、驳回合并请求 | 接受为 `instruction`；驳回取所在唤醒的 origin |
| 委托给 supervisor 的卡住（`question`、受委托的授权请求） | `reply`（独立队列，只能回复，见第 8 节） |

origin 由**中枢**根据账本计算并固化在任务上，不取自 supervisor 或模型可写的任何字段：

- **instruction**：你的决定直接或间接引出的工作。可以建写类任务、请求合并，`auto_merge` 只对它生效。
- **autonomous**：巡检、回看等 supervisor 自发的工作。**不能建写类任务**（`proposal_required`），只能用 `task_propose`
  提案等你接受；它请求的合并一律走你的批准。
- **reply**：只能 `task_respond` 与只读操作，不能建任务、提案、提问、请求合并或写笔记。

不在 supervisor 链上的任务（你手动建的、没挂到唤醒下的）没有 origin：它们的完成不会唤醒 supervisor，
PR 也不能被 supervisor 请求合并（卡住仍可能被委托代回复）。

调度规则：

- 每个 workspace 有三条队列：instruction、autonomous、reply。同一时刻最多一个**普通唤醒**（instruction 或 autonomous），
  空闲时 instruction 优先；另可并行一个 reply 唤醒。
- 一次唤醒只合并同一条队列里的事件（最新 200 个；`inputs.wake` 有 16000 字符预算，超出时逐级降级）。
- 普通唤醒失败重试一次；仍失败则出现一条 Interrupt 条目，**该队列暂停**，直到你 `--release` 或 1 小时后自动恢复一次
  （再失败则退避翻倍，最长 24 小时）。
- 唤醒任务 `blocked` 时新事件继续排队；你取消它即放行队列。

## 3. 权限与硬性上限

上限由中枢强制（配置见第 1 节的 `limits`）：

| 上限 | 默认 | 超出时 |
| --- | --- | --- |
| 每次唤醒创建的任务数 | 5 | `limit_exceeded` |
| 每 workspace 每天的普通唤醒次数（其中 autonomous） | 24（4） | 事件留在队列，收件箱出现"今日唤醒已达上限"，可用 `--release` 放行一次 |
| 每 workspace 每天的 reply 唤醒次数 | 48 | 新的委托立即转交你 |
| `parent` 链深度 | 8 | `limit_exceeded` |
| 同一 PR 的 `changes_requested` 轮数 | 2 | 再建 write 任务返回 `review_rounds_exceeded` |
| 同一 workspace 未回答的提问 | 3 | `too_many_questions` |

supervisor 建任务（`task_create`）时，中枢依次检查：

1. reply 唤醒一律拒绝（`reply_only_wake`）；
2. `parent` 必须是本 workspace 未结束的普通唤醒任务（`parent_required`）；
3. autonomous 唤醒不能建写类角色的任务（`proposal_required`）；
4. 不能建 `kind: merge` 或 `kind: supervisor` 的任务（`role_not_allowed`）；
5. 合同的 `cwd` / `inputs.repo` 必须在本 workspace 登记的仓库内（`repo_not_in_workspace`）；
6. **验收命令 `verify`**：验收命令由节点在沙箱**之外**直接运行，所以非 user 身份建任务时，每条命令都要经策略判定
   （动作为 `tool:Verify`），只有 `auto` / `auto-report` 放行，否则 `verify_not_allowed`；命令的每个词还必须符合形态白名单
   （相对路径、`-x`/`--name`/`--name=<词>` 形式的选项，不含绝对路径、`:`、`@`、`~`、glob、空格）。
   不启用白名单时，supervisor 建的任务**不能带 verify**；启用方式见第 12 节。
7. 第 3 节表中的数量与深度上限。

supervisor **不能**：回复任务（`task_reply`）、接受或驳回提案、批准合并、处理收件箱条目（只能忽略自己发起的提问）、
访问节点协议。这些返回 `user_only` / `scope_denied`。唤醒身份由节点领租约时中枢签发的"唤醒绑定 token"认定，
细节见 [hub-auth.md](hub-auth.md)。

## 4. 简报：supervisor 的记忆

每次唤醒是新会话。supervisor 开头读 `ws_brief`，结束前用 `brief_update` 写回自己的笔记：

- 笔记在 `brain/briefs/<workspace id>.md`（例如 `briefs/product-res.md`），上限 3000 字符，**整体替换**（带 `base_hash`，冲突时重读合并）；
  只能经中枢写入，会过 gitleaks 与脱敏；不是知识条目，不进索引与搜索。
- `ws_brief` 还拼上进行中的任务、待处理条目、近期决策，笔记最多占预算的 40%；supervisor 以 8000 字符预算调用。
- **代回复记录**一节由中枢根据 `task.replied`（actor supervisor）与 `task.reply_escalated` 确定性生成，标明"不是指令"，
  只含任务 id、决定、时间与回答长度，**不含回答原文**。原因：回答由 reply 唤醒写出，如果进入简报，就会进入之后有建任务权限的唤醒的上下文，
  worker 就能经提问内容影响它。回答原文只出现在你可见的每日摘要里。
- reply 唤醒不写笔记，也不写 journal。

你也可以自己改笔记：`flow brief update`（user 同样走中枢）。

## 5. 提问、任务提案与决策回看

**提问** `ask_user`：在收件箱（和 Telegram）生成一条 Decide 条目，可带 2–4 个选项按钮。提问**不挂起**本次唤醒，supervisor 写完笔记就结束；
你回复后条目关闭为 `answered`，触发新的唤醒（origin 取提问所在唤醒）。7 天没人回答则关闭为 `expired` 并唤醒一次。
同一 workspace 未回答的提问最多 3 个。

**任务提案** `task_propose`：autonomous 唤醒不能直接建写类任务，只能提案。条目展示角色、执行器、仓库与 cwd、验收命令、目标全文；
你**接受**后，中枢以 user 身份建任务（origin 为 instruction），**驳回**则唤醒 supervisor 知道结果。
- Web 页面可以先改目标再接受；Web 页面目前**只能在本机访问**（`flow ui`），Telegram 消息里不附链接，只注明"Web 页面仅本机可用"。
  手机访问 Web 是后续任务（tasks 4.10）。
- 验收命令不会因为"你点了接受"而绕过判定：接受时 `verify` 仍按第 3 节第 6 步逐条判定，不通过则接受失败（`verify_not_allowed`），条目保持打开；
  提交提案时也先预判，注定建不出来的提案直接拒绝。

**决策与回看**：提案可带 `title`、`expected_outcome`、`metric`、`review_date`（晚于今天、不超过 180 天）。接受时中枢写
`brain/decisions/<日期>-<slug>.md`（`status: approved`），任务合同引用它。每天 09:00（中枢时区）扫描回看日期已到的决策：
workspace 启用了 supervisor 则唤醒它做一次回看（origin 为 autonomous），它用 `decision_review` 追加一节"回看"并把状态改为 `reviewed`
（这是 AI 写 decision 的唯一窄例外：只追加、只改 `status` 与 `last_verified`、只限本次唤醒关联的那条）；
没有 workspace 或未启用 supervisor 的决策只生成一条每日摘要里的提醒。到期 14 天仍未回看的补一条提醒。

## 6. PR 验收链与自动合并

```
dev 任务 done（产出 PR）
  → supervisor 被唤醒，建 pr-reviewer 任务（只读审查）
  → 审查结论 changes_requested：supervisor 在同一分支建修改任务（受 review_rounds 上限）
  → 审查结论 approve：supervisor 调 pr_merge_request
  → auto_merge: false（默认）：你在收件箱批准 / 驳回"合并请求"
    auto_merge: true 且请求来自 instruction 唤醒：中枢直接建 merger 任务
  → merger（pr-merge 执行器，不调用模型）核对条件后合并，等待默认分支的 workflow 跑完
  → merger 结束，supervisor 被唤醒，写 journal、更新简报；失败则提问或进收件箱
```

**审查结论由执行器把关**：只有 `reviewer_roles` 里、执行器为 claude-sdk 的任务产出的 `result.review` 才被中枢采信。节点在启动会话前
用 `gh` 读 PR、记录 head SHA（`reviewed_sha` 由执行器填，**不取自模型**）、把 diff 写到私有目录，并把 head 检出到临时 worktree 供只读审查；
fork PR 一律拒绝。审查任务的目标文字由中枢模板生成，supervisor 写的 `goal` 会被丢弃（`focus` 只能补充关注点，不改变判定标准）。

**`pr_merge_request` 的资格核对**（全部取自账本与配置，拿不准即 `merge_not_eligible`，原因列在 `details.reasons`）：
PR 是本 workspace 内某个已完成、origin 为 instruction 的写类任务的产物，且该任务上报过任务分支；PR 属于登记仓库；
`review_task` 是该 PR **最新一次**可信审查、结论为 approve、没有未结束的审查任务；该审查的合并请求没被你驳回过
（驳回后必须重新审查）。你批准时中枢会再核对一次。

**pr-merge 合并前再核对一遍**（任一不满足就失败、不合并，原因码如 `pr_not_open`、`head_moved`、`checks_not_green`、`review_not_approved`）：
PR 为 open、base 是默认分支、不是 fork、head 分支等于任务分支、head SHA 等于审查时的 SHA、可合并、没有启用合并队列；
至少有一项检查且**全部成功**、没有进行中的检查（`allow_no_checks: true` 才允许没有检查）；审查结论仍有效。
合并方式取 `merge_method`。合并后等待默认分支上该提交触发的 workflow（最多 30 分钟）：全部成功 → `done`；有失败 →
`failed(pipeline_failed)`；超时 → `failed(pipeline_timeout)`；没有 workflow → `done` 并注明未发现流水线。

**取舍与限制，请在开启 `auto_merge` 前读完：**

- `auto_merge` **默认关闭**。关闭时每次合并都要你在收件箱批准一次。开启后，**只有 instruction 唤醒**请求的合并会直接执行；
  autonomous 唤醒请求的合并仍然走你的批准。
- 检查判定是 **fail-closed** 的：head 提交上的每个 check run 与 status 都单独计入，不按名称合并重跑结果。有意的后果：
  flaky 检查重跑成功后，旧的失败记录仍会阻止合并，需要推新提交，或由你手动合并。
- **合并队列（merge queue）不支持**：启用了合并队列的仓库，merger 会以 `merge_queue_unsupported` 失败。
- pr-merge 只能在本机节点上运行；请把关键检查设为分支保护的 required，因为 pr-merge 只看得到读取时已存在的检查。
- 审查模型的判定可能被 PR 内容影响，这是残余风险，靠 CI、默认关闭的自动合并和你的批准兜底。
- 能读到 `state/hub.token` 的进程（例如沙箱外运行的 Codex）就是 user，也能批准合并条目，见 [hub-auth.md](hub-auth.md) 的已接受风险。
- supervisor 停用后，已生成的合并审批条目你仍可批准（资格照常重新核对）；不想合并请驳回或忽略。

## 7. 巡检

巡检就是一条定时规则触发的 autonomous 唤醒。`flow init` 会在 `config/schedules.yaml` **不存在时**生成一份只有注释的示例
（已有文件不覆盖），默认不启用任何巡检。要巡检的 workspace 各写一条（取消注释、把 `<id>` 换成实际 id）：

```yaml
# config/schedules.yaml —— 每天 09:00 巡检 product-res
- id: patrol-product-res
  cron: "0 9 * * *"
  timezone: Asia/Shanghai        # 缺省为本机时区
  workspace: ws/product-res
  payload:
    kind: supervisor_patrol      # 必须是这个值，才会唤醒 supervisor
```

规则 id 不能以 `inbox:` 开头；写错的规则只会被跳过，`flow hub status` 报告。改完重启中枢生效。
启用了 supervisor（有登记仓库、存在 supervisor 角色）却没有巡检规则的 workspace，`flow doctor` 会给一条 info。
autonomous 每天最多 4 次（`autonomous_wakes_per_day`），计入每日普通唤醒上限。

巡检唤醒做什么，分两类：

**提示词引导的行为**（写在 `supervisor.md` 里，靠模型遵守，不是确定性保证）：读简报；看进行中 / 卡住 / 失败的任务、
未合并的 PR、可能过时的知识条目、近期的 raw 与收件箱；写一份日报；发现需要写代码或改配置的问题就 `task_propose` 提案；
最后更新简报。巡检唤醒的 `inputs.wake` 里有 `type: schedule.fired`、说明为"定时巡检（规则 …）"的事件，提示词据此判断这是巡检。

**中枢实现的确定性功能**：

- **不能直接建写类任务**：autonomous 唤醒建写类任务一律 `proposal_required`（第 3 节），只能提案等你接受。
- **日报通道 `patrol_report`**：supervisor 调用它提交日报（最多 3500 字符）。中枢只接受**合并了巡检触发的非 reply 唤醒**
  （否则 `not_patrol_wake` / `reply_only_wake`），每次唤醒一份（再交 `patrol_already_reported`）；接受后
  1. 以 supervisor 身份追加一条 journal（`brain/journal/<日期>.md`，标题"巡检日报（唤醒 <id>）"）；
  2. 生成一条 Digest 级、没有任何动作的收件箱条目 `patrol.<唤醒任务 id>`，**不推送**；
  3. 下一份每日摘要的"supervisor 巡检日报"一节列出它（每份最多展示 600 字符，全文在 journal 与条目里），随后条目以 `digested` 关闭。

  supervisor 没调用 `patrol_report`（例如模型没照提示词做），这一天的摘要里就没有日报；这不会报错，可在 `flow task show <唤醒任务>` 看它做了什么。
- **花费汇总**：见第 9 节。

## 8. 代回复：卡住时由 supervisor 替你回

**范围**：`delegate_replies` 开启时，本 workspace 任务（包括你手动建、没有 origin 的）的以下卡住先委托给 supervisor：

- `blocked(question)`：worker 的提问；
- `blocked(awaiting_approval)`：授权请求，**且**策略判定为 `supervisor` 档位、判定与这次卡住绑定（缺 `decision_id` 一律交给你）。

**不委托**（直接进你的收件箱）：supervisor 自己的唤醒任务、merger 任务、`reviewer_roles` 里的审查任务（审查必须独立）、
`node_lost` 后遗留的卡住、没有命令文本的授权请求；没有可用的 supervisor 角色或没有登记仓库的 workspace 同样不委托。
委托的条目标为"supervisor 处理中"，**不推送**到手机。

**策略档位 `supervisor`**：你在 `policies.yaml` 里写 `level: supervisor` 的规则，表示"这类请求先问 supervisor"，不是直接放行。
合并次序为 `notify > user > draft-approve > supervisor > auto-report > auto`。要点：

- 受保护的动作（`shell.opaque`、`pr.merge`、`deploy`、`secrets`、`policy.edit`、`config.edit`、`flow.admin`、`task.respond` 等）
  命中 `supervisor` 规则也会被提升为 `draft-approve`，**永不委托**；
- 受保护的工具（`tool:CodexCommand`、`tool:mcp__*` 等）只有"具体 scope + 精确 action"的规则才能判为 `supervisor`，不要写 `scope: *`；
- `command_prefix` 按原始词严格匹配：`pnpm test --x` 命中，`pnpm test:e2e`、`sudo pnpm test`、`./pnpm test`、`FOO=1 pnpm test`、
  `pnpm test > f`、`pnpm test $X` 都不命中，只允许独立的 `2>&1`；串联命令每段都须满足。

**白名单模板**（`flow init` 生成在 `policies.yaml` 里，**默认全部注释掉**，按 workspace 启用）：

- `tool:CodexCommand` 与 `tool:Bash` 下的 `pnpm check`、`pnpm test`、`pnpm lint` 前缀；
- 带 `gh_scope: workspace_repo` 的 `pr.create`、`gh pr view`、`gh pr diff`（不带 `-R`、无环境变量前缀，节点核对 gh 解析出的仓库；
  不接受 `--body-file`、`--jq`/`--template`）；
- 带 `push_to: task_branch` 的 `git.push`（单段 `git push <登记的 remote 名> <任务分支>`，无全局选项、无强推，节点核对推送环境）。

**目前 `push` 与 `pr.create` 不会真正委托**：`push_to` 与 `gh_scope` 要求节点上报命令的**实际执行目录**，
而 codex-orca 拿不到 Codex 提权命令的实际 workdir，claude-sdk 的 Bash 又会在调用之间保留 cwd，二者目前都不上报，
所以这两类规则不会命中，推送与开 PR 的授权仍交给你。模板留着，等执行器能提供可信的执行目录后才生效。
现阶段实际能委托的是 `pnpm check|test|lint` 这类命令前缀规则（以及 `question`）。

**怎么回复**：reply 唤醒只能调用 `task_respond{task_id, block_seq, decision, text?, reason}`
（CLI：`flow supervisor respond`）：`approve` / `deny` 用于授权请求，`answer`（必须带 `text`，≤2000 字符）用于提问，`escalate`
两者都可，转交给你。批准会被节点在送达前**重新读取待批请求并复查环境**，与判定时不一致就拒收并改交给你。

**转交与竞态**：下列情况委托结束，条目按原级别推送给你：

| 原因 | 含义 |
| --- | --- |
| `supervisor` | supervisor 主动 `escalate` |
| `timeout` | 超过 `reply_timeout_s`（默认 600 秒）仍未回复 |
| `wake_unavailable` | 唤醒起不来：未启用、没有角色、当天 reply 配额用尽、当前 reply 唤醒卡住；立即转交，不等超时 |
| `wake_failed` / `wake_ended` | 处理该委托的唤醒失败，或结束时仍没回复（reply 唤醒失败不重试） |
| `user_dismissed` | 你忽略了条目 |

此外任务离开了这次卡住（取消、租约过期、已被回复等）时委托静默失效。**在 supervisor 的回复写入之前，你的回复优先**
（你一回复，委托就结束，之后 supervisor 的 `task_respond` 返回 `stale_block`）；supervisor 的回复已写入但尚未送达时，
你再回复会得到 `reply_pending`。每日摘要会列出 supervisor 代回复的内容与送达状态（已送达、被拒收、已随任务重新排队、待送达）。

**已接受的风险（请知晓后再启用白名单）：**

1. **批准 `pnpm check|test|lint` 等于在沙箱外运行仓库里的脚本**：包括 worker 改过的 `package.json` scripts、测试配置，
   以及 `--reporter`、`--preload` 等参数引入的代码；与你自己点批准的风险相同。supervisor 会参考任务卡住时附带的 `git diff --stat`
   判断改动是否触及这些文件，但这靠提示词，不是确定性保证。验收命令（`tool:Verify`）同理，词法白名单拦不住仓库内指向仓库外的符号链接。
2. **git hook 与 git 配置**：推送由沙箱外的 git 执行，仓库里的 hook 和配置可能执行代码。节点会在批准前后检查 gitdir、
   remote 地址、配置项禁用清单与 hook 目录（Git LFS 仓库的 `pre-push` 会被拒绝），但从最后一次检查到命令真正执行之间有一个很短的时间窗，无法排除。
3. **回答靠提示词约束**：worker 的提问文字可能夹带指令，中枢只能用确定性规则限定授权请求，"回答是否合理"靠 supervisor 的判断。
   为此 reply 唤醒不能建任务、提案、提问或请求合并，回答原文也不进入任何后续唤醒的上下文（但仍在账本里，后续唤醒可以主动读到，读到的仍只是数据）。
4. 与全局一致：能读 `state/hub.token` 的同用户进程就是 user（[hub-auth.md](hub-auth.md) 信任边界）。

## 9. 费用

每次唤醒是一次 Opus 级别的 claude-sdk 会话；代回复唤醒、巡检、审查任务也各自是会话。claude-sdk 执行器在结果里记录
`result.cost.usd`（SDK 给出的**估算值，不是账单**），Flow 据此汇总 supervisor 的花费：

- **每日摘要**的"supervisor 花费（估算）"一节：昨天**结束**的唤醒任务（含 reply 唤醒）按 workspace 列出次数、代回复次数、金额，
  以及没有上报费用的次数（例如被取消的唤醒）；
- **`flow supervisor status`** 的"今日花费（估算）"：今天（中枢时区）已结束的唤醒任务的金额与次数。

只统计唤醒任务本身；supervisor 建的 dev、审查等任务不计入，未结束的唤醒也不计入。实际账单以 Anthropic 控制台为准。
控制费用的手段：

- 巡检默认关闭（`schedules.yaml` 里没有取消注释的巡检规则就没有巡检唤醒）；
- 同一队列的多个事件合并成一次唤醒；
- `limits.wakes_per_day`、`autonomous_wakes_per_day`、`reply_wakes_per_day` 是硬上限（默认 24 / 4 / 48）；
- 不想让 supervisor 代回复就设 `delegate_replies: false`；整体停用设 `enabled: false`。

## 10. 命令

```sh
flow ask product-res "给登录页加上忘记密码链接"       # 下指令；输出唤醒任务 id 或"已排队"
flow supervisor wake product-res [<说明>]               # 手动唤醒（有说明则等同指令）
flow supervisor wake product-res --release instruction  # 放行暂停 / 达到上限的队列（instruction | autonomous）
flow supervisor status [product-res]                    # 当前唤醒、各队列长度、暂停状态、今日次数与花费、最近一次结果
```

- workspace 写 `product-res` 或 `ws/product-res` 都可以。以上命令都**只有 user** 能用，AI 身份返回 `user_only`。
- 不可唤醒（未启用、没有角色、没有登记仓库）时 `flow ask` 会告知"未启用"，指令不会被积压。
- `--release` 只作用于放行当时队列里已有的事件；它立刻用这些事件唤醒一次，**不计入每日上限**，不能与说明同时给出。
- Telegram：`/ask <workspace> <内容>`，回复唤醒编号、排队说明或"未启用"。转发来的消息和 inline bot 发出的消息会被拒绝。
- supervisor 自己用的命令（`flow supervisor ask-user | propose | merge-request | respond | review-decision | patrol-report`、`flow brief update`）
  在你的终端里没有意义，需要唤醒绑定 token。

## 11. 故障排查

先运行 `flow doctor`（在节点实际使用的环境里），再看 `flow supervisor status`。

| 现象 / 提示 | 含义与处理 |
| --- | --- |
| doctor：`<ws> supervisor：未启用` | `enabled: false`，或 supervisor 段写错被降级（同时有一条指向文件与字段的 warning，改正后重跑） |
| doctor：`启用了 supervisor 但没有登记仓库` | 在 workspace 的 `repos` 登记仓库，或设 `enabled: false` |
| doctor：supervisor 角色问题（多个、可写、名字不符） | 只保留一个只读的 `kind: supervisor` 角色；可写时参照 `flow init` 生成的 `supervisor.yaml` 收紧 |
| doctor：`dev.yaml` 的 `creatable_by` 不包含 supervisor | supervisor 建不出 dev 任务，按提示片段补上 |
| doctor（info）：`启用了 supervisor 但没有巡检规则` | 只是提示：不需要每日巡检可以忽略；需要时按第 7 节在 `schedules.yaml` 取消注释示例 |
| 每日摘要里没有巡检日报 | 确认规则的 `payload.kind` 是 `supervisor_patrol` 且当天有巡检唤醒（`flow supervisor status`）；日报靠 supervisor 调用 `patrol_report`，没调用就没有 |
| doctor：角色有效类别 | 显示每个角色是 read / write / merge / supervisor；声明只能收紧，推断更严格时以推断为准 |
| `/ask` 回"未启用" | 同上三类原因之一 |
| 事件没处理、队列为空 | 不可唤醒期间中枢会写 `supervisor.queue_dropped{queue, up_to_seq, reason}` 并清掉该队列的积压（原因 `disabled`、`global`、`no_repo`、`no_role`、`unknown_workspace` 立即丢；配置暂时有错的 `role_invalid`、`workspaces_invalid` 先保留并重试，持续 24 小时才丢）。重新启用后**不会**带出旧事件，需要重新下指令 |
| Interrupt："今日唤醒已达上限，<队列> 的事件在等待" | 触到 `wakes_per_day` / `autonomous_wakes_per_day`；等明天，或 `flow supervisor wake <ws> --release <队列>` 放行一次，或调大上限 |
| Interrupt："supervisor 唤醒连续失败，<队列> 已暂停" | 普通唤醒重试后仍失败；看唤醒任务的失败原因修好后 `--release`，或等自动恢复（1 小时起，翻倍，最长 24 小时） |
| Interrupt："supervisor 唤醒无法创建" | 角色或配置临时不可读，已按 30 秒起翻倍退避重试 3 次；每天每 workspace 一条 |
| Interrupt："超过 24 小时无法唤醒，已丢弃积压的事件" | 配置错误持续超过 24 小时；修好配置后重新下指令 |
| supervisor 建任务被拒：`verify_not_allowed` | 没启用 `tool:Verify` 白名单，或命令含不允许的词；见第 12 节 |
| `proposal_required` | autonomous 唤醒想建写类任务，只能 `task_propose` |
| `merge_not_eligible` | 看 `details.reasons`：常见是审查不是最新的 approve、PR 不是 instruction 链上的产物、任务没上报分支 |
| 合并失败 `checks_not_green` / `head_moved` / `merge_queue_unsupported` | 见第 6 节；flaky 检查需推新提交或手动合并 |
| 卡住总是直接来到我的收件箱 | 没启用 `level: supervisor` 规则、命中的是受保护动作、不在委托范围（第 8 节），或 `delegate_replies: false`；`push` 与 `pr.create` 目前本来就不委托 |
| 委托后很久才转交 | 默认 `reply_timeout_s` 是 600 秒；supervisor 回复已写入但节点长期不 ack 时，条目会一直被挡住，直到任务离开这次卡住（送达、租约过期或你取消） |

## 12. 升级步骤（已有 flow-home）

假设你已经有运行中的中枢与节点。按顺序做：

1. **更新代码并补齐模板**：拉取最新 main 后运行 `flow init`。它只补齐缺失文件、**不覆盖已有文件**，
   会新增 `config/roles/supervisor.yaml`、`supervisor.md`、`pr-reviewer.yaml`、`pr-reviewer.md`、`merger.yaml`、`merger.md`，
   并在**尚不存在**时生成带注释模板的 `policies.yaml` 与只有注释巡检示例的 `schedules.yaml`。已有的 `policies.yaml` 不会被改动，需要的模板请从
   `packages/core/src/templates.ts` 的 `POLICIES_YAML` 或新建 flow-home 里的文件复制。
2. **手动改 `config/roles/dev.yaml`**：加上 supervisor 才能创建 dev 任务（`flow init` 不会改已有文件，`flow doctor` 会提示缺失）：

   ```yaml
   creatable_by:
     - supervisor
   ```

   已有 `creatable_by` 时把 `supervisor` 追加到列表里。
3. **在 `config/policies.yaml` 启用规则**（取消注释，把 `ws/<id>` 换成真实 workspace）：
   - 必须：让 supervisor 能直接建任务。不启用时每次建任务都要你批准一次，流程能走通但很烦：

     ```yaml
     - scope: supervisor
       action: task.create
       level: auto
     ```
   - 可选：`tool:Verify` 白名单（`pnpm check`、`pnpm test`、`pnpm lint`），否则 supervisor 建的任务不能带验收命令；
   - 可选：代回复白名单（第 8 节）。**先升级所有节点，再写带 `push_to` / `gh_scope` 的规则**，旧节点不认识这些条件。
4. **按需调整 workspace**：在 `config/workspaces/<id>.yaml` 增加 `supervisor` 段（第 1 节）。想先观察就写 `enabled: false`。
   要自动合并再写 `auto_merge: true`，建议先在 `false` 下完整跑过几次。
5. **按需启用巡检**：在 `config/schedules.yaml` 取消注释巡检示例（第 7 节）；已有 `schedules.yaml` 时 `flow init` 不改它，照第 7 节手动加规则。
6. **重启，先中枢后节点**：
   - 用 launchd 常驻（**前提是之前执行过 `flow daemon install`**）：`launchctl kickstart -k gui/$(id -u)/dev.flow.hub`，
     再 `launchctl kickstart -k gui/$(id -u)/dev.flow.node`（或重新运行 `flow daemon install`）；
   - 没有用 launchd 常驻、在前台运行的：先停掉并重新运行 `flow hub start`，再停掉并重新运行 `flow node start`。

   新旧节点协议兼容；`node.yaml` 的 `reserved` 要等所有节点升级后才能写（见 [daemon.md](daemon.md)）。
7. **检查**：`flow doctor` 应没有 supervisor 相关的 fail；`flow supervisor status` 应列出各 workspace 的启用状态；
   用 `flow ask <ws> "说明一下当前状态"` 做一次冒烟。

**回滚**：把对应 workspace 的 `supervisor.enabled` 设为 `false`（或删除 supervisor 角色）即停止唤醒与代回复；已建的任务不受影响，
已排队的事件会被清掉。需要回到旧版本二进制时，先删掉 `node.yaml` 的 `reserved` 与 `policies.yaml` 中带 `push_to` / `gh_scope` / `level: supervisor` 的规则。
