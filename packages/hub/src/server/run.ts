import { flowPaths, type HubConfig, loadHubConfig, type Result, VERSION } from '@flow/core'
import { createTaskRoutes } from '../ledger/routes.ts'
import { type LedgerStore, openLedger } from '../ledger/store.ts'
import { createTaskService, workspaceCheckFromHome } from '../ledger/tasks.ts'
import { createNodeProtocol, type NodeProtocol } from '../nodes/protocol.ts'
import { currentRuntime } from '../serve.ts'
import { systemClock } from './clock.ts'
import { type RunningHub, type StartHubOptions, startHub } from './start.ts'

export type RunHubOptions = Omit<StartHubOptions, 'ledger' | 'openLedger' | 'routes' | 'onStop'>

/**
 * 生产用的中枢组合：取得锁后打开 `state/flow.db`，挂载任务路由与节点协议路由，
 * 启动租约过期扫描与睡眠检测，把每日备份写成 `hub.backup_done`，启动成功后写入 `hub.started`。
 * 注入的 clock 同时用于账本的事件时间戳，保证租约到期时间与扫描用同一个时钟。
 */
export async function runHub(options: RunHubOptions): Promise<Result<RunningHub>> {
  const clock = options.clock ?? systemClock
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
        ...(options.logger ? { logger: options.logger } : {}),
      })
      return [
        { path: '/', app: createTaskRoutes({ ledger, tasks }) },
        { path: '/', app: protocol.routes },
      ]
    },
    onStop: () => protocol?.stop(),
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
  ledger.append(
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
  protocol?.start()
  return started
}
