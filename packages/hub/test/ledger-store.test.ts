import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type LedgerEvent,
  ledgerEvent,
  openDatabase,
  TASK_STATUSES,
  type TaskStatus,
  taskView,
} from '@flow/core'
import { type LedgerStore, openLedger } from '../src/index.ts'
import {
  contract,
  type DraftKey,
  drafts,
  must,
  result,
  SHA,
  startTask,
  stepClock,
  sys,
  tempLedger,
  WS,
} from './ledger-helpers.ts'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})
async function ledger(opts: Parameters<typeof tempLedger>[0] = {}) {
  const l = await tempLedger(opts)
  cleanups.push(l.cleanup)
  return l
}

const create = (store: LedgerStore, id: string, ws = WS) =>
  must(store.append(drafts(id, { ws })['task.created'], { actor: 'user' }))

describe('append：事件与投影同事务写入', () => {
  test('写入分配 seq 与 ts，投影同步更新，事件符合 ledgerEvent schema', async () => {
    const { store } = await ledger()
    expect(store.seq()).toBe(0)
    const e = create(store, 't1')
    expect(e.seq).toBe(1)
    expect(ledgerEvent.parse(e)).toEqual(e)
    expect(e.actor).toBe('user')
    const task = store.getTask('t1')
    expect(taskView.parse(task)).toEqual(task as never)
    expect(task).toMatchObject({
      id: 't1',
      status: 'queued',
      attempt: 0,
      created_by: 'user',
      created_at: e.ts,
      updated_at: e.ts,
      lease: null,
      cancel_requested: false,
    })
    expect(store.seq()).toBe(1)
  })

  test('状态变化留下事件，此前的事件保持不变（task-ledger "只追加"）', async () => {
    const { store } = await ledger()
    create(store, 't1')
    const before = store.eventsAfter(0)
    startTask(store, 't1')
    const after = store.eventsAfter(0)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.slice(before.length).map((e) => e.type)).toEqual(['task.started', 'lease.granted'])
    expect(store.getTask('t1')).toMatchObject({ status: 'running', attempt: 1 })
  })

  test('events 表只追加：UPDATE / DELETE 被触发器拒绝', async () => {
    const { store, path } = await ledger()
    create(store, 't1')
    const db = await openDatabase(path)
    try {
      expect(() => db.exec("UPDATE events SET actor = 'x'")).toThrow(/append-only/)
      expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/)
    } finally {
      db.close()
    }
    expect(store.eventsAfter(0)[0]?.actor).toBe('user')
  })

  test('信封或载荷不合法：invalid_event，不写任何东西', async () => {
    const { store } = await ledger()
    const bad = { ...drafts('t1')['task.created'], workspace: 'nope' }
    const r = store.append(bad, sys)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_event')
    const r2 = store.append(drafts('t1')['task.created'], { actor: 'bad actor' })
    expect(r2.ok).toBe(false)
    expect(store.seq()).toBe(0)
    expect(store.getTask('t1')).toBeNull()
  })

  test('appendMany 原子：后一条不合法时前一条也不写', async () => {
    const { store } = await ledger()
    create(store, 't1')
    const d = drafts('t1')
    const r = store.appendMany([d['task.started'], d['task.started']], sys)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_transition')
    expect(store.seq()).toBe(1)
    expect(store.getTask('t1')?.status).toBe('queued')
    expect(store.activeLease('t1')).toBeNull()
  })

  test('appendMany 中后面的事件看到前面事件的投影（lease_expired + blocked）', async () => {
    const { store } = await ledger()
    create(store, 't1')
    const d = startTask(store, 't1')
    const events = must(
      store.appendMany(
        [
          d['task.lease_expired'],
          {
            task_id: 't1',
            workspace: WS,
            type: 'task.blocked',
            payload: { reason: 'node_lost', message: '租约过期' },
          },
        ],
        sys,
      ),
    )
    expect(events.map((e) => e.seq)).toEqual([4, 5])
    expect(events[0]?.ts).toBe(events[1]?.ts as string)
    expect(store.getTask('t1')).toMatchObject({
      status: 'blocked',
      blocked: { reason: 'node_lost', message: '租约过期' },
      lease: null,
    })
    expect(store.getLease('l-t1-1')?.state).toBe('expired')
  })

  test('一致性检查：workspace 不一致、attempt 跳号、重复租约、非活动租约过期、重复触发', async () => {
    const { store } = await ledger()
    create(store, 't1')
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)
    expect(code(store.append({ ...drafts('t1', { ws: 'ws/other' })['task.cancelled'] }, sys))).toBe(
      'invalid_event',
    )
    expect(code(store.append(drafts('t1', { attempt: 2 })['task.started'], sys))).toBe(
      'invalid_event',
    )
    const mismatch = {
      ...drafts('t2')['task.created'],
      payload: { contract: contract({ workspace: 'ws/other' }) },
    }
    expect(code(store.append(mismatch, sys))).toBe('invalid_event')
    startTask(store, 't1')
    expect(code(store.append(drafts('t1', { leaseId: 'l-x' })['lease.granted'], sys))).toBe(
      'invalid_transition',
    )
    expect(code(store.append(drafts('t1', { leaseId: 'l-x' })['task.lease_expired'], sys))).toBe(
      'invalid_event',
    )
    const fire = {
      type: 'schedule.fired',
      workspace: WS,
      payload: { rule_id: 'daily', planned_at: '2026-10-24T03:30:00.000Z' },
    } as const
    expect(code(store.append(fire, { actor: 'scheduler' }))).toBe('ok')
    expect(code(store.append(fire, { actor: 'scheduler' }))).toBe('duplicate_fire')
    expect(store.snapshot().schedule_fires).toHaveLength(1)
  })

  test('幂等键在投影中唯一：直接追加重复键返回 idempotency_conflict', async () => {
    const { store } = await ledger()
    const withKey = (id: string) => ({
      ...drafts(id)['task.created'],
      payload: { contract: contract({ idempotency_key: 'k1' }) },
    })
    must(store.append(withKey('t1'), sys))
    const r = store.append(withKey('t2'), sys)
    expect(r.ok ? 'ok' : r.error.code).toBe('idempotency_conflict')
    expect(store.findTaskByIdempotencyKey('k1')?.id).toBe('t1')
  })
})

