import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  channelId,
  channelMessageKind,
  channelRef,
  INBOX_BODY_MAX,
  INBOX_NOTE_MAX,
  INBOX_PUSH_REASON_MAX,
  INBOX_TITLE_MAX,
  INBOX_VIA,
  inboxAction,
  inboxCloseReason,
  inboxItemId,
  inboxLevel,
  inboxOptions,
  inboxSource,
  inboxVia,
} from '../inbox/schema.ts'
import { policyDecisionSchema } from '../policy/decide.ts'
import { fail, ok, type Result } from '../result.ts'
import { dateString, workspaceRef } from '../schema/common.ts'
import { actor, capability, executorType, leaseId, nodeId, taskId, timestamp } from './common.ts'
import {
  blockedDelegationShape,
  blockedReason,
  canTransition,
  policyDecisionId,
  prUrl,
  replyId,
  replyKind,
  type TaskStatus,
  taskBranch,
  taskContract,
  taskOrigin,
  taskResult,
  wakeGeneration,
  wakeOrigin,
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

/** 渠道 chat id 的摘要（sha256 十六进制前 16 位），账本里不记明文 chat id。 */
export const chatDigestSchema = z.string().regex(/^[0-9a-f]{16}$/)
export const chatDigest = (channel: string, chatId: number): string =>
  createHash('sha256').update(`${channel}-chat:${chatId}`).digest('hex').slice(0, 16)

export const executorInfo = z
  .strictObject({
    type: executorType,
    mode: z
      .enum(['interactive', 'headless'])
      .optional()
      .meta({ description: '交互式（如 codex-orca）或无头（如 claude-sdk）；由变更 ② 使用' }),
  })
  .meta({ title: 'Executor info' })

/**
 * `task.replied` 的渠道：收件箱渠道之外多一个 `supervisor`（D15：supervisor 代用户回复）。
 * 只用于回复事件，不扩大收件箱其他事件的 via。
 */
export const REPLY_VIA = [...INBOX_VIA, 'supervisor'] as const
export type ReplyVia = (typeof REPLY_VIA)[number]
export const replyVia = z.enum(REPLY_VIA).meta({
  description: '回复发起的渠道；supervisor 表示 supervisor 代用户回复',
})

/**
 * 代回复委托结束的原因（D15 "转交与竞态"）。任务离开该次卡住（包括进入新的卡住）时委托隐式失效，
 * 不写事件，见 `activeDelegation`。
 */
export const REPLY_ESCALATION_REASONS = [
  'supervisor',
  'timeout',
  'wake_unavailable',
  'wake_failed',
  'wake_ended',
  'user_dismissed',
  'user_replied',
] as const
export type ReplyEscalationReason = (typeof REPLY_ESCALATION_REASONS)[number]
export const replyEscalationReason = z.enum(REPLY_ESCALATION_REASONS).meta({
  description:
    'supervisor 主动转交；timeout 超时；wake_unavailable 唤醒无法开始；wake_failed / wake_ended 唤醒失败或结束仍未回复；user_dismissed 用户忽略；user_replied 用户已回复',
})

/** 可委托给 supervisor 的卡住原因（D15）。 */
export const DELEGABLE_BLOCKED_REASONS = ['question', 'awaiting_approval'] as const
export const delegableBlockedReason = z.enum(DELEGABLE_BLOCKED_REASONS)

/** 普通唤醒队列（`supervisor.release` 只能放行这两条；reply 队列不暂停、不放行）。 */
export const SUPERVISOR_QUEUES = ['instruction', 'autonomous'] as const
export const supervisorQueue = z.enum(SUPERVISOR_QUEUES)

/** 任务提案 id：`tp-<随机串>`。 */
export const taskProposalId = z
  .string()
  .regex(/^tp-[A-Za-z0-9_.-]{1,64}$/, '任务提案 id 形如 tp-<随机串>')
  .meta({ description: '任务提案 id，由中枢在提交时分配' })

/** brain 中决策条目的路径（相对 brain/），例如 `decisions/2026-10-26-cache.md`。 */
export const decisionPath = z
  .string()
  .max(256)
  .regex(/^decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, '决策路径应形如 decisions/<名称>.md')
  .meta({ description: '决策条目路径（相对 brain/）' })

/** 任务提案附带的决策（D11）：接受时写入 brain/decisions/，到回看日期唤醒 supervisor 回看。 */
export const taskProposalDecision = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    expected_outcome: z.string().trim().min(1).max(2000),
    metric: z.string().trim().min(1).max(2000),
    review_date: dateString.meta({
      description: '回看日期（YYYY-MM-DD），晚于当天且不超过 180 天',
    }),
  })
  .meta({ title: 'Task proposal decision' })

