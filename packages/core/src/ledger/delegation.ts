import type { LedgerEvent } from './events.ts'
import type { TaskStatus } from './task.ts'

/**
 * 代回复委托是否仍有效（add-m1-supervisor D15）——调度、`task_respond` 与 store 统一用它判断。
 *
 * 委托只在任务处于 `blocked`、且当前这次卡住（最近一次 `task.blocked`）的 seq 等于委托的
 * `block_seq` 时有效。任务离开这次卡住时委托**隐式失效，不写事件**：离开包括
 * `task.unblocked`、`task.requeued`、`task.requeued_with_reply`、`task.lease_expired`，
 * 以及进入新的卡住（blocked → blocked，新卡住重新判定是否委托）。
 * 委托被 `task.reply_escalated` 结束后同样无效。
 */
export interface ActiveDelegation {
  /** `task.reply_delegated` 的 seq。 */
  seq: number
  block_seq: number
  kind: 'question' | 'awaiting_approval'
  decision_id?: number
  deadline: string
}

/** 离开当前这次卡住的事件（委托随之隐式失效）。 */
export const DELEGATION_ENDING_EVENTS: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.blocked',
  'task.unblocked',
  'task.requeued',
  'task.requeued_with_reply',
  'task.lease_expired',
])

/**
 * 纯函数：`events` 为该任务的全部事件（按 seq 升序）。返回当前有效的委托，没有时为 null。
 */
export function activeDelegation(
  task: { status: TaskStatus },
  events: readonly LedgerEvent[],
): ActiveDelegation | null {
  if (task.status !== 'blocked') return null
  let blockSeq: number | null = null
  for (const e of events) if (e.type === 'task.blocked') blockSeq = e.seq
  if (blockSeq === null) return null
  let found: ActiveDelegation | null = null
  for (const e of events) {
    if (e.seq <= blockSeq) continue
    if (DELEGATION_ENDING_EVENTS.has(e.type)) return null
    if (e.type === 'task.reply_delegated' && e.payload.block_seq === blockSeq) {
      found = {
        seq: e.seq,
        block_seq: blockSeq,
        kind: e.payload.kind,
        ...(e.payload.decision_id === undefined ? {} : { decision_id: e.payload.decision_id }),
        deadline: e.payload.deadline,
      }
    }
    if (e.type === 'task.reply_escalated' && e.payload.block_seq === blockSeq) return null
  }
  return found
}
