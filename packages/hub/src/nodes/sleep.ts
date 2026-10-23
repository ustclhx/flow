import type { LedgerStore } from '../ledger/store.ts'
import type { HubClock } from '../server/clock.ts'

/**
 * 睡眠检测（tasks.md 4.2；design D5；node-protocol "睡眠不误判掉线"）。
 *
 * 每次 `check()` 对比两次检查之间墙钟与单调时钟各自前进的时间：墙钟多走超过阈值（默认 30 秒）
 * 就判定本机刚从睡眠中恢复，把全部活动租约顺延"睡眠时长 + 一个 TTL"，并写 `hub.resumed`。
 *
 * 顺延量取"睡眠时长 + TTL"而不是只顺延一个 TTL：store 的 `extendActiveLeases` 是在原到期时间上
 * 累加，睡眠一小时后只加 60 秒仍然早已过期；加上睡眠时长等于"把睡眠期间从租约计时中扣掉，
 * 再多给一个周期"，节点唤醒后有完整的 TTL 来续约。
 */

export interface SleepDetectorOptions {
  ledger: Pick<LedgerStore, 'extendActiveLeases' | 'append'>
  clock: HubClock & { monotonic(): number }
  /** 租约有效期毫秒。 */
  ttlMs: number
  /** 判定为睡眠的阈值，默认 30 秒。 */
  thresholdMs?: number
  /** 记录恢复事件后通知其他中枢服务。 */
  onResume?: () => void
}

export interface SleepDetector {
  /** 检查一次；检测到睡眠时返回睡眠毫秒数，否则返回 0。 */
  check(): number
}

export const SLEEP_THRESHOLD_MS = 30_000

export function createSleepDetector(o: SleepDetectorOptions): SleepDetector {
  const threshold = o.thresholdMs ?? SLEEP_THRESHOLD_MS
  let lastWall = o.clock.now()
  let lastMono = o.clock.monotonic()
  return {
    check() {
      const wall = o.clock.now()
      const mono = o.clock.monotonic()
      const slept = Math.round(wall - lastWall - (mono - lastMono))
      lastWall = wall
      lastMono = mono
      if (slept <= threshold) return 0
      const extended = o.ledger.extendActiveLeases(slept + o.ttlMs)
      o.ledger.append(
        { type: 'hub.resumed', payload: { slept_ms: slept, extended_leases: extended } },
        { actor: 'hub' },
      )
      o.onResume?.()
      return slept
    },
  }
}