export const eventPayloads = {
  'policy.decided': policyDecisionSchema.extend({
    task_id: taskId,
    request: z.strictObject({
      tool: z.string().min(1).max(128),
      actions: z.array(z.string().min(1)),
      command: z.string().max(2000).optional(),
      paths: z.array(z.string().max(2000)).max(200).optional(),
      push_env_ok: z
        .boolean()
        .optional()
        .meta({ description: '节点上报的推送环境检查结果（D15）；缺失视为不满足' }),
      gh_env_ok: z
        .boolean()
        .optional()
        .meta({ description: '节点上报的 gh 仓库解析检查结果（D15）；缺失视为不满足' }),
    }),
  }),
  'task.created': z.strictObject({
    contract: taskContract,
    origin: taskOrigin.optional().meta({
      description: '中枢计算的来源（D2），创建时写入、之后不变；不在 supervisor 链上的任务省略',
    }),
  }),
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
    prior_reason: blockedReason.optional().meta({
      description:
        'node_lost 时节点掉线之前的卡住原因，例如 awaiting_approval（仍可 approve / deny）',
    }),
    ...blockedDelegationShape,
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
      via: replyVia.optional(),
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
    result: taskResult.optional().meta({ description: '取消时已执行的验收命令结果' }),
    node_id: nodeId.optional().meta({ description: '由持有租约的节点确认取消时填写' }),
  }),
  'task.lease_expired': z.strictObject({
    lease_id: leaseId,
    node_id: nodeId,
    expired_at: timestamp,
    attempt: z.number().int().min(1),
  }),
  /**
   * 卡住委托给 supervisor 代回复（D15）。`block_seq` 是该次 `task.blocked` 的 seq；
   * 委托期间条目不推送，到 `deadline` 仍未回复则转交用户。
   */
  'task.reply_delegated': z.strictObject({
    task_id: taskId,
    block_seq: z.number().int().min(1).meta({ description: '被委托的那次 task.blocked 的 seq' }),
    kind: delegableBlockedReason.meta({ description: '卡住原因：question 或 awaiting_approval' }),
    decision_id: policyDecisionId.optional(),
    deadline: timestamp.meta({ description: '超过此时间仍未回复即转交用户（reply_timeout_s）' }),
  }),
  /** 代回复委托结束、转交用户（D15）；除 user_replied、user_dismissed 外按条目原级别推送。 */
  'task.reply_escalated': z.strictObject({
    reason: replyEscalationReason,
    block_seq: z
      .number()
      .int()
      .min(1)
      .meta({ description: '被结束的委托对应的 task.blocked seq（必须是当前这次卡住）' }),
    note: z.string().max(2000).optional().meta({ description: '说明，例如 supervisor 转交的理由' }),
  }),
  /**
   * 执行器创建的任务分支（D15，codex-orca 开始时上报）：只接受持有该任务活动租约的节点写入，
   * 每个任务只写一次、不可更改。`when.push_to: task_branch` 以它为准。
   */
  'task.branch_reported': z.strictObject({ branch: taskBranch }),
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
  // 收件箱（add-m1-inbox design D1）：由中枢的反应器与提案监听写入，折叠成 inbox_items 投影。
  'inbox.item_created': z.strictObject({
    item_id: inboxItemId,
    level: inboxLevel,
    source: inboxSource,
    source_ref: z
      .string()
      .min(1)
      .max(256)
      .meta({ description: '关联对象：任务 id、提案 id 或源事件 seq' }),
    reason: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta({ description: '来源内的原因，例如卡住原因 question' }),
    title: z.string().min(1).max(INBOX_TITLE_MAX),
    body: z.string().max(INBOX_BODY_MAX).default(''),
    actions: z.array(inboxAction).default([]).meta({
      description: '可用的操作；忽略（dismiss）总是可用，不写在这里',
    }),
    options: inboxOptions.optional().meta({
      description: 'supervisor 提问的候选答复（2–4 个，D11）；只用于 source=supervisor 的条目',
    }),
    source_seq: z.number().int().min(1).optional().meta({
      description: '触发该条目的账本事件 seq（反应器的幂等键）；提案等账本外的来源没有',
    }),
    deferred_until: timestamp
      .optional()
      .meta({ description: '静默时段内生成时，顺延推送到此时（3.3）' }),
  }),
  'inbox.item_updated': z
    .strictObject({
      item_id: inboxItemId,
      level: inboxLevel.optional(),
      title: z.string().min(1).max(INBOX_TITLE_MAX).optional(),
      body: z.string().max(INBOX_BODY_MAX).optional(),
      actions: z.array(inboxAction).optional(),
      deferred_until: timestamp.nullable().optional().meta({ description: 'null 表示取消顺延' }),
    })
    .refine((p) => Object.keys(p).length > 1, { message: 'inbox.item_updated 至少要改一个字段' }),
  'inbox.item_closed': z.strictObject({
    item_id: inboxItemId,
    reason: inboxCloseReason,
    note: z.string().max(INBOX_NOTE_MAX).optional(),
    cause_seq: z.number().int().min(1).optional().meta({
      description: '导致关闭的账本事件 seq（例如 task.unblocked），反应器据此续跑',
    }),
    cause_actor: actor.optional().meta({
      description: '导致关闭的操作者，例如答复任务的 user（渠道据此显示"已处理（来自 CLI）"）',
    }),
    via: inboxVia.optional().meta({ description: '操作发起的渠道；缺省表示命令行或自动关闭' }),
  }),
  /**
   * 渠道推送记录（add-m1-inbox 3.3 / 4.1）：
   * - `op: send`：消息已发出，`item_ids` 是消息里的条目（Decide 合并消息有多个）；
   * - `op: update`：条目关闭后消息已改为"已处理"，`item_ids` 是这次同步了关闭状态的条目；
   * - `op: failed`：放弃推送（消息级失败连续 5 次、永久错误或超时 3 次），`reason` 说明原因。
   *   没有 `ref` 时是发送失败（这些条目不再推送到该渠道）；有 `ref` 时是该消息的"已处理"同步失败。
   *   投影把它视为已处理，条目视图与 `flow hub status` 中标出"推送失败"。
   * 投影维护 `pushed_at`、`channels`（channel_refs_json）与 `channel_messages`，可重建。
   * 条目关闭后仍可写入（推送与关闭可能交错）。
   */
  'inbox.pushed': z
    .strictObject({
      channel: channelId,
      ref: channelRef.optional(),
      op: z.enum(['send', 'update', 'failed']).default('send'),
      kind: channelMessageKind.default('item'),
      item_ids: z.array(inboxItemId).min(1).max(500),
      reason: z
        .string()
        .min(1)
        .max(INBOX_PUSH_REASON_MAX)
        .optional()
        .meta({ description: 'op=failed 时放弃推送的原因' }),
    })
    .refine((p) => p.op === 'failed' || p.ref !== undefined, {
      message: 'send / update 必须带 ref',
      path: ['ref'],
    })
    .refine((p) => (p.op === 'failed') === (p.reason !== undefined), {
      message: '只有 op=failed 带 reason，且必须带',
      path: ['reason'],
    }),
  /**
   * 用户下达给 supervisor 的指令（telegram-channel "命令"：`/ask <workspace> <内容>`）。
   * 由变更 ④ 的 supervisor 消费；在它上线之前只入账，不产生任何投影。
   */
  /**
   * 渠道改绑（add-m1-inbox 5.1 审查）：已绑定的 Telegram 被新的绑定码改绑到另一个 chat。
   * 只记 chat id 的摘要（`chatDigest`），不记明文 id；改绑前已通知原 chat。
   */
  'channel.rebound': z.strictObject({
    channel: channelId,
    from_chat: chatDigestSchema.meta({ description: '原 chat id 的摘要' }),
    to_chat: chatDigestSchema.meta({ description: '新 chat id 的摘要' }),
    via: inboxVia,
  }),
  /** 渠道解除绑定（`flow telegram unlink`）。 */
  'channel.unlinked': z.strictObject({
    channel: channelId,
    chat: chatDigestSchema.meta({ description: '解除绑定的 chat id 的摘要' }),
    via: inboxVia,
  }),
  'user.instruction': z.strictObject({
    text: z.string().min(1).max(INBOX_BODY_MAX).meta({ description: '指令原文' }),
    via: inboxVia.meta({ description: '指令来自哪个渠道' }),
  }),
  /**
   * supervisor 唤醒开始（D1、D3）：中枢以 hub 身份创建唤醒任务后立即写入。
   * **判断某任务是不是唤醒任务、它的 origin 是什么，都以这条事件为准**，不看角色名或 inputs。
   * `events` 是这次唤醒合并的账本事件 seq。
   */
  'supervisor.wake_started': z.strictObject({
    task_id: taskId.meta({ description: '唤醒任务 id' }),
    workspace: workspaceRef,
    origin: wakeOrigin,
    events: z
      .array(z.number().int().min(1))
      .max(200)
      .meta({ description: '这次唤醒合并的账本事件 seq（按顺序）' }),
    generation: wakeGeneration,
  }),
  /** 用户回答了 supervisor 的提问（D11）：条目关闭为 answered，并唤醒 supervisor。 */
  'supervisor.answered': z.strictObject({
    item_id: inboxItemId,
    text: z.string().min(1).max(INBOX_BODY_MAX).meta({ description: '答复原文或所选选项' }),
    via: inboxVia.optional(),
  }),
  /** 用户手动放行一条普通唤醒队列（`flow supervisor wake <ws> --release <queue>`，D3）。 */
  'supervisor.release': z.strictObject({ queue: supervisorQueue }),
  /** supervisor 提交任务提案（D11）：`draft` 是接受后要建的任务合同。 */
  'task_proposal.created': z.strictObject({
    proposal_id: taskProposalId,
    wake_task_id: taskId.meta({ description: '提交提案的唤醒任务' }),
    draft: taskContract,
    decision: taskProposalDecision.optional(),
    reason: z.string().max(2000).optional().meta({ description: '提案理由' }),
  }),
  /** 用户接受任务提案：中枢以 user 身份建任务（origin instruction），有决策时写入 brain。 */
  'task_proposal.accepted': z.strictObject({
    proposal_id: taskProposalId,
    task_id: taskId.meta({ description: '据此创建的任务' }),
    goal: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({ description: '用户在 Web 上修改后的目标；没有修改时省略' }),
    decision_path: decisionPath.optional(),
    via: inboxVia.optional(),
  }),
  'task_proposal.rejected': z.strictObject({
    proposal_id: taskProposalId,
    note: z.string().max(2000).optional(),
    via: inboxVia.optional(),
  }),
  /** 决策到回看日期（D11）：同一决策只写一次，停机错过的在下一次扫描补发。 */
  'decision.review_due': z.strictObject({
    path: decisionPath,
    review_date: dateString,
    missed: z.boolean().default(false).meta({ description: '停机期间错过、恢复后补发' }),
  }),
  /** 用户批准了 supervisor 的合并请求（D10）：中枢随后以 hub 身份建 merger 任务。 */
  'merge_request.approved': z.strictObject({
    item_id: inboxItemId.optional().meta({ description: '合并请求的收件箱条目' }),
    pr: prUrl,
    review_task: taskId.meta({ description: '给出 approve 结论的审查任务' }),
    approved_by: actor.meta({ description: '批准者' }),
    via: inboxVia.optional(),
  }),
} as const

