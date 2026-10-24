import { z } from 'zod'
import { actor, taskId, timestamp } from '../ledger/common.ts'
import { workspaceRef } from '../schema/common.ts'

/**
 * 收件箱条目的基础类型（add-m1-inbox design D1；inbox spec）。
 *
 * 条目是账本的投影：`inbox.item_created` / `inbox.item_updated` / `inbox.item_closed`
 * 折叠成 `inbox_items` 表，可随时从事件重建。这里只放数据形状，业务规则见 hub 的反应器。
 */

/** 条目级别：Interrupt 立即推送、Decide 成批推送、Digest 进每日摘要（inbox spec "推送节奏"）。 */
export const INBOX_LEVELS = ['interrupt', 'decide', 'digest'] as const
export type InboxLevel = (typeof INBOX_LEVELS)[number]
export const inboxLevel = z.enum(INBOX_LEVELS).meta({
  description: '条目级别：interrupt 立即推送，decide 成批推送，digest 写进每日摘要',
})

/** 级别的显示顺序（列表排序用）：interrupt 最前。 */
export const INBOX_LEVEL_RANK: Readonly<Record<InboxLevel, number>> = {
  interrupt: 0,
  decide: 1,
  digest: 2,
}

/**
 * 条目来源：
 * - `task`：任务进入 blocked；
 * - `proposal`：待确认的修改提案（state/proposals/，不在账本中）；
 * - `policy`：`auto-report` 策略的执行记录；
 * - `supervisor`：supervisor 的提问（变更 ④ 接入）；
 * - `digest`：每日摘要（3.3）。
 */
export const INBOX_SOURCES = ['task', 'proposal', 'policy', 'supervisor', 'digest'] as const
export type InboxSource = (typeof INBOX_SOURCES)[number]
export const inboxSource = z.enum(INBOX_SOURCES).meta({ description: '条目来源' })

/**
 * 条目上的操作（inbox spec "操作"，3.2 映射到已有操作）：
 * approve / deny / reply → `task_reply`；accept / reject → `kb_proposals_accept` / `kb_proposals_reject`；
 * dismiss（忽略）对任何未关闭的条目都可用，不写进 `actions`。
 */
export const INBOX_ACTIONS = ['approve', 'deny', 'reply', 'accept', 'reject'] as const
/** 写在条目上的操作。 */
export type InboxItemAction = (typeof INBOX_ACTIONS)[number]
/** 3.2 的 inbox_act 接受的操作：条目上的操作加上忽略。 */
export type InboxAction = InboxItemAction | 'dismiss'
export const inboxAction = z.enum(INBOX_ACTIONS).meta({ description: '条目上可用的操作' })

/** 操作发起的渠道（design D3）：Telegram、Web 页面或命令行。 */
export const INBOX_VIA = ['telegram', 'web', 'cli'] as const
export type InboxVia = (typeof INBOX_VIA)[number]
export const inboxVia = z.enum(INBOX_VIA).meta({ description: '操作发起的渠道' })

/**
 * 关闭原因（inbox spec "自动关闭"：注明原因）：
 * - `task_running`：任务回到 running（回复已送达或执行器自行恢复）；
 * - `task_queued`：任务带着回复或被人工重新排队；
 * - `task_done` / `task_failed` / `task_cancelled`：任务进入终态；
 * - `superseded`：同一任务再次卡住（原因变了），由新条目取代；
 * - `proposal_accepted` / `proposal_rejected` / `proposal_removed`：提案已处理或已不存在；
 * - `answered`：提问已被答复（变更 ④）；
 * - `dismissed`：用户忽略（3.2）；`acted`：用户在条目上执行了操作（3.2）。
 */
export const INBOX_CLOSE_REASONS = [
  'task_running',
  'task_queued',
  'task_done',
  'task_failed',
  'task_cancelled',
  'superseded',
  'proposal_accepted',
  'proposal_rejected',
  'proposal_removed',
  'answered',
  'dismissed',
  'acted',
] as const
export type InboxCloseReason = (typeof INBOX_CLOSE_REASONS)[number]
export const inboxCloseReason = z.enum(INBOX_CLOSE_REASONS).meta({ description: '条目关闭原因' })

