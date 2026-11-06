import { foldTaskAttempts, gitSha, prUrl, type TaskRecovery, type TaskView } from '@raindown/core'
import type { LedgerStore } from '../ledger/store.ts'

/** 只读任务自己的已知事实；不把终端文字或获准 push 当成已经发生的外部动作。 */
export function recoveryForTask(
  ledger: Pick<LedgerStore, 'taskEvents' | 'taskActivity'>,
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
  const prs = new Set<string>()
  const addPr = (value: unknown) => {
    const parsed = prUrl.safeParse(value)
    if (parsed.success) prs.add(parsed.data)
  }
  for (const event of events) {
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
  // 活动 data 是已有的结构化执行器事实通道；只采信明确的 PR / push 字段，逐项校验。
  let pushedSha: string | undefined
  for (const activity of ledger.taskActivity(task.id)) {
    const data = activity.data
    if (Array.isArray(data?.prs)) for (const pr of data.prs) addPr(pr)
    const sha = gitSha.safeParse(data?.pushed_sha)
    if (sha.success) pushedSha = sha.data
  }
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
    prs: [...prs],
    ...(pushedSha ? { pushed_sha: pushedSha } : {}),
  }
}
