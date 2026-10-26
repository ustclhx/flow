import type { Hono } from 'hono'
import type { LedgerStore } from '../ledger/store.ts'
import { type HubClock, systemClock } from '../server/clock.ts'
import { createNodeRoutes } from './routes.ts'
import {
  createNodeService,
  type NodeProtocolConfig,
  type NodeService,
  type NodeServiceOptions,
} from './service.ts'
import { createSleepDetector, type SleepDetector } from './sleep.ts'

/**
 * 节点协议在中枢中的组合：服务 + 路由 + 定时器（每 5 秒过期扫描、每 1 秒睡眠检测）。
 * 扫描前总是先做一次睡眠检测：唤醒后两个定时器谁先触发不确定，先检测才能保证
 * 睡眠期间"看起来过期"的租约被顺延而不是被判掉线。
 */

export const EXPIRY_SWEEP_MS = 5_000
export const SLEEP_CHECK_MS = 1_000

export interface NodeProtocolOptions
  extends NodeProtocolConfig,
    Pick<NodeServiceOptions, 'issueWakeToken' | 'logger'> {
  ledger: LedgerStore
  clock?: HubClock
  onResume?: () => void
}

export interface NodeProtocol {
  service: NodeService
  routes: Hono
  sleep: SleepDetector | null
  /** 扫描一次（先睡眠检测再处理过期），返回处理的过期租约数。 */
  sweep(): number
  /** 启动定时器。 */
  start(): void
  /** 停止定时器、结束 long-poll 等待；可重复调用。 */
  stop(): void
}

export function createNodeProtocol(o: NodeProtocolOptions): NodeProtocol {
  const clock = o.clock ?? systemClock
  const service = createNodeService({ ...o, clock })
  const routes = createNodeRoutes({ service })
  const monotonic = clock.monotonic?.bind(clock)
  const sleep = monotonic
    ? createSleepDetector({
        ledger: o.ledger,
        clock: { now: () => clock.now(), monotonic, setTimeout: clock.setTimeout.bind(clock) },
        ttlMs: o.leaseTtlS * 1000,
        ...(o.onResume ? { onResume: o.onResume } : {}),
      })
    : null
  const cancels: Array<() => void> = []
  let running = false

  const guard = (what: string, fn: () => unknown) => {
    try {
      fn()
    } catch (err) {
      o.logger?.warn(`${what}失败`, String(err))
    }
  }

  const sweep = () => {
    sleep?.check()
    return service.expireDue()
  }

  const every = (ms: number, what: string, fn: () => unknown) => {
    const slot = cancels.length
    const arm = () => {
      cancels[slot] = clock.setTimeout(() => {
        if (!running) return
        guard(what, fn)
        if (running) arm()
      }, ms)
    }
    arm()
  }

  return {
    service,
    routes,
    sleep,
    sweep,
    start() {
      if (running) return
      running = true
      every(EXPIRY_SWEEP_MS, '租约过期扫描', sweep)
      if (sleep) every(SLEEP_CHECK_MS, '睡眠检测', () => sleep.check())
    },
    stop() {
      running = false
      for (const cancel of cancels) cancel()
      cancels.length = 0
      service.close()
    },
  }
}
