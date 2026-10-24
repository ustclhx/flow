import {
  ACTIVITY_TEXT_MAX,
  type Activity,
  checkTaskEvent,
  type Database,
  type EventType,
  type eventPayloads,
  fail,
  INBOX_LEVEL_RANK,
  type InboxItemView,
  type InboxLevel,
  type InboxSource,
  inboxShortId,
  type LedgerEvent,
  type LedgerEventDraft,
  type ListTasksQuery,
  type NodeView,
  ok,
  openDatabase,
  parseLedgerEventDraft,
  type RebuildData,
  type ReplyView,
  type Result,
  redactKnownSecrets,
  type SqlValue,
  sanitizeText,
  type TaskResume,
  type TaskStatus,
  type TaskView,
} from '@flow/core'
import type { z } from 'zod'
import { redactDeep } from '../secrets/redactor.ts'
import { type Applier, createApplier } from './apply.ts'
import type { EventFilter, LedgerMaintenance, LedgerReader } from './port.ts'
import {
  LEDGER_COLUMN_MIGRATIONS,
  LEDGER_DDL,
  PROJECTION_KEYS,
  PROJECTION_TABLES,
  type ProjectionTable,
  SOFT_COLUMNS,
} from './schema.ts'
import { scrubPayload } from './scrub.ts'

/**
 * 账本 store（design D1、D2；tasks.md 2.1、2.2）。
 *
 * 写入流程：在同一个事务里 校验信封与载荷（`parseLedgerEventDraft`）→ 基于投影当前状态检查
 * 状态机（`checkTaskEvent`）与一致性 → 插入事件 → `apply(event)` 更新投影；事务提交后按序通知
 * 订阅者。任何一步失败都整体回滚，不写入任何东西。
 */

/** 待写入事件：没有 seq / ts；actor 由 `append` 的选项提供。 */
export type EventInput = {
  [T in EventType]: {
    type: T
    workspace?: string
    task_id?: string
    actor?: string
    /** 调用方形态：带默认值的字段可省略，写入时由 schema 补齐。 */
    payload: z.input<(typeof eventPayloads)[T]>
  }
}[EventType]

export interface AppendOptions {
  /** 操作者，写入事件信封的 `actor`。 */
  actor: string
}

export interface RebuildOptions {
  /** 活动租约重置后的有效期秒数；缺省用各租约 `lease.granted` 时的 ttl_s（D2）。 */
  leaseTtlS?: number
  /** 写入 `hub.rebuilt` 的操作者，默认 `hub`。 */
  actor?: string
}

export interface LeaseRecord {
  lease_id: string
  task_id: string
  node_id: string
  attempt: number
  token_sha256: string
  ttl_s: number
  granted_at: string
  expires_at: string
  state: 'active' | 'released' | 'expired'
  ended_at: string | null
}

export interface OpenLedgerOptions {
  /** 毫秒时钟，默认 `Date.now`；事件 ts 与软状态时间都取自它。测试可注入。 */
  now?: () => number
  /** 每个任务保留的最近活动条数，默认 50。 */
  activityKeep?: number
  /**
   * 写入前对事件载荷与活动片段中所有字符串做的替换（secret-hygiene "已知密钥值的脱敏"）。
   * 中枢传入脱敏名单；重建只重放已写入（已脱敏）的事件，不再替换。
   */
  redact?: (text: string) => string
}

/** 收件箱条目的查询条件（3.2 的 inbox_list 在此之上加参数校验）。 */
export interface InboxItemFilter {
  state?: 'open' | 'closed'
  level?: InboxLevel
  workspace?: string
  task_id?: string
  source?: InboxSource
  /** 默认 200。 */
  limit?: number
}

/** 每张投影表按主键排序后的行（JSON 字段保持原文）。 */
export type ProjectionSnapshot = Record<ProjectionTable, Record<string, unknown>[]>

export interface LedgerStore extends LedgerReader, LedgerMaintenance {
  /** 追加一条事件。 */
  append(draft: EventInput, opts: AppendOptions): Result<LedgerEvent>
  /** 在一个事务里依次追加多条事件；任一条不合法则全部不写。 */
  appendMany(drafts: readonly EventInput[], opts: AppendOptions): Result<LedgerEvent[]>
  /** 清空投影并按 seq 重放全部事件，软状态按 D2 重置，最后写入 `hub.rebuilt`。 */
  rebuild(opts?: RebuildOptions): Result<RebuildData>

  /** 最近一条事件；beforeSeq 用于取得本次 hub.started 之前的恢复边界。 */
  latestEvent(beforeSeq?: number, type?: EventType): LedgerEvent | null
  /** 某时刻（含）之后策略自动放行（auto、auto-report）的次数（Telegram `/status`）。 */
  countAutoDecisions(sinceIso: string): number
  hasScheduleFire(ruleId: string, plannedAt: string): boolean

