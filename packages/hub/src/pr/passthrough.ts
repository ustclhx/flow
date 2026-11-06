import {
  checkTaskMandateForResume,
  clipText,
  DEFAULT_RESUME_PER_DAY,
  type EventOf,
  isAllowedHumanPrEvent,
  isTerminalStatus,
  type LedgerEvent,
  type Result,
  samePrUrl,
  type TaskView,
} from '@raindown/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { RoleLookup, WorkspaceLookup } from '../ledger/tasks.ts'
import type { HubLogger } from '../server/maintenance.ts'

/**
 * PR 事件直通（harness-neutral D11；tasks 8.4–8.6）：pr-watcher 写下的每条 `pr.event`
 * 按订阅分发，不唤醒 supervisor。
 *
 * - 只分发给**事件之前**就已订阅的任务（`subscribed_seq < pr_event_seq`，store 同样强制），
 *   后来才订阅的任务不会收到或被重放更早的事件；
 * - 未结束的订阅任务（排队、运行、校验、卡住）：一律写 `task.input_added{source:'pr'}`，经续约
 *   或下一次派工送达；内容（含名单外用户与机器人）由送达模板包成不可信数据；
 * - 已结束（done / failed）的订阅任务：**只有名单内人类的 PR 评论或代码行评论**才尝试恢复，且依次核对：
 *   PR 仍为 open（已合并或关闭时不恢复）、该任务没有进行中的合并请求或 merger 任务、
 *   今天的恢复次数未超过 `github.resume_per_day`（默认 3，超出转收件箱）、
 *   当前策略下的授权仍成立（`checkTaskMandateForResume`）。全部通过才同一事务写 `task.input_added` 与
 *   `task.requeued{reason:'input'}`；否则任务保持结束，评论改为唤醒 supervisor（`resume_rejected`），
 *   supervisor 不可用时进收件箱；
 * - 名单内的人类评论没有任何订阅任务接收时，唤醒 supervisor（`no_subscriber`），不可用时进收件箱；
 * - 直通只是上下文：不改任务的授权依据与合同，也不放宽任何策略判定。
 *
 * 每条事件处理完写 `pr.dispatched{pr_event_seq}` 作为持久化检查点：中枢重启后只处理检查点之后的事件。
 * 所有写入同时按 pr_event_seq 去重（收件箱与唤醒之间互相去重），重复处理也不会重复送达或重复唤醒。
 */

export interface PrPassthroughOptions {
  ledger: LedgerStore
  workspaces: WorkspaceLookup
  roles: RoleLookup
  /** 该 workspace 的 supervisor 是否可以唤醒（启用且有 supervisor 角色）。 */
  supervisorActive: (workspace: string) => Promise<boolean>
  logger?: Pick<HubLogger, 'warn'>
  now?: () => number
}

const RUNNING: ReadonlySet<TaskView['status']> = new Set([
  'queued',
  'running',
  'verifying',
  'blocked',
])
type Check = { ok: true } | { ok: false; message: string; inboxOnly: boolean }

const RESUMABLE: ReadonlySet<TaskView['status']> = new Set(['done', 'failed'])
/** 启动时一次补处理的事件上限（其余在后续批次中处理）。 */
const CATCH_UP_BATCH = 1000