// ---------------------------------------------------------------------------
// 状态机：每种状态 × 每种任务事件
// ---------------------------------------------------------------------------

/** 期望矩阵，直接按 task-ledger spec "状态机" 与 node-protocol "租约过期处理" 手写。 */
const ALLOWED: Record<TaskStatus | 'none', DraftKey[]> = {
  none: ['task.created'],
  queued: ['task.started', 'task.cancelled'],
  running: [
    'task.verifying',
    'task.done',
    'task.failed',
    'task.blocked',
    'task.requeued:lease_expired',
    'task.cancel_requested',
    'task.cancelled',
    'task.lease_expired',
  ],
  verifying: [
    'task.done',
    'task.failed',
    'task.blocked',
    'task.requeued:lease_expired',
    'task.cancel_requested',
    'task.cancelled',
    'task.lease_expired',
  ],
  blocked: ['task.failed', 'task.unblocked', 'task.requeued:manual', 'task.cancelled'],
  done: [],
  failed: [],
  cancelled: [],
}
const STATUS_AFTER: Partial<Record<DraftKey, TaskStatus>> = {
  'task.created': 'queued',
  'task.started': 'running',
  'task.verifying': 'verifying',
  'task.done': 'done',
  'task.failed': 'failed',
  'task.blocked': 'blocked',
  'task.unblocked': 'running',
  'task.requeued:manual': 'queued',
  'task.requeued:lease_expired': 'queued',
  'task.cancelled': 'cancelled',
}

/** 把任务 t 带到指定状态（running / verifying 持有活动租约 l-t-1）。 */
function reach(store: LedgerStore, status: TaskStatus | 'none') {
  if (status === 'none') return
  create(store, 't')
  const d = drafts('t')
  const path: Record<TaskStatus, DraftKey[]> = {
    queued: [],
    running: [],
    verifying: ['task.verifying'],
    blocked: ['task.blocked'],
    done: ['task.done'],
    failed: ['task.failed'],
    cancelled: ['task.cancelled'],
  }
  if (status !== 'queued' && status !== 'cancelled') startTask(store, 't')
  for (const k of path[status]) must(store.append(d[k], sys))
  expect(store.getTask('t')?.status).toBe(status)
}

