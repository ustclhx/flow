/** 定时器返回取消函数，避免业务模块依赖 Bun / Node 的 timer handle。 */
export interface HubClock {
  now(): number
  setTimeout(callback: () => void | Promise<void>, delayMs: number): () => void
}

export const systemClock: HubClock = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}
