import { fail, loadHubConfig, ok, type Result } from '@flow/core'
import { createHubApp, type HubDeps } from '../app.ts'
import type { LedgerMaintenance, LedgerReader } from '../ledger/port.ts'
import { type RunningServer, type Runtime, serve } from '../serve.ts'
import { systemClock } from './clock.ts'
import { acquireHubLock } from './lock.ts'
import { type MaintenanceOptions, startMaintenance } from './maintenance.ts'
import { ensureHubToken } from './token.ts'
import { type HubTokenStore, openTokenStore } from './tokens.ts'

type HubLedger = LedgerReader & LedgerMaintenance

export interface StartHubOptions
  extends Pick<HubDeps, 'version' | 'mount' | 'clock' | 'leaseHolders' | 'wakeTokens'>,
    Pick<MaintenanceOptions, 'fetch' | 'logger' | 'onBackupDone'> {
  home: string
  /** 已打开的账本由调用者确保单实例；优先使用 openLedger，在取得锁后才打开数据库。 */
  ledger?: HubLedger
  openLedger?: () => HubLedger | Promise<HubLedger>
  /** 账本打开后再构造的子应用（例如任务路由），与 mount 一起挂载在认证之后。 */
  routes?: (ledger: HubLedger) => NonNullable<HubDeps['mount']>
  /** 测试可用 0 申请随机端口；默认读取 hub.yaml。 */
  port?: number
  runtime?: Runtime
  /** 停止时最先调用（关闭 HTTP 与账本之前），用于停止调用方自己的定时器。 */
  onStop?: () => void | Promise<void>
}

export interface RunningHub {
  url: string
  port: number
  /** 取消定时任务和订阅，关闭 HTTP 与账本，最后释放单实例锁；可重复调用。 */
  stop(): Promise<void>
}

/** 锁 → token / 配置 → 打开账本 → 路由 → 监听 → 定时维护。 */
export async function startHub(options: StartHubOptions): Promise<Result<RunningHub>> {
  const acquired = await acquireHubLock(options.home)
  if (!acquired.ok) return acquired
  const lock = acquired.data
  let ledger: HubLedger | undefined
  let server: RunningServer | undefined
  let maintenance: ReturnType<typeof startMaintenance> | undefined
  let tokens: HubTokenStore | undefined
  const shutdown = new AbortController()
  let stopping: Promise<void> | undefined
  const onSignal = () => {
    void stop().catch((err) => (options.logger ?? console).warn('停止中枢失败', err))
  }
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      shutdown.abort()
      try {
        await options.onStop?.()
      } catch (err) {
        ;(options.logger ?? console).warn('停止回调失败', String(err))
      }
      // 即使服务关闭失败，也必须尝试关闭账本并释放锁。
      try {
        await maintenance?.stop()
      } finally {
        try {
          await server?.close()
        } finally {
          try {
            ledger?.close()
          } finally {
            try {
              await tokens?.close()
            } finally {
              await lock.release()
            }
          }
        }
      }
    })()
    return stopping
  }
  try {
    const token = await ensureHubToken(options.home)
    if (!token.ok) {
      await stop()
      return token
    }
    const opened = await openTokenStore(options.home)
    if (!opened.ok) {
      await stop()
      return opened
    }
    tokens = opened.data
    const config = await loadHubConfig(options.home)
    if (!config.ok) {
      await stop()
      return config
    }
    if (options.ledger && options.openLedger) throw new Error('ledger 与 openLedger 不能同时提供')
    ledger = options.openLedger ? await options.openLedger() : options.ledger
    const clock = options.clock ?? systemClock
    const app = createHubApp({
      token: token.data,
      tokens,
      clock,
      ...(options.leaseHolders ? { leaseHolders: options.leaseHolders } : {}),
      ...(options.wakeTokens ? { wakeTokens: options.wakeTokens } : {}),
      signal: shutdown.signal,
      ...(ledger ? { ledger } : {}),
      ...(options.version ? { version: options.version } : {}),
      mount: [
        ...(options.mount ?? []),
        ...(ledger && options.routes ? options.routes(ledger) : []),
      ],
    })
    server = await serve(app.fetch, {
      port: options.port ?? config.data.port,
      ...(options.runtime ? { runtime: options.runtime } : {}),
    })
    maintenance = startMaintenance({
      ...options,
      config: config.data,
      clock,
      ...(ledger ? { ledger } : {}),
    })
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    return ok({ url: server.url, port: server.port, stop })
  } catch (err) {
    await stop()
    return fail('failure', 'hub_start_failed', `无法启动中枢：${(err as Error).message}`)
  }
}
