import { describe, expect, test } from 'bun:test'
import {
  canTransition,
  checkTaskEvent,
  EVENT_TYPES,
  type EventType,
  isTaskEventType,
  ledgerEvent,
  ledgerEventDraft,
  parseLedgerEvent,
  parseLedgerEventDraft,
  TASK_EVENT_RULES,
  TASK_STATUSES,
  type TaskStatus,
} from '../src/index.ts'

const ts = '2026-10-24T08:00:00.000Z'
const contract = { goal: 'g', workspace: 'ws/product-res', role: 'developer', executor: 'fake' }
const result = { summary: 's', executor: 'fake', node_id: 'n1' }
const task = { workspace: 'ws/product-res', task_id: 't_1' }
const sha = 'a'.repeat(64)

/** 每种事件一个合法样例（只写 type 之外的信封字段与载荷）与一个非法样例。 */
const samples: Record<
  EventType,
  { valid: Record<string, unknown>; invalid: Record<string, unknown> }
> = {
  'policy.decided': {
    valid: {
      ...task,
      payload: {
        task_id: task.task_id,
        request: { tool: 'Bash', actions: ['tool:Bash', 'git.push'], command: 'git push' },
        level: 'user',
        matched_rules: [],
        actions: [{ action: 'git.push', level: 'user', matched_rules: [], guarded: false }],
      },
    },
    invalid: { ...task, payload: { level: 'always' } },
  },
  'task.created': {
    valid: { ...task, payload: { contract } },
    invalid: { ...task, payload: { contract: { ...contract, workspace: undefined } } },
  },
  'task.started': {
    valid: { ...task, payload: { node_id: 'n1', lease_id: 'l1', attempt: 1 } },
    invalid: { ...task, payload: { node_id: 'n1', lease_id: 'l1', attempt: 0 } },
  },
  'task.verifying': {
    valid: { ...task, payload: { node_id: 'n1' } },
    invalid: { workspace: 'ws/product-res', payload: { node_id: 'n1' } },
  },
  'task.done': {
    valid: { ...task, payload: { result } },
    invalid: { ...task, payload: {} },
  },
  'task.failed': {
    valid: { ...task, payload: { message: '用户放弃' } },
    invalid: { ...task, payload: {} },
  },
  'task.blocked': {
    valid: { ...task, payload: { reason: 'question', message: '哪个分支？', tail: ['> ?'] } },
    invalid: { ...task, payload: { reason: 'tired', message: 'x' } },
  },
  'task.unblocked': {
    valid: { ...task, payload: { note: '用 main', reply_id: 'r-1' } },
    invalid: { ...task, payload: { note: 1 } },
  },
  'task.replied': {
    valid: { ...task, payload: { reply_id: 'r-1', kind: 'text', text: '用 main' } },
    invalid: { ...task, payload: { reply_id: 'r-1', kind: 'text' } },
  },
  'task.requeued_with_reply': {
    valid: { ...task, payload: { reply_id: 'r-1', session: 'sess-1' } },
    invalid: { ...task, payload: { reply_id: 'bad' } },
  },
  'task.requeued': {
    valid: { ...task, payload: { reason: 'lease_expired' } },
    invalid: { ...task, payload: { reason: 'because' } },
  },
  'task.cancel_requested': {
    valid: { ...task, payload: { reason: '不需要了' } },
    invalid: { task_id: 't_1', payload: {} },
  },
  'task.cancelled': {
    valid: { ...task, payload: { node_id: 'n1' } },
    invalid: { ...task, payload: { node_id: 'bad id' } },
  },
  'task.lease_expired': {
    valid: { ...task, payload: { lease_id: 'l1', node_id: 'n1', expired_at: ts, attempt: 1 } },
    invalid: { ...task, payload: { lease_id: 'l1', node_id: 'n1', attempt: 1 } },
  },
  'lease.granted': {
    valid: {
      ...task,
      payload: { lease_id: 'l1', node_id: 'n1', token_sha256: sha, ttl_s: 60, expires_at: ts },
    },
    invalid: {
      ...task,
      payload: {
        lease_id: 'l1',
        node_id: 'n1',
        token_sha256: 'plain-token',
        ttl_s: 60,
        expires_at: ts,
      },
    },
  },
  'node.registered': {
    valid: {
      payload: {
        node_id: 'n1',
        hostname: 'mac',
        version: '0.0.0',
        capabilities: ['executor:fake'],
        executors: [{ type: 'fake', mode: 'headless' }],
        concurrency: 1,
      },
    },
    invalid: {
      payload: {
        node_id: 'n1',
        hostname: 'mac',
        version: '0',
        capabilities: ['X'],
        concurrency: 1,
      },
    },
  },
  'schedule.fired': {
    valid: {
      workspace: 'ws/global',
      payload: { rule_id: 'daily', planned_at: ts, missed: true, payload: { kind: 'patrol' } },
    },
    invalid: { payload: { rule_id: 'daily', planned_at: ts } },
  },
  'hub.started': {
    valid: { payload: { version: '0.0.0', pid: 123, runtime: 'bun', port: 7477 } },
    invalid: { payload: { version: '0.0.0', pid: 123, runtime: 'deno', port: 7477 } },
  },
  'hub.resumed': {
    valid: { payload: { slept_ms: 3_600_000, extended_leases: 2 } },
    invalid: { payload: { slept_ms: -1, extended_leases: 0 } },
  },
  'hub.backup_done': {
    valid: { payload: { path: 'state/backups/flow-x.db', size_bytes: 10, duration_ms: 3 } },
    invalid: { payload: { size_bytes: 10, duration_ms: 3 } },
  },
  'hub.rebuilt': {
    valid: { payload: { events_replayed: 10, duration_ms: 3 } },
    invalid: { payload: { events_replayed: 10, duration_ms: 3, extra: true } },
  },
  'inbox.item_created': {
    valid: {
      ...task,
      payload: {
        item_id: 'blk.12',
        level: 'interrupt',
        source: 'task',
        source_ref: 't_1',
        reason: 'question',
        title: '需要确认',
        actions: ['reply'],
        source_seq: 12,
      },
    },
    invalid: {
      payload: { item_id: 'blk.12', level: 'urgent', source: 'task', source_ref: 't', title: 'x' },
    },
  },
  'inbox.item_updated': {
    valid: { payload: { item_id: 'blk.12', level: 'digest' } },
    invalid: { payload: { item_id: 'blk.12' } },
  },
  'inbox.item_closed': {
    valid: { ...task, payload: { item_id: 'blk.12', reason: 'task_running', cause_seq: 13 } },
    invalid: { payload: { item_id: 'blk.12', reason: 'whatever' } },
  },
  'inbox.pushed': {
    valid: { payload: { channel: 'telegram', ref: '42:7', item_ids: ['blk.12'] } },
    invalid: { payload: { channel: 'Tele Gram', ref: '42:7', item_ids: [] } },
  },
  'channel.rebound': {
    valid: {
      payload: {
        channel: 'telegram',
        from_chat: '0123456789abcdef',
        to_chat: 'fedcba9876543210',
        via: 'telegram',
      },
    },
    invalid: {
      payload: { channel: 'telegram', from_chat: '7001', to_chat: '9009', via: 'telegram' },
    },
  },
  'channel.unlinked': {
    valid: { payload: { channel: 'telegram', chat: '0123456789abcdef', via: 'cli' } },
    invalid: { payload: { channel: 'telegram', chat: 7001, via: 'cli' } },
  },
  'user.instruction': {
    valid: { workspace: 'ws/global', payload: { text: '看看昨天的部署', via: 'telegram' } },
    invalid: { payload: { text: '缺少 workspace', via: 'telegram' } },
  },
}

