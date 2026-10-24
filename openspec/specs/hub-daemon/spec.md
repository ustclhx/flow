# hub-daemon Specification

## Purpose
规定中枢守护进程 `flowd` 的接口、认证、事件流、托管方式与自我保护，使任务账本有唯一、常驻、可被外部监控的持有者。

## Requirements

### Requirement: 唯一持有者
同一个 flow-home 在同一时刻 SHALL 只有一个中枢进程持有账本。第二个中枢启动时 MUST 失败退出，并指出已有进程的 pid。

#### Scenario: 重复启动
- **WHEN** 中枢已在运行时再执行 `flow hub start`
- **THEN** 新进程以非零状态退出，输出已有中枢的 pid，账本不受影响

### Requirement: 本机 HTTP API
中枢 SHALL 只监听本机回环地址（默认 `127.0.0.1:7477`，可配置），提供版本化的 HTTP API（`/v1/...`）。请求与响应体都 MUST 由 JSON Schema 描述，错误响应采用与 CLI `--json` 一致的格式。

#### Scenario: 健康检查
- **WHEN** 请求 `GET /v1/health`
- **THEN** 返回 200 与 `{ ok: true, data: { version, uptime, ledger_seq } }`，此接口无需认证

### Requirement: Token 认证
除健康检查外，所有 API 都 MUST 携带 `Authorization: Bearer <token>`。token 在首次启动时生成，保存在 `state/hub.token`，文件权限为 0600。认证失败返回 401，且不泄露任何账本内容。

#### Scenario: 缺少 token
- **WHEN** 不带 token 请求 `GET /v1/tasks`
- **THEN** 返回 401，错误码为 `unauthorized`

### Requirement: 事件流
中枢 SHALL 通过 SSE 提供事件流（`GET /v1/events?after=<seq>`）。客户端断线重连时带上最后收到的序号，MUST 能从断点继续，不丢失、不重复。

#### Scenario: 断线重连
- **WHEN** 客户端收到序号 10 后断开，在此期间产生了序号 11、12 两条事件，然后客户端以 `after=10` 重连
- **THEN** 客户端依次收到 11 与 12，之后继续接收新事件

### Requirement: launchd 托管
`flow daemon install` SHALL 在 `~/Library/LaunchAgents/` 安装中枢与本机节点两个 launchd 任务，二者都设置为开机启动、崩溃后自动重启，日志写入 `state/logs/`。`flow daemon uninstall` MUST 停止并移除这两个任务，不触碰账本。`flow daemon status` 报告两个进程是否在运行、中枢健康状况，以及最近一次备份的时间。

#### Scenario: 崩溃后自动恢复
- **WHEN** 中枢进程被 `kill -9`
- **THEN** launchd 在数秒内重新拉起中枢，重启后账本完整，正在运行的租约按原定期限继续有效

### Requirement: 外部心跳
配置了 `hub.heartbeat_url` 时，中枢 SHALL 按固定间隔（默认 5 分钟）请求该 URL。请求失败只记录日志，MUST NOT 影响中枢的其他功能。

#### Scenario: 心跳地址不可达
- **WHEN** 心跳地址连续请求失败
- **THEN** 中枢记录警告日志，任务调度和 API 照常工作

### Requirement: 账本备份
中枢 SHALL 每天对 `state/flow.db` 做一次在线一致性备份，保存到 `state/backups/`，保留最近 14 份（可配置）。备份过程中 MUST NOT 阻塞 API 写入超过 1 秒。

#### Scenario: 备份可恢复
- **WHEN** 把一份备份复制回 `state/flow.db` 后启动中枢
- **THEN** 中枢正常启动，任务状态与备份时刻一致
