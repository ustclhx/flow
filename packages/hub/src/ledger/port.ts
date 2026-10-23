import type { LedgerEvent } from '@flow/core'

/**
 * 账本对中枢其余部分（HTTP 层、SSE、备份、反应器）暴露的接口。
 * 实现见 `ledger/` 下的 store（tasks.md 第 2 组）；使用方（第 3 组及以后）只依赖这里。
 */

export interface EventFilter {
  task_id?: string
  workspace?: string
}

export interface LedgerReader {
  /** 当前最大事件序号；空账本为 0。 */
  seq(): number
  /** 按序返回 seq > after 的事件，最多 limit 条（默认 500）。 */
  eventsAfter(after: number, filter?: EventFilter, limit?: number): LedgerEvent[]
  /** 订阅新事件：写入事务提交后按序回调。返回取消订阅的函数。 */
  subscribe(listener: (event: LedgerEvent) => void): () => void
}

export interface LedgerMaintenance {
  /** 在线一致性备份到目标路径（`VACUUM INTO`），供每日备份使用。 */
  backupTo(path: string): void
  close(): void
}
