# node-protocol Specification

## Purpose
规定执行节点与中枢之间的协议，以及执行器插件的接口。节点主动拉取任务，以便日后中枢迁到服务器、节点留在 NAT 之后时协议保持不变，并且可以用其他语言重写节点。

## Requirements

### Requirement: 节点注册
节点启动时 SHALL 向中枢注册，提交节点 id、主机名、版本，以及能力列表（例如 `executor:codex-orca`、`repo:/Users/hxlee/workspace/product-res`、`browser`）。中枢 SHALL 记录节点最近一次的活动时间，并通过 `flow node list` 展示。

#### Scenario: 查看节点
- **WHEN** 本机节点启动后，用户运行 `flow node list`
- **THEN** 输出包含该节点的 id、能力和最近一次的活动时间

### Requirement: 按能力领取租约
节点 SHALL 通过 long-poll 请求领取任务（等待时间可配置，默认 30 秒）。中枢 MUST 只把"所需能力是该节点能力子集"的 `queued` 任务分配给该节点，按创建时间先后分配。分配时任务变为 `running`，并附带一个有期限的租约（默认 60 秒）。没有可领取的任务时，请求在等待时间到达后返回空结果。

#### Scenario: 能力不匹配
- **WHEN** 队列中只有一个需要 `executor:codex-orca` 的任务，而请求领取的节点只有 `executor:fake`
- **THEN** 该节点的领取请求在等待结束后返回空结果，任务保持 `queued`

#### Scenario: 同一任务不会被分配两次
- **WHEN** 两个具备相同能力的节点同时请求领取，而队列中只有一个任务
- **THEN** 只有一个节点得到该任务

### Requirement: 续约与活动上报
持有租约的节点 SHALL 在租约到期前续约，并可以同时上报活动事件（输出片段、心跳、状态提示）。中枢在续约响应中 MUST 告知该任务是否已被取消。

#### Scenario: 续约时得知取消
- **WHEN** 任务被取消后，节点发起续约
- **THEN** 续约响应中标明已取消，节点随后提交 `cancelled`

### Requirement: 提交结束
节点 SHALL 以 `done`、`failed` 或 `blocked` 结束一次租约，并附带结果或原因。`blocked` 必须附带原因类别（例如 `awaiting_approval`、`question`、`no_progress`、`crashed`）与说明。只有持有当前租约的节点 MUST 才能提交，其他节点的提交一律被拒绝。

#### Scenario: 过期租约的迟到提交
- **WHEN** 租约已过期并被处理后，原节点才提交 `done`
- **THEN** 提交被拒绝，错误码为 `lease_expired`，任务状态不变

### Requirement: 租约过期处理
租约过期未续约时，中枢 SHALL 根据任务合同决定处理方式：
- 允许重试且未超过最大尝试次数：回到 `queued`，尝试次数加一；
- 否则：变为 `blocked`，原因 `node_lost`。

由于执行器可能已经产生副作用，合同默认不允许重试。

#### Scenario: 节点掉线
- **WHEN** 一个默认合同的任务在执行中，节点进程被杀死，租约到期
- **THEN** 任务变为 `blocked`，原因为 `node_lost`，账本记录 `task.lease_expired`

### Requirement: 睡眠不误判掉线
中枢检测到本机从睡眠中恢复（墙钟前进明显超过单调时钟）时，SHALL 把所有活动租约的到期时间顺延一个租约周期，并记录 `hub.resumed` 事件。节点从睡眠中恢复后 MUST 立即续约。

#### Scenario: 合盖一小时后打开
- **WHEN** 一个任务正在执行时 Mac 睡眠一小时，之后被唤醒
- **THEN** 任务保持 `running`，不会因为租约过期而变为 `blocked`；账本中有一条带睡眠时长的 `hub.resumed` 事件

### Requirement: 执行器插件接口
节点 SHALL 通过插件接口调用执行器：插件声明自己的类型和所需能力，接收任务合同与工作目录，返回活动事件流与最终结果，并支持被取消。本变更提供一个仅用于测试的 `fake` 执行器，按合同中的指令模拟成功、失败、卡住和长时间运行；它 MUST NOT 执行任何外部命令。

#### Scenario: fake 执行器模拟卡住
- **WHEN** 一个合同指示 fake 执行器以 `question` 卡住的任务被领取执行
- **THEN** 任务变为 `blocked`，原因为 `question`，账本中能看到 fake 执行器上报的说明
