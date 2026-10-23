/**
 * 节点用的时钟（与中枢的 HubClock 同形，节点包不依赖 @flow/hub）。
 * 测试注入可控时钟；fake 执行器的延时也走它。
 */
export interface NodeClock {
  /** 墙钟毫秒。 */
  now(): number
  /** 单调时钟毫秒；睡眠期间不前进。缺省时不做时钟跳变检测。 */
  monotonic?(): number
  /** 返回取消函数。 */
  setTimeout(callback: () => void, delayMs: number): () => void
}

export const systemClock: NodeClock = {
  now: Date.now,
  monotonic: () => performance.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** 按时钟等待 ms 毫秒；signal 中止时提前返回。 */
export function sleep(clock: NodeClock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      cancel()
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const cancel = clock.setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
