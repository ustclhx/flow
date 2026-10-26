/**
 * 中枢事件循环"被卡住"的检测（租约过期扫描用）。
 *
 * 一个按固定间隔触发的采样定时器：两次采样之间单调时钟走过的时间比间隔多出的部分，就是这段时间里
 * 事件循环得不到调度的时长（GC、同步 I/O、机器负载）。卡住结束时，到期的过期扫描与排队中的节点续约
 * 谁先被处理是不确定的；扫描把最近一个租约周期内累计的卡住时长当作宽限，避免因中枢自己被卡住而误判
 * 节点掉线。
 *
 * 只看单调时钟：合盖睡眠时墙钟前进而单调时钟不前进，由睡眠检测（`sleep.ts`）处理，不在这里重复计算。
 */

export interface StarvationMonitorOptions {
  monotonic(): number
  /** 采样间隔（毫秒），与采样定时器一致。 */
  intervalMs: number
  /** 累计卡住时长的窗口（毫秒），取一个租约周期。 */
  windowMs: number
  /** 单次多出不足这么多（毫秒）视为正常的定时器抖动，不计入；缺省为间隔的四分之一。 */
  thresholdMs?: number
}

export interface StarvationMonitor {
  /** 采样定时器每次触发时调用。 */
  tick(): void
  /** 采样重新开始（定时器启动时）：之前的空档不算卡住。 */
  reset(): void
  /** 最近一个窗口内累计的卡住时长，含正在进行中的（采样定时器已经逾期）。 */
  starvedMs(): number
}

export function createStarvationMonitor(o: StarvationMonitorOptions): StarvationMonitor {
  const threshold = o.thresholdMs ?? o.intervalMs / 4
  let last = o.monotonic()
  let stalls: { at: number; ms: number }[] = []
  const prune = (now: number) => {
    stalls = stalls.filter((s) => s.at > now - o.windowMs)
  }
  const overdue = (now: number) => {
    const extra = now - last - o.intervalMs
    return extra > threshold ? extra : 0
  }
  return {
    tick() {
      const now = o.monotonic()
      const extra = overdue(now)
      if (extra > 0) stalls.push({ at: now, ms: extra })
      last = now
      prune(now)
    },
    reset() {
      last = o.monotonic()
      stalls = []
    },
    starvedMs() {
      const now = o.monotonic()
      prune(now)
      return stalls.reduce((sum, s) => sum + s.ms, 0) + overdue(now)
    },
  }
}