describe('状态机：合法与非法转换', () => {
  const keys = Object.keys(drafts('t')).filter((k) => k !== 'lease.granted') as DraftKey[]
  for (const status of ['none', ...TASK_STATUSES] as const) {
    for (const key of keys) {
      const allowed = ALLOWED[status].includes(key)
      test(`${status} + ${key} → ${allowed ? '接受' : 'invalid_transition'}`, async () => {
        const { store } = await ledger()
        reach(store, status)
        const before = store.seq()
        const prev = store.getTask('t')
        const attempt = (prev?.attempt ?? 0) + (key === 'task.started' ? 1 : 0)
        const r = store.append(drafts('t', { attempt: Math.max(1, attempt) })[key], sys)
        if (allowed) {
          expect(r.ok).toBe(true)
          expect(store.seq()).toBe(before + 1)
          const expected = STATUS_AFTER[key] ?? prev?.status
          expect(store.getTask('t')?.status).toBe(expected as TaskStatus)
        } else {
          expect(r.ok).toBe(false)
          if (!r.ok) expect(r.error.code).toBe('invalid_transition')
          expect(store.seq()).toBe(before)
          expect(store.getTask('t')).toEqual(prev)
        }
      })
    }
  }

  test('lease.granted：running 且无活动租约时接受，其他状态拒绝', async () => {
    const { store } = await ledger()
    create(store, 't')
    const d = drafts('t')
    expect(store.append(d['lease.granted'], sys).ok).toBe(false)
    must(store.append(d['task.started'], sys))
    must(store.append(d['lease.granted'], sys))
    expect(store.getTask('t')?.lease).toEqual({
      lease_id: 'l-t-1',
      node_id: 'n1',
      expires_at: '2026-10-24T01:00:00.000Z',
    })
  })

  test('已完成的任务不能再运行（spec 场景）', async () => {
    const { store } = await ledger()
    reach(store, 'done')
    const before = store.seq()
    const r = store.append(drafts('t', { attempt: 2 })['task.started'], sys)
    expect(r.ok ? 'ok' : r.error.code).toBe('invalid_transition')
    expect(store.getTask('t')?.status).toBe('done')
    expect(store.seq()).toBe(before)
  })

  test('终态记录 finished_at；done 附带结果；离开 running 时释放租约', async () => {
    const { store } = await ledger()
    reach(store, 'done')
    const t = store.getTask('t')
    expect(t?.finished_at).not.toBeNull()
    expect(t?.result).toEqual({ ...result(), artifacts: [], verify: [] })
    expect(t?.lease).toBeNull()
    expect(store.getLease('l-t-1')).toMatchObject({ state: 'released', token_sha256: SHA })
  })

  test('重试：requeued 后再次开始，attempt 递增，新租约', async () => {
    const { store } = await ledger()
    reach(store, 'running')
    const d1 = drafts('t')
    must(store.appendMany([d1['task.lease_expired'], d1['task.requeued:lease_expired']], sys))
    expect(store.getTask('t')).toMatchObject({ status: 'queued', attempt: 1, lease: null })
    startTask(store, 't', 2)
    expect(store.getTask('t')).toMatchObject({
      status: 'running',
      attempt: 2,
      lease: { lease_id: 'l-t-2' },
    })
  })
})

// ---------------------------------------------------------------------------
// 读取接口、订阅、软状态、备份
// ---------------------------------------------------------------------------

describe('LedgerReader', () => {
  test('eventsAfter：按 seq、过滤与 limit', async () => {
    const { store } = await ledger()
    create(store, 'a')
    create(store, 'b', 'ws/other')
    startTask(store, 'a')
    expect(store.eventsAfter(0).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(store.eventsAfter(2).map((e) => e.seq)).toEqual([3, 4])
    expect(store.eventsAfter(0, { task_id: 'a' }).map((e) => e.seq)).toEqual([1, 3, 4])
    expect(store.eventsAfter(0, { workspace: 'ws/other' }).map((e) => e.task_id)).toEqual(['b'])
    expect(store.eventsAfter(0, {}, 2).map((e) => e.seq)).toEqual([1, 2])
    for (const e of store.eventsAfter(0)) ledgerEvent.parse(e)
  })

  test('subscribe：提交后按序回调；失败的写入不通知；取消订阅后不再回调', async () => {
    const { store } = await ledger()
    const seen: LedgerEvent[] = []
    const seqAtCallback: number[] = []
    const off = store.subscribe((e) => {
      seen.push(e)
      seqAtCallback.push(store.seq())
    })
    store.subscribe(() => {
      throw new Error('坏订阅者不影响写入')
    })
    create(store, 't')
    startTask(store, 't')
    store.append(drafts('t')['task.started'], sys) // 非法
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3])
    // appendMany 的两条事件在整个事务提交后才通知，回调时 seq 已是 3
    expect(seqAtCallback).toEqual([1, 3, 3])
    off()
    must(store.append(drafts('t')['task.done'], sys))
    expect(seen).toHaveLength(3)
  })

  test('重新打开后数据仍在', async () => {
    const { store, path } = await ledger()
    create(store, 't')
    store.close()
    const again = await openLedger(path)
    try {
      expect(again.seq()).toBe(1)
      expect(again.getTask('t')?.status).toBe('queued')
    } finally {
      again.close()
    }
  })
})

