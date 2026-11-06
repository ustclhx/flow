import { z } from 'zod'
import { foldTaskAttempts } from './attempts.ts'
import type { ActiveDelegation } from './delegation.ts'
import type { LedgerEvent } from './events.ts'
import { isTerminalStatus, type TaskView } from './task.ts'

export const taskStageSchema = z.enum([
  'waiting-human-approval',
  'waiting-human-answer',
  'waiting-supervisor',
  'waiting-human-review',
  'stalled',
  'queued',
  'idle',
  'working',
])
export type TaskStage = z.infer<typeof taskStageSchema>
export const taskStageFilter = z.enum([...taskStageSchema.options, 'waiting-human'])

export const TASK_STAGE_LABELS: Readonly<Record<TaskStage, string>> = {
  'waiting-human-approval': '等人授权',
  'waiting-human-answer': '等人回答',
  'waiting-supervisor': '等 supervisor',
  'waiting-human-review': '等人审阅',
  stalled: '受阻',
  queued: '排队',
  idle: '空闲',
  working: '工作中',
}

export function isWaitingHumanStage(stage: TaskStage | null): boolean {
  return (
    stage === 'waiting-human-approval' ||
    stage === 'waiting-human-answer' ||
    stage === 'waiting-human-review'
  )
}

/**
 * 由任务视图与完整账本派生阶段，不存储状态，也不读取时钟。
 * 委托是否因超时等原因转交，由调用方传入的当前有效委托决定。
 */
export function taskStage(
  task: TaskView,
  delegation: ActiveDelegation | null,
  options: { events?: readonly LedgerEvent[]; hasActiveSubscription?: boolean } = {},
): TaskStage | null {
  if (isTerminalStatus(task.status)) return null

  const blocked = task.status === 'blocked'
  if (blocked && delegation === null) {
    if (task.blocked?.reason === 'awaiting_approval') return 'waiting-human-approval'
    if (task.blocked?.reason === 'question') return 'waiting-human-answer'
  }
  if (blocked && delegation !== null) return 'waiting-supervisor'

  const events = (options.events ?? [])
    .filter((event) => event.task_id === task.id)
    .sort((a, b) => a.seq - b.seq)
  const attempts = foldTaskAttempts(task, events)
  const latestAttempt = attempts.at(-1)
  const latestStart = events.findLast((event) => event.type === 'task.started')
  const latestRequeue = events.findLast(
    (event) => event.type === 'task.requeued' || event.type === 'task.requeued_with_reply',
  )
  const latestReport = events.findLast((event) => event.type === 'task.reported')
  // 重试或新派工不能沿用上一轮交付物的待审阶段。
  if (
    latestReport?.type === 'task.reported' &&
    latestReport.payload.status === 'ready' &&
    latestReport.payload.deliverables?.length &&
    latestReport.payload.attempt === latestAttempt?.attempt &&
    latestReport.seq > (latestStart?.seq ?? 0) &&
    latestReport.seq > (latestRequeue?.seq ?? 0)
  ) {
    return 'waiting-human-review'
  }

  const latestBlock = events.findLast((event) => event.type === 'task.blocked')
  const replied = events.some(
    (event) =>
      event.type === 'task.replied' &&
      event.seq > (latestBlock?.seq ?? 0) &&
      (event.actor === 'user' || event.actor === 'supervisor' || event.payload.via !== undefined),
  )
  if (blocked && !replied) return 'stalled'
  if (task.status === 'queued') return 'queued'
  if (latestAttempt === undefined || latestAttempt.ended_at !== undefined) {
    // 排队状态优先；已结束派工且仍订阅事件时才空闲，避免“无派工”吞掉空闲阶段。
    if (latestAttempt?.ended_at !== undefined && options.hasActiveSubscription) return 'idle'
    return 'queued'
  }
  return 'working'
}