export type EventType = keyof typeof eventPayloads
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[]
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>

/** 信封中 task_id / workspace 的要求。 */
type Scope = 'task' | 'workspace' | 'none'
export const EVENT_SCOPES: Record<EventType, Scope> = {
  'policy.decided': 'task',
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
  'task.reply_delegated': 'task',
  'task.reply_escalated': 'task',
  'task.branch_reported': 'task',
  'lease.granted': 'task',
  'node.registered': 'none',
  'schedule.fired': 'workspace',
  'hub.started': 'none',
  'hub.resumed': 'none',
  'hub.backup_done': 'none',
  'hub.rebuilt': 'none',
  // 任务来源的条目带 task_id 与 workspace；提案等全局来源都可省略。
  'inbox.item_created': 'none',
  'inbox.item_updated': 'none',
  'inbox.item_closed': 'none',
  'inbox.pushed': 'none',
  'channel.rebound': 'none',
  'channel.unlinked': 'none',
  'user.instruction': 'workspace',
  // 唤醒事件带唤醒任务 id 与 workspace；唤醒任务刚创建（queued）时写入。
  'supervisor.wake_started': 'task',
  'supervisor.answered': 'workspace',
  'supervisor.release': 'workspace',
  'task_proposal.created': 'workspace',
  'task_proposal.accepted': 'workspace',
  'task_proposal.rejected': 'workspace',
  // 决策可能没有 workspace（此时只生成 Digest 条目）。
  'decision.review_due': 'none',
  'merge_request.approved': 'workspace',
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
  Record<
    Exclude<
      EventType,
      | `node.${string}`
      | `hub.${string}`
      | `inbox.${string}`
      | `user.${string}`
      | `channel.${string}`
      | `task_proposal.${string}`
      | `decision.${string}`
      | `merge_request.${string}`
      | 'supervisor.answered'
      | 'supervisor.release'
      | 'schedule.fired'
    >,
    TransitionRule
  >
> = {
  'policy.decided': {
    from: ['queued', 'running', 'verifying', 'blocked', 'done', 'failed', 'cancelled'],
    to: 'unchanged',
  },
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
  // 代回复委托与转交只发生在卡住期间（D15）。
  'task.reply_delegated': { from: ['blocked'], to: 'unchanged' },
  'task.reply_escalated': { from: ['blocked'], to: 'unchanged' },
  // codex-orca 开始执行后上报一次（持有活动租约，见 store 的校验）。
  'task.branch_reported': { from: ['running', 'verifying', 'blocked'], to: 'unchanged' },
  // 唤醒任务创建后立即写入（同一事务或紧随其后），此时任务仍在排队。
  'supervisor.wake_started': { from: ['queued'], to: 'unchanged' },
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
