import type { Database, LedgerEvent, Statement, TaskStatus } from '@flow/core'

/**
 * 投影维护：唯一的 `apply(event)`（design D2）。
 *
 * 增量写入（`append`）与重建（`rebuild`）都调用同一个函数，保证两者结果一致。
 * 这里假定事件已经通过校验（`parseLedgerEventDraft` + `checkTaskEvent` + store 的一致性检查），
 * 只负责把事件折叠进投影表，不做业务判断。
 *
 * 软状态列（`last_activity_at`、`activity_json`、`last_seen_at`、`leases.expires_at` 的续约值）
 * 不在这里维护，见 store 的 `touchNode` / `renewLease` / `recordActivity`。
 */
export type Applier = (event: LedgerEvent) => void

/**
 * 结束租约的事件：任务离开 running / verifying 时，当前租约随之释放。
 * 例外：`task.blocked` 带 `lease_held: true` 时（交互式执行器的 worker 还活着，D7a）不释放。
 */
const RELEASING: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.done',
  'task.failed',
  'task.blocked',
  'task.requeued',
  'task.requeued_with_reply',
  'task.cancelled',
])

/** 任务离开 blocked 的事件：尚未送达的回复不再有人等待，标记为 dropped。 */
const DROPPING_REPLIES: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.done',
  'task.failed',
  'task.unblocked',
  'task.requeued',
  'task.requeued_with_reply',
  'task.cancelled',
])

const releases = (e: LedgerEvent) =>
  RELEASING.has(e.type) && !(e.type === 'task.blocked' && e.payload.lease_held === true)

