import { z } from 'zod'
import { fail, ok, type Result } from '../result.ts'
import { workspaceRef } from '../schema/common.ts'
import { actor, capability, executorType, leaseId, nodeId, taskId, timestamp } from './common.ts'
import {
  blockedReason,
  canTransition,
  replyId,
  replyKind,
  type TaskStatus,
  taskContract,
  taskResult,
} from './task.ts'

/**
 * 账本事件（design D2：事件类型集中定义在这里，导出到 `schemas/events/`）。
 *
 * 公共信封：`seq`（中枢分配，单调递增）、`ts`、`type`、`workspace?`、`task_id?`、`actor`、`payload`。
 * 与任务相关的事件（task.*、lease.granted）必须带 `task_id` 与 `workspace`。
 *
 * **不入账本的高频信号**（只更新投影中的"软状态"列，不产生事件）：
 * - 续约（lease renew）：每个租约每 TTL/3 左右一次。只刷新 `leases.expires_at`。
 *   中枢重启后按表中到期时间恢复（D2）；投影重建时活动租约的到期时间重置为
 *   "重建时刻 + lease_ttl_s"，与睡眠恢复（D5）一样宁可多等一个 TTL，也不误判掉线。
 * - 活动（activity）：输出片段量大且价值短暂。中枢只在内存/投影中保留每个任务最近 N 条
 *   与 `last_activity_at`；需要持久化的末尾输出随 `task.blocked` 的 `tail` 写入账本。
 * - 节点心跳（node seen）：每次注册、领取、续约都刷新 `nodes.last_seen_at`。
 * 因此 `lease.renewed`、`task.activity`、`node.seen` 不是事件类型。
 * 代价：重建后 `last_activity_at`、`last_seen_at` 与活动缓存为空，直到下一次续约；
 * 任务的状态、尝试次数与事件时间戳不受影响（task-ledger "投影可重建"）。
 */

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

export const executorInfo = z
  .strictObject({
    type: executorType,
    mode: z
      .enum(['interactive', 'headless'])
      .optional()
      .meta({ description: '交互式（如 codex-orca）或无头（如 claude-sdk）；由变更 ② 使用' }),
  })
  .meta({ title: 'Executor info' })

