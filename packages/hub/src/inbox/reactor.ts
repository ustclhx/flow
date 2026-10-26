import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type BlockedReason,
  clipText,
  type EventOf,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxCloseReason,
  type InboxConfig,
  type InboxItemAction,
  type InboxVia,
  type LedgerEvent,
  type ReplyEscalationReason,
  resolveInboxLevel,
  type TaskStatus,
  type TaskView,
} from '@flow/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import { acceptedReplyKinds } from '../ledger/tasks.ts'
import type { HubLogger } from '../server/maintenance.ts'

/**
 * 收件箱反应器（add-m1-inbox design D1；inbox spec "条目来源""默认分级""自动关闭"）。
 *
 * 订阅账本事件，把底层事件转换成收件箱事件：
 * - `task.blocked` → 开条目（按卡住原因与 `config/inbox.yaml` 分级）；
 * - `task.unblocked`、`task.requeued*`、终态 → 关闭该任务未关闭的条目；
 * - `policy.decided` 的 auto-report → Digest 条目（不随任务状态关闭，由每日摘要 3.3 处理）。
 *
 * **幂等**：条目 id 由源事件确定（`blk.<seq>`、`pol.<seq>`），账本拒绝重复创建（`duplicate_item`）
 * 与重复关闭（`item_closed`）。关闭只作用于"源事件 seq 小于关闭事件 seq"的条目，所以重放旧事件
 * 不会关掉之后新开的条目。开条目前还要求该事件仍是任务最近一次卡住且任务仍处于 blocked：
 * 卡住后立刻恢复（同一批写入）不会打扰用户，首次在旧账本上运行也不会为历史卡住补开条目。
 *
 * **重建不重复**：反应器写的是普通事件，投影重建只重放事件，不重跑反应器。
 *
 * **续跑**：启动时从 `max(游标文件, ledger.inboxCursor())` 之后补处理，然后核对一次：任务已不再
 * 因该事件卡住的条目按当前状态关闭；仍卡住却没有对应条目的补开。写入失败后的 drain 也会核对。
 * 游标文件只是加速，丢失时退回账本推导。
 *
 * **异步**：订阅回调只入队，处理放到微任务中：在账本通知订阅者的循环里同步追加事件，
 * 会让 SSE 等其他订阅者先看到更大的 seq，再看到更小的 seq（SSE 按游标丢弃）。
 */

export interface InboxReactorOptions {
  ledger: LedgerStore
  /** 当前的分级配置（热加载时返回新值）。 */
  config?: () => Pick<InboxConfig, 'levels'>
  logger?: Pick<HubLogger, 'warn'>
  /** 续跑游标文件（`state/inbox-reactor.json`）；缺省不持久化，只靠账本推导。 */
  cursorPath?: string
  /** 写入收件箱事件的操作者，默认 `hub`。 */
  actor?: string
}

export interface InboxReactor {
  /** 订阅账本、补处理游标之后的事件，并核对未关闭的任务条目。 */
  start(): void
  stop(): void
  /** 等到队列处理完（测试与停机用）。 */
  idle(): Promise<void>
  /** 已处理到的 seq。 */
  processed(): number
  /** 直接处理一条事件（测试用；正常路径经由订阅）。 */
  handle(event: LedgerEvent): void
  /** 立即做一次兜底核对（启动时与写入失败后的 drain 会自动做）。 */
  reconcile(): void
}

const REASON_LABEL: Readonly<Record<BlockedReason, string>> = {
  awaiting_approval: '等待授权',
  question: '提问',
  no_progress: '没有进展',
  crashed: '崩溃',
  node_lost: '节点掉线',
  other: '卡住',
}

/** 正文里末尾输出最多保留的行数（渠道发送时再按配置截断，notify-channel 默认 1500 字符）。 */
const TAIL_LINES = 40

const CLOSING: Partial<Record<LedgerEvent['type'], InboxCloseReason>> = {
  'task.unblocked': 'task_running',
  'task.requeued': 'task_queued',
  'task.requeued_with_reply': 'task_queued',
  'task.done': 'task_done',
  'task.failed': 'task_failed',
  'task.cancelled': 'task_cancelled',
}

