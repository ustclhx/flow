# Supervisor：AI 主管

（变更 ④ add-m1-supervisor。设计依据见 `openspec/changes/add-m1-supervisor/design.md`，本文以 main 上的实际实现为准。）

supervisor 是每个 workspace 的 AI 主管：你在手机上说一句话（`/ask`），它拆成任务交给 worker（Codex 等），
PR 开出后安排只读审查，通过后请求合并；worker 中途卡住时，在你预先划定的范围内替你批准或回答，
拿不准就转交给你。它不是常驻进程，**每次唤醒都是一个全新的会话**，靠"简报"恢复记忆。

本文面向使用者。身份与接口权限见 [hub-auth.md](hub-auth.md)，策略规则语法见
`packages/core/src/policy/README.md`，执行器与角色见 [executors.md](executors.md)，简报细节见 [briefs.md](briefs.md)。

## 1. 概念与开关

- supervisor 是一个 `kind: supervisor` 的角色（`config/roles/supervisor.yaml`，`raindown init` 生成），每次唤醒由**中枢**
  创建一个该角色的任务（执行器 claude-sdk）。全局只能有一个 `kind: supervisor` 角色，名字必须是 `supervisor`。
- supervisor 角色必须是只读配置：只有 Read、Grep、Glob 和 Raindown MCP，没有 Bash 与写文件工具，并设 `read_scope: cwd`
  （只能读合同工作目录，读不到 `state/hub.token`、密钥与 `~/.ssh`）。配置被改成可写时 `raindown doctor` 报错，中枢不唤醒。
- 它能产生的外部效果只有：建任务（受上限与策略约束）、提案、提问、请求合并、代回复。所有动作落账，可审计。

### workspace 配置（`config/workspaces/<id>.yaml` 的 `supervisor` 段）

整段可省略，全部取默认值；写错（未知字段、类型不对）时该 workspace 照常加载，但 supervisor 视为未启用，`raindown doctor` 报告问题。

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
  observe:                 # observe 模式：只记录 supervisor 会怎么做，不执行；三项默认都是 false，见第 8 节末尾
    replies: false         # 代答（提问）
    approvals: false       # 代批（授权请求）
    autonomous: false      # 自主工作（巡检、回看唤醒中的建任务、提案、合并请求）
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
`raindown doctor` 给出指向文件与字段的 warning；改正后重跑 doctor 即恢复。

要点：

- **默认已启用**：`enabled` 缺省为 `true`。升级后只要某个 workspace 有登记仓库、又存在 supervisor 角色，它就会被唤醒
  （升级步骤见第 12 节，想先观察请显式写 `enabled: false`）。
- 唤醒任务以**登记仓库**为工作目录，没有登记仓库的 workspace 视为不可唤醒。
- **`ws/global` 固定不启用** supervisor：不唤醒，也不代回复其中任务的卡住；`raindown doctor` 显示"global 不启用 supervisor"。
- 是否代回复 = `enabled && delegate_replies`。
- `raindown doctor` 会逐个 workspace 显示 supervisor 设置（启用与否、是否缺仓库）。

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
| 你的指令（`raindown ask`、`raindown supervisor wake`、Telegram `/ask`） | `instruction` |
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
- 一次唤醒只合并同一条队列里的事件（最新 200 个；`inputs.wake.events` 以 16000 字符为预算，超出时逐级省略正文）。任务快照按 id 在顶层去重，PR 只关联本次涉及的对象并限制内联任务数。降级同时裁剪正文和元数据，最终 `inputs.wake` 不超过 16000 字符；省略部分附 `chars` 与读取指针。事件引用也装不下时，`overflow.read` 指向本次唤醒的 `task_show section=events`，其中 `supervisor.wake_started.events` 保留完整 seq 清单，可逐条用 `event_get` 读取；队列仍一次消费最多 200 条事件。
- 按读取指针调用 `event_get` 或带 `section`、`offset`、`limit` 的 `task_show` 补读内容；`tail` 与 `instruction` 按字符分页，其他列表按条目分页。supervisor 只能读本 workspace 的事件；无 workspace 的全局事件只有被本次唤醒引用时可读，其他返回 `forbidden`。用户可读取全部事件。`event_get` 与 `task_show section=events/tail` 都对疑似密钥做正则遮蔽；tail 先遮蔽再分页，避免秘密跨页边界泄露。任务绑定的 worker 只能读取本任务、同 workspace 的事件，越界与不存在均返回 `not_found`；唤醒读取其他 workspace 的任务同样返回 `not_found`。
- supervisor 建任务时，中枢附加 `origin_instruction`，原文与 supervisor 的补充分段显示，以原始指令为准。本次唤醒只有一条用户指令时自动选择，多条时必须传本次唤醒中的 `instruction_seq`；autonomous 没有原始指令。用户指令最多 8192 字符，合同内联前 4000 字符，超出部分附原长和 `event_get` 指针。由开发任务完成等事件引出的审查与后续任务从关联开发任务继承原始指令；候选任务对应多条不同指令时不自动继承，授权依据中的 `instruction_note` 解释原因。提案通过 `draft.instruction_seq` 指定本次唤醒中的指令，接受后保留相同来源。没有原始指令的输入明确写出“本任务没有用户原始指令”，目标仍按 JSON 数据包裹。 长原文注入 worker 时，core 把读取指针转为本任务的 `task_show section=instruction`；中枢只从该任务合同关联的指令读取并脱敏分页，worker 仍不能直接读取没有本任务归属的原始事件。
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