/**
 * 条目 id：`<来源前缀>.<来源内标识>`，由来源确定性地生成，同一来源只会有一个条目（幂等）：
 * - 任务卡住：`blk.<task.blocked 的 seq>`；
 * - 提案：`prop.<提案 id>`；
 * - 策略记录：`pol.<policy.decided 的 seq>`。
 * 渠道里用的短 id 是 `short_id`（创建事件 seq 的 base36），不在这里。
 */
export const INBOX_ITEM_ID_RE = /^[a-z]{2,12}\.[A-Za-z0-9_.-]{1,120}$/
export const inboxItemId = z
  .string()
  .regex(INBOX_ITEM_ID_RE, '条目 id 应形如 <来源前缀>.<标识>')
  .meta({ description: '条目 id，例如 blk.42、prop.<提案 id>' })

/** 标题、正文、关闭说明的长度上限（字符）；账本写入前按此截断（scrub.ts）。 */
export const INBOX_TITLE_MAX = 200
export const INBOX_BODY_MAX = 4000
export const INBOX_NOTE_MAX = 1000

/** 条目视图（3.2 的 `inbox_list` 与渠道都读它）。 */
export const inboxItemView = z
  .strictObject({
    id: inboxItemId,
    short_id: z.string().meta({ description: '短 id：创建事件 seq 的 base36，供渠道按钮使用' }),
    level: inboxLevel,
    source: inboxSource,
    source_ref: z.string().meta({ description: '关联对象：任务 id、提案 id 或源事件 seq' }),
    reason: z.string().nullable().meta({ description: '来源内的原因，例如卡住原因 question' }),
    workspace: workspaceRef.nullable(),
    task_id: taskId.nullable(),
    title: z.string(),
    body: z.string(),
    actions: z.array(inboxAction),
    state: z.enum(['open', 'closed']),
    created_at: timestamp,
    created_by: actor,
    updated_at: timestamp,
    deferred_until: timestamp
      .nullable()
      .meta({ description: '静默时段内生成的 Interrupt 条目顺延到此时推送（3.3）' }),
    pushed_at: timestamp.nullable().meta({ description: '首次推送到渠道的时间（4.1 维护）' }),
    closed: z
      .strictObject({
        reason: inboxCloseReason,
        note: z.string().nullable(),
        at: timestamp,
        by: actor,
        cause_actor: actor
          .nullable()
          .meta({ description: '导致关闭的操作者，例如答复任务的 user' }),
        via: inboxVia.nullable(),
      })
      .nullable(),
  })
  .meta({ title: 'Inbox item', description: '收件箱条目（inbox_items 投影的一行）' })
export type InboxItemView = z.infer<typeof inboxItemView>

/** 条目的短 id：创建事件 seq 的 base36。 */
export const inboxShortId = (createdSeq: number): string => createdSeq.toString(36)

/** 操作入口接受完整 id 或表格中的 base36 短 id。 */
export const inboxItemRef = z.union([inboxItemId, z.string().regex(/^[0-9a-z]{1,11}$/)])

export const inboxListQuery = z.strictObject({
  state: z.enum(['open', 'closed']).default('open'),
  level: inboxLevel.optional(),
  workspace: workspaceRef.optional(),
})
export type InboxListQuery = z.infer<typeof inboxListQuery>
export const inboxListData = z.object({ items: z.array(inboxItemView) })

export const inboxActRequest = z.strictObject({
  action: z.enum([...INBOX_ACTIONS, 'dismiss']),
  text: z.string().trim().min(1).max(16_384).optional(),
  via: inboxVia.optional(),
})
export type InboxActRequest = z.infer<typeof inboxActRequest>
/** 非 dismiss 操作成功时条目可能仍在等待底层状态变化。 */
export const inboxActData = z.object({ item: inboxItemView })