const envelope = (type: EventType, body: Record<string, unknown>) => ({
  seq: 1,
  ts,
  type,
  actor: 'hub',
  ...body,
})

describe('事件 schema', () => {
  test('事件类型清单', () => {
    expect(EVENT_TYPES).toEqual(Object.keys(samples) as EventType[])
  })

  test.each(EVENT_TYPES)('%s：合法样例通过，非法样例被拒', (type) => {
    const { valid, invalid } = samples[type]
    const ok = ledgerEvent.safeParse(envelope(type, valid))
    if (!ok.success) throw new Error(ok.error.message)
    expect(ledgerEvent.safeParse(envelope(type, invalid)).success).toBe(false)
    // 草稿没有 seq/ts
    const { seq: _s, ts: _t, ...draft } = envelope(type, valid)
    expect(ledgerEventDraft.safeParse(draft).success).toBe(true)
  })

  test('信封：seq、ts、actor 与未知 type', () => {
    const good = envelope('hub.rebuilt', samples['hub.rebuilt'].valid)
    expect(ledgerEvent.safeParse({ ...good, seq: 0 }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, ts: '昨天' }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, actor: '' }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, type: 'lease.renewed' }).success).toBe(false)
    expect(ledgerEvent.safeParse({ ...good, extra: 1 }).success).toBe(false)
  })

  test('task.created 的合同补齐默认值', () => {
    const r = parseLedgerEvent(envelope('task.created', samples['task.created'].valid))
    expect(r.ok).toBe(true)
    if (r.ok && r.data.type === 'task.created') expect(r.data.payload.contract.timeout_s).toBe(3600)
  })

  test('parse 辅助函数返回 invalid_event', () => {
    const r = parseLedgerEventDraft({ type: 'task.done', actor: 'hub', payload: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_event')
  })
})