supervisor 重试任务（`task_retry`）时，必须提供非空 `reason`，且只限本 workspace 唤醒链派生的任务：中枢检查 `created_by`，从目标任务到唤醒任务的每一级都必须由 `supervisor` 或 `hub` 创建。用户手工创建的任务、接受提案后以 `user` 创建的任务，即使继承 origin，也必须由 user 重试。唤醒任务本身与 merge/supervisor 类任务不可重试；reply 唤醒不可调用重试，autonomous 唤醒重试写类任务仍只能提案。

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

你也可以自己改笔记：`raindown brief update`（user 同样走中枢）。

## 5. 提问、任务提案与决策回看

**提问** `ask_user`：在收件箱（和 Telegram）生成一条 Decide 条目，可带 2–4 个选项按钮。提问**不挂起**本次唤醒，supervisor 写完笔记就结束；
你回复后条目关闭为 `answered`，触发新的唤醒（origin 取提问所在唤醒）。7 天没人回答则关闭为 `expired` 并唤醒一次。
同一 workspace 未回答的提问最多 3 个。

**任务提案** `task_propose`：autonomous 唤醒不能直接建写类任务，只能提案。条目展示角色、执行器、仓库与 cwd、验收命令、目标全文；
你**接受**后，中枢以 user 身份建任务（origin 为 instruction），**驳回**则唤醒 supervisor 知道结果。
- Web 页面可以先改目标再接受；Web 页面目前**只能在本机访问**（`raindown ui`），Telegram 消息里不附链接，只注明"Web 页面仅本机可用"。
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

巡检就是一条定时规则触发的 autonomous 唤醒。`raindown init` 会在 `config/schedules.yaml` **不存在时**生成一份只有注释的示例
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

规则 id 不能以 `inbox:` 开头；写错的规则只会被跳过，`raindown hub status` 报告。改完重启中枢生效。
启用了 supervisor（有登记仓库、存在 supervisor 角色）却没有巡检规则的 workspace，`raindown doctor` 会给一条 info。
autonomous 每天最多 4 次（`autonomous_wakes_per_day`），计入每日普通唤醒上限。

巡检唤醒做什么，分两类：

**提示词引导的行为**（写在 `supervisor.md` 里，靠模型遵守，不是确定性保证）：读简报；看进行中 / 卡住 / 失败的任务、
未合并的 PR、可能过时的知识条目、近期的 raw 与收件箱；写一份日报；发现需要写代码或改配置的问题就 `task_propose` 提案；
最后更新简报。巡检唤醒的 `inputs.wake` 里有 `type: schedule.fired`、说明为"定时巡检（规则 …）"的事件，提示词据此判断这是巡检。

**中枢实现的确定性功能**：

