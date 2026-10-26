# Spec Delta

## Purpose

把用户现在的"Orca 建 worktree、在终端里启动 Codex、盯着终端"流程做成节点上的执行器，用于长时间、交互式的开发任务。

## ADDED Requirements

### Requirement: 按任务创建 worktree
执行 `codex-orca` 任务时，执行器 SHALL 在合同的仓库中，基于 `origin/<默认分支>` 创建一个以任务 id 命名的 Orca worktree，并在仓库定义了 setup 时等待它完成。仓库必须是某个已定义 workspace 的仓库，否则任务 MUST 以 `failed`（`repo_not_in_workspace`）结束。

#### Scenario: 为 product-res 的任务创建 worktree
- **WHEN** 一个 `ws/product-res` 的 dev 任务被本机节点领取
- **THEN** Orca 中出现一个以该任务 id 命名的 product-res worktree，分支基于 origin/main

### Requirement: 任务说明
执行器 SHALL 把任务合同渲染成一份任务说明交给 Codex，包括：
- 目标、角色提示词；
- 上下文引用：brain 条目要内联其摘要，并给出 `flow kb get` 命令；
- 允许修改的范围、验收命令；
- 完成标准：在分支上提交、推送并开 PR，不合并；
- "遇到无法判断的问题时写明问题后停下"这条约定。

任务说明同时保存在 `state/tasks/<id>/spec.md`，便于事后回看。

#### Scenario: 任务说明带上下文
- **WHEN** 合同的 context 中包含 `projects/product-res`
- **THEN** 任务说明中包含该项目卡片的摘要，以及 `flow kb get projects/product-res`

### Requirement: 自动处理文件夹信任提示
Codex 在新 worktree 中停在文件夹信任提示上时，如果该仓库属于已定义的 workspace，执行器 SHALL 自动确认，方法是只发送回车，然后继续监控；否则上报 `blocked(awaiting_approval)`。

#### Scenario: 首次进入仓库
- **WHEN** Codex 启动后输出末尾是 "Trust this folder?" 提示
- **THEN** 执行器发送回车，Codex 继续工作，任务保持 `running`

### Requirement: 终端监控与结束判定
执行器 SHALL 定期读取终端末尾的输出（默认每 30 秒），并作为活动上报。
- 输出中出现忙碌标记（例如 `Working (`、`esc to interrupt`），视为在工作。
- 连续两次都没有忙碌标记，视为已停止。停止后按卡住检测的规则判定：
  - 分支上存在本任务的 PR：以 `done` 结束，产物中包含 PR 链接；
  - 否则：以 `blocked` 结束，附带原因和末尾输出。

#### Scenario: Codex 开完 PR 停下
- **WHEN** Codex 推送分支、开了 PR 后停止
- **THEN** 任务进入验收阶段，最终结果的产物中包含该 PR 的链接

#### Scenario: Codex 停下提问
- **WHEN** Codex 停止，没有 PR，末尾输出是一个问题
- **THEN** 任务变为 `blocked(question)`，说明中附带末尾 40 行输出

### Requirement: 送达回复与取消
收到用户对 `blocked` 任务的回复时，执行器 SHALL 把回复文字送进该任务的 Orca 终端，然后恢复监控。任务被取消时，执行器 MUST 关闭终端；worktree 保留，用于排查，由后续的清理流程处理。

#### Scenario: 回复后继续
- **WHEN** 用户对 `blocked(question)` 的任务回复"用方案 A"
- **THEN** 终端收到这段文字，Codex 重新开始工作，任务回到 `running`