const STATUS_CLOSE: Readonly<Record<TaskStatus, InboxCloseReason>> = {
  queued: 'task_queued',
  running: 'task_running',
  verifying: 'task_running',
  blocked: 'superseded',
  done: 'task_done',
  failed: 'task_failed',
  cancelled: 'task_cancelled',
}

export const blockedItemId = (seq: number) => `blk.${seq}`
export const policyItemId = (seq: number) => `pol.${seq}`

/** 条目上的操作：与 `task_reply` 接受的回复种类一致（text → reply）。 */
export function blockedActions(reason: string, priorReason?: string): InboxItemAction[] {
  return acceptedReplyKinds(reason, priorReason).map((k) => (k === 'text' ? 'reply' : k))
}

/** 正文：卡住说明，加上从末尾往前、能放进上限的输出行。 */
function blockedBody(message: string, tail: readonly string[] | undefined): string {
  const head = clipText(message, INBOX_BODY_MAX)
  const lines = (tail ?? []).slice(-TAIL_LINES)
  if (lines.length === 0) return head
  let budget = INBOX_BODY_MAX - head.length - 2
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
    const line = lines[i] ?? ''
    if (line.length + 1 > budget) break
    kept.unshift(line)
    budget -= line.length + 1
  }
  return kept.length === 0 ? head : `${head}\n\n${kept.join('\n')}`
}