  getTask(id: string): TaskView | null
  listTasks(filter?: Partial<ListTasksQuery>): TaskView[]
  /** 全部 queued 任务，按创建先后（created_seq 升序），供租约分配使用。 */
  queuedTasks(): TaskView[]
  findTaskByIdempotencyKey(key: string): TaskView | null
  /** 某任务的全部事件（按 seq）。 */
  taskEvents(taskId: string): LedgerEvent[]
  getNode(nodeId: string): NodeView | null
  listNodes(): NodeView[]
  getLease(leaseId: string): LeaseRecord | null
  /** 任务当前的活动租约。 */
  activeLease(taskId: string): LeaseRecord | null
  activeLeases(): LeaseRecord[]
  /** 某任务最早一条待送达的回复。 */
  pendingReply(taskId: string): ReplyView | null
  getReply(replyId: string): ReplyView | null
  /** 某任务的全部回复（按收到先后）。 */
  taskReplies(taskId: string): ReplyView[]
  /** 任务带着回复重新排队后，下一次执行要带上的恢复信息。 */
  taskResume(taskId: string): TaskResume | null

  getInboxItem(itemId: string): InboxItemView | null
  /** 按短 id（创建事件 seq 的 base36）找条目，渠道按钮用。 */
  getInboxItemByShortId(shortId: string): InboxItemView | null
  /** 某渠道的一条消息里包含的条目 id（按条目创建先后）。 */
  channelMessageItems(channel: string, ref: string): string[]
  /** 某渠道上条目已关闭、但消息还没改为"已处理"的消息，按发送先后。 */
  pendingChannelUpdates(channel: string): { ref: string; item_ids: string[] }[]
  /** 某渠道上记为推送失败（op=failed）的条目数。 */
  channelFailedCount(channel: string): number
  /** 按级别（interrupt → digest）再按创建先后排序。 */
  listInboxItems(filter?: InboxItemFilter): InboxItemView[]
  /**
   * 收件箱反应器已处理到的账本位置的下界：全部收件箱事件中 `source_seq` 与 `cause_seq` 的最大值。
   * 反应器按 seq 顺序处理，写出某个源事件的条目时，更早的事件都已处理过。
   */
  inboxCursor(): number

  // ---- 软状态（不入账本，D2） ----
  /** 刷新节点最近活动时间；节点不存在时返回 false。 */
  touchNode(nodeId: string, at?: string): boolean
  /** 续约：只更新活动租约的到期时间；租约不存在或已结束时返回 false。 */
  renewLease(leaseId: string, expiresAt: string): boolean
  /** 把全部活动租约的到期时间顺延 ms 毫秒（睡眠恢复，D5），返回受影响的租约数。 */
  extendActiveLeases(ms: number): number
  /** 记录任务活动：保留最近 N 条，更新 last_activity_at。任务不存在时返回 false。 */
  recordActivity(taskId: string, activities: readonly Activity[]): boolean
  taskActivity(taskId: string): Activity[]

  /** 投影表快照；`includeSoft: false` 时去掉软状态列（性质测试与诊断用）。 */
  snapshot(opts?: { includeSoft?: boolean }): ProjectionSnapshot
}

/** 打开（必要时创建）账本数据库并建表。 */
export async function openLedger(path: string, opts: OpenLedgerOptions = {}): Promise<LedgerStore> {
  const db = await openDatabase(path)
  db.exec(LEDGER_DDL)
  migrateColumns(db)
  return createStore(db, opts)
}

/** 给旧账本补上新增的投影列（见 `LEDGER_COLUMN_MIGRATIONS`）。 */
function migrateColumns(db: Database) {
  for (const m of LEDGER_COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl)
  }
}

class Abort extends Error {
  constructor(readonly result: Result<never>) {
    super(result.ok ? 'abort' : result.error.message)
  }
}

interface EventRow {
  seq: number
  ts: string
  type: string
  workspace: string | null
  task_id: string | null
  actor: string
  payload_json: string
}

interface TaskRow {
  id: string
  workspace: string
  status: TaskStatus
  contract_json: string
  attempt: number
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  cancel_requested: number
  blocked_json: string | null
  result_json: string | null
  created_by: string
  last_activity_at: string | null
  lease_id: string | null
  lease_node_id: string | null
  lease_expires_at: string | null
}

interface ReplyRow {
  id: string
  task_id: string
  kind: ReplyView['kind']
  text: string | null
  by: string
  created_at: string
  state: ReplyView['state']
  delivered_at: string | null
}

