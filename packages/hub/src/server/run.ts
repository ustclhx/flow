import {
  flowPaths,
  type HubConfig,
  type HubStatusData,
  loadHubConfig,
  type Result,
  VERSION,
} from '@flow/core'
import { Hono } from 'hono'
import { createTaskRoutes } from '../ledger/routes.ts'
import { type LedgerStore, openLedger } from '../ledger/store.ts'
import { createTaskService, workspaceCheckFromHome } from '../ledger/tasks.ts'
import { createNodeProtocol, type NodeProtocol } from '../nodes/protocol.ts'
import { createScheduler, type Scheduler } from '../scheduler/index.ts'
import { currentRuntime } from '../serve.ts'
import { systemClock } from './clock.ts'
import { type RunningHub, type StartHubOptions, startHub } from './start.ts'

export type RunHubOptions = Omit<StartHubOptions, 'ledger' | 'openLedger' | 'routes' | 'onStop'>

/**
 * 生产用的中枢组合：取得锁后打开 `state/flow.db`，挂载任务路由与节点协议路由，
 * 启动租约过期扫描、睡眠检测与定时调度，把每日备份写成 `hub.backup_done`，启动成功后写入 `hub.started`。
 * 注入的 clock 同时用于账本的事件时间戳，保证租约到期时间与扫描用同一个时钟。
 */
export async function runHub(options: RunHubOptions): Promise<Result<RunningHub>> {
  const clock = options.clock ?? systemClock
  const startedAt = clock.now()
  let scheduler: Scheduler | undefined
  let ledger: LedgerStore | undefined
  let config: HubConfig | undefined
  let protocol: NodeProtocol | undefined
  const started = await startHub({
    ...options,
    openLedger: async () => {
      // startHub 在打开账本之前已校验过 hub.yaml，这里再读一次取租约参数。
      const loaded = await loadHubConfig(options.home)
      if (!loaded.ok) throw new Error(loaded.error.message)
      config = loaded.data
      ledger = await openLedger(flowPaths(options.home).ledgerDb, { now: () => clock.now() })
      // 中枢停机期间节点无法续约：重启后给每个活动租约至少一个 TTL 的宽限，
      // 让仍在运行的节点有机会续上，而不是在第一次扫描时被误判为 node_lost（hub-daemon "崩溃后自动恢复"）。
      const graceUntil = new Date(clock.now() + config.lease_ttl_s * 1000).toISOString()
      for (const lease of ledger.activeLeases()) {
        if (lease.expires_at < graceUntil) ledger.renewLease(lease.lease_id, graceUntil)
      }
      return ledger
    },
    routes: () => {
      if (!ledger || !config) return []
      const tasks = createTaskService({
        ledger,
        workspaceExists: workspaceCheckFromHome(options.home),
        now: () => clock.now(),
      })
      protocol = createNodeProtocol({
        ledger,
        clock,
        leaseTtlS: config.lease_ttl_s,
        leaseWaitMaxS: config.lease_wait_max_s,
        onResume: () => scheduler?.resume(),
        ...(options.logger ? { logger: options.logger } : {}),
      })
      const status = new Hono()
      status.get('/v1/hub/status', (c) => {
        const backup = ledger?.latestEvent(undefined, 'hub.backup_done')
        const scheduleErrors = scheduler?.errors() ?? []
        const data: HubStatusData = {
          version: options.version ?? VERSION,
          pid: process.pid,
          started_at: new Date(startedAt).toISOString(),
          runtime: options.runtime ?? currentRuntime(),
          uptime: Math.max(0, (clock.now() - startedAt) / 1000),
          ledger_seq: ledger?.seq() ?? 0,
          schedules: { loaded: scheduler?.loaded() ?? 0, errors: scheduleErrors },
          schedule_errors: scheduleErrors,
          last_backup:
            backup?.type === 'hub.backup_done'
              ? { path: backup.payload.path, at: backup.ts }
              : null,
        }
        return c.json({ ok: true as const, data })
      })
      return [
        { path: '/', app: status },
        { path: '/', app: createTaskRoutes({ ledger, tasks }) },
        { path: '/', app: protocol.routes },
      ]
    },
    onStop: () => {
      scheduler?.stop()
      protocol?.stop()
    },
    onBackupDone: (info) => {
      options.onBackupDone?.(info)
      ledger?.append(
        {
          type: 'hub.backup_done',
          payload: {
            path: info.path,
            size_bytes: info.size_bytes,
            duration_ms: info.duration_ms,
            removed: info.removed,
          },
        },
        { actor: 'hub' },
      )
    },
  })
  if (!started.ok || !ledger) return started
  const marker = ledger.append(
    {
      type: 'hub.started',
      payload: {
        version: options.version ?? VERSION,
        pid: process.pid,
        runtime: options.runtime ?? currentRuntime(),
        port: started.data.port,
      },
    },
    { actor: 'hub' },
  )
  if (!marker.ok) {
    await started.data.stop()
    return marker
  }
  scheduler = await createScheduler({
    ledger,
    clock,
    home: options.home,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  protocol?.start()
  return started
}