- **不能直接建写类任务**：autonomous 唤醒建写类任务一律 `proposal_required`（第 3 节），只能提案等你接受。
- **日报通道 `patrol_report`**：supervisor 调用它提交日报（最多 3500 字符）。中枢只接受**合并了巡检触发的非 reply 唤醒**
  （否则 `not_patrol_wake` / `reply_only_wake`），每次唤醒一份（再交 `patrol_already_reported`）；接受后
  1. 正文先脱敏（已登记的密钥值显示为 `[secret:<路径>]`，疑似密钥按规则替换），行首的 `#` 标题标记前加 `\`
     （正文不能伪造 journal 记录的标题），再以 supervisor 身份追加一条 journal（`brain/journal/<日期>.md`，首行
     "巡检日报（唤醒 <id>）"；中枢写条目失败后 supervisor 重试，按唤醒 id 去重，不会重复追加）；
  2. 生成一条 Digest 级、没有任何动作的收件箱条目 `patrol.<唤醒任务 id>`，**不推送**；
  3. 下一份每日摘要的"supervisor 巡检日报"一节列出它（每份最多展示 600 字符，全文在 journal 与条目里），随后条目以 `digested` 关闭。

  supervisor 没调用 `patrol_report`（例如模型没照提示词做），这一天的摘要里就没有日报；这不会报错，可在 `raindown task show <唤醒任务>` 看它做了什么。
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

- 受保护的动作（`shell.opaque`、`pr.merge`、`deploy`、`secrets`、`policy.edit`、`config.edit`、`raindown.admin`、`task.respond` 等）
  命中 `supervisor` 规则也会被提升为 `draft-approve`，**永不委托**；
- 受保护的工具（`tool:CodexCommand`、`tool:mcp__*` 等）只有"具体 scope + 精确 action"的规则才能判为 `supervisor`，不要写 `scope: *`；
- `command_prefix` 按原始词严格匹配：`pnpm test --x` 命中，`pnpm test:e2e`、`sudo pnpm test`、`./pnpm test`、`FOO=1 pnpm test`、
  `pnpm test > f`、`pnpm test $X` 都不命中，只允许独立的 `2>&1`；串联命令每段都须满足。

**白名单模板**（`raindown init` 生成在 `policies.yaml` 里，**默认全部注释掉**，按 workspace 启用）：

- `tool:CodexCommand` 与 `tool:Bash` 下的 `pnpm check`、`pnpm test`、`pnpm lint` 前缀；
- 带 `gh_scope: workspace_repo` 的 `pr.create`、`gh pr view`、`gh pr diff`（不带 `-R`、无环境变量前缀，节点核对 gh 解析出的仓库；
  不接受 `--body-file`、`--jq`/`--template`）；
- 带 `push_to: task_branch` 的 `git.push`（单段 `git push <登记的 remote 名> <任务分支>`，无全局选项、无强推，节点核对推送环境）。

**目前 `push` 与 `pr.create` 不会真正委托**：`push_to` 与 `gh_scope` 要求节点上报命令的**实际执行目录**，
而 codex-orca 拿不到 Codex 提权命令的实际 workdir，claude-sdk 的 Bash 又会在调用之间保留 cwd，二者目前都不上报，
所以这两类规则不会命中，推送与开 PR 的授权仍交给你。模板留着，等执行器能提供可信的执行目录后才生效。
现阶段实际能委托的是 `pnpm check|test|lint` 这类命令前缀规则（以及 `question`）。

**怎么回复**：reply 唤醒只能调用 `task_respond{task_id, block_seq, decision, text?, reason}`
（CLI：`raindown supervisor respond`）：`approve` / `deny` 用于授权请求，`answer`（必须带 `text`，≤2000 字符）用于提问，`escalate`
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

### observe 模式：先看 supervisor 会怎么做

放开代答、代批或自主工作之前，可以先让 supervisor 只"说"不"做"，用一段时间的真实数据看它的判断和你是否一致。
在 workspace 配置里逐项打开（三项相互独立，缺省都是 `false`，缺省时行为与没有这一节完全相同）：

```yaml
supervisor:
  observe:
    approvals: true     # 代批只记录
    replies: true       # 代答只记录
    autonomous: true    # 自主工作的写类动作只记录