describe('事件触发的状态转换', () => {
  /** 期望表：事件 → 允许的当前状态（null=任务不存在）→ 之后的状态。独立于实现手写。 */
  const expected: Record<string, [TaskStatus | null, TaskStatus][]> = {
    'policy.decided': TASK_STATUSES.map((status) => [status, status]),
    'task.created': [[null, 'queued']],
    'task.started': [['queued', 'running']],
    'lease.granted': [['running', 'running']],
    'task.verifying': [['running', 'verifying']],
    'task.done': [
      ['running', 'done'],
      ['verifying', 'done'],
    ],
    'task.failed': [
      ['running', 'failed'],
      ['verifying', 'failed'],
      ['blocked', 'failed'],
    ],
    'task.blocked': [
      ['running', 'blocked'],
      ['verifying', 'blocked'],
      ['blocked', 'blocked'],
    ],
    'task.unblocked': [['blocked', 'running']],
    'task.replied': [['blocked', 'blocked']],
    'task.requeued_with_reply': [['blocked', 'queued']],
    'task.requeued': [
      ['blocked', 'queued'],
      ['running', 'queued'],
      ['verifying', 'queued'],
    ],
    'task.cancel_requested': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
    'task.cancelled': [
      ['queued', 'cancelled'],
      ['running', 'cancelled'],
      ['verifying', 'cancelled'],
      ['blocked', 'cancelled'],
    ],
    'task.lease_expired': [
      ['running', 'running'],
      ['verifying', 'verifying'],
      ['blocked', 'blocked'],
    ],
  }

  test('规则覆盖全部任务事件', () => {
    expect(Object.keys(TASK_EVENT_RULES).sort()).toEqual(Object.keys(expected).sort())
    expect(EVENT_TYPES.filter(isTaskEventType).sort() as string[]).toEqual(
      Object.keys(expected).sort(),
    )
  })

  const states: (TaskStatus | null)[] = [null, ...TASK_STATUSES]
  const cases = Object.keys(expected).flatMap((type) =>
    states.map((from) => [type as EventType, from] as const),
  )

  const payloadFor = (type: EventType, from: TaskStatus | null) => {
    if (type === 'task.requeued') return { reason: from === 'blocked' ? 'manual' : 'lease_expired' }
    return samples[type].valid.payload
  }

  test.each(cases)('%s 作用于 %s', (type, from) => {
    const hit = expected[type]?.find(([f]) => f === from)
    const r = checkTaskEvent(from, { type, payload: payloadFor(type, from) } as never)
    if (hit) {
      expect(r).toEqual({ ok: true, data: hit[1] })
      if (from !== null && hit[1] !== from) expect(canTransition(from, hit[1])).toBe(true)
    } else {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_transition')
    }
  })

  test('已完成的任务不能再运行（task-ledger 场景）', () => {
    const r = checkTaskEvent('done', {
      type: 'task.started',
      payload: samples['task.started'].valid.payload,
    } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_transition')
  })

  test('blocked → blocked 只接受 lease_held=false（本轮结束）', () => {
    const held = {
      type: 'task.blocked',
      payload: { reason: 'question', message: 'x', lease_held: true },
    } as never
    const ended = {
      type: 'task.blocked',
      payload: { reason: 'crashed', message: 'x', lease_held: false },
    } as never
    expect(checkTaskEvent('blocked', held).ok).toBe(false)
    expect(checkTaskEvent('blocked', ended)).toEqual({ ok: true, data: 'blocked' })
    expect(checkTaskEvent('running', held)).toEqual({ ok: true, data: 'blocked' })
  })

  test('task.requeued 的 reason 必须与来源状态匹配', () => {
    const manual = { type: 'task.requeued', payload: { reason: 'manual' } } as never
    const expired = { type: 'task.requeued', payload: { reason: 'lease_expired' } } as never
    expect(checkTaskEvent('running', manual).ok).toBe(false)
    expect(checkTaskEvent('blocked', expired).ok).toBe(false)
  })

  test('非任务事件不涉及状态', () => {
    expect(checkTaskEvent(null, { type: 'hub.rebuilt', payload: {} } as never)).toEqual({
      ok: true,
      data: null,
    })
  })
})
