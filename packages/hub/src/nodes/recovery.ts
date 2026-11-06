import { foldTaskAttempts, prUrl, type TaskRecovery, type TaskView } from '@raindown/core'
import type { LedgerStore } from '../ledger/store.ts'

/** 只从可重放的本任务账本结果读取 PR，不采信临时活动或终端文字。 */
export function recordedTaskPrs(ledger: Pick<LedgerStore, 'taskEvents'>, taskId: string): string[] {
  const prs = new Set<string>()
  const addPr = (value: unknown) => {
    const parsed = prUrl.safeParse(value)
    if (parsed.success) prs.add(parsed.data)
  }
  for (const event of ledger.taskEvents(taskId)) {
    if (
      event.type !== 'task.done' &&
      event.type !== 'task.failed' &&
      event.type !== 'task.cancelled'
    )
      continue
    for (const artifact of event.payload.result?.artifacts ?? []) {
      if (artifact.kind === 'pr') addPr(artifact.ref)
    }
    for (const pr of event.payload.result?.prs ?? []) addPr(pr)
  }
  return [...prs]
}

/** 只为中断后的恢复或主动重试附提示；普通提问回复沿用原任务输入。 */
export function recoveryForTask(
  ledger: Pick<LedgerStore, 'taskEvents'>,
  task: TaskView,
): TaskRecovery | undefined {
  if (task.attempt === 0) return undefined
  const events = ledger.taskEvents(task.id)
  const previous = foldTaskAttempts(task, events).at(-1)
  const started = events.findLast(
    (e) => e.type === 'task.started' && e.payload.attempt === task.attempt,
  )
  const prior = events.filter((e) => e.seq >= (started?.seq ?? 0))
  const context = prior.findLast(
    (e) => e.type === 'task.blocked' || e.type === 'task.failed' || e.type === 'task.unblocked',
  )
  const requeued = prior.findLast(
    (e) => e.type === 'task.requeued' || e.type === 'task.requeued_with_reply',
  )
  const interrupted =
    prior.some((e) => e.type === 'task.lease_expired') ||
    previous?.reason === 'lease_expired' ||
    previous?.reason === 'node_lost' ||
    previous?.reason === 'retry' ||
    (context?.type === 'task.blocked' && ['crashed', 'node_lost'].includes(context.payload.reason))
  if (requeued?.type !== 'task.requeued' && !interrupted) return undefined
  return {
    previous_end: {
      attempt: previous?.attempt ?? task.attempt,
      reason: previous?.reason ?? 'unknown',
      ...(previous?.ended_at ? { ended_at: previous.ended_at } : {}),
      ...(previous?.last_report ? { last_report: previous.last_report } : {}),
      ...(context?.type === 'task.blocked'
        ? { blocked_reason: context.payload.reason, message: context.payload.message }
        : context?.type === 'task.failed'
          ? { message: context.payload.result?.summary ?? context.payload.message }
          : {}),
    },
    ...(task.branch ? { reported_branch: task.branch } : {}),
    prs: recordedTaskPrs(ledger, task.id),
  }
}