```

`raindown doctor` 的 supervisor 摘要会显示每项是"开"还是"关"。改配置不需要重启中枢。

**代答 / 代批处于 observe 时**：委托照常发生，reply 唤醒照常给出判断；`task_respond` 不写回复，而是记录
`task.reply_observed`（判断、理由、对应的委托与策略判定），随后以转交原因 `observe` 把卡住推给你。收件箱条目
（含 Telegram）第一行是"【observe】supervisor 会：批准 / 拒绝 / 回答「…」（理由）"。你照常回复，回复照常送达 worker，
之后 `raindown supervisor report` 会把它和 supervisor 的判断对比。

- **判断绝不会到达 worker**：不建回复、不重新排队，续约、交付记录与恢复回复里都没有它；带 observe 的委托上 supervisor 的回复
  会被账本直接拒绝。observe 判断是不带任务 id 的 workspace 级事件，不在任何任务的事件列表里。
- **可见范围**：只有 user 能看到 observe 判断与条目里的"supervisor 会：……"。
  - 任务绑定的 worker（派工令牌），以及 user token 声明的其他身份（AI、节点等，非 supervisor 唤醒）调用 `task_show` 时，
    事件列表去掉 observe 判断、未执行的自主动作与全部 `inbox.*` 事件；任务绑定的 `event_get` 读这些事件按不存在处理；
  - 非 user 的调用方（含 supervisor 唤醒）读取收件箱（`inbox_list`）时，条目正文去掉 observe 这一行，只剩标题与原卡住说明；
  - `event_get` 读 `task.reply_observed` 只对 reply 唤醒开放：instruction / autonomous 唤醒被拒绝，reply 唤醒的产出不进入
    其他唤醒的上下文（与第 8 节"回答原文不进入后续唤醒"一致；简报同样只取条目标题）。
- 判断以委托时的配置为准；委托之后才打开 observe 的，`task_respond` 时读取的当前配置同样生效（两者任一开启即不送达）。
- observe 只记录、从不送达，所以只与送达有关的前提（节点仍持有租约、没有待送达回复、当前策略仍允许代批）不再检查：
  判断照常记录并立即转交；判断本身无法记录（例如对授权请求给出 answer）时返回错误，同时立即以 `observe` 转交，不等 `reply_timeout_s`。
- 回复时读不到该 workspace 的配置（workspace 已被删除等）：同样只记录、不送达（失败即不送达），但如实标为
  `forced: config_unavailable`、转交原因 `config_unavailable`，条目不显示"supervisor 会"，report 单独计数、不计入一致率。
- supervisor 自己判断要转交（`escalate`）的也会记录，但不计入一致率。

**自主工作处于 observe 时**：只影响 autonomous 唤醒（巡检、决策回看）。其中的 `task_create`、`task_propose`、
`pr_merge_request` 在各自的核对全部通过后不执行，只记录 `supervisor.observed_action{action, 参数摘要, reason}`
（参数摘要遮蔽疑似密钥、最多 1000 字符），supervisor 收到错误码 `observe_not_executed`，说明以"observe：未执行"开头。
instruction 与 reply 唤醒不受影响。autonomous observe **只覆盖这三个动作**；其他写类操作（`ask_user`、`decision_review`、
`patrol_report`、`brief update` 等）照常执行。observe 记录计入 `limits.tasks_per_wake`：一次唤醒记录满上限后返回 `limit_exceeded`。

**看一致率**：

```sh
raindown supervisor report product-res            # 最近 7 天
raindown supervisor report product-res --days 30  # 最近 30 天
raindown supervisor report --since 2026-11-01 --until 2026-11-08 --json
```

- 代批：你的批准 / 拒绝与 supervisor 的判断相同即一致；
- 代答：提问带结构化选项、且双方都恰好选了某个选项时比较是否同一项；自由文本回答只统计"已回复"，不判一致；
- 另外列出卡住记录中 `basis: reported`（worker 主动上报）与 `inferred`（终端推断）的比例（按执行器），
  以及 observe 下未执行的自主动作数量与类型。

**建议的逐项放开顺序**：

1. 先打开 `approvals` 与 `replies` 的 observe 跑一到两周；
2. 代批一致率稳定在高位（例如 ≥ 95%，样本至少几十条）后关掉 `approvals` 的 observe，让 supervisor 真正代批；
3. 再看代答：可判定样本足够、一致率稳定后关掉 `replies` 的 observe；自由文本多时先让 worker 用结构化选项提问；
4. 最后才考虑自主工作：先开 `autonomous` 的 observe 看几轮巡检会建什么、提什么、请求合并什么，确认无误再关闭。

任何一步出现不一致，重新打开对应项即可回到只记录，不影响其他项。

## 9. 费用

每次唤醒是一次 Opus 级别的 claude-sdk 会话；代回复唤醒、巡检、审查任务也各自是会话。claude-sdk 执行器在结果里记录
`result.cost.usd`（SDK 给出的**估算值，不是账单**），Raindown 据此汇总 supervisor 的花费：

- **每日摘要**的"supervisor 花费（估算）"一节：昨天**结束**的唤醒任务（含 reply 唤醒；按结束时间归日，每个唤醒恰好计入一份摘要）按 workspace 列出次数、代回复次数、金额，
  以及没有上报费用的次数（例如被取消的唤醒）；
- **`raindown supervisor status`** 的"今日花费（估算）"：今天（中枢时区）结束的唤醒任务的金额与次数（`--json` 中 `today.cost_usd` 保留 6 位小数）。

只统计唤醒任务本身；supervisor 建的 dev、审查等任务不计入，未结束的唤醒也不计入。实际账单以 Anthropic 控制台为准。
控制费用的手段：

- 巡检默认关闭（`schedules.yaml` 里没有取消注释的巡检规则就没有巡检唤醒）；
- 同一队列的多个事件合并成一次唤醒；
- `limits.wakes_per_day`、`autonomous_wakes_per_day`、`reply_wakes_per_day` 是硬上限（默认 24 / 4 / 48）；
- 不想让 supervisor 代回复就设 `delegate_replies: false`；整体停用设 `enabled: false`。

## 10. 命令

```sh
raindown ask product-res "给登录页加上忘记密码链接"       # 下指令；输出唤醒任务 id 或"已排队"
raindown supervisor wake product-res [<说明>]               # 手动唤醒（有说明则等同指令）
raindown supervisor wake product-res --release instruction  # 放行暂停 / 达到上限的队列（instruction | autonomous）
raindown supervisor status [product-res]                    # 当前唤醒、各队列长度、暂停状态、今日次数与花费、最近一次结果
raindown supervisor report [product-res] [--days 30]        # observe 一致率、卡住 basis 比例、未执行的自主动作（第 8 节末尾）
```

- workspace 写 `product-res` 或 `ws/product-res` 都可以。以上命令都**只有 user** 能用，AI 身份返回 `user_only`。
- 不可唤醒（未启用、没有角色、没有登记仓库）时 `raindown ask` 会告知"未启用"，指令不会被积压。
- `--release` 只作用于放行当时队列里已有的事件；它立刻用这些事件唤醒一次，**不计入每日上限**，不能与说明同时给出。
- Telegram：`/ask <workspace> <内容>`，回复唤醒编号、排队说明或"未启用"。转发来的消息和 inline bot 发出的消息会被拒绝。
- supervisor 自己用的命令（`raindown supervisor ask-user | propose | merge-request | respond | review-decision | patrol-report`、`raindown brief update`）
  在你的终端里没有意义，需要唤醒绑定 token。

## 11. 故障排查

先运行 `raindown doctor`（在节点实际使用的环境里），再看 `raindown supervisor status`。

| 现象 / 提示 | 含义与处理 |
| --- | --- |
| doctor：`<ws> supervisor：未启用` | `enabled: false`，或 supervisor 段写错被降级（同时有一条指向文件与字段的 warning，改正后重跑） |
| doctor：`启用了 supervisor 但没有登记仓库` | 在 workspace 的 `repos` 登记仓库，或设 `enabled: false` |
| doctor：supervisor 角色问题（多个、可写、名字不符） | 只保留一个只读的 `kind: supervisor` 角色；可写时参照 `raindown init` 生成的 `supervisor.yaml` 收紧 |
| doctor：`dev.yaml` 的 `creatable_by` 不包含 supervisor | supervisor 建不出 dev 任务，按提示片段补上 |
| doctor（info）：`启用了 supervisor 但没有巡检规则` | 只是提示：不需要每日巡检可以忽略；需要时按第 7 节在 `schedules.yaml` 取消注释示例 |
| 每日摘要里没有巡检日报 | 确认规则的 `payload.kind` 是 `supervisor_patrol` 且当天有巡检唤醒（`raindown supervisor status`）；日报靠 supervisor 调用 `patrol_report`，没调用就没有 |
| doctor：角色有效类别 | 显示每个角色是 read / write / merge / supervisor；声明只能收紧，推断更严格时以推断为准 |
| `/ask` 回"未启用" | 同上三类原因之一 |
| 事件没处理、队列为空 | 不可唤醒期间中枢会写 `supervisor.queue_dropped{queue, up_to_seq, reason}` 并清掉该队列的积压（原因 `disabled`、`global`、`no_repo`、`no_role`、`unknown_workspace` 立即丢；配置暂时有错的 `role_invalid`、`workspaces_invalid` 先保留并重试，持续 24 小时才丢）。重新启用后**不会**带出旧事件，需要重新下指令 |
| Interrupt："今日唤醒已达上限，<队列> 的事件在等待" | 触到 `wakes_per_day` / `autonomous_wakes_per_day`；等明天，或 `raindown supervisor wake <ws> --release <队列>` 放行一次，或调大上限 |
| Interrupt："supervisor 唤醒连续失败，<队列> 已暂停" | 普通唤醒重试后仍失败；看唤醒任务的失败原因修好后 `--release`，或等自动恢复（1 小时起，翻倍，最长 24 小时） |
| Interrupt："supervisor 唤醒无法创建" | 角色或配置临时不可读，已按 30 秒起翻倍退避重试 3 次；每天每 workspace 一条 |
| Interrupt："超过 24 小时无法唤醒，已丢弃积压的事件" | 配置错误持续超过 24 小时；修好配置后重新下指令 |
| supervisor 建任务被拒：`verify_not_allowed` | 没启用 `tool:Verify` 白名单，或命令含不允许的词；见第 12 节 |
| `proposal_required` | autonomous 唤醒想建写类任务，只能 `task_propose` |
| `merge_not_eligible` | 看 `details.reasons`：常见是审查不是最新的 approve、PR 不是 instruction 链上的产物、任务没上报分支 |
| 合并失败 `checks_not_green` / `head_moved` / `merge_queue_unsupported` | 见第 6 节；flaky 检查需推新提交或手动合并 |
| 卡住总是直接来到我的收件箱 | 没启用 `level: supervisor` 规则、命中的是受保护动作、不在委托范围（第 8 节），或 `delegate_replies: false`；`push` 与 `pr.create` 目前本来就不委托 |
| 委托后很久才转交 | 默认 `reply_timeout_s` 是 600 秒；supervisor 回复已写入但节点长期不 ack 时，条目会一直被挡住，直到任务离开这次卡住（送达、租约过期或你取消） |

## 12. 升级步骤（已有 raindown-home）

假设你已经有运行中的中枢与节点。按顺序做：

1. **更新代码并补齐模板**：拉取最新 main 后运行 `raindown init`。它只补齐缺失文件、**不覆盖已有文件**，
   会新增 `config/roles/supervisor.yaml`、`supervisor.md`、`pr-reviewer.yaml`、`pr-reviewer.md`、`merger.yaml`、`merger.md`，
   并在**尚不存在**时生成带注释模板的 `policies.yaml` 与只有注释巡检示例的 `schedules.yaml`。已有的 `policies.yaml` 不会被改动，需要的模板请从
   `packages/core/src/templates.ts` 的 `POLICIES_YAML` 或新建 raindown-home 里的文件复制。
2. **手动改 `config/roles/dev.yaml`**：加上 supervisor 才能创建 dev 任务（`raindown init` 不会改已有文件，`raindown doctor` 会提示缺失）：

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
5. **补上提示词里的巡检段**：`raindown init` 不覆盖已有的 `config/roles/supervisor.md`，所以升级前就有这个文件的 home
   拿不到新增的"巡检"一段（读简报 → 检查 → `patrol_report` 提交日报 → 只能提案 → 更新简报），supervisor 也就不会调用 `patrol_report`。
   请把新模板中以"巡检（inputs.wake.events 中有 type 为 schedule.fired"开头的一段复制进你的 `supervisor.md`。新模板可在
   `packages/core/src/role-templates.ts` 的 `DEFAULT_ROLE_FILES['supervisor.md']` 查看；也可以在临时目录里初始化一个新 home 后查看：
   `export RAINDOWN_HOME=$(mktemp -d)/home && raindown init`，打开 `$RAINDOWN_HOME/config/roles/supervisor.md`，看完 `unset RAINDOWN_HOME`
   （别在这个终端里继续操作真实的 home）。
6. **按需启用巡检**：在 `config/schedules.yaml` 取消注释巡检示例（第 7 节）；已有 `schedules.yaml` 时 `raindown init` 不改它，照第 7 节手动加规则。
7. **重启，先中枢后节点**：
   - 用 launchd 常驻（**前提是之前执行过 `raindown daemon install`**）：`launchctl kickstart -k gui/$(id -u)/dev.raindown.hub`，
     再 `launchctl kickstart -k gui/$(id -u)/dev.raindown.node`（或重新运行 `raindown daemon install`）；
   - 没有用 launchd 常驻、在前台运行的：先停掉并重新运行 `raindown hub start`，再停掉并重新运行 `raindown node start`。

   新旧节点协议兼容；`node.yaml` 的 `reserved` 要等所有节点升级后才能写（见 [daemon.md](daemon.md)）。
8. **检查**：`raindown doctor` 应没有 supervisor 相关的 fail；`raindown supervisor status` 应列出各 workspace 的启用状态；
   用 `raindown ask <ws> "说明一下当前状态"` 做一次冒烟。

**回滚**：把对应 workspace 的 `supervisor.enabled` 设为 `false`（或删除 supervisor 角色）即停止唤醒与代回复；已建的任务不受影响，
已排队的事件会被清掉。这只关闭 supervisor 功能；**任何一次任务重试（包括它生成的收件箱通知）之后，都不能沿用当前账本退回旧中枢与旧客户端**。

旧版 `task.requeued` 的 `strictObject` 不认识新增的 `requested_by` / `retry_reason` 字段；旧版 `inbox.item_created` 的 `source` 枚举不认识 `task_retry`，旧 CLI 列收件箱也可能解析失败。此外，`failed → queued` 转换及后续 `task.started` 在旧状态机中不合法，重建会以 `ledger_inconsistent` 中止。

使用任务重试前，先停止服务并备份账本，升级中枢、节点与使用该账本的客户端。需要退回旧版本时，必须停止服务并使用升级前的备份，不能继续使用已经发生任何任务重试或包含其收件箱通知的账本；升级后产生的记录不会包含在该备份中，详见 [任务重试的升级与回滚限制](daemon.md#任务重试的升级与回滚限制)。其他情况下需要回到旧版本二进制时，先删掉 `node.yaml` 的 `reserved` 与 `policies.yaml` 中带 `push_to` / `gh_scope` / `level: supervisor` 的规则。

`user.instruction` 的长度上限已从 4000 提高到 8192 字符；一旦账本写入超过 4000 字符的指令，旧中枢重放会校验失败，回滚必须停止服务并恢复升级前的账本备份。

## 13. PR 订阅与直通（`github.watch`）

开出或审查 PR 的任务可以持续跟随这个 PR：PR 上后来的 CI 结果、审查结论与评论由中枢读取并记入账本，
之后（见下文"直通送达"）直接送到负责的 worker，不必每次都唤醒 supervisor。默认关闭；不打开时行为与之前完全相同。

### 开启

在 `config/workspaces/<id>.yaml` 加 `github` 段：

```yaml
github:
  watch: true              # 轮询本 workspace 有订阅的 PR；默认 false
  allowed_users: [ustclhx] # 可选：其评论算"请求"的 GitHub 用户（不区分大小写）