export function createInboxReactor(o: InboxReactorOptions): InboxReactor {
  const { ledger } = o
  const actor = o.actor ?? 'hub'
  const config = o.config ?? (() => ({ levels: [] }))
  const queue: LedgerEvent[] = []
  let done = 0
  let savedCursor = 0
  let scheduled: Promise<void> | null = null
  let unsubscribe: (() => void) | undefined
  let stopped = false

  /** 本轮处理中有写入失败：drain 结束时再核对一次（补开漏掉的条目、关闭过时的条目）。 */
  let needsReconcile = false

  /** 在一个事务里写入多条收件箱事件：任一条被拒绝则全部不写。 */
  const write = (...drafts: EventInput[]) => {
    if (drafts.length === 0) return true
    const r = ledger.appendMany(drafts, { actor })
    if (!r.ok && r.error.code !== 'duplicate_item' && r.error.code !== 'item_closed') {
      needsReconcile = true
      o.logger?.warn('收件箱事件写入失败', { types: drafts.map((d) => d.type), error: r.error })
    }
    return r.ok
  }

  const latestBlocked = (taskId: string): EventOf<'task.blocked'> | null => {
    const events = ledger.taskEvents(taskId)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'task.blocked') return e
    }
    return null
  }
  const latestBlockedSeq = (taskId: string): number | null => latestBlocked(taskId)?.seq ?? null

  /** 任务卡住开出的未关闭条目（策略记录等同一任务上的其他来源不随任务状态关闭）。 */
  const openTaskItems = (taskId: string) =>
    ledger.listInboxItems({ task_id: taskId, source: 'task', state: 'open', limit: 1000 })

  /** 关闭任务上源事件早于 cause 的未关闭条目的草稿。 */
  function closeTaskDrafts(
    task: { id: string; workspace: string },
    reason: InboxCloseReason,
    cause: { seq?: number; actor?: string; via?: InboxVia },
  ): EventInput[] {
    const out: EventInput[] = []
    for (const item of openTaskItems(task.id)) {
      const sourceSeq = Number(item.id.startsWith('blk.') ? item.id.slice(4) : Number.NaN)
      if (cause.seq !== undefined && Number.isFinite(sourceSeq) && sourceSeq >= cause.seq) continue
      out.push({
        type: 'inbox.item_closed',
        task_id: task.id,
        workspace: task.workspace,
        payload: {
          item_id: item.id,
          reason,
          ...(cause.seq === undefined ? {} : { cause_seq: cause.seq }),
          ...(cause.actor === undefined ? {} : { cause_actor: cause.actor }),
          ...(cause.via === undefined ? {} : { via: cause.via }),
        },
      })
    }
    return out
  }

  /**
   * 为任务最近一次卡住开条目：关闭被取代的旧条目与开新条目在同一个事务里写入。
   * 若分两次写入、中间崩溃，关闭事件的 cause_seq 会把 inboxCursor 推过这次卡住，重启后不再补开。
   */
  function openBlocked(task: TaskView, e: EventOf<'task.blocked'>) {
    // 同一任务再次卡住（例如等待授权期间节点掉线）：旧条目由新条目取代。
    const closes = closeTaskDrafts(task, 'superseded', { seq: e.seq, actor: e.actor })
    write(...closes, blockedDraft(task, e))
  }

  function onBlocked(e: EventOf<'task.blocked'>) {
    const task = ledger.getTask(e.task_id ?? '')
    if (task?.status !== 'blocked' || latestBlockedSeq(task.id) !== e.seq) return
    openBlocked(task, e)
  }

  /** 条目标题：委托给 supervisor 期间加上"supervisor 处理中"（D15）。 */
  const delegatedNow = (task: TaskView, blockSeq: number) =>
    ledger.activeDelegation(task.id)?.block_seq === blockSeq

  function blockedDraft(task: TaskView, e: EventOf<'task.blocked'>): EventInput {
    const p = e.payload
    const title = blockedTitle(task, p.reason)
    return {
      type: 'inbox.item_created',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        item_id: blockedItemId(e.seq),
        level: resolveInboxLevel(config(), {
          source: 'task',
          workspace: task.workspace,
          reason: p.reason,
        }),
        source: 'task',
        source_ref: task.id,
        reason: p.reason,
        title: delegatedNow(task, e.seq) ? delegatedTitle(title) : title,
        body: blockedBody(p.message, p.tail),
        actions: blockedActions(p.reason, p.prior_reason),
        source_seq: e.seq,
      },
    }
  }

  function onTaskLeft(e: LedgerEvent, reason: InboxCloseReason) {
    const task = ledger.getTask(e.task_id ?? '')
    if (!task) return
    // 因回复而恢复：关闭原因归到回复者（例如在终端答复的 user），渠道据此显示来源。
    const replyId =
      e.type === 'task.unblocked' || e.type === 'task.requeued_with_reply'
        ? e.payload.reply_id
        : undefined
    const by = replyId === undefined ? undefined : ledger.getReply(replyId)?.by
    const reply =
      replyId === undefined
        ? undefined
        : ledger
            .taskEvents(task.id)
            .find((event) => event.type === 'task.replied' && event.payload.reply_id === replyId)
    const via = reply?.type === 'task.replied' ? reply.payload.via : undefined
    write(
      ...closeTaskDrafts(task, reason, {
        seq: e.seq,
        actor: by ?? e.actor,
        // supervisor 代回复不是收件箱渠道：关闭记录只留 cause_actor（supervisor），不写 via。
        ...(via && via !== 'supervisor' ? { via } : {}),
      }),
    )
  }

  /**
   * `policy.decided`（策略引擎 2.2）：auto-report 档位生成 Digest 条目，正文为请求的工具与命令。
   * 其他档位：auto 不打扰用户；需要用户的档位由随后的 `task.blocked(awaiting_approval)` 开条目。
   */
  function onPolicyDecided(e: EventOf<'policy.decided'>) {
    const p = e.payload
    if (p.level !== 'auto-report') return
    // policy.decided 是任务事件，信封必带 workspace 与 task_id。
    const ws = e.workspace as string
    const actions = p.request.actions.filter((a) => !a.startsWith('tool:'))
    const shown = actions.length > 0 ? actions : p.request.actions
    write({
      type: 'inbox.item_created',
      task_id: e.task_id as string,
      workspace: ws,
      payload: {
        item_id: policyItemId(e.seq),
        level: resolveInboxLevel(config(), { source: 'policy', workspace: ws }),
        source: 'policy',
        source_ref: String(e.seq),
        title: clipText(
          `[${ws}] 策略自动放行：${shown.join('、') || p.request.tool}`,
          INBOX_TITLE_MAX,
        ),
        body: clipText(
          [`任务 ${e.task_id}`, `工具 ${p.request.tool}`, p.request.command]
            .filter((x): x is string => typeof x === 'string' && x.length > 0)
            .join('\n'),
          INBOX_BODY_MAX,
        ),
        source_seq: e.seq,
      },
    })
  }

  /**
   * 代回复委托（D15）：委托开始时条目标题标"supervisor 处理中"；委托结束（转交）时恢复标题，
   * 由 supervisor、超时或唤醒问题转交的在正文末尾注明原因（转交说明来自 supervisor，只给用户看）。
   * 按目标内容比较后再写，重放同一事件不会重复修改。
   */
  function onDelegation(e: EventOf<'task.reply_delegated'> | EventOf<'task.reply_escalated'>) {
    const task = ledger.getTask(e.task_id ?? '')
    if (!task) return
    const blockSeq = e.payload.block_seq
    const item = ledger.getInboxItem(blockedItemId(blockSeq))
    if (item?.state !== 'open') return
    const blocked = ledger.taskEvents(task.id).find((x) => x.seq === blockSeq)
    if (blocked?.type !== 'task.blocked') return
    const base = blockedTitle(task, blocked.payload.reason)
    let title = base
    let body = item.body
    if (e.type === 'task.reply_delegated') {
      title = delegatedNow(task, blockSeq) ? delegatedTitle(base) : base
    } else if (e.payload.reason !== 'user_replied' && e.payload.reason !== 'user_dismissed') {
      const line = clipText(
        `supervisor 未代为处理，已转交给你：${ESCALATION_LABEL[e.payload.reason]}${
          e.payload.note ? `（${e.payload.note}）` : ''
        }`,
        600,
      )
      const original = blockedBody(blocked.payload.message, blocked.payload.tail)
      body = clipText(`${line}\n\n${original}`, INBOX_BODY_MAX)
    }
    if (title === item.title && body === item.body) return
    write({
      type: 'inbox.item_updated',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        item_id: item.id,
        ...(title === item.title ? {} : { title }),
        ...(body === item.body ? {} : { body }),
      },
    })
  }

  /** 请求取消结束了这次卡住上的委托（不写转交事件）：去掉"supervisor 处理中"。 */
  function onCancelRequested(e: EventOf<'task.cancel_requested'>) {
    const task = ledger.getTask(e.task_id ?? '')
    if (task?.status !== 'blocked') return
    const blocked = latestBlocked(task.id)
    if (!blocked) return
    const item = ledger.getInboxItem(blockedItemId(blocked.seq))
    if (item?.state !== 'open' || !item.title.startsWith(DELEGATED_TITLE_PREFIX)) return
    write({
      type: 'inbox.item_updated',
      task_id: task.id,
      workspace: task.workspace,
      payload: { item_id: item.id, title: blockedTitle(task, blocked.payload.reason) },
    })
  }

  function handle(e: LedgerEvent) {
    if (e.seq <= done) return
    try {
      if (e.type === 'task.blocked') onBlocked(e)
      else if (e.type === 'policy.decided') onPolicyDecided(e)
      else if (e.type === 'task.reply_delegated' || e.type === 'task.reply_escalated') {
        onDelegation(e)
      } else if (e.type === 'task.cancel_requested') onCancelRequested(e)
      else {
        const reason = CLOSING[e.type]
        if (reason !== undefined) onTaskLeft(e, reason)
      }
    } catch (err) {
      o.logger?.warn('收件箱反应器处理事件失败', { seq: e.seq, type: e.type, error: String(err) })
    }
    done = e.seq
  }

  function saveCursor() {
    if (!o.cursorPath || done <= savedCursor) return
    try {
      mkdirSync(dirname(o.cursorPath), { recursive: true })
      const tmp = `${o.cursorPath}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ seq: done })}\n`)
      renameSync(tmp, o.cursorPath)
      savedCursor = done
    } catch (err) {
      o.logger?.warn('收件箱游标保存失败', String(err))
    }
  }

  function drain() {
    while (queue.length > 0 && !stopped) {
      const e = queue.shift() as LedgerEvent
      handle(e)
    }
    if (needsReconcile && !stopped) reconcile()
    saveCursor()
  }

  function kick() {
    if (scheduled) return
    scheduled = Promise.resolve().then(() => {
      scheduled = null
      drain()
    })
  }

  function readCursor(): number {
    if (!o.cursorPath) return 0
    try {
      const seq = (JSON.parse(readFileSync(o.cursorPath, 'utf8')) as { seq?: unknown }).seq
      // 账本被换成更短的（例如从备份恢复）时，文件里的游标作废。
      return typeof seq === 'number' && Number.isInteger(seq) && seq <= ledger.seq() ? seq : 0
    } catch {
      return 0
    }
  }

  /**
   * 续跑与写入失败后的兜底核对：
   * - 未关闭的任务条目，若任务已不再因该事件卡住，按任务当前状态关闭；
   * - 仍处于 blocked、最近一次卡住还没有对应条目的任务，补开条目。条目已存在（包括已被用户
   *   忽略而关闭的）就不动：同一次卡住只开一次。
   */
  function reconcile() {
    needsReconcile = false
    for (const task of ledger.listTasks({ status: 'blocked', limit: 100_000 })) {
      const e = latestBlocked(task.id)
      if (e === null || ledger.getInboxItem(blockedItemId(e.seq))) continue
      openBlocked(task, e)
    }
    for (const item of ledger.listInboxItems({ source: 'task', state: 'open', limit: 10_000 })) {
      if (item.task_id === null) continue
      const task = ledger.getTask(item.task_id)
      if (!task) continue
      const latest = latestBlockedSeq(task.id)
      if (task.status === 'blocked' && latest !== null) {
        if (item.id === blockedItemId(latest)) continue
        // 最近一次卡住的条目还没开：由上面的补开与关闭一起原子写入，这里不单独关闭。
        if (!ledger.getInboxItem(blockedItemId(latest))) continue
      }
      write({
        type: 'inbox.item_closed',
        task_id: task.id,
        workspace: task.workspace,
        payload: { item_id: item.id, reason: STATUS_CLOSE[task.status] },
      })
    }
    // 这里的写入再失败时 needsReconcile 重新置位：下一轮 drain（有新事件时）或下次启动再试，不在此循环重试。
  }

  return {
    start() {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe((e) => {
        if (stopped) return
        queue.push(e)
        kick()
      })
      const from = Math.max(readCursor(), ledger.inboxCursor())
      done = from
      savedCursor = from
      for (let after = from; ; ) {
        const batch = ledger.eventsAfter(after, {}, 1000)
        if (batch.length === 0) break
        for (const e of batch) handle(e)
        after = batch[batch.length - 1]?.seq ?? after
      }
      reconcile()
      saveCursor()
    },
    stop() {
      if (stopped) return
      drain()
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
    },
    async idle() {
      while (scheduled) await scheduled
    },
    processed: () => done,
    handle,
    reconcile,
  }
}

/** 委托给 supervisor 期间的条目标题前缀（D15 "supervisor 处理中"）。 */
export const DELEGATED_TITLE_PREFIX = '【supervisor 处理中】'
const delegatedTitle = (title: string) =>
  clipText(`${DELEGATED_TITLE_PREFIX}${title}`, INBOX_TITLE_MAX)

const ESCALATION_LABEL: Record<ReplyEscalationReason, string> = {
  supervisor: 'supervisor 判断需要你来决定',
  timeout: 'supervisor 超时未回复',
  wake_unavailable: 'supervisor 无法开始处理',
  wake_failed: 'supervisor 处理失败',
  wake_ended: 'supervisor 结束时没有回复',
  user_dismissed: '你忽略了该条目',
  user_replied: '你已回复',
}

function blockedTitle(task: TaskView, reason: BlockedReason): string {
  const goal = task.contract.goal.split('\n')[0] ?? ''
  return clipText(`[${task.workspace}] ${REASON_LABEL[reason]}：${goal}`, INBOX_TITLE_MAX)
}