const rowToReply = (r: ReplyRow): ReplyView => ({
  id: r.id,
  task_id: r.task_id,
  kind: r.kind,
  text: r.text,
  by: r.by,
  created_at: r.created_at,
  state: r.state,
  delivered_at: r.delivered_at,
})

interface NodeRow {
  node_id: string
  hostname: string
  version: string
  capabilities_json: string
  executors_json: string
  concurrency: number
  registered_at: string
  last_seen_at: string | null
  active_leases: number
}

interface InboxRow {
  id: string
  level: InboxLevel
  source: InboxSource
  source_ref: string
  reason: string | null
  workspace: string | null
  task_id: string | null
  title: string
  body: string
  actions_json: string
  state: 'open' | 'closed'
  created_seq: number
  created_at: string
  created_by: string
  updated_at: string
  deferred_until: string | null
  pushed_at: string | null
  channel_refs_json: string
  close_reason: string | null
  close_note: string | null
  closed_at: string | null
  closed_by: string | null
  cause_actor: string | null
  closed_via: string | null
}

function rowToInbox(r: InboxRow): InboxItemView {
  return {
    id: r.id,
    short_id: inboxShortId(r.created_seq),
    level: r.level,
    source: r.source,
    source_ref: r.source_ref,
    reason: r.reason,
    workspace: r.workspace,
    task_id: r.task_id,
    title: r.title,
    body: r.body,
    actions: JSON.parse(r.actions_json),
    state: r.state,
    created_at: r.created_at,
    created_by: r.created_by,
    updated_at: r.updated_at,
    deferred_until: r.deferred_until,
    pushed_at: r.pushed_at,
    channels: JSON.parse(r.channel_refs_json),
    closed:
      r.state === 'closed' && r.closed_at !== null && r.closed_by !== null
        ? {
            reason: r.close_reason as NonNullable<InboxItemView['closed']>['reason'],
            note: r.close_note,
            at: r.closed_at,
            by: r.closed_by,
            cause_actor: r.cause_actor,
            via: r.closed_via as NonNullable<InboxItemView['closed']>['via'],
          }
        : null,
  }
}

const LEVEL_ORDER = `CASE level ${Object.entries(INBOX_LEVEL_RANK)
  .map(([level, rank]) => `WHEN '${level}' THEN ${rank}`)
  .join(' ')} END`

const TASK_SELECT = `SELECT t.*, l.lease_id AS lease_id, l.node_id AS lease_node_id,
  l.expires_at AS lease_expires_at
  FROM tasks t LEFT JOIN leases l ON l.task_id = t.id AND l.state = 'active'`

const NODE_SELECT = `SELECT n.*, (SELECT COUNT(*) FROM leases l
  WHERE l.node_id = n.node_id AND l.state = 'active') AS active_leases FROM nodes n`

function rowToEvent(r: EventRow): LedgerEvent {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    ...(r.workspace === null ? {} : { workspace: r.workspace }),
    ...(r.task_id === null ? {} : { task_id: r.task_id }),
    actor: r.actor,
    payload: JSON.parse(r.payload_json),
  } as LedgerEvent
}

function rowToTask(r: TaskRow): TaskView {
  return {
    id: r.id,
    workspace: r.workspace,
    status: r.status,
    contract: JSON.parse(r.contract_json),
    attempt: r.attempt,
    created_at: r.created_at,
    updated_at: r.updated_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    cancel_requested: r.cancel_requested === 1,
    // lease_held 不单独存储：blocked 期间仍有活动租约即为持有（D7a）。
    blocked:
      r.blocked_json === null
        ? null
        : { ...JSON.parse(r.blocked_json), lease_held: r.lease_id !== null },
    lease:
      r.lease_id === null || r.lease_node_id === null || r.lease_expires_at === null
        ? null
        : { lease_id: r.lease_id, node_id: r.lease_node_id, expires_at: r.lease_expires_at },
    result: r.result_json === null ? null : JSON.parse(r.result_json),
    created_by: r.created_by,
    last_activity_at: r.last_activity_at,
  }
}

function rowToNode(r: NodeRow): NodeView {
  return {
    node_id: r.node_id,
    hostname: r.hostname,
    version: r.version,
    capabilities: JSON.parse(r.capabilities_json),
    executors: JSON.parse(r.executors_json),
    concurrency: r.concurrency,
    registered_at: r.registered_at,
    last_seen_at: r.last_seen_at,
    active_leases: r.active_leases,
  }
}

const invalidEvent = (message: string, details?: unknown) =>
  fail('failure', 'invalid_event', message, details)

