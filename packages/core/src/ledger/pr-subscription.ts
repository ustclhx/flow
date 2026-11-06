import { z } from 'zod'
import { taskId, timestamp } from './common.ts'
import { PROTOCOL_MESSAGE_MAX } from './redact.ts'
import { prUrl } from './task.ts'

/**
 * PR 订阅与 PR 事件（add-harness-neutral-coordination D11；pr-subscription spec）。
 *
 * - `pr.subscribed` / `pr.unsubscribed`：任务跟随某个 PR（开发任务 author、审查任务 reviewer）。
 *   订阅在任务结束后保留，直到 PR 关闭或合并后再过 14 天，或用户取消。
 * - `pr.event`：中枢 pr-watcher 读到的一条 CI 结果、审查结论或评论。`allowed` 只由中枢按 workspace 的
 *   `github.allowed_users` 计算，**只有 allowed 且 actor_kind 为 human 的事件**才能恢复已结束任务、
 *   被交回或唤醒 supervisor；其余只作为不可信上下文送达运行中的任务。
 */

/** 订阅关系：author 由任务分支开出 PR；reviewer 审查该 PR。 */
export const PR_SUBSCRIPTION_ROLES = ['author', 'reviewer'] as const
export const prSubscriptionRole = z.enum(PR_SUBSCRIPTION_ROLES).meta({
  description: 'author：任务分支开出的 PR；reviewer：审查任务审查的 PR',
})
export type PrSubscriptionRole = z.infer<typeof prSubscriptionRole>

/** 结束订阅的原因。 */
export const PR_UNSUBSCRIBE_REASONS = [
  'user',
  'pr_closed',
  'not_task_branch',
  'repo_not_registered',
] as const
export const prUnsubscribeReason = z.enum(PR_UNSUBSCRIBE_REASONS).meta({
  description:
    'user 用户取消；pr_closed PR 关闭或合并已满保留期；not_task_branch PR 不是由任务分支开出；repo_not_registered PR 不在 workspace 登记的仓库',
})
export type PrUnsubscribeReason = z.infer<typeof prUnsubscribeReason>

/** PR 关闭或合并后订阅继续保留的天数。 */
export const PR_SUBSCRIPTION_RETENTION_DAYS = 14

/** PR 事件的种类：CI 检查、审查结论、PR 对话评论、代码行评论。 */
export const PR_EVENT_KINDS = ['check_run', 'review', 'issue_comment', 'review_comment'] as const
export const prEventKind = z.enum(PR_EVENT_KINDS)
export type PrEventKind = z.infer<typeof prEventKind>

/** 入账的 PR 事件文字上限（脱敏后截断）；送达时再按输入上限截断并附读取指针。 */
export const PR_EVENT_TEXT_MAX = PROTOCOL_MESSAGE_MAX

/** GitHub 内容链接：只接受 github.com 下的 https 地址。 */
export const githubHtmlUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/github\.com\/[\x21-\x7e]*$/, '只接受 https://github.com/ 下的链接')

/**
 * 游标：`<ISO 时间>|<GitHub 对象 id>`。同一种类按 (时间, id) 递增比较；
 * 时间取评论与审查的 `updated_at` / `submitted_at`、检查的 `completed_at`。
 */
export const prEventCursor = z
  .string()
  .max(128)
  .regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\|\d{1,20}$/, '游标形如 <ISO 时间>|<id>')

export const prEventPayload = z.strictObject({
  pr: prUrl.meta({ description: '规范化的 PR 链接（来自订阅，不来自评论内容）' }),
  kind: prEventKind,
  actor: z.string().min(1).max(64).meta({ description: 'GitHub 用户名或检查所属 App 的 slug' }),
  actor_kind: z
    .enum(['human', 'bot'])
    .meta({ description: 'bot：GitHub App、[bot] 账号或 CI 检查' }),
  allowed: z.boolean().meta({
    description: '中枢按 github.allowed_users 计算；bot 恒为 false。只有 allowed 的人类评论算请求',
  }),
  state: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z_]+$/)
    .optional()
    .meta({ description: '审查结论（approved / changes_requested / commented）或检查结论' }),
  text: z.string().max(PR_EVENT_TEXT_MAX).meta({ description: '内容（疑似密钥已遮蔽、超长截断）' }),
  chars: z.number().int().nonnegative().optional().meta({
    description: '截断前的字符数；只在截断时出现',
  }),
  url: githubHtmlUrl.meta({ description: '该条内容在 GitHub 上的链接' }),
  cursor: prEventCursor,
})
export type PrEventPayload = z.infer<typeof prEventPayload>

/** `raindown task show` 中的订阅。 */
export const prSubscriptionView = z
  .object({
    task_id: taskId,
    pr: prUrl,
    role: prSubscriptionRole,
    subscribed_at: timestamp,
    active: z.boolean(),
    ended_at: timestamp.nullable(),
    reason: prUnsubscribeReason.nullable(),
  })
  .meta({ title: 'PR subscription' })
export type PrSubscriptionView = z.infer<typeof prSubscriptionView>

/** `POST /v1/tasks/:id/unsubscribe` 请求体。 */
export const unsubscribeTaskRequest = z
  .strictObject({ pr: prUrl })
  .meta({ title: 'POST /v1/tasks/:id/unsubscribe' })
export type UnsubscribeTaskRequest = z.infer<typeof unsubscribeTaskRequest>
export const unsubscribeTaskData = z
  .object({
    subscription: prSubscriptionView,
    changed: z.boolean().meta({ description: 'false：订阅原本就已结束' }),
  })
  .meta({ title: 'POST /v1/tasks/:id/unsubscribe 响应' })
export type UnsubscribeTaskData = z.infer<typeof unsubscribeTaskData>

/** 游标比较：先比时间，再比 id（数字）。 */
export function compareCursor(a: string, b: string): number {
  const [at = '', aid = '0'] = a.split('|')
  const [bt = '', bid = '0'] = b.split('|')
  const ta = Date.parse(at)
  const tb = Date.parse(bt)
  if (ta !== tb) return ta < tb ? -1 : 1
  const ia = BigInt(aid)
  const ib = BigInt(bid)
  return ia === ib ? 0 : ia < ib ? -1 : 1
}

/** 由时间与 id 组成游标；时间统一为 toISOString 形式。 */
export function makeCursor(at: string, id: number | string): string | undefined {
  const ms = Date.parse(at)
  const idText = String(id)
  if (!Number.isFinite(ms) || !/^\d{1,20}$/.test(idText)) return undefined
  return `${new Date(ms).toISOString()}|${idText}`
}

/** 由任务自己的事件折叠：是否还有有效的 PR 订阅（任务阶段"空闲"的判定输入）。 */
export function hasActivePrSubscription(
  events: readonly { type: string; payload: unknown }[],
): boolean {
  const active = new Set<string>()
  for (const event of events) {
    const pr = (event.payload as { pr?: unknown } | null)?.pr
    if (typeof pr !== 'string') continue
    if (event.type === 'pr.subscribed') active.add(pr)
    else if (event.type === 'pr.unsubscribed') active.delete(pr)
  }
  return active.size > 0
}