```

- 中枢用**自己所在机器上的 `gh` 登录**只读查询（`gh api --method GET`），先确认 `gh auth status` 正常；
- PR 必须位于 workspace 登记仓库（`repos`）的 origin 所在的 github.com 仓库；不在时（或有登记仓库暂时读不出 origin 时）按查询失败报告，不自动退订；
- `raindown doctor` 显示每个打开了 `github` 段的 workspace 的开关与名单；打开了 `watch` 却没有登记仓库时给出 warning。

### 订阅

- 开发任务上报任务分支后，账本记录到它的 PR（`raindown_report` 的 ready 交付物、结果里的 PR）时自动订阅（关系 `author`）。
  中枢首次轮询时用 GitHub 的 head 信息核对：PR 不是由该任务分支开出、或来自 fork，订阅即取消（`not_task_branch`）；
- 审查任务创建时订阅它审查的 PR（关系 `reviewer`）；
- 订阅在任务结束后保留，直到 PR 关闭或合并后再过 14 天（`pr_closed`）；
- `raindown task show <task>` 列出订阅；`raindown task unsubscribe <task> <PR 链接>` 取消（只限你本人经 CLI，AI 身份返回 `user_only`）。
  取消后不会被自动重新订阅。

### 采集（pr-watcher）

- 只轮询 `watch: true` 的 workspace 中有有效订阅的 PR：每 2 分钟一次，连续无变化时依次退避到 4、8、10 分钟，读到新内容后回到 2 分钟；
- 读取 check runs、reviews、PR 评论与代码行评论，写 `pr.event{pr, kind, actor, actor_id, actor_kind, allowed, not_allowed, pr_state, text, url, cursor}`。
  订阅之前的历史内容不送达（有效游标不早于最早有效订阅的时间）；每种内容按游标续读、各自提交（一类失败不阻塞其他类），
  游标随事件落账，中枢重启后不会重复送达；以游标时间往前 1 秒重查并去重，避免同一秒的竞态漏读；
- 分页达到上限：代码行评论按 updated 升序、只推进到已取到的部分；PR 评论、审查与检查本类本次不入账并按失败报告，游标不越过没读到的内容；
- `text` 先遮蔽疑似密钥再截断（附原始字符数）；
- 单个 PR 查询失败只记在该 PR 上，下一轮重试；连续 3 次失败才出现在 `raindown hub status` 的"PR 查询失败"一行并写告警日志。

### 共享 GitHub 身份（当前版本的保守限制）

worker 目前用中枢所在机器的 `gh` 登录在 PR 上发评论与审查——通常就是你本人。这样 worker 发的评论与你的评论无法区分，
会被当作"名单内的人类请求"：任务可以自我恢复、任务之间来回触发、陌生人的内容经 worker 转述后被洗白，
或经 PR 评论取得 instruction 唤醒的权限。因此：

- 中枢启动时与每 30 分钟用 `gh api user` 核对自己的登录（按数字 id）。该身份在某个 PR 的有效名单中时视为**共享身份**：
  该 workspace 的 PR 评论一律只作为不可信上下文送给运行中的订阅任务，`allowed` 为 false（`not_allowed: shared_identity`），
  **不**恢复已结束任务、**不**交回 supervisor、**不**为无订阅评论唤醒 supervisor；查询失败时同样按共享身份处理（fail closed）；
- `raindown hub status` 的"PR 共享身份"一行写明原因，`raindown doctor` 对打开了 `watch` 却没有配置 `worker_identity` 的 workspace 给出 warning；
- 解除方法：为 worker 配置独立的 GitHub bot 账号或 App，在 `github.worker_identity` 写上它的登录名（App 写 `<slug>[bot]`），
  并让 `allowed_users` 只含你本人。只有 `worker_identity` 已配置、与中枢 gh 登录不同、且不在名单中时才解除限制；
  它发的内容标为 `actor_kind: agent`，永不算请求。**把 bot 凭证注入 worker 留待后续变更**，本版本只提供配置与显示。

### 什么算"请求"

`allowed` 只有全部满足才为 true：

- 种类是 PR 评论或代码行评论（审查正文、CI 检查一律只作上下文）；
- 人类账号（不是 bot、不是 `worker_identity`），且账号**数字 id** 在该 PR 的有效名单中（改名冒用的同名账号不算）；
- 评论没有被编辑过（编辑后再次送达只作上下文，同一条多次编辑只保留最新）；
- 不处于共享身份。

非请求内容在账本中只存 500 字（完整内容见 `url`），每个 PR 每次轮询最多入账 20 条、每天最多 200 条，超出的丢弃并在 `hub status` 提示。

### `allowed_users` 的安全含义

仓库公开时，任何人都能在 PR 上评论。**只有名单内用户的人类评论算"请求"**：能恢复已结束的任务、被 worker 交回给 supervisor、
或在没有订阅任务时唤醒 supervisor。名单外用户、机器人（GitHub App、`[bot]` 账号）与 CI 的内容 `allowed` 恒为 false，
只作为不可信的上下文送达运行中的任务，不恢复任务、不唤醒 supervisor。

- 不写 `allowed_users` 时，名单只取**该 PR 所属**登记仓库 origin 的 owner（例如 `git@github.com:ustclhx/raindown.git` → `ustclhx`），
  且只在 owner 是个人账号时；owner 是组织时默认名单为空（`hub status` 提示），请显式列出成员。fork 开出的 PR 不会成为 author 订阅；
  名单按账号数字 id 比较，同名账号的 id 变化时告警；
- `allowed: true` 只表示"可以算请求"，**不扩大任务的授权依据或合同范围**：worker 收到超出范围的请求时应交回 supervisor；
- 名单写错（如拼错用户名）只会让评论被当作不可信上下文，不会放宽任何权限。
