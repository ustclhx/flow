# Spec Delta

## Purpose

用"范围 × 动作 × 档位"的统一模型，决定执行器的审批请求由谁来答复，让用户只处理自己真正关心的那部分（PRD §10）。

## ADDED Requirements

### Requirement: 策略配置
策略 SHALL 写在 `config/policies.yaml` 中，每条规则包括：
- `scope`：`ws/<id>`、角色名或 `*`；
- `action`：动作 id，支持通配符，例如 `tool:Bash`、`git.push`、`pr.create`；
- `level`：`notify`、`draft-approve`、`auto-report`、`auto` 之一；
- `when`：可选条件，例如命令前缀、文件路径通配。

配置不合法时 MUST 拒绝加载该条规则并报告，其余规则照常生效。

#### Scenario: 一条规则写错
- **WHEN** `policies.yaml` 中有一条规则的 level 是 `always`
- **THEN** 该规则不生效，`flow hub status` 报告该错误，其他规则正常工作

### Requirement: 动作识别
执行器的审批请求 SHALL 被映射成一个或多个动作 id：
- 工具调用映射为 `tool:<工具名>`；
- Bash 或 Codex 的命令再按前缀映射为更具体的动作，例如 `git push` 映射为 `git.push`，`gh pr create` 映射为 `pr.create`，`gh pr merge` 映射为 `pr.merge`，`wrangler deploy` 映射为 `deploy`。

映射表 SHALL 可以扩展。

#### Scenario: 命令映射
- **WHEN** Claude 请求执行 `git push origin feat-x`
- **THEN** 该请求被识别为 `tool:Bash` 与 `git.push`

### Requirement: 判定顺序
对一个请求，系统 SHALL 选出所有匹配的规则，取最具体的一条：
1. scope 为具体 workspace 的，优先于角色，角色优先于 `*`；
2. 同一层级内，具体的 action 优先于通配符；
3. 仍然并列时，取更保守的档位。

没有任何规则匹配时，请求交给用户。判定结果 MUST 记入 `policy.decided` 事件，包括请求、命中的规则和结果。

#### Scenario: 具体规则优先
- **WHEN** 有两条规则 `scope: * action: git.push level: auto` 和 `scope: ws/xuanxue-saas action: git.push level: draft-approve`，此时 xuanxue-saas 的任务请求 `git push`
- **THEN** 判定为 `draft-approve`，生成收件箱条目等待用户

### Requirement: 档位行为
各档位 SHALL 按以下方式处理命中的请求：
- `auto`：系统以 `policy` 身份直接批准，不生成条目；
- `auto-report`：直接批准，并生成一条 Digest 条目；
- `draft-approve`：生成 Decide 级别以上的条目，等用户批准或驳回；
- `notify`：同 `draft-approve`，但条目级别为 Interrupt。

#### Scenario: 自动放行并汇报
- **WHEN** 一条 `auto-report` 规则命中了 `pr.create`
- **THEN** 该请求被立即批准，任务不进入 `blocked`，当天的每日摘要中出现这次操作

### Requirement: 不可自动放行的动作
`pr.merge`、`deploy` 以及策略文件本身的修改，在用户没有显式配置时 SHALL 一律交给用户；即使命中了 `scope: *` 的 `auto` 规则，也 MUST 只有 scope 为具体 workspace 或角色的规则才能自动放行它们。

#### Scenario: 通配规则不能放行合并
- **WHEN** 只有一条 `scope: * action: * level: auto` 规则，此时某任务请求 `gh pr merge`
- **THEN** 请求交给用户，收件箱生成条目