describe('软状态（不入账本）', () => {
  test('touchNode / renewLease / recordActivity / extendActiveLeases 不产生事件', async () => {
    const { store } = await ledger({ activityKeep: 3 })
    must(
      store.append(
        {
          type: 'node.registered',
          payload: {
            node_id: 'n1',
            hostname: 'mac',
            version: '0.0.0',
            capabilities: ['executor:fake'],
            concurrency: 1,
          },
        },
        { actor: 'node:n1' },
      ),
    )
    create(store, 't')
    startTask(store, 't')
    const seq = store.seq()
    expect(store.touchNode('n1', '2026-10-24T00:10:00.000Z')).toBe(true)
    expect(store.touchNode('nope')).toBe(false)
    expect(store.renewLease('l-t-1', '2026-10-24T02:00:00.000Z')).toBe(true)
    expect(store.renewLease('l-none', '2026-10-24T02:00:00.000Z')).toBe(false)
    const act = (i: number) => ({
      ts: `2026-10-24T00:0${i}:00.000Z`,
      kind: 'output' as const,
      text: `line ${i}`,
    })
    expect(store.recordActivity('t', [act(1), act(2)])).toBe(true)
    expect(store.recordActivity('t', [act(4), act(3)])).toBe(true)
    expect(store.taskActivity('t').map((a) => a.text)).toEqual(['line 2', 'line 4', 'line 3'])
    expect(store.extendActiveLeases(60_000)).toBe(1)
    expect(store.seq()).toBe(seq)
    expect(store.getNode('n1')).toMatchObject({
      last_seen_at: '2026-10-24T00:10:00.000Z',
      active_leases: 1,
    })
    expect(store.getTask('t')).toMatchObject({
      last_activity_at: '2026-10-24T00:04:00.000Z',
      lease: { expires_at: '2026-10-24T02:01:00.000Z' },
    })
  })
})

describe('backupTo', () => {
  test('VACUUM INTO 生成可打开的一致副本', async () => {
    const { store, dir } = await ledger()
    create(store, 't')
    startTask(store, 't')
    const target = join(dir, "backup's.db")
    store.backupTo(target)
    expect(existsSync(target)).toBe(true)
    const copy = await openLedger(target)
    try {
      expect(copy.seq()).toBe(3)
      expect(copy.snapshot()).toEqual(store.snapshot())
    } finally {
      copy.close()
    }
  })
})

describe('rebuild（task-ledger "投影可重建"）', () => {
  test('删除投影后重建：状态、尝试次数与时间戳一致；软状态按 D2 重置；写 hub.rebuilt', async () => {
    const now = stepClock()
    const { store, path } = await ledger({ now })
    create(store, 'a')
    create(store, 'b')
    startTask(store, 'a')
    must(store.append(drafts('a')['task.done'], sys))
    startTask(store, 'b')
    store.recordActivity('b', [{ ts: '2026-10-24T00:00:30.000Z', kind: 'heartbeat' }])
    store.renewLease('l-b-1', '2030-01-01T00:00:00.000Z')
    const before = [store.getTask('a'), store.getTask('b')]
    const hard = store.snapshot({ includeSoft: false })

    // 模拟投影被清空（另开连接直接删）
    const db = await openDatabase(path)
    db.exec('DELETE FROM tasks; DELETE FROM leases;')
    db.close()
    expect(store.getTask('a')).toBeNull()

    const seqBefore = store.seq()
    const r = must(store.rebuild())
    expect(r).toMatchObject({ events_replayed: seqBefore, ledger_seq: seqBefore + 1 })
    const last = store.eventsAfter(seqBefore)[0]
    expect(last).toMatchObject({ type: 'hub.rebuilt', actor: 'hub' })
    expect(store.snapshot({ includeSoft: false })).toEqual(hard)

    const a = store.getTask('a')
    expect(a).toEqual(before[0] as never)
    const b = store.getTask('b')
    const pick = (t: typeof b) => ({ ...t, last_activity_at: undefined, lease: undefined })
    expect(pick(b)).toEqual(pick(before[1] ?? null))
    expect(b?.last_activity_at).toBeNull()
    expect(store.taskActivity('b')).toEqual([])
    // 活动租约到期时间 = 重建时刻 + ttl（60s）
    expect(Date.parse(b?.lease?.expires_at ?? '')).toBe(Date.parse(last?.ts ?? '') + 60_000)
  })

  test('账本自相矛盾时重建失败并保留原投影', async () => {
    const { store, path } = await ledger()
    create(store, 't')
    // 绕过 store 写入一条非法事件（只追加，触发器允许 INSERT）
    const db = await openDatabase(path)
    db.prepare(
      'INSERT INTO events (ts, type, workspace, task_id, actor, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      '2026-10-24T00:00:00.000Z',
      'task.done',
      WS,
      't',
      'x',
      JSON.stringify({ result: result() }),
    )
    db.close()
    const snap = store.snapshot()
    const r = store.rebuild()
    expect(r.ok ? 'ok' : r.error.code).toBe('ledger_inconsistent')
    expect(store.snapshot()).toEqual(snap)
  })
})
