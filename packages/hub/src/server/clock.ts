/** 定时器返回取消函数，避免业务模块依赖 Bun / Node 的 timer handle。 */
export interface HubClock {
  /** 墙钟毫秒（事件时间戳、租约到期时间）。 */
  now(): number
  /**
   * 单调时钟毫秒（睡眠检测，design D5）。系统睡眠期间不前进（macOS 的 mach_absolute_time、
   * Linux 的 CLOCK_MONOTONIC）。缺省时不做睡眠检测。
   */
  monotonic?(): number
  setTimeout(callback: () => void | Promise<void>, delayMs: number): () => void
}

export const systemClock: HubClock = {
  now: Date.now,
  monotonic: () => performance.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}