function createStore(db: Database, opts: OpenLedgerOptions): LedgerStore {
  const nowMs = opts.now ?? Date.now
  const iso = (ms = nowMs()) => new Date(ms).toISOString()
  const activityKeep = opts.activityKeep ?? 50
  const redact = opts.redact
  /** 活动 data 等结构化字段只做名单替换（见 scrub.ts）。 */
  const knownOnly = (text: string) => redactKnownSecrets(redact ? redact(text) : text)
  const apply: Applier = createApplier(db)
  const listeners = new Set<(event: LedgerEvent) => void>()

  const all = <T>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[]
  const get = <T>(sql: string, ...params: SqlValue[]) =>
    db.prepare(sql).get(...params) as T | undefined
  const run = (sql: string, ...params: SqlValue[]) => db.prepare(sql).run(...params)

  const taskState = (id: string) =>
    get<{ status: TaskStatus; workspace: string; attempt: number }>(
      'SELECT status, workspace, attempt FROM tasks WHERE id = ?',
      id,
    )

  const hasActiveLease = (taskId: string | undefined) =>
    !!get("SELECT 1 FROM leases WHERE task_id = ? AND state = 'active'", taskId ?? null)
  const noLease = (from: TaskStatus | null, type: string, why: string) =>
    fail('failure', 'invalid_transition', why, { from, type })
  /** 事件引用的回复必须是该任务尚未送达的回复。 */
  const pendingReplyOf = (draft: {
    task_id?: string | undefined
    payload: { reply_id?: string | undefined }
  }) => {
    const r = get<{ task_id: string; state: string }>(
      'SELECT task_id, state FROM replies WHERE id = ?',
      draft.payload.reply_id ?? null,
    )
    return r && r.task_id === draft.task_id && r.state === 'pending'
      ? ok(null)
      : invalidEvent(`回复 ${draft.payload.reply_id} 不是该任务待送达的回复`)
  }

  /** 写入前的校验：信封、状态机与投影一致性。只读投影，不写任何东西。 */
  function validate(draft: LedgerEventDraft): Result<null> {
    const task = draft.task_id === undefined ? undefined : taskState(draft.task_id)
    const checked = checkTaskEvent(task?.status ?? null, draft)
    if (!checked.ok) return checked
    if (task !== undefined && draft.workspace !== task.workspace) {
      return invalidEvent(`事件的 workspace ${draft.workspace} 与任务的 ${task.workspace} 不一致`)
    }
    switch (draft.type) {
      case 'policy.decided':
        return draft.payload.task_id === draft.task_id
          ? ok(null)
          : invalidEvent('policy.decided 的 task_id 必须与信封一致')
      case 'task.created': {
        const c = draft.payload.contract
        if (c.workspace !== draft.workspace) {
          return invalidEvent('task.created 的 workspace 必须与合同中的 workspace 一致')
        }
        if (c.idempotency_key !== undefined) {
          const hit = get<{ id: string }>(
            'SELECT id FROM tasks WHERE idempotency_key = ?',
            c.idempotency_key,
          )
          if (hit) {
            return fail('failure', 'idempotency_conflict', `幂等键已被任务 ${hit.id} 使用`, {
              task_id: hit.id,
            })
          }
        }
        return ok(null)
      }
      case 'task.started': {
        const expected = (task?.attempt ?? 0) + 1
        if (draft.payload.attempt !== expected) {
          return invalidEvent(`task.started 的 attempt 应为 ${expected}`)
        }
        return ok(null)
      }
      case 'lease.granted': {
        if (get('SELECT 1 FROM leases WHERE lease_id = ?', draft.payload.lease_id)) {
          return invalidEvent(`租约 ${draft.payload.lease_id} 已存在`)
        }
        if (
          get("SELECT 1 FROM leases WHERE task_id = ? AND state = 'active'", draft.task_id ?? null)
        ) {
          return fail('failure', 'invalid_transition', '任务已有活动租约，不能再次分配', {
            from: task?.status ?? null,
            type: draft.type,
          })
        }
        return ok(null)
      }
      case 'task.blocked': {
        if (draft.payload.lease_held && !hasActiveLease(draft.task_id)) {
          return noLease(task?.status ?? null, draft.type, 'lease_held=true 要求任务仍有活动租约')
        }
        return ok(null)
      }
      case 'task.unblocked': {
        // D7a：没有活动租约就不能回到 running（否则成了"running 但无人持有"），应改为重新排队。
        if (!hasActiveLease(draft.task_id)) {
          return noLease(task?.status ?? null, draft.type, '任务没有活动租约，应改为重新排队')
        }
        if (draft.payload.reply_id !== undefined) return pendingReplyOf(draft)
        return ok(null)
      }
      case 'task.cancel_requested': {
        if (task?.status === 'blocked' && !hasActiveLease(draft.task_id)) {
          return noLease('blocked', draft.type, '没有节点持有该任务，应直接取消')
        }
        return ok(null)
      }
      case 'task.replied': {
        if (get('SELECT 1 FROM replies WHERE id = ?', draft.payload.reply_id)) {
          return invalidEvent(`回复 ${draft.payload.reply_id} 已存在`)
        }
        const pending = get<{ id: string }>(
          "SELECT id FROM replies WHERE task_id = ? AND state = 'pending'",
          draft.task_id ?? null,
        )
        if (pending) {
          return fail('failure', 'reply_pending', `任务已有尚未送达的回复 ${pending.id}`, {
            reply_id: pending.id,
          })
        }
        return ok(null)
      }
      case 'task.requeued_with_reply':
        return pendingReplyOf(draft)
      case 'task.lease_expired': {
        if (task?.status === 'blocked' && !hasActiveLease(draft.task_id)) {
          return noLease('blocked', draft.type, '任务卡住时没有持有租约，不存在可过期的租约')
        }
        const lease = get<{ task_id: string; state: string }>(
          'SELECT task_id, state FROM leases WHERE lease_id = ?',
          draft.payload.lease_id,
        )
        if (!lease || lease.task_id !== draft.task_id || lease.state !== 'active') {
          return invalidEvent(`租约 ${draft.payload.lease_id} 不是该任务的活动租约`)
        }
        return ok(null)
      }
      case 'inbox.item_created': {
        // 条目 id 由来源确定性生成：同一来源重复写入（反应器重放、重启续跑）在这里被拒绝。
        if (get('SELECT 1 FROM inbox_items WHERE id = ?', draft.payload.item_id)) {
          return fail('failure', 'duplicate_item', `收件箱条目 ${draft.payload.item_id} 已存在`, {
            item_id: draft.payload.item_id,
          })
        }
        return ok(null)
      }
      case 'inbox.pushed': {
        // 推送记录不检查条目状态：消息发出与条目关闭可能交错，已发出的消息必须如实入账。
        for (const itemId of draft.payload.item_ids) {
          if (!get('SELECT 1 FROM inbox_items WHERE id = ?', itemId)) {
            return fail('failure', 'not_found', `收件箱条目 ${itemId} 不存在`)
          }
          if (
            draft.payload.ref !== undefined &&
            draft.payload.op !== 'send' &&
            !get(
              'SELECT 1 FROM channel_messages WHERE channel = ? AND ref = ? AND item_id = ?',
              draft.payload.channel,
              draft.payload.ref,
              itemId,
            )
          ) {
            return invalidEvent(`条目 ${itemId} 不在渠道 ${draft.payload.channel} 的该消息中`)
          }
        }
        return ok(null)
      }
      case 'inbox.item_updated':
      case 'inbox.item_closed': {
        const item = get<{ state: string }>(
          'SELECT state FROM inbox_items WHERE id = ?',
          draft.payload.item_id,
        )
        if (!item) {
          return fail('failure', 'not_found', `收件箱条目 ${draft.payload.item_id} 不存在`)
        }
        if (item.state !== 'open') {
          return fail('failure', 'item_closed', `收件箱条目 ${draft.payload.item_id} 已关闭`, {
            item_id: draft.payload.item_id,
          })
        }
        return ok(null)
      }
      case 'schedule.fired': {
        const dup = get(
          'SELECT 1 FROM schedule_fires WHERE rule_id = ? AND planned_at = ?',
          draft.payload.rule_id,
          draft.payload.planned_at,
        )
        return dup
          ? fail('failure', 'duplicate_fire', `规则 ${draft.payload.rule_id} 在该计划时间已触发`)
          : ok(null)
      }
      default:
        return ok(null)
    }
  }

  const insertEvent = db.prepare(
    `INSERT INTO events (ts, type, workspace, task_id, actor, payload_json)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
  )

  /** 事务内：校验 → 插入 → apply。不合法时抛出 Abort 让事务回滚。 */
  function writeOne(raw: unknown, ts: string): LedgerEvent {
    // 先脱敏再校验：脱敏后的载荷仍须符合 schema。
    const parsed = parseLedgerEventDraft(
      raw !== null && typeof raw === 'object' && 'payload' in raw
        ? {
            ...raw,
            payload: scrubPayload(
              String((raw as { type?: unknown }).type),
              (raw as { payload: unknown }).payload,
              redact,
            ),
          }
        : raw,
    )
    if (!parsed.ok) throw new Abort(parsed)
    const draft = parsed.data
    const valid = validate(draft)
    if (!valid.ok) throw new Abort(valid)
    const row = insertEvent.get(
      ts,
      draft.type,
      draft.workspace ?? null,
      draft.task_id ?? null,
      draft.actor,
      JSON.stringify(draft.payload),
    ) as { seq: number }
    const event = { ...draft, seq: row.seq, ts } as LedgerEvent
    apply(event)
    return event
  }

  function notify(events: readonly LedgerEvent[]) {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // 订阅者的异常不影响写入方与其他订阅者。
        }
      }
    }
  }

  /** 在事务中执行 fn；Abort 转为失败结果，其他异常原样抛出。 */
  function inTransaction<T>(fn: () => T): Result<T> {
    try {
      return ok(db.transaction(fn))
    } catch (err) {
      if (err instanceof Abort) return err.result
      throw err
    }
  }

  function appendMany(drafts: readonly EventInput[], o: AppendOptions): Result<LedgerEvent[]> {
    if (drafts.length === 0) return ok([])
    const ts = iso()
    const result = inTransaction(() => drafts.map((d) => writeOne({ ...d, actor: o.actor }, ts)))
    if (result.ok) notify(result.data)
    return result
  }

  function eventsAfter(after: number, filter: EventFilter = {}, limit = 500): LedgerEvent[] {
    const where = ['seq > ?']
    const params: SqlValue[] = [after]
    if (filter.task_id !== undefined) {
      where.push('task_id = ?')
      params.push(filter.task_id)
    }
    if (filter.workspace !== undefined) {
      where.push('workspace = ?')
      params.push(filter.workspace)
    }
    params.push(limit)
    return all<EventRow>(
      `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
      ...params,
    ).map(rowToEvent)
  }

  function rebuild(o: RebuildOptions = {}): Result<RebuildData> {
    const started = nowMs()
    let replayed: LedgerEvent[] = []
    try {
      replayed = db.transaction(() => {
        for (const table of PROJECTION_TABLES) run(`DELETE FROM ${table}`)
        let count = 0
        let after = 0
        for (;;) {
          const batch = eventsAfter(after, {}, 1000)
          if (batch.length === 0) break
          for (const event of batch) {
            // 重放时同样校验，账本自相矛盾时整体回滚，保留原投影。
            const valid = validate(event)
            if (!valid.ok) {
              throw new Abort(
                fail(
                  'failure',
                  'ledger_inconsistent',
                  `重放到 seq ${event.seq}（${event.type}）时校验失败：${valid.error.message}`,
                  { seq: event.seq, error: valid.error },
                ),
              )
            }
            apply(event)
          }
          count += batch.length
          after = batch[batch.length - 1]?.seq ?? after
        }
        // 软状态（D2）：清空活动与心跳；活动租约的到期时间重置为"重建时刻 + TTL"。
        const now = nowMs()
        run("UPDATE tasks SET last_activity_at = NULL, activity_json = '[]'")
        run('UPDATE nodes SET last_seen_at = NULL')
        for (const l of all<{ lease_id: string; ttl_s: number }>(
          "SELECT lease_id, ttl_s FROM leases WHERE state = 'active'",
        )) {
          const ttl = o.leaseTtlS ?? l.ttl_s
          run(
            'UPDATE leases SET expires_at = ? WHERE lease_id = ?',
            iso(now + ttl * 1000),
            l.lease_id,
          )
        }
        const marker = writeOne(
          {
            type: 'hub.rebuilt',
            actor: o.actor ?? 'hub',
            payload: { events_replayed: count, duration_ms: Math.max(0, now - started) },
          },
          iso(now),
        )
        return [marker]
      })
    } catch (err) {
      if (err instanceof Abort) return err.result
      return fail('failure', 'internal_error', `重建失败：${(err as Error).message}`)
    }
    notify(replayed)
    const marker = replayed[0] as Extract<LedgerEvent, { type: 'hub.rebuilt' }>
    return ok({ ...marker.payload, ledger_seq: marker.seq })
  }

  const leaseRow = (r: LeaseRecord | undefined) => r ?? null

  return {
    seq: () => get<{ s: number }>('SELECT COALESCE(MAX(seq), 0) AS s FROM events')?.s ?? 0,
    eventsAfter,
    latestEvent(beforeSeq, type) {
      const row = get<EventRow>(
        'SELECT * FROM events WHERE seq < ? AND (? IS NULL OR type = ?) ORDER BY seq DESC LIMIT 1',
        beforeSeq ?? Number.MAX_SAFE_INTEGER,
        type ?? null,
        type ?? null,
      )
      return row ? rowToEvent(row) : null
    },
    countAutoDecisions(sinceIso) {
      return (
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events WHERE type = 'policy.decided' AND ts >= ?
             AND json_extract(payload_json, '$.level') IN ('auto', 'auto-report')`,
          sinceIso,
        )?.n ?? 0
      )
    },
    hasScheduleFire(ruleId, plannedAt) {
      return !!get(
        'SELECT 1 FROM schedule_fires WHERE rule_id = ? AND planned_at = ?',
        ruleId,
        plannedAt,
      )
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    append(draft, o) {
      const r = appendMany([draft], o)
      return r.ok ? ok(r.data[0] as LedgerEvent) : r
    },
    appendMany,
    rebuild,

    getTask(id) {
      const r = get<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, id)
      return r ? rowToTask(r) : null
    },
    listTasks(filter = {}) {
      const where: string[] = []
      const params: SqlValue[] = []
      for (const key of ['workspace', 'status', 'parent'] as const) {
        const v = filter[key]
        if (v !== undefined) {
          where.push(`t.${key} = ?`)
          params.push(v)
        }
      }
      params.push(filter.limit ?? 50)
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      return all<TaskRow>(
        `${TASK_SELECT} ${clause} ORDER BY t.created_seq DESC LIMIT ?`,
        ...params,
      ).map(rowToTask)
    },
    queuedTasks() {
      return all<TaskRow>(
        `${TASK_SELECT} WHERE t.status = 'queued' ORDER BY t.created_seq ASC`,
      ).map(rowToTask)
    },
    findTaskByIdempotencyKey(key) {
      const r = get<TaskRow>(`${TASK_SELECT} WHERE t.idempotency_key = ?`, key)
      return r ? rowToTask(r) : null
    },
    taskEvents(taskId) {
      return all<EventRow>('SELECT * FROM events WHERE task_id = ? ORDER BY seq', taskId).map(
        rowToEvent,
      )
    },
    getNode(nodeId) {
      const r = get<NodeRow>(`${NODE_SELECT} WHERE n.node_id = ?`, nodeId)
      return r ? rowToNode(r) : null
    },
    listNodes() {
      return all<NodeRow>(`${NODE_SELECT} ORDER BY n.node_id`).map(rowToNode)
    },
    getLease(leaseId) {
      return leaseRow(get<LeaseRecord>('SELECT * FROM leases WHERE lease_id = ?', leaseId))
    },
    activeLease(taskId) {
      return leaseRow(
        get<LeaseRecord>("SELECT * FROM leases WHERE task_id = ? AND state = 'active'", taskId),
      )
    },
    activeLeases() {
      return all<LeaseRecord>("SELECT * FROM leases WHERE state = 'active' ORDER BY expires_at")
    },
    pendingReply(taskId) {
      const r = get<ReplyRow>(
        "SELECT * FROM replies WHERE task_id = ? AND state = 'pending' ORDER BY created_seq LIMIT 1",
        taskId,
      )
      return r ? rowToReply(r) : null
    },
    getReply(replyId) {
      const r = get<ReplyRow>('SELECT * FROM replies WHERE id = ?', replyId)
      return r ? rowToReply(r) : null
    },
    taskReplies(taskId) {
      return all<ReplyRow>(
        'SELECT * FROM replies WHERE task_id = ? ORDER BY created_seq',
        taskId,
      ).map(rowToReply)
    },
    taskResume(taskId) {
      const r = get<{ resume_json: string | null }>(
        'SELECT resume_json FROM tasks WHERE id = ?',
        taskId,
      )
      return r?.resume_json ? (JSON.parse(r.resume_json) as TaskResume) : null
    },

    getInboxItem(itemId) {
      const r = /^[0-9a-z]{1,11}$/.test(itemId)
        ? get<InboxRow>(
            'SELECT * FROM inbox_items WHERE created_seq = ?',
            Number.parseInt(itemId, 36),
          )
        : get<InboxRow>('SELECT * FROM inbox_items WHERE id = ?', itemId)
      return r ? rowToInbox(r) : null
    },
    getInboxItemByShortId(shortId) {
      if (!/^[0-9a-z]{1,12}$/.test(shortId)) return null
      const seq = Number.parseInt(shortId, 36)
      if (!Number.isSafeInteger(seq)) return null
      const r = get<InboxRow>('SELECT * FROM inbox_items WHERE created_seq = ?', seq)
      return r ? rowToInbox(r) : null
    },
    channelMessageItems(channel, ref) {
      return all<{ item_id: string }>(
        `SELECT m.item_id FROM channel_messages m JOIN inbox_items i ON i.id = m.item_id
         WHERE m.channel = ? AND m.ref = ? AND m.ref != '' ORDER BY i.created_seq`,
        channel,
        ref,
      ).map((r) => r.item_id)
    },
    pendingChannelUpdates(channel) {
      const rows = all<{ ref: string; item_id: string }>(
        `SELECT m.ref, m.item_id FROM channel_messages m JOIN inbox_items i ON i.id = m.item_id
         WHERE m.channel = ? AND m.synced_at IS NULL AND m.ref != '' AND i.state = 'closed'
         ORDER BY m.sent_seq, i.created_seq`,
        channel,
      )
      const out = new Map<string, string[]>()
      for (const r of rows) out.set(r.ref, [...(out.get(r.ref) ?? []), r.item_id])
      return [...out].map(([ref, item_ids]) => ({ ref, item_ids }))
    },
    channelFailedCount(channel) {
      return (
        get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM channel_messages WHERE channel = ? AND failed_at IS NOT NULL',
          channel,
        )?.n ?? 0
      )
    },
    listInboxItems(filter = {}) {
      const where: string[] = []
      const params: SqlValue[] = []
      for (const key of ['state', 'level', 'workspace', 'task_id', 'source'] as const) {
        const v = filter[key]
        if (v !== undefined) {
          where.push(`${key} = ?`)
          params.push(v)
        }
      }
      params.push(filter.limit ?? 200)
      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      return all<InboxRow>(
        `SELECT * FROM inbox_items ${clause} ORDER BY ${LEVEL_ORDER}, created_seq LIMIT ?`,
        ...params,
      ).map(rowToInbox)
    },
    inboxCursor() {
      return (
        get<{ s: number }>(
          `SELECT MAX(COALESCE(MAX(source_seq), 0), COALESCE(MAX(cause_seq), 0)) AS s
           FROM inbox_items`,
        )?.s ?? 0
      )
    },

    touchNode(nodeId, at = iso()) {
      if (!get('SELECT 1 FROM nodes WHERE node_id = ?', nodeId)) return false
      run('UPDATE nodes SET last_seen_at = ? WHERE node_id = ?', at, nodeId)
      return true
    },
    renewLease(leaseId, expiresAt) {
      if (!get("SELECT 1 FROM leases WHERE lease_id = ? AND state = 'active'", leaseId))
        return false
      run('UPDATE leases SET expires_at = ? WHERE lease_id = ?', expiresAt, leaseId)
      return true
    },
    extendActiveLeases(ms) {
      return db.transaction(() => {
        const active = all<{ lease_id: string; expires_at: string }>(
          "SELECT lease_id, expires_at FROM leases WHERE state = 'active'",
        )
        for (const l of active) {
          run(
            'UPDATE leases SET expires_at = ? WHERE lease_id = ?',
            iso(Date.parse(l.expires_at) + ms),
            l.lease_id,
          )
        }
        return active.length
      })
    },
    recordActivity(taskId, activities) {
      const row = get<{ activity_json: string }>(
        'SELECT activity_json FROM tasks WHERE id = ?',
        taskId,
      )
      if (!row) return false
      if (activities.length === 0) return true
      // 活动文本是自由文本：限长并脱敏（sanitizeText：名单 → 截断 → 正则）；data 只做名单替换。
      const incoming = activities.map((a) => ({
        ...redactDeep(a, knownOnly),
        ...(a.text === undefined
          ? {}
          : { text: sanitizeText(redact ? redact(a.text) : a.text, ACTIVITY_TEXT_MAX) }),
      }))
      const kept = [...(JSON.parse(row.activity_json) as Activity[]), ...incoming].slice(
        -activityKeep,
      )
      let last = activities[0]?.ts ?? iso()
      for (const a of activities) if (a.ts > last) last = a.ts
      run(
        'UPDATE tasks SET activity_json = ?, last_activity_at = ? WHERE id = ?',
        JSON.stringify(kept),
        last,
        taskId,
      )
      return true
    },
    taskActivity(taskId) {
      const row = get<{ activity_json: string }>(
        'SELECT activity_json FROM tasks WHERE id = ?',
        taskId,
      )
      return row ? (JSON.parse(row.activity_json) as Activity[]) : []
    },

    snapshot({ includeSoft = true } = {}) {
      const out = {} as ProjectionSnapshot
      for (const table of PROJECTION_TABLES) {
        const rows = all<Record<string, unknown>>(
          `SELECT * FROM ${table} ORDER BY ${PROJECTION_KEYS[table]}`,
        )
        out[table] = includeSoft
          ? rows
          : rows.map((r) =>
              Object.fromEntries(
                Object.entries(r).filter(([k]) => !SOFT_COLUMNS[table].includes(k)),
              ),
            )
      }
      return out
    },

    backupTo(path) {
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
    },
    close() {
      listeners.clear()
      db.close()
    },
  }
}
