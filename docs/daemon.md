# 守护进程（launchd）

中枢（`dev.flow.hub`）和节点（`dev.flow.node`）以 macOS LaunchAgent 常驻：登录后自动启动，崩溃后由 launchd 拉起（`KeepAlive`，`ThrottleInterval` 5 秒）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `flow daemon install` | 写入 `~/Library/LaunchAgents/dev.flow.{hub,node}.plist`，用 launchctl 加载，等待中枢健康检查通过 |
| `flow daemon status` | 两个服务的加载状态与 PID、plist 中 bun 与入口路径是否仍有效、中枢健康、最近一次账本备份 |
| `flow daemon uninstall` | 卸载并删除两个 plist；账本与 `state/` 不受影响 |

日志：`$FLOW_HOME/state/logs/{hub,node}.log`，按大小轮转。

plist 里写的是安装时 bun 与 `packages/cli/src/main.ts` 的绝对路径。仓库移动或 bun 重装后，`flow daemon status` 和 `flow doctor` 会报路径失效，重新运行 `flow daemon install` 即可。

## 节点配置（`config/node.yaml`）

字段：`capabilities`、`concurrency`（默认 1）、`hub_url`，以及 ④ 新增的 `reserved`：

```yaml
reserved:
  supervisor: 1   # 只给普通 supervisor 唤醒的预留槽，默认 1
  reply: 1        # 只给代回复（reply）唤醒的预留槽，默认 1
```

**升级注意**：`node.yaml` 是严格校验的，未知字段会让读取失败。写入 `reserved` 之后，**旧版本的节点二进制会因为不认识该字段而读取失败、无法启动**。先升级节点（与中枢）再写 `reserved`；回滚到旧版本前先删掉这一节。不写时取默认值，新旧版本都能读。

同理，旧节点会 strict 解析策略检查响应中的 `matched_rules[].rule`：升级节点之后，才能在 `policies.yaml` 中写带新条件（`when.push_to`、`when.gh_scope`）的规则，见 `packages/core/src/policy/README.md`。

## 本机验收记录（2026-10-24，add-m1-ledger-daemon 7.2）

环境：macOS 15.1（Darwin 24.1.0），bun 位于 `~/.bun/bin/bun`，`FLOW_HOME=~/flow-home`。

1. `flow daemon install`：返回 `ok`，中枢健康检查通过（`ledger_seq: 2`），安装前自动做了一次账本备份。
2. 安装后约 4 秒运行 `flow daemon status`：中枢已加载，节点显示"未加载"，退出码 1。节点日志显示它比中枢先启动，此时 `state/hub.token` 还不存在，于是以可重试错误 `hub_token_missing` 退出；5 秒后 launchd 重新拉起，节点注册成功。之后 `status` 正常。
3. `kill -9 <中枢 PID>`：1 秒内 launchd 拉起新进程（PID 78285 → 78730），`/v1/health` 恢复，`flow daemon status` 退出码 0，账本序号连续。
4. 节点在中枢重启期间记录一次 `领取任务失败，稍后重试 hub_unavailable`，随后自动恢复，`flow node list` 的最近活动时间继续更新。
5. `kill -9 <节点 PID>`：launchd 拉起新节点（PID 78408 → 79041），`flow daemon status` 退出码 0。

结论：两个服务都能在被强杀后自动恢复，账本完整。

## 已知小问题

- 安装后的头几秒，节点可能因为中枢尚未写出 token 而退出一次，要等 launchd 重试才恢复，所以这段时间内 `flow daemon status` 可能短暂报 `daemon_unhealthy`。可以改成节点在启动时等待 token 出现。