export function createPrPassthrough(o: PrPassthroughOptions) {
  const { ledger } = o
  const now = o.now ?? Date.now
  let unsubscribe: (() => void) | undefined
  let chain: Promise<void> = Promise.resolve()
  let stopped = false
  const queued = new Set<number>()

  const hasInput = (taskId: string, prEventSeq: number) => ledger.taskHasPrInput(taskId, prEventSeq)

  const append = (drafts: EventInput[], what: string) => {
    const r = ledger.appendMany(drafts, { actor: 'hub' })
    if (!r.ok) o.logger?.warn(`PR 直通写入失败：${what}`, r.error)
    return r.ok
  }

  async function mandateCheck(task: TaskView): Promise<Result<void>> {
    const role = await o.roles(task.contract.role)
    const ws = await o.workspaces(task.workspace)
    const active = ws ? await o.supervisorActive(task.workspace) : false
    return checkTaskMandateForResume(task, {
      supervisor_enabled: active,
      role: role.ok ? role.data : null,
    })
  }

  /** 该开发任务的 PR 是否有进行中的合并请求（待批准）或未结束的 merger 任务。 */
  function mergePending(task: TaskView, pr: string): boolean {
    for (const e of ledger.eventsByPayload('merge_request.created', 'dev_task', task.id)) {
      if (e.type !== 'merge_request.created' || !samePrUrl(e.payload.pr, pr)) continue
      const item = e.payload.item_id ? ledger.getInboxItem(e.payload.item_id) : null
      if (item?.state === 'open') return true
      const merger = e.payload.merger_task ? ledger.getTask(e.payload.merger_task) : null
      if (merger && !isTerminalStatus(merger.status)) return true
    }
    return ledger
      .listTasks({ workspace: task.workspace, limit: 1000 })
      .some(
        (t) =>
          !isTerminalStatus(t.status) &&
          t.contract.inputs?.merge?.pr !== undefined &&
          samePrUrl(t.contract.inputs.merge.pr, pr),
      )
  }

  /** 恢复前的全部核对；不通过时给出原因与去向（budget 超限只进收件箱）。 */
  async function resumeCheck(task: TaskView, event: EventOf<'pr.event'>): Promise<Check> {
    const p = event.payload
    const no = (message: string, inboxOnly = false): Check => ({ ok: false, message, inboxOnly })
    if (p.pr_state !== undefined && p.pr_state !== 'open') {
      return no(`PR 已${p.pr_state === 'merged' ? '合并' : '关闭'}，不恢复任务`)
    }
    if (mergePending(task, p.pr)) {
      return no('该 PR 有进行中的合并请求或 merger 任务，不恢复开发任务')
    }
    const ws = await o.workspaces(task.workspace)
    const limit = ws?.github?.resume_per_day ?? DEFAULT_RESUME_PER_DAY
    const since = new Date(now() - 86_400_000).toISOString()
    const used = ledger
      .taskEvents(task.id)
      .filter(
        (e) => e.type === 'task.requeued' && e.payload.reason === 'input' && e.ts >= since,
      ).length
    if (used >= limit) {
      return no(
        `该任务 24 小时内已因 PR 评论恢复 ${used} 次（上限 ${limit}，github.resume_per_day）`,
        true,
      )
    }
    const mandate = await mandateCheck(task)
    return mandate.ok ? { ok: true } : no(mandate.error.message)
  }

  /** 名单内评论转给 supervisor；supervisor 不可用（或 inboxOnly）时作为收件箱条目给用户。 */
  async function escalate(
    event: EventOf<'pr.event'>,
    reason: 'resume_rejected' | 'no_subscriber',
    task?: TaskView,
    note?: string,
    inboxOnly = false,
  ) {
    const workspace = event.workspace as string
    const itemId = `prc.${event.seq}${task ? `.${task.id}` : ''}`
    // 收件箱与唤醒之间互相去重：配置变化后重复处理也只有一个去向。
    if (ledger.prWakeRequested(event.seq, reason, task?.id) || ledger.getInboxItem(itemId)) return
    if (!inboxOnly && (await o.supervisorActive(workspace))) {
      append(
        [
          {
            type: 'pr.wake_requested',
            workspace,
            ...(task ? { task_id: task.id } : {}),
            payload: {
              pr_event_seq: event.seq,
              reason,
              ...(note ? { note: clipText(note, 2000) } : {}),
            },
          },
        ],
        `唤醒 supervisor（${reason}）`,
      )
      return
    }
    const p = event.payload
    append(
      [
        {
          type: 'inbox.item_created',
          workspace,
          ...(task ? { task_id: task.id } : {}),
          payload: {
            item_id: itemId,
            level: 'decide',
            source: 'pr_comment',
            source_ref: task?.id ?? String(event.seq),
            reason: 'pr_comment',
            title: clipText(
              task ? `PR 评论没有恢复已结束的任务 ${task.id}` : `PR 上有你的评论，但没有任务订阅它`,
              200,
            ),
            body: clipText(
              [
                `${p.actor} 在 ${p.pr} 上评论（${p.url}）：`,
                p.text,
                '',
                task
                  ? `任务保持结束：${note ?? '恢复前的授权校验未通过'}。需要继续时请手动处理。`
                  : 'supervisor 当前不可唤醒，请手动处理。',
              ].join('\n'),
              4000,
            ),
            actions: [],
            source_seq: event.seq,
          },
        },
      ],
      '收件箱条目',
    )
  }

  async function handle(event: EventOf<'pr.event'>) {
    const workspace = event.workspace
    if (!workspace) return
    const p = event.payload
    const request = isAllowedHumanPrEvent(p)
    const seen = new Set<string>()
    let taken = false
    const rejected: { task: TaskView; note: string; inboxOnly: boolean }[] = []
    for (const sub of ledger.activePrSubscriptions(workspace)) {
      if (sub.pr !== p.pr || seen.has(sub.task_id)) continue
      // 只送给事件之前就已订阅的任务。
      if (sub.subscribed_seq === undefined || sub.subscribed_seq >= event.seq) continue
      seen.add(sub.task_id)
      const task = ledger.getTask(sub.task_id)
      if (!task || task.cancel_requested || ledger.wakeOf(task.id)) continue
      if (hasInput(task.id, event.seq)) {
        taken = true
        continue
      }
      const input: EventInput = {
        type: 'task.input_added',
        task_id: task.id,
        workspace: task.workspace,
        payload: { source: 'pr', pr_event_seq: event.seq },
      }
      if (RUNNING.has(task.status)) {
        if (append([input], `送达任务 ${task.id}`)) taken = true
        continue
      }
      // 已结束的任务：机器人、CI、审查正文与名单外用户的内容不恢复。
      if (!request || !RESUMABLE.has(task.status)) continue
      const checked = await resumeCheck(task, event)
      if (stopped) return
      const fresh = ledger.getTask(task.id)
      if (!fresh || !RESUMABLE.has(fresh.status) || fresh.cancel_requested) continue
      if (!checked.ok) {
        rejected.push({ task: fresh, note: checked.message, inboxOnly: checked.inboxOnly })
        continue
      }
      const ended = ledger.attemptEnded(fresh.id, fresh.attempt)
      if (
        append(
          [
            ...(fresh.attempt > 0 && !ended
              ? [
                  {
                    type: 'task.attempt_ended' as const,
                    task_id: fresh.id,
                    workspace: fresh.workspace,
                    payload: {
                      attempt: fresh.attempt,
                      reason: fresh.status === 'done' ? ('done' as const) : ('failed' as const),
                    },
                  },
                ]
              : []),
            input,
            {
              type: 'task.requeued',
              task_id: fresh.id,
              workspace: fresh.workspace,
              payload: {
                reason: 'input',
                pr_event_seq: event.seq,
                // 因 PR 评论恢复的任务带 PR 来源污染（中枢计算）：下游不自动合并。
                pr_sourced: true,
                note: `PR ${p.pr} 上名单内用户 ${p.actor} 的评论`,
              },
            },
          ],
          `恢复任务 ${fresh.id}`,
        )
      )
        taken = true
    }
    if (request) {
      for (const r of rejected) {
        await escalate(event, 'resume_rejected', r.task, r.note, r.inboxOnly)
        taken = true
      }
      if (!taken) await escalate(event, 'no_subscriber')
    }
  }

  function enqueue(event: LedgerEvent) {
    if (stopped || event.type !== 'pr.event' || queued.has(event.seq)) return
    queued.add(event.seq)
    chain = chain
      .then(async () => {
        if (stopped) return
        await handle(event)
        if (stopped) return
        // 持久化检查点：已处理到这条事件。
        append(
          [
            {
              type: 'pr.dispatched',
              workspace: event.workspace as string,
              payload: { pr_event_seq: event.seq },
            },
          ],
          '直通检查点',
        )
      })
      .catch((error: unknown) => o.logger?.warn('PR 直通失败', String(error)))
      .finally(() => queued.delete(event.seq))
  }

  /** 从持久化检查点之后补处理（分批，直到追上）。 */
  async function catchUp() {
    let after = ledger.prDispatchedUpTo()
    for (;;) {
      if (stopped) return
      const batch = ledger.prEventsAfter(after, CATCH_UP_BATCH)
      // 检查点只推进到第一个缺口：之后已处理过的事件跳过，处理失败或追赶中的事件重新处理。
      for (const e of batch) if (!ledger.prIsDispatched(e.seq)) enqueue(e)
      await chain
      if (batch.length < CATCH_UP_BATCH) return
      after = batch.at(-1)?.seq ?? after
    }
  }

  return {
    /** 开始监听；同时从持久化检查点之后补处理停机期间的 PR 事件。 */
    start() {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe(enqueue)
      void catchUp().catch((error: unknown) => o.logger?.warn('PR 直通补处理失败', String(error)))
    },
    async idle() {
      await chain
      await chain
    },
    async stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      await chain
    },
  }
}
