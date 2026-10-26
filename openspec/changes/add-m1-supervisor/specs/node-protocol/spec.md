# Spec Delta

## ADDED Requirements

### Requirement: supervisor 预留执行槽
领取租约请求 SHALL 支持可选字段 `slots: {general, supervisor}`；中枢只把 `kind: supervisor` 的任务分给 supervisor 空位，普通空位也可以接。没有该字段的节点 MUST 被视为只有普通空位。`node.yaml` SHALL 支持 `reserved.supervisor`（默认 2：一个普通唤醒加一个 reply 唤醒），节点在普通槽位已满时仍为 supervisor 空位发起领取。

#### Scenario: dev 任务卡住时仍能唤醒
- **WHEN** `concurrency: 1` 的节点上一个 dev 任务处于 `blocked` 并持有租约
- **THEN** 新的唤醒任务仍被该节点领取并运行

#### Scenario: 旧节点
- **WHEN** 不带 `slots` 字段的节点领取任务
- **THEN** 中枢按原有并发语义分配，不报错

### Requirement: 卡住时附带改动摘要
执行器上报 `blocked` 时 SHALL 在工作目录是 git 仓库的情况下附带 `diff_stat`（相对任务基点的 `git diff --stat` 与未提交改动，最多 2000 字符，超出截断并注明）；取不到时省略，不影响上报。

#### Scenario: Codex 卡住
- **WHEN** codex-orca 任务在改了 README 后请求授权
- **THEN** `blocked.diff_stat` 列出 `README.md | 2 ++`

### Requirement: 代回复相关的节点职责
节点 SHALL：
- 对策略结果为 `supervisor` 的请求不放行，上报 `blocked` 时带上 `decision_id` 与请求文本；
- 在 precheck 时为 `git push` 上报 `push_env_ok`（push 地址与登记仓库一致、没有会执行命令或改写目标的 git 配置、没有启用的 hook），为 gh 命令上报 `gh_env_ok`（gh 实际解析出的仓库与登记仓库一致）；
- 执行 supervisor 的批准前重新读取待批请求并复查上述环境，不一致时在 ack 中标记该回复 `dropped{reason: request_changed}`，并以 `no_delegate: true` 重新上报卡住；
- codex-orca 开始时写 `task.branch_reported{branch}`；中枢 MUST 只接受持有该任务活动租约的节点写入，每个任务一次、不可更改；
- 领到唤醒任务租约时接收中枢签发的唤醒绑定 token 并注入 MCP 环境，租约结束后不再使用。

#### Scenario: 请求在等待期间变了
- **WHEN** supervisor 批准了 `pnpm check`，但节点送达时待批请求已变为另一条命令
- **THEN** 节点不放行，ack 标记 `dropped`，新的卡住直接交给用户
