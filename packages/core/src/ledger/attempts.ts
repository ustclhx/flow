import { z } from 'zod'
import { executorType, nodeId, timestamp } from './common.ts'
import type { LedgerEvent } from './events.ts'
import { type TaskView, taskAttemptEndReason } from './task.ts'

/** 派工由事件折叠得到，不建立单独的持久化表。 */
export const taskAttempt = z
  .strictObject({
    attempt: z.number().int().min(1),
    executor: executorType,
    node_id: nodeId,
    started_at: timestamp,
    ended_at: timestamp.optional(),
    reason: taskAttemptEndReason.or(z.literal('unknown')).optional(),
    last_report: z.string().max(16_384).optional(),
  })
  .meta({ title: 'Task attempt', description: '由账本事件折叠的一次派工' })
export type TaskAttempt = z.infer<typeof taskAttempt>

/**
 * 读取任务的完整事件历史，按 seq 折叠派工；输入可以包含其他任务的事件。
 * 同一派工结束后再手动重试，只保留最早的显式结束事实，避免 retry 覆盖 failed 等结果；
 * 后续结束事件只补齐缺失的最后上报。旧账没有显式结束时，以首次终态或下一次 started
 * 的时间推断结束，原因标记 unknown，不猜测历史上未记录的事实。
 */
export function foldTaskAttempts(
  task: Pick<TaskView, 'id' | 'contract'>,
  events: readonly LedgerEvent[],
): TaskAttempt[] {
  const attempts: TaskAttempt[] = []
  const byAttempt = new Map<number, TaskAttempt>()
  const explicitEnds = new Set<number>()
  let current: TaskAttempt | undefined
  const inferEnd = (ts: string) => {
    if (current && current.ended_at === undefined) {
      current.ended_at = ts
      current.reason = 'unknown'
    }
  }

  for (const event of events.filter((e) => e.task_id === task.id).sort((a, b) => a.seq - b.seq)) {
    switch (event.type) {
      case 'task.started': {
        inferEnd(event.ts)
        current = {
          attempt: event.payload.attempt,
          executor: task.contract.executor,
          node_id: event.payload.node_id,
          started_at: event.ts,
        }
        attempts.push(current)
        byAttempt.set(current.attempt, current)
        break
      }
      case 'task.attempt_ended': {
        const attempt = byAttempt.get(event.payload.attempt)
        if (!attempt) break
        if (!explicitEnds.has(attempt.attempt)) {
          attempt.ended_at = event.ts
          attempt.reason = event.payload.reason
          explicitEnds.add(attempt.attempt)
        }
        if (attempt.last_report === undefined && event.payload.last_report !== undefined) {
          attempt.last_report = event.payload.last_report
        }
        break
      }
      case 'task.done':
      case 'task.failed':
      case 'task.cancelled':
        inferEnd(event.ts)
        break
    }
  }
  return attempts
}