export function createApplier(db: Database): Applier {
  const stmt = (() => {
    const cache = new Map<string, Statement>()
    return (sql: string): Statement => {
      let s = cache.get(sql)
      if (s === undefined) {
        s = db.prepare(sql)
        cache.set(sql, s)
      }
      return s
    }
  })()

  const touchTask = (e: LedgerEvent, extra: string, ...params: (string | number | null)[]) => {
    stmt(`UPDATE tasks SET updated_at = ?, last_seq = ?${extra} WHERE id = ?`).run(
      e.ts,
      e.seq,
      ...params,
      e.task_id ?? null,
    )
  }
  const setStatus = (
    e: LedgerEvent,
    status: TaskStatus,
    extra = '',
    ...params: (string | number | null)[]
  ) => touchTask(e, `, status = ?${extra}`, status, ...params)

  const releaseLease = (e: LedgerEvent) => {
    stmt(
      `UPDATE leases SET state = 'released', ended_at = ? WHERE task_id = ? AND state = 'active'`,
    ).run(e.ts, e.task_id ?? null)
  }

  /** 先处理事件本身指向的回复，再把其余待送达回复标记为 dropped。 */
  const dropPendingReplies = (e: LedgerEvent) => {
    stmt(`UPDATE replies SET state = 'dropped' WHERE task_id = ? AND state = 'pending'`).run(
      e.task_id ?? null,
    )
  }

  return (e) => {
    if (releases(e)) releaseLease(e)
    applyEvent(e)
    if (DROPPING_REPLIES.has(e.type)) dropPendingReplies(e)
  }

  function applyEvent(e: LedgerEvent) {
    switch (e.type) {
      case 'policy.decided':
        // 策略判定只供审计，不修改任务或租约投影。
        return
      case 'task.created': {
        const c = e.payload.contract
        stmt(
          `INSERT INTO tasks (id, workspace, status, contract_json, idempotency_key, parent,
             attempt, created_seq, last_seq, created_at, updated_at, created_by)
           VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        ).run(
          e.task_id ?? null,
          e.workspace ?? null,
          JSON.stringify(c),
          c.idempotency_key ?? null,
          c.parent ?? null,
          e.seq,
          e.seq,
          e.ts,
          e.ts,
          e.actor,
        )
        return
      }
      case 'task.started':
        setStatus(
          e,
          'running',
          // resume 只给紧接着的这一次执行，开始执行即消费（重建时同样在此清空）。
          ', attempt = ?, started_at = ?, blocked_json = NULL, resume_json = NULL',
          e.payload.attempt,
          e.ts,
        )
        return
      case 'lease.granted': {
        const p = e.payload
        stmt(
          `INSERT INTO leases (lease_id, task_id, node_id, attempt, token_sha256, ttl_s,
             granted_at, expires_at, state)
           SELECT ?, id, ?, attempt, ?, ?, ?, ?, 'active' FROM tasks WHERE id = ?`,
        ).run(p.lease_id, p.node_id, p.token_sha256, p.ttl_s, e.ts, p.expires_at, e.task_id ?? null)
        touchTask(e, '')
        return
      }
      case 'task.verifying':
        setStatus(e, 'verifying')
        return
      case 'task.done':
        setStatus(
          e,
          'done',
          ', finished_at = ?, result_json = ?',
          e.ts,
          JSON.stringify(e.payload.result),
        )
        return
      case 'task.failed':
        setStatus(
          e,
          'failed',
          ', finished_at = ?, result_json = ?, blocked_json = NULL',
          e.ts,
          e.payload.result === undefined ? null : JSON.stringify(e.payload.result),
        )
        return
      case 'task.blocked': {
        const p = e.payload
        const blocked = {
          reason: p.reason,
          message: p.message,
          ...(p.tail ? { tail: p.tail } : {}),
          ...(p.session ? { session: p.session } : {}),
          ...(p.prior_reason ? { prior_reason: p.prior_reason } : {}),
        }
        setStatus(e, 'blocked', ', blocked_json = ?', JSON.stringify(blocked))
        return
      }
      case 'task.unblocked':
        if (e.payload.reply_id !== undefined) {
          stmt(`UPDATE replies SET state = 'delivered', delivered_at = ? WHERE id = ?`).run(
            e.ts,
            e.payload.reply_id,
          )
        }
        setStatus(e, 'running', ', blocked_json = NULL')
        return
      case 'task.replied':
        stmt(
          `INSERT INTO replies (id, task_id, kind, text, by, created_at, created_seq, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(
          e.payload.reply_id,
          e.task_id ?? null,
          e.payload.kind,
          e.payload.text ?? null,
          e.actor,
          e.ts,
          e.seq,
        )
        touchTask(e, '')
        return
      case 'task.requeued_with_reply': {
        const reply = stmt('SELECT kind, text, by FROM replies WHERE id = ?').get(
          e.payload.reply_id,
        ) as { kind: string; text: string | null; by: string } | undefined
        stmt(`UPDATE replies SET state = 'requeued', delivered_at = ? WHERE id = ?`).run(
          e.ts,
          e.payload.reply_id,
        )
        const resume = {
          reply: {
            reply_id: e.payload.reply_id,
            kind: reply?.kind ?? 'text',
            ...(reply?.text != null ? { text: reply.text } : {}),
            by: reply?.by ?? 'unknown',
          },
          ...(e.payload.session ? { session: e.payload.session } : {}),
        }
        setStatus(e, 'queued', ', blocked_json = NULL, resume_json = ?', JSON.stringify(resume))
        return
      }
      case 'task.requeued':
        setStatus(e, 'queued', ', blocked_json = NULL')
        return
      case 'task.cancel_requested':
        touchTask(e, ', cancel_requested = 1')
        return
      case 'task.cancelled':
        setStatus(
          e,
          'cancelled',
          ', finished_at = ?, blocked_json = NULL, result_json = ?',
          e.ts,
          e.payload.result === undefined ? null : JSON.stringify(e.payload.result),
        )
        return
      case 'task.lease_expired':
        stmt(`UPDATE leases SET state = 'expired', ended_at = ? WHERE lease_id = ?`).run(
          e.ts,
          e.payload.lease_id,
        )
        touchTask(e, '')
        return
      case 'node.registered': {
        const p = e.payload
        stmt(
          `INSERT INTO nodes (node_id, hostname, version, capabilities_json, executors_json,
             concurrency, registered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (node_id) DO UPDATE SET hostname = excluded.hostname,
             version = excluded.version, capabilities_json = excluded.capabilities_json,
             executors_json = excluded.executors_json, concurrency = excluded.concurrency,
             registered_at = excluded.registered_at`,
        ).run(
          p.node_id,
          p.hostname,
          p.version,
          JSON.stringify(p.capabilities),
          JSON.stringify(p.executors),
          p.concurrency,
          e.ts,
        )
        return
      }
      case 'schedule.fired':
        stmt(
          `INSERT INTO schedule_fires (rule_id, planned_at, workspace, fired_at, missed, seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          e.payload.rule_id,
          e.payload.planned_at,
          e.workspace ?? null,
          e.ts,
          e.payload.missed ? 1 : 0,
          e.seq,
        )
        return
      case 'inbox.item_created': {
        const p = e.payload
        stmt(
          `INSERT INTO inbox_items (id, level, source, source_ref, source_seq, reason, workspace,
             task_id, title, body, actions_json, state, created_seq, created_at, created_by,
             updated_at, last_seq, deferred_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        ).run(
          p.item_id,
          p.level,
          p.source,
          p.source_ref,
          p.source_seq ?? null,
          p.reason ?? null,
          e.workspace ?? null,
          e.task_id ?? null,
          p.title,
          p.body,
          JSON.stringify(p.actions),
          e.seq,
          e.ts,
          e.actor,
          e.ts,
          e.seq,
          p.deferred_until ?? null,
        )
        return
      }
      case 'inbox.item_updated': {
        const p = e.payload
        const sets: string[] = []
        const params: (string | number | null)[] = []
        const set = (col: string, v: string | number | null) => {
          sets.push(`${col} = ?`)
          params.push(v)
        }
        if (p.level !== undefined) set('level', p.level)
        if (p.title !== undefined) set('title', p.title)
        if (p.body !== undefined) set('body', p.body)
        if (p.actions !== undefined) set('actions_json', JSON.stringify(p.actions))
        if (p.deferred_until !== undefined) set('deferred_until', p.deferred_until)
        set('updated_at', e.ts)
        set('last_seq', e.seq)
        db.prepare(`UPDATE inbox_items SET ${sets.join(', ')} WHERE id = ?`).run(
          ...params,
          p.item_id,
        )
        return
      }
      case 'inbox.item_closed': {
        const p = e.payload
        stmt(
          `UPDATE inbox_items SET state = 'closed', close_reason = ?, close_note = ?, closed_at = ?,
             closed_by = ?, closed_seq = ?, cause_seq = ?, cause_actor = ?, closed_via = ?,
             updated_at = ?, last_seq = ?
           WHERE id = ?`,
        ).run(
          p.reason,
          p.note ?? null,
          e.ts,
          e.actor,
          e.seq,
          p.cause_seq ?? null,
          p.cause_actor ?? null,
          p.via ?? null,
          e.ts,
          e.seq,
          p.item_id,
        )
        return
      }
      case 'inbox.pushed': {
        const p = e.payload
        for (const itemId of p.item_ids) {
          if (p.op === 'send') {
            stmt(
              `INSERT OR IGNORE INTO channel_messages
                 (channel, ref, item_id, kind, sent_at, sent_seq, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL)`,
            ).run(p.channel, p.ref ?? '', itemId, p.kind, e.ts, e.seq)
            stmt('UPDATE inbox_items SET pushed_at = COALESCE(pushed_at, ?) WHERE id = ?').run(
              e.ts,
              itemId,
            )
          } else if (p.op === 'update') {
            stmt(
              'UPDATE channel_messages SET synced_at = ? WHERE channel = ? AND ref = ? AND item_id = ?',
            ).run(e.ts, p.channel, p.ref ?? '', itemId)
          } else if (p.ref === undefined) {
            // 发送失败：记一行没有消息引用的记录，该条目不再推送到这个渠道。
            stmt(
              `INSERT OR IGNORE INTO channel_messages
                 (channel, ref, item_id, kind, sent_at, sent_seq, synced_at, failed_at, failed_reason)
               VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`,
            ).run(p.channel, itemId, p.kind, e.ts, e.seq, e.ts, e.ts, p.reason ?? null)
          } else {
            stmt(
              `UPDATE channel_messages SET synced_at = ?, failed_at = ?, failed_reason = ?
               WHERE channel = ? AND ref = ? AND item_id = ?`,
            ).run(e.ts, e.ts, p.reason ?? null, p.channel, p.ref, itemId)
          }
          // 条目上的消息引用（channel_refs_json）与 channel_messages 同源，按发送先后排列。
          const rows = stmt(
            `SELECT channel, ref, kind, sent_at, synced_at, failed_at, failed_reason
             FROM channel_messages WHERE item_id = ? ORDER BY sent_seq, channel, ref`,
          ).all(itemId) as {
            channel: string
            ref: string
            kind: string
            sent_at: string
            synced_at: string | null
            failed_at: string | null
            failed_reason: string | null
          }[]
          const refs = rows.map((r) => ({
            channel: r.channel,
            ref: r.ref === '' ? null : r.ref,
            kind: r.kind,
            sent_at: r.sent_at,
            synced_at: r.synced_at,
            failed:
              r.failed_at === null ? null : { reason: r.failed_reason ?? '', at: r.failed_at },
          }))
          stmt('UPDATE inbox_items SET channel_refs_json = ? WHERE id = ?').run(
            JSON.stringify(refs),
            itemId,
          )
        }
        return
      }
      case 'hub.started':
      case 'hub.resumed':
      case 'hub.backup_done':
      case 'hub.rebuilt':
      case 'user.instruction':
      case 'channel.rebound':
      case 'channel.unlinked':
        // 中枢运维事件与用户指令（变更 ④ 消费）不影响投影（租约顺延属于软状态，由调用方直接更新 expires_at）。
        return
      default: {
        const never: never = e
        throw new Error(`未知事件类型：${(never as { type: string }).type}`)
      }
    }
  }
}
