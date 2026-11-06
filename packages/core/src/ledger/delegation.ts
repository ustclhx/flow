import type { LedgerEvent } from './events.ts'
import type { TaskStatus } from './task.ts'

/**
 * 代回复委托是否仍有效（add-m1-supervisor D15）——调度、`task_respond` 与 store 统一用它判断。
 *
 * 委托只在任务处于 `blocked`、且当前这次卡住（最近一次 `task.blocked`）的 seq 等于委托的
 * `block_seq` 时有效。任务离开这次卡住时委托**隐式失效，不写事件**：离开包括
 * `task.unblocked`、`task.requeued`、`task.requeued_with_reply`、`task.lease_expired`，
 * 以及进入新的卡住（blocked → blocked，新卡住重新判定是否委托）。
 * 委托被 `task.reply_escalated` 结束，或本次卡住的 supervisor 回复被拒收后同样无效。
 */
export interface ActiveDelegation {
  /** `task.reply_delegated` 的 seq。 */
  seq: number
  block_seq: number
  kind: 'question' | 'awaiting_approval'
  decision_id?: number
  deadline: string
  /** 委托时该项处于 observe 模式（D10）：判断只记录，不送达。 */
  observe?: true
}

/**
 * 结束当前这次卡住上委托的事件（委托随之隐式失效）：离开这次卡住，以及请求取消
 * （`task.cancel_requested`：用户要停掉任务，supervisor 不应再替它批准或回答，D15）。
 */
export const DELEGATION_ENDING_EVENTS: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.blocked',
  'task.unblocked',
  'task.requeued',
  'task.requeued_with_reply',
  'task.lease_expired',
  'task.cancel_requested',
])

/**
 * 任务绑定（worker 的派工令牌）读取本任务事件时隐藏的事件类型（D10 observe 的纵深防御）：
 * - `task.reply_observed`、`supervisor.observed_action`：observe 判断与未执行的动作，绝不能送达 worker；
 * - `inbox.*`：收件箱条目是给用户看的文字，其中可能附有"supervisor 会：……"与 supervisor 的转交说明。
 * observe 判断本身不带 task_id（workspace 级事件），这里再按类型兜底一次。
 */
export function hiddenFromWorker(type: string): boolean {
  return (
    type === 'task.reply_observed' ||
    type === 'supervisor.observed_action' ||
    type.startsWith('inbox.')
  )
}

/** 卡住上报的待批请求与策略判定所针对的请求中，参与一致性核对的字段。 */
export interface DelegationRequest {
  tool: string
  command?: string | undefined
  paths?: readonly string[] | undefined
}

/** 请求文本（命令、路径）的上限：与 `BLOCKED_REQUEST_TEXT_MAX`、`policy.decided.request.command` 一致。 */
const REQUEST_TEXT_MAX = 2000

/**
 * 文本是否可能被改写过（不确定）：达到上限（可能被截断）、以截断符结尾，或含脱敏标记
 * （`[REDACTED:<规则>]`、已知密钥的 `[secret:<路径>]`）。两侧被同样截断或脱敏时逐字比较仍会"一致"，
 * 但被比较的已不是原始请求，所以一律判为不一致。
 */
export function requestTextUncertain(text: string): boolean {
  return (
    text.length >= REQUEST_TEXT_MAX ||
    text.endsWith('…') ||
    text.includes('[REDACTED:') ||
    text.includes('[secret:')
  )
}

/**
 * D15 "判定与卡住绑定"中的请求一致：`task.blocked.request` 与 `decision_id` 对应的
 * `policy.decided.request` 逐字相同（两侧经同样的脱敏，G9）。任何不确定都判为不一致：
 * - 任一侧缺失、或任一侧没有 `command`（没有命令的请求一律不委托）；
 * - 工具不同、命令不逐字相等；
 * - 路径：两侧都没有才算一致；有路径时必须两侧都有、顺序与内容完全相同；
 * - 任一侧的命令或路径可能被截断或脱敏过（`requestTextUncertain`）。
 */
export function delegationRequestMatches(
  blocked: DelegationRequest | undefined,
  decided: DelegationRequest | undefined,
): boolean {
  if (!blocked || !decided) return false
  if (blocked.command === undefined || decided.command === undefined) return false
  for (const text of [
    blocked.command,
    decided.command,
    ...(blocked.paths ?? []),
    ...(decided.paths ?? []),
  ]) {
    if (requestTextUncertain(text)) return false
  }
  if (blocked.tool !== decided.tool || blocked.command !== decided.command) return false
  const a = blocked.paths
  const b = decided.paths
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((p, i) => p === b[i])
}

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
  const supervisorReplies = new Set<string>()
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
        ...(e.payload.observe === true ? { observe: true as const } : {}),
      }
    }
    if (e.type === 'task.reply_escalated' && e.payload.block_seq === blockSeq) return null
    if (e.type === 'task.replied' && e.actor === 'supervisor') {
      supervisorReplies.add(e.payload.reply_id)
    }
    if (e.type === 'task.reply_dropped' && supervisorReplies.has(e.payload.reply_id)) return null
  }
  return found
}
