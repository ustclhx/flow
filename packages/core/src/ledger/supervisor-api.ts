import { z } from 'zod'
import { INBOX_BODY_MAX, inboxVia } from '../inbox/schema.ts'
import { dateString, workspaceRef } from '../schema/common.ts'
import { taskId, timestamp } from './common.ts'
import { supervisorQueue } from './events.ts'
import { taskStatus, wakeGeneration, wakeOrigin } from './task.ts'

/**
 * supervisor 唤醒调度的用户接口（add-m1-supervisor D3；tasks 3.4）：
 * `flow ask`、`flow supervisor wake [--release]`、`flow supervisor status` 与 Telegram `/ask`。
 * 这些路由只接受 user 身份（userOnly）。
 */

/** 手动唤醒时没有附加说明的指令文字（`user.instruction.text` 不能为空）。 */
export const MANUAL_WAKE_TEXT = '（用户手动唤醒，没有附加说明）'

export const supervisorWakeRequest = z
  .strictObject({
    workspace: workspaceRef,
    text: z
      .string()
      .trim()
      .min(1)
      .max(INBOX_BODY_MAX)
      .optional()
      .meta({ description: '指令原文；省略且不带 release 时写入一条"手动唤醒"指令' }),
    release: supervisorQueue.optional().meta({
      description:
        '放行一条普通唤醒队列：写 supervisor.release，立刻用该队列现有事件创建一次唤醒（不计入每日上限）；不能与 text 同时给出',
    }),
    via: inboxVia.default('cli').meta({ description: '指令来自哪个渠道，默认 cli' }),
  })
  .refine((r) => r.text === undefined || r.release === undefined, {
    message: 'text 与 release 不能同时给出',
    path: ['release'],
  })
  .meta({ title: 'POST /v1/supervisor/wake' })
export type SupervisorWakeRequest = z.input<typeof supervisorWakeRequest>

/**
 * 一次唤醒的摘要。`status` 是唤醒任务当前状态；`events` 是合并的事件数。
 */
export const wakeSummary = z
  .object({
    task_id: taskId,
    origin: wakeOrigin,
    generation: wakeGeneration,
    status: taskStatus,
    events: z.number().int().min(0),
    started_at: timestamp,
    finished_at: timestamp.nullable(),
  })
  .meta({ title: 'Wake summary' })
export type WakeSummary = z.infer<typeof wakeSummary>

/**
 * 指令或放行的去向：
 * - `started`：已为它创建唤醒（`wake`）；
 * - `queued`：已入队，`reason` 说明为什么没有立即唤醒（`busy` 前面有一次唤醒在运行，`daily_limit`
 *   今日唤醒已达上限，`paused` 队列因连续失败暂停，`unavailable` 暂时无法唤醒）；
 * - `empty`：放行时该队列没有待处理事件（暂停与上限已解除，下一个事件到达即唤醒）。
 */
export const WAKE_PLACEMENT_STATES = ['started', 'queued', 'empty'] as const
export const WAKE_QUEUED_REASONS = ['busy', 'daily_limit', 'paused', 'unavailable'] as const

export const supervisorWakeData = z
  .object({
    workspace: workspaceRef,
    state: z.enum(WAKE_PLACEMENT_STATES),
    reason: z.enum(WAKE_QUEUED_REASONS).optional(),
    instruction_seq: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: '写入的 user.instruction 的 seq' }),
    release_seq: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: '写入的 supervisor.release 的 seq' }),
    wake: wakeSummary.optional().meta({ description: 'state=started 时新建的唤醒' }),
    running: wakeSummary.optional().meta({ description: 'reason=busy 时正在进行的唤醒' }),
    message: z.string().meta({ description: '给人看的说明' }),
  })
  .meta({ title: 'POST /v1/supervisor/wake 响应' })
export type SupervisorWakeData = z.infer<typeof supervisorWakeData>

export const supervisorStatusQuery = z
  .strictObject({ workspace: workspaceRef.optional() })
  .meta({ title: 'GET /v1/supervisor/status 查询参数' })

const queueCounts = z.object({
  instruction: z.number().int().min(0),
  autonomous: z.number().int().min(0),
  reply: z.number().int().min(0),
})

const queuePause = z
  .object({
    failures: z.number().int().min(1).meta({ description: '连续失败次数' }),
    until: timestamp.meta({ description: '到此时间自动恢复一次' }),
  })
  .nullable()

export const supervisorWorkspaceStatus = z
  .object({
    workspace: workspaceRef,
    enabled: z
      .boolean()
      .meta({ description: '当前能否唤醒（启用、有唯一的只读 supervisor 角色）' }),
    reason: z.string().nullable().meta({ description: '不能唤醒的原因' }),
    current: wakeSummary.nullable().meta({ description: '未结束的普通唤醒' }),
    reply: wakeSummary.nullable().meta({ description: '未结束的 reply 唤醒' }),
    queues: queueCounts.meta({ description: '各队列待处理的事件数' }),
    paused: z
      .object({ instruction: queuePause, autonomous: queuePause })
      .meta({ description: '因连续失败暂停的普通队列' }),
    release_pending: z
      .array(supervisorQueue)
      .meta({ description: '已放行、等当前唤醒结束后立即处理的队列' }),
    today: z.object({
      date: dateString,
      wakes: z.number().int().min(0).meta({ description: '今日计入上限的普通唤醒数' }),
      autonomous: z.number().int().min(0),
      reply: z.number().int().min(0),
      wakes_per_day: z.number().int().min(0),
      autonomous_wakes_per_day: z.number().int().min(0),
      reply_wakes_per_day: z.number().int().min(0),
      cost_usd: z.number().min(0).optional().meta({
        description: '今天结束的唤醒任务（含 reply）已上报的 result.cost.usd 之和（估算，D13）',
      }),
      cost_wakes: z.number().int().min(0).optional().meta({
        description: '今天结束的唤醒任务数（含 reply），其中未上报费用的见 cost_unreported',
      }),
      cost_unreported: z.number().int().min(0).optional(),
    }),
    last: wakeSummary.nullable().meta({ description: '最近一次已结束的唤醒' }),
  })
  .meta({ title: 'Supervisor workspace status' })
export type SupervisorWorkspaceStatus = z.infer<typeof supervisorWorkspaceStatus>

export const supervisorStatusData = z
  .object({ workspaces: z.array(supervisorWorkspaceStatus) })
  .meta({ title: 'GET /v1/supervisor/status' })
export type SupervisorStatusData = z.infer<typeof supervisorStatusData>
