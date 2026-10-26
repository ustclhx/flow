# Spec Delta

## MODIFIED Requirements

### Requirement: 策略配置
策略 SHALL 写在 `config/policies.yaml` 中，每条规则包括：
- `scope`：`ws/<id>`、角色名或 `*`；
- `action`：动作 id，支持通配符，例如 `tool:Bash`、`git.push`、`pr.create`；
- `level`：`notify`、`draft-approve`、`supervisor`、`auto-report`、`auto` 之一；
- `when`：可选条件，例如命令前缀、文件路径通配、`push_to: task_branch`。

配置不合法时 MUST 拒绝加载该条规则并报告，其余规则照常生效。

#### Scenario: 一条规则写错
- **WHEN** `policies.yaml` 中有一条规则的 level 是 `always`
- **THEN** 该规则不生效，`flow hub status` 报告该错误，其他规则正常工作

### Requirement: 档位行为
各档位 SHALL 按以下方式处理命中的请求：
- `auto`：系统以 `policy` 身份直接批准，不生成条目；
- `auto-report`：直接批准，并生成一条 Digest 条目；
- `supervisor`：任务在代回复范围内（所在 workspace 开启了代回复，且不是唤醒任务或合并任务）时委托给 supervisor 判断（条目不推送，超时或无法唤醒时转交用户）；否则按 `draft-approve` 处理；
- `draft-approve`：生成 Decide 级别以上的条目，等用户批准或驳回；
- `notify`：同 `draft-approve`，但条目级别为 Interrupt。

各档位合并时的保守次序为 `notify > user > draft-approve > supervisor > auto-report > auto`。

#### Scenario: 自动放行并汇报
- **WHEN** 一条 `auto-report` 规则命中了 `pr.create`
- **THEN** 该请求被立即批准，任务不进入 `blocked`，当天的每日摘要中出现这次操作


#### Scenario: 委托给 supervisor
- **WHEN** `scope: ws/product-res action: tool:CodexCommand level: supervisor when: {command_prefix: pnpm check}` 命中了 Codex 的越出沙箱请求
- **THEN** 判定为 `supervisor`，请求委托给 product-res 的 supervisor，用户没有收到推送

### Requirement: 不可自动放行的动作
`pr.merge`、`deploy`、`secrets`、`shell.opaque`、策略文件的修改（`policy.edit`）、flow-home `config/` 下任何文件的修改（`config.edit`），以及 flow MCP 中会扩大权限的操作（`task.create`、`task.cancel`、`task.reply`、`proposal.decide`、`resource.transfer`），在用户没有显式配置时 SHALL 一律交给用户；即使命中了 `scope: *` 或通配 action 的 `auto` 规则，也 MUST 只有 scope 为具体 workspace 或角色、且 action 不含通配符的规则才能自动放行它们。这些动作 MUST NOT 被判为 `supervisor`：命中 `supervisor` 规则时提升为 `draft-approve`。

请求涉及受保护的工具时——Codex 越出沙箱的命令（`tool:CodexCommand`）、所有 MCP 工具（`tool:mcp__*`）、外发工具（`tool:WebFetch`、`tool:WebSearch`）、派生子 agent（`tool:Task`）——参与判定的每个动作 MUST 只由 action 不含通配符的规则自动放行；`*`、`tool:*`、`tool:mcp__*` 这类通配规则最多判为 `draft-approve`；`supervisor` 档位同样只能由具体 scope 加精确 action 的规则给出。

经 Bash 调用 flow CLI 完成同样的操作时 MUST 识别为同样的动作，flow 的管理命令（hub、policy、daemon 等）识别为受保护的 `flow.admin`；命令直接访问中枢端口时 MUST 按无法确定处理。

识别策略或配置文件时 MUST 不区分大小写；命令中出现 glob、变量展开或命令替换且涉及 `config` 或 `polic` 时，MUST 按无法确定处理（视为可能修改策略与配置）；节点 MUST 把路径解析符号链接后的真实位置与原路径一并送去判定。

#### Scenario: 通配规则不能放行合并
- **WHEN** 只有一条 `scope: * action: * level: auto` 规则，此时某任务请求 `gh pr merge`
- **THEN** 请求交给用户，收件箱生成条目

#### Scenario: 通配规则不能放行受保护的工具
- **WHEN** 只有一条 `scope: dev action: tool:* level: auto` 规则，此时 dev 角色的 Claude 调用 `mcp__flow__task_create`，或 Codex 请求越出沙箱执行 `rm -rf ~`
- **THEN** 两个请求都交给用户；改为显式规则 `scope: dev action: task.create level: auto` 或 `scope: ws/a action: tool:CodexCommand level: auto` 后，对应请求才可自动放行

#### Scenario: 策略文件的变体写法
- **WHEN** 只有 `scope: * action: tool:* level: auto` 规则，请求的命令为 `sed -i … ~/flow-home/config/polic*.yaml`，或写入 `~/flow-home/CONFIG/Policies.yaml`，或编辑一个指向策略文件的符号链接
- **THEN** 请求被识别为 `policy.edit`，交给用户

#### Scenario: 合并永远不委托
- **WHEN** 有一条 `scope: ws/product-res action: pr.merge level: supervisor` 规则，此时任务请求 `gh pr merge 29`
- **THEN** 判定为 `draft-approve`，交给用户

## ADDED Requirements

### Requirement: 推送目标条件
规则 SHALL 支持条件 `when.push_to: task_branch`，只用于 `git.push`。节点 MUST 确定性地解析推送命令：目标 ref 是该任务自己的分支（codex-orca 为 worktree 分支，其余为合同登记的分支）、不是仓库默认分支、没有强推（`-f`、`--force`、`--force-with-lease`、`+` 开头的 refspec）、没有删除（`--delete`、`:<ref>`）时才满足；无法确定时 MUST 视为不满足。

#### Scenario: 推到任务分支
- **WHEN** 任务分支为 `ustclhx/t-1`，Codex 请求 `git push -u origin ustclhx/t-1`，命中 `git.push level: supervisor when: {push_to: task_branch}`
- **THEN** 判定为 `supervisor`

#### Scenario: 推到默认分支或强推
- **WHEN** 同一任务请求 `git push origin HEAD:main` 或 `git push --force origin ustclhx/t-1`
- **THEN** 条件不满足，规则不命中，请求交给用户
