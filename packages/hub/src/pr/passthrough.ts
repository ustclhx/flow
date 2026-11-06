import {
  checkTaskMandateForResume,
  clipText,
  type EventOf,
  isAllowedHumanPrEvent,
  type LedgerEvent,
  type Result,
  type TaskView,
} from '@raindown/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { RoleLookup, WorkspaceLookup } from '../ledger/tasks.ts'
import type { HubLogger } from '../server/maintenance.ts'

/**
 * PR 事件直通（harness-neutral D11；tasks 8.4–8.6）：pr-watcher 写下的每条 `pr.event`
 * 按订阅分发，不唤醒 supervisor。
 *
 * - 未结束的订阅任务（排队、运行、校验、卡住）：一律写 `task.input_added{source:'pr'}`，经续约
 *   或下一次派工送达；内容（含名单外用户与机器人）由送达模板包成不可信数据；
 * - 已结束（done / failed）的订阅任务：**只有名单内的人类评论**才恢复。先按当前策略重新校验授权
 *   （`checkTaskMandateForResume`），通过则同一事务写 `task.input_added` 与 `task.requeued{reason:'input'}`；
 *   不通过则任务保持结束，评论改为唤醒 supervisor（`pr.wake_requested{reason:'resume_rejected'}`），
 *   supervisor 不可用时进收件箱。机器人、CI 与名单外用户的内容不恢复已结束任务；
 * - 名单内的人类评论没有任何订阅任务接收时，唤醒 supervisor（`no_subscriber`），不可用时进收件箱；
 * - 直通只是上下文：不改任务的授权依据与合同，也不放宽任何策略判定。
 *
 * 所有写入都是幂等的（按 pr_event_seq 去重），中枢重启后补处理近期事件不会重复送达或重复唤醒。
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
const RESUMABLE: ReadonlySet<TaskView['status']> = new Set(['done', 'failed'])

export function createPrPassthrough(o: PrPassthroughOptions) {
  const { ledger } = o
  let unsubscribe: (() => void) | undefined
  let chain: Promise<void> = Promise.resolve()
  let stopped = false

  const hasInput = (taskId: string, prEventSeq: number) =>
    ledger
      .taskEvents(taskId)
      .some((e) => e.type === 'task.input_added' && e.payload.pr_event_seq === prEventSeq)

  const append = (drafts: EventInput[], what: string) => {
    const r = ledger.appendMany(drafts, { actor: 'hub' })
    if (!r.ok) o.logger?.warn(`PR 直通写入失败：${what}`, r.error)
    return r.ok
  }

  async function resumeCheck(task: TaskView): Promise<Result<void>> {
    const role = await o.roles(task.contract.role)
    const ws = await o.workspaces(task.workspace)
    const active = ws ? await o.supervisorActive(task.workspace) : false
    return checkTaskMandateForResume(task, {
      supervisor_enabled: active,
      role: role.ok ? role.data : null,
    })
  }

  /** 名单内评论转给 supervisor；supervisor 不可用时作为收件箱条目给用户。 */
  async function escalate(
    event: EventOf<'pr.event'>,
    reason: 'resume_rejected' | 'no_subscriber',
    task?: TaskView,
    note?: string,
  ) {
    const workspace = event.workspace as string
    if (ledger.prWakeRequested(event.seq, reason, task?.id)) return
    if (await o.supervisorActive(workspace)) {
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
    const itemId = `prc.${event.seq}${task ? `.${task.id}` : ''}`
    if (ledger.getInboxItem(itemId)) return
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
    const rejected: { task: TaskView; note: string }[] = []
    for (const sub of ledger.activePrSubscriptions(workspace)) {
      if (sub.pr !== p.pr || seen.has(sub.task_id)) continue
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
      // 已结束的任务：机器人、CI 与名单外用户的内容不恢复。
      if (!request || !RESUMABLE.has(task.status)) continue
      const checked = await resumeCheck(task)
      if (stopped) return
      const fresh = ledger.getTask(task.id)
      if (!fresh || !RESUMABLE.has(fresh.status) || fresh.cancel_requested) continue
      if (!checked.ok) {
        rejected.push({ task: fresh, note: checked.error.message })
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
                note: `PR ${p.pr} 上名单内用户 ${p.actor} 的评论`,
              },
            },
          ],
          `恢复任务 ${fresh.id}`,
        )
      )
        taken = true
    }
    if (!request) return
    for (const r of rejected) {
      await escalate(event, 'resume_rejected', r.task, r.note)
      taken = true
    }
    if (!taken) await escalate(event, 'no_subscriber')
  }

  function enqueue(event: LedgerEvent) {
    if (stopped || event.type !== 'pr.event') return
    chain = chain
      .then(() => (stopped ? undefined : handle(event)))
      .catch((error: unknown) => o.logger?.warn('PR 直通失败', String(error)))
  }

  return {
    /** 开始监听；同时补处理最近 7 天的 PR 事件（写入均幂等，不会重复送达）。 */
    start() {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe(enqueue)
      const since = new Date((o.now ?? Date.now)() - 7 * 86_400_000).toISOString()
      for (const e of ledger.recentPrEvents(since)) enqueue(e)
    },
    async idle() {
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