export const eventPayloads = {
  'task.created': z.strictObject({ contract: taskContract }),
  'task.started': z.strictObject({
    node_id: nodeId,
    lease_id: leaseId,
    attempt: z.number().int().min(1).meta({ description: '第几次尝试，从 1 开始' }),
  }),
  'task.verifying': z.strictObject({ node_id: nodeId }),
  'task.done': z.strictObject({ result: taskResult }),
  'task.failed': z
    .strictObject({
      result: taskResult.optional().meta({ description: '节点提交失败时的结果' }),
      message: z.string().min(1).optional().meta({ description: '人或 supervisor 放弃时的说明' }),
    })
    .refine((p) => p.result !== undefined || p.message !== undefined, {
      message: 'task.failed 至少需要 result 或 message',
    }),
  'task.blocked': z.strictObject({
    reason: blockedReason,
    message: z.string().min(1),
    tail: z
      .array(z.string())
      .max(200)
      .optional()
      .meta({ description: '卡住时终端或输出的末尾若干行' }),
    node_id: nodeId.optional(),
    lease_held: z.boolean().default(false).meta({
      description:
        'true：交互式执行器的 worker 还活着，节点继续持有并续约租约（D7a）；false：这一轮执行已结束，租约随之释放',
    }),
    session: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .meta({ description: '执行器的会话 id；带回复重新排队时附到下一次执行（D6）' }),
  }),
  'task.unblocked': z.strictObject({
    note: z.string().optional().meta({ description: '解除卡住的说明，例如用户的答复摘要' }),
    reply_id: replyId
      .optional()
      .meta({ description: '因送达这条回复而解除卡住（ack-reply）；没有时为执行器自行恢复' }),
    dropped_reply_ids: z.array(replyId).optional().meta({
      description: 'worker 自行恢复时尚未送达、因此被丢弃的回复（供收件箱通知回复者）',
    }),
  }),
  'task.replied': z
    .strictObject({
      reply_id: replyId,
      kind: replyKind,
      text: z.string().min(1).max(16_384).optional().meta({ description: '回复文字或拒绝理由' }),
    })
    .refine((p) => p.kind !== 'text' || p.text !== undefined, {
      message: '文字回复必须带 text',
      path: ['text'],
    }),
  'task.requeued_with_reply': z.strictObject({
    reply_id: replyId,
    session: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .meta({ description: '上一轮卡住时上报的会话 id，下一次执行据此恢复' }),
  }),
  'task.requeued': z.strictObject({
    reason: z.enum(['lease_expired', 'manual']).meta({
      description: 'lease_expired：允许重试的任务租约过期；manual：人或 supervisor 重新排队',
    }),
    note: z.string().optional(),
  }),
  'task.cancel_requested': z.strictObject({ reason: z.string().optional() }),
  'task.cancelled': z.strictObject({
    reason: z.string().optional(),
    node_id: nodeId.optional().meta({ description: '由持有租约的节点确认取消时填写' }),
  }),
  'task.lease_expired': z.strictObject({
    lease_id: leaseId,
    node_id: nodeId,
    expired_at: timestamp,
    attempt: z.number().int().min(1),
  }),
  'lease.granted': z.strictObject({
    lease_id: leaseId,
    node_id: nodeId,
    token_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({ description: '租约令牌的 SHA-256；令牌明文不入账本' }),
    ttl_s: z.number().int().positive(),
    expires_at: timestamp,
  }),
  'node.registered': z.strictObject({
    node_id: nodeId,
    hostname: z.string().min(1),
    version: z.string().min(1),
    capabilities: z.array(capability),
    executors: z.array(executorInfo).default([]),
    concurrency: z.number().int().min(1),
  }),
  'schedule.fired': z.strictObject({
    rule_id: z.string().min(1),
    planned_at: timestamp,
    missed: z.boolean().default(false).meta({ description: '中枢停机或睡眠期间错过、恢复后补发' }),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  'hub.started': z.strictObject({
    version: z.string().min(1),
    pid: z.number().int().positive(),
    runtime: z.enum(['bun', 'node']),
    port: z.number().int().min(1).max(65535),
  }),
  'hub.resumed': z.strictObject({
    slept_ms: z.number().int().min(0).meta({ description: '墙钟比单调时钟多走的毫秒数' }),
    extended_leases: z.number().int().min(0),
  }),
  'hub.backup_done': z.strictObject({
    path: z.string().min(1).meta({ description: '备份文件路径（相对 flow-home）' }),
    size_bytes: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    removed: z.array(z.string()).default([]).meta({ description: '按保留份数删除的旧备份' }),
  }),
  'hub.rebuilt': z.strictObject({
    events_replayed: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
  }),
} as const

export type EventType = keyof typeof eventPayloads
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[]
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>

/** 信封中 task_id / workspace 的要求。 */
type Scope = 'task' | 'workspace' | 'none'
export const EVENT_SCOPES: Record<EventType, Scope> = {
  'task.created': 'task',
  'task.started': 'task',
  'task.verifying': 'task',
  'task.done': 'task',
  'task.failed': 'task',
  'task.blocked': 'task',
  'task.unblocked': 'task',
  'task.replied': 'task',
  'task.requeued_with_reply': 'task',
  'task.requeued': 'task',
  'task.cancel_requested': 'task',
  'task.cancelled': 'task',
  'task.lease_expired': 'task',
  'lease.granted': 'task',
  'node.registered': 'none',
  'schedule.fired': 'workspace',
  'hub.started': 'none',
  'hub.resumed': 'none',
  'hub.backup_done': 'none',
  'hub.rebuilt': 'none',
}

const scopeShape = (scope: Scope) =>
  scope === 'task'
    ? { workspace: workspaceRef, task_id: taskId }
    : scope === 'workspace'
      ? { workspace: workspaceRef, task_id: taskId.optional() }
      : { workspace: workspaceRef.optional(), task_id: taskId.optional() }

const seq = z.number().int().min(1).meta({ description: '账本序号，单调递增' })

function variants(withSeq: boolean) {
  return EVENT_TYPES.map((type) =>
    z
      .strictObject({
        ...(withSeq ? { seq, ts: timestamp } : {}),
        type: z.literal(type),
        ...scopeShape(EVENT_SCOPES[type]),
        actor,
        payload: eventPayloads[type],
      })
      .meta({ title: type }),
  )
}

const eventVariants = variants(true)
const draftVariants = variants(false)

/** 已写入账本的事件（SSE 每条消息的 data 也是它）。 */
export const ledgerEvent = z
  .discriminatedUnion(
    'type',
    eventVariants as unknown as [
      (typeof eventVariants)[number],
      ...(typeof eventVariants)[number][],
    ],
  )
  .meta({ title: 'Flow ledger event', description: '账本事件；按 type 区分载荷' })

/** 待写入的事件：没有 seq 与 ts，由中枢写入时分配。 */
export const ledgerEventDraft = z
  .discriminatedUnion(
    'type',
    draftVariants as unknown as [
      (typeof draftVariants)[number],
      ...(typeof draftVariants)[number][],
    ],
  )
  .meta({ title: 'Flow ledger event draft' })

/** 单个类型的事件 schema（含信封），用于导出 `schemas/events/<type>.schema.json`。 */
export const eventSchemas = Object.fromEntries(
  EVENT_TYPES.map((t, i) => [t, eventVariants[i] as z.ZodType]),
) as Record<EventType, z.ZodType>

interface Envelope<T extends EventType> {
  seq: number
  ts: string
  type: T
  workspace?: string
  task_id?: string
  actor: string
  payload: EventPayload<T>
}

/** 账本事件（按 type 收窄载荷）。 */
export type LedgerEvent = { [T in EventType]: Envelope<T> }[EventType]
export type LedgerEventDraft = {
  [T in EventType]: Omit<Envelope<T>, 'seq' | 'ts'>
}[EventType]
export type EventOf<T extends EventType> = Extract<LedgerEvent, { type: T }>

// ---------------------------------------------------------------------------
// 事件触发的状态转换
// ---------------------------------------------------------------------------

/** `unchanged`：事件合法但不改变状态（例如 lease.granted、task.cancel_requested）。 */
export interface TransitionRule {
  /** 允许的当前状态；`null` 表示任务尚不存在。 */
  from: readonly (TaskStatus | null)[]
  to: TaskStatus | 'unchanged'
}

/** 每种任务事件的转换规则；`apply(event)` 与写入前的校验都以此为准。 */
export const TASK_EVENT_RULES: Readonly<
  Record<Exclude<EventType, `node.${string}` | `hub.${string}` | 'schedule.fired'>, TransitionRule>
> = {
  'task.created': { from: [null], to: 'queued' },
  'task.started': { from: ['queued'], to: 'running' },
  'lease.granted': { from: ['running'], to: 'unchanged' },
  'task.verifying': { from: ['running'], to: 'verifying' },
  'task.done': { from: ['running', 'verifying'], to: 'done' },
  'task.failed': { from: ['running', 'verifying', 'blocked'], to: 'failed' },
  // blocked → blocked：只用于"本轮结束"（lease_held=false），例如卡住期间 worker 崩溃、节点掉线（D7a）。
  'task.blocked': { from: ['running', 'verifying', 'blocked'], to: 'blocked' },
  'task.unblocked': { from: ['blocked'], to: 'running' },
  'task.replied': { from: ['blocked'], to: 'unchanged' },
  'task.requeued_with_reply': { from: ['blocked'], to: 'queued' },
  'task.requeued': { from: ['blocked', 'running', 'verifying'], to: 'queued' },
  // blocked：交互式执行器卡住期间仍持有租约（D7a），可以请求取消、租约也可能过期。
  'task.cancel_requested': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  'task.cancelled': { from: ['queued', 'running', 'verifying', 'blocked'], to: 'cancelled' },
  'task.lease_expired': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
}

export const isTaskEventType = (type: EventType): type is keyof typeof TASK_EVENT_RULES =>
  type in TASK_EVENT_RULES

/**
 * 检查一个事件能否作用于处于 `current` 状态的任务（`null` 表示任务不存在），
 * 返回事件之后的状态。不合法时返回 `invalid_transition`，此时不得写入事件。
 * 非任务事件（node.*、hub.*、schedule.fired）原样返回 `current`。
 */
export function checkTaskEvent(
  current: TaskStatus | null,
  event: Pick<LedgerEventDraft, 'type' | 'payload'>,
): Result<TaskStatus | null> {
  if (!isTaskEventType(event.type)) return ok(current)
  const rule = TASK_EVENT_RULES[event.type]
  const reject = (why: string) =>
    fail('failure', 'invalid_transition', `任务状态为 ${current ?? '（不存在）'}，${why}`, {
      from: current,
      type: event.type,
    })
  if (!rule.from.includes(current)) return reject(`不能接受 ${event.type}`)
  if (event.type === 'task.blocked' && current === 'blocked') {
    const held = (event.payload as { lease_held?: boolean }).lease_held === true
    if (held) return reject('已卡住的任务只能以 lease_held=false 再次上报 task.blocked（本轮结束）')
    return ok('blocked')
  }
  if (event.type === 'task.requeued' && current !== null) {
    const reason = (event.payload as EventPayload<'task.requeued'>).reason
    const expected = current === 'blocked' ? 'manual' : 'lease_expired'
    if (reason !== expected) return reject(`task.requeued 的 reason 应为 ${expected}`)
  }
  const to = rule.to === 'unchanged' ? current : rule.to
  if (to !== null && current !== null && to !== current && !canTransition(current, to)) {
    return reject(`不能转换到 ${to}`)
  }
  return ok(to)
}

/** 校验并收窄一个事件；失败时返回 `invalid_event` 与 zod issues。 */
export function parseLedgerEvent(raw: unknown): Result<LedgerEvent> {
  const parsed = ledgerEvent.safeParse(raw)
  return parsed.success
    ? ok(parsed.data as LedgerEvent)
    : fail('failure', 'invalid_event', z.prettifyError(parsed.error), parsed.error.issues)
}

/** 校验并收窄一个待写入事件。 */
export function parseLedgerEventDraft(raw: unknown): Result<LedgerEventDraft> {
  const parsed = ledgerEventDraft.safeParse(raw)
  return parsed.success
    ? ok(parsed.data as LedgerEventDraft)
    : fail('failure', 'invalid_event', z.prettifyError(parsed.error), parsed.error.issues)
}
