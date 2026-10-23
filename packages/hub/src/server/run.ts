import { flowPaths, type Result, VERSION } from '@flow/core'
import { createTaskRoutes } from '../ledger/routes.ts'
import { type LedgerStore, openLedger } from '../ledger/store.ts'
import { createTaskService, workspaceCheckFromHome } from '../ledger/tasks.ts'
import { currentRuntime } from '../serve.ts'
import { type RunningHub, type StartHubOptions, startHub } from './start.ts'

export type RunHubOptions = Omit<StartHubOptions, 'ledger' | 'openLedger' | 'routes'>

/**
 * 生产用的中枢组合：取得锁后打开 `state/flow.db`，挂载任务路由，
 * 把每日备份写成 `hub.backup_done`，启动成功后写入 `hub.started`。
 */
export async function runHub(options: RunHubOptions): Promise<Result<RunningHub>> {
  let ledger: LedgerStore | undefined
  const started = await startHub({
    ...options,
    openLedger: async () => {
      ledger = await openLedger(flowPaths(options.home).ledgerDb)
      return ledger
    },
    routes: () => {
      if (!ledger) return []
      const tasks = createTaskService({
        ledger,
        workspaceExists: workspaceCheckFromHome(options.home),
      })
      return [{ path: '/', app: createTaskRoutes({ ledger, tasks }) }]
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
  return started
}
