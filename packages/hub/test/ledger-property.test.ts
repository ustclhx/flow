import { describe, expect, test } from 'bun:test'
import { BLOCKED_REASONS, type TaskStatus } from '@flow/core'
import { type EventInput, type LedgerStore, openLedger } from '../src/index.ts'
import { contract, result, SHA, stepClock } from './ledger-helpers.ts'

/**
 * 性质测试（tasks.md 2.2）：随机生成合法事件序列，断言
 * "增量维护的投影 == 清空后重建的投影"（排除软状态列）。
 * 用带种子的 mulberry32，失败时按种子即可复现。
 */

const SEEDS = 240
const STEPS = 60

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORKSPACES = ['ws/a', 'ws/b', 'ws/global'] as const
const NODES = ['n1', 'n2', 'n3'] as const

/** 各类事件（及软状态操作）在全部种子中出现的次数。 */
const coverage = new Map<string, number>()
const hit = (k: string) => coverage.set(k, (coverage.get(k) ?? 0) + 1)

async function runSeed(seed: number) {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const chance = (p: number) => rnd() < p
  const now = stepClock(Date.parse('2026-10-24T00:00:00.000Z'), 1 + Math.floor(rnd() * 5000))
  const store: LedgerStore = await openLedger(':memory:', { now })
  const tasks: { id: string; ws: string }[] = []
  let leaseCounter = 0
  let fireCounter = 0
  /** 已创建的收件箱条目（open 表示还可更新、关闭）。 */
  const items: { id: string; open: boolean }[] = []

  const write = (label: string, events: EventInput[], actor = 'hub') => {
    const r = store.appendMany(events, { actor })
    if (!r.ok) throw new Error(`seed ${seed}：合法序列 ${label} 被拒绝：${r.error.message}`)
    hit(label)
  }
  const statusOf = (id: string) => store.getTask(id)?.status as TaskStatus

  try {
    for (let step = 0; step < STEPS; step++) {
      const roll = rnd()
      if (tasks.length === 0 || roll < 0.15) {
        const id = `t-${seed}-${tasks.length}`
        const ws = pick(WORKSPACES)
        const c = contract({
          workspace: ws,
          goal: `目标 ${step}`,
          ...(chance(0.4) ? { retry: { max_attempts: 1 + Math.floor(rnd() * 3) } } : {}),
          ...(chance(0.3) ? { idempotency_key: `k-${seed}-${tasks.length}` } : {}),
          ...(chance(0.2) && tasks.length > 0 ? { parent: pick(tasks).id } : {}),
          ...(chance(0.3) ? { requires: ['browser'] } : {}),
        })
        write(
          'task.created',
          [{ type: 'task.created', task_id: id, workspace: ws, payload: { contract: c } }],
          'user',
        )
        tasks.push({ id, ws })
        continue
      }
      if (roll < 0.2) {
        const node = pick(NODES)
        write(
          'node.registered',
          [
            {
              type: 'node.registered',
              payload: {
                node_id: node,
                hostname: `host-${node}`,
                version: `0.${Math.floor(rnd() * 3)}.0`,
                capabilities: chance(0.5) ? ['executor:fake'] : ['executor:fake', 'browser'],
                concurrency: 1 + Math.floor(rnd() * 2),
              },
            },
          ],
          `node:${node}`,
        )
        continue
      }
      if (roll < 0.24) {
        const kind = pick(['schedule', 'started', 'resumed', 'backup'] as const)
        if (kind === 'schedule') {
          write(
            'schedule.fired',
            [
              {
                type: 'schedule.fired',
                workspace: pick(WORKSPACES),
                payload: {
                  rule_id: pick(['daily', 'hourly']),
                  planned_at: new Date(
                    Date.parse('2026-10-24T00:00:00Z') + fireCounter++ * 3_600_000,
                  ).toISOString(),
                  missed: chance(0.3),
                },
              },
            ],
            'hub',
          )
        } else if (kind === 'started') {
          write('hub.started', [
            {
              type: 'hub.started',
              payload: { version: '0.0.0', pid: 42, runtime: 'bun', port: 7477 },
            },
          ])
        } else if (kind === 'resumed') {
          const n = store.extendActiveLeases(60_000)
          write('hub.resumed', [
            { type: 'hub.resumed', payload: { slept_ms: 3_600_000, extended_leases: n } },
          ])
        } else {
          write('hub.backup_done', [
            {
              type: 'hub.backup_done',
              payload: { path: 'state/backups/x.db', size_bytes: 1, duration_ms: 1 },
            },
          ])
        }
        continue
      }
      if (roll < 0.3) {
        // 软状态：不产生事件，重建时重置；比较时排除。
        const t = pick(tasks)
        const lease = store.activeLease(t.id)
        if (lease) store.renewLease(lease.lease_id, new Date(now() + 60_000).toISOString())
        store.recordActivity(t.id, [
          { ts: new Date(now()).toISOString(), kind: 'output', text: 'x' },
        ])
        store.touchNode(pick(NODES))
        hit('soft-state')
        continue
      }
      if (roll < 0.33) {
        // 偶尔重建一次，之后继续追加（重建后的投影也要能继续增量维护）
        expect(store.rebuild().ok).toBe(true)
        hit('hub.rebuilt')
        continue
      }
      if (roll < 0.39) {
        // 收件箱事件（add-m1-inbox 3.1）：创建（任务来源或全局来源）、更新、关闭，以及被拒绝的重复写入
        const open = items.filter((i) => i.open)
        const kind = open.length === 0 ? 'created' : pick(['created', 'updated', 'closed'] as const)
        if (kind === 'created') {
          const id = `blk.${seed}-${items.length}`
          const t = chance(0.6) ? pick(tasks) : undefined
          write(
            'inbox.item_created',
            [
              {
                type: 'inbox.item_created',
                ...(t ? { task_id: t.id, workspace: t.ws } : {}),
                payload: {
                  item_id: id,
                  level: pick(['interrupt', 'decide', 'digest'] as const),
                  source: t ? 'task' : pick(['proposal', 'policy', 'digest'] as const),
                  source_ref: t?.id ?? `ref-${items.length}`,
                  ...(t ? { reason: pick(BLOCKED_REASONS) } : {}),
                  title: `条目 ${step}`,
                  body: chance(0.5) ? `正文 ${step}` : '',
                  actions: chance(0.5) ? ['reply'] : [],
                  ...(chance(0.7) ? { source_seq: store.seq() } : {}),
                  ...(chance(0.2) ? { deferred_until: new Date(now()).toISOString() } : {}),
                },
              },
            ],
            'hub',
          )
          items.push({ id, open: true })
        } else if (kind === 'updated') {
          const it = pick(open)
          write(
            'inbox.item_updated',
            [
              {
                type: 'inbox.item_updated',
                payload: {
                  item_id: it.id,
                  ...(chance(0.5)
                    ? { level: pick(['interrupt', 'decide', 'digest'] as const) }
                    : {}),
                  ...(chance(0.5) ? { title: `改 ${step}` } : { body: `改正文 ${step}` }),
                  ...(chance(0.3) ? { deferred_until: null } : {}),
                },
              },
            ],
            'hub',
          )
        } else {
          const it = pick(open)
          write(
            'inbox.item_closed',
            [
              {
                type: 'inbox.item_closed',
                payload: {
                  item_id: it.id,
                  reason: pick(['task_running', 'dismissed', 'superseded'] as const),
                  ...(chance(0.5) ? { cause_seq: store.seq(), cause_actor: 'user' } : {}),
                  ...(chance(0.3) ? { via: pick(['telegram', 'web', 'cli'] as const) } : {}),
                },
              },
            ],
            pick(['hub', 'user']),
          )
          it.open = false
          // 负样本：已关闭的条目不能再关闭、不能重复创建
          const before = store.seq()
          const again = store.append(
            { type: 'inbox.item_closed', payload: { item_id: it.id, reason: 'dismissed' } },
            { actor: 'user' },
          )
          expect(again.ok ? null : again.error.code).toBe('item_closed')
          const dup = store.append(
            {
              type: 'inbox.item_created',
              payload: {
                item_id: it.id,
                level: 'decide',
                source: 'proposal',
                source_ref: 'x',
                title: 't',
              },
            },
            { actor: 'hub' },
          )
          expect(dup.ok ? null : dup.error.code).toBe('duplicate_item')
          expect(store.seq()).toBe(before)
          hit('inbox.rejected')
        }
        continue
      }

      const t = pick(tasks)
      const base = { task_id: t.id, workspace: t.ws }
      const s = statusOf(t.id)
      const task = store.getTask(t.id)
      const lease = store.activeLease(t.id)
      const node = lease?.node_id ?? pick(NODES)

      if (chance(0.05)) {
        // 负样本：终态任务上的任何转换都被拒绝且不写入
        if (s === 'done' || s === 'failed' || s === 'cancelled') {
          const before = store.seq()
          const r = store.append(
            {
              ...base,
              type: 'task.started',
              payload: { node_id: node, lease_id: 'l-neg', attempt: (task?.attempt ?? 0) + 1 },
            },
            { actor: 'hub' },
          )
          expect(r.ok).toBe(false)
          expect(store.seq()).toBe(before)
          hit('rejected')
        }
        continue
      }

      switch (s) {
        case 'queued': {
          if (chance(0.15)) {
            write(
              'task.cancelled',
              [{ ...base, type: 'task.cancelled', payload: { reason: 'r' } }],
              'user',
            )
            break
          }
          const attempt = (task?.attempt ?? 0) + 1
          const leaseId = `l-${seed}-${leaseCounter++}`
          write('task.started+lease.granted', [
            {
              ...base,
              type: 'task.started',
              payload: { node_id: node, lease_id: leaseId, attempt },
            },
            {
              ...base,
              type: 'lease.granted',
              payload: {
                lease_id: leaseId,
                node_id: node,
                token_sha256: SHA,
                ttl_s: pick([30, 60]),
                expires_at: new Date(now() + 60_000).toISOString(),
              },
            },
          ])
          break
        }
        case 'running':
        case 'verifying': {
          const options = ['done', 'failed', 'blocked', 'cancel_requested', 'cancelled']
          if (s === 'running') options.push('verifying')
          if (lease) options.push('lease_expired', 'lease_expired')
          const op = pick(options)
          if (op === 'verifying')
            write(
              'task.verifying',
              [{ ...base, type: 'task.verifying', payload: { node_id: node } }],
              `node:${node}`,
            )
          else if (op === 'done')
            write(
              'task.done',
              [
                {
                  ...base,
                  type: 'task.done',
                  payload: {
                    result: {
                      ...result(node),
                      artifacts: chance(0.5)
                        ? [{ kind: 'pr', ref: 'https://example.com/pr/1' }]
                        : [],
                    },
                  },
                },
              ],
              `node:${node}`,
            )
          else if (op === 'failed')
            write(
              'task.failed',
              [
                {
                  ...base,
                  type: 'task.failed',
                  payload: chance(0.5) ? { result: result(node) } : { message: '失败' },
                },
              ],
              `node:${node}`,
            )
          else if (op === 'blocked') {
            // 交互式执行器卡住时继续持有租约（D7a）；无头执行器结束这一轮、释放租约。
            const held = chance(0.5)
            write(
              held ? 'task.blocked(lease_held)' : 'task.blocked',
              [
                {
                  ...base,
                  type: 'task.blocked',
                  payload: {
                    reason: pick(BLOCKED_REASONS),
                    message: '卡住',
                    ...(chance(0.5) ? { tail: ['a', 'b'] } : {}),
                    ...(chance(0.3) ? { session: `s-${step}` } : {}),
                    node_id: node,
                    lease_held: held,
                  },
                },
              ],
              `node:${node}`,
            )
          } else if (op === 'cancel_requested')
            write(
              'task.cancel_requested',
              [{ ...base, type: 'task.cancel_requested', payload: {} }],
              'user',
            )
          else if (op === 'cancelled')
            write(
              'task.cancelled',
              [{ ...base, type: 'task.cancelled', payload: { node_id: node } }],
              `node:${node}`,
            )
          else if (lease) {
            const expired = {
              ...base,
              type: 'task.lease_expired',
              payload: {
                lease_id: lease.lease_id,
                node_id: lease.node_id,
                expired_at: lease.expires_at,
                attempt: lease.attempt,
              },
            } as const
            const max = task?.contract.retry?.max_attempts ?? 1
            if ((task?.attempt ?? 0) < max) {
              write('task.lease_expired+task.requeued', [
                expired,
                { ...base, type: 'task.requeued', payload: { reason: 'lease_expired' } },
              ])
            } else {
              write('task.lease_expired+task.blocked', [
                expired,
                {
                  ...base,
                  type: 'task.blocked',
                  payload: { reason: 'node_lost', message: '租约过期' },
                },
              ])
            }
          }
          break
        }
        case 'blocked': {
          const held = lease !== null
          const pending = store.pendingReply(t.id)
          const session = task?.blocked?.session
          const ops: string[] = ['requeued', 'cancelled', 'failed']
          if (!pending) ops.push('replied', 'replied')
          if (held) {
            ops.push('unblocked', 'cancel_requested', 'lease_expired', 'crashed')
            if (pending) ops.push('unblocked_reply', 'unblocked_reply', 'not_running')
          }
          const op = pick(ops)
          const replyId = `r-${seed}-${step}`
          const requeueWith = (id: string) =>
            ({
              ...base,
              type: 'task.requeued_with_reply',
              payload: { reply_id: id, ...(session ? { session } : {}) },
            }) as const
          if (op === 'replied') {
            const kind = pick(['text', 'approve', 'deny'] as const)
            const replied = {
              ...base,
              type: 'task.replied',
              payload: {
                reply_id: replyId,
                kind,
                ...(kind === 'text' || chance(0.3) ? { text: '答复' } : {}),
              },
            } as const
            if (held) write('task.replied', [replied], 'user')
            else write('task.replied+requeued_with_reply', [replied, requeueWith(replyId)], 'user')
          } else if (op === 'unblocked_reply' && pending)
            write(
              'task.unblocked(reply)',
              [
                {
                  ...base,
                  type: 'task.unblocked',
                  payload: { reply_id: pending.id, note: '已送达' },
                },
              ],
              `node:${node}`,
            )
          else if (op === 'not_running' && pending)
            write('task.requeued_with_reply', [requeueWith(pending.id)], `node:${node}`)
          else if (op === 'unblocked')
            write(
              'task.unblocked',
              [{ ...base, type: 'task.unblocked', payload: chance(0.5) ? { note: '恢复' } : {} }],
              `node:${node}`,
            )
          else if (op === 'cancel_requested')
            write(
              'task.cancel_requested(blocked)',
              [{ ...base, type: 'task.cancel_requested', payload: {} }],
              'user',
            )
          else if (op === 'lease_expired' && lease) {
            const expired = {
              ...base,
              type: 'task.lease_expired',
              payload: {
                lease_id: lease.lease_id,
                node_id: lease.node_id,
                expired_at: lease.expires_at,
                attempt: lease.attempt,
              },
            } as const
            const nodeLost = {
              ...base,
              type: 'task.blocked',
              payload: {
                reason: 'node_lost',
                message: '等待回复期间掉线',
                node_id: lease.node_id,
                lease_held: false,
                ...(session ? { session } : {}),
              },
            } as const
            write(
              'task.lease_expired(blocked)',
              pending ? [expired, requeueWith(pending.id)] : [expired, nodeLost],
            )
          } else if (op === 'crashed' && lease) {
            const crashed = {
              ...base,
              type: 'task.blocked',
              payload: { reason: 'crashed', message: '崩溃', node_id: node, lease_held: false },
            } as const
            write(
              'task.blocked(blocked→crashed)',
              pending ? [crashed, requeueWith(pending.id)] : [crashed],
              `node:${node}`,
            )
          } else if (op === 'requeued')
            write(
              'task.requeued(manual)',
              [{ ...base, type: 'task.requeued', payload: { reason: 'manual' } }],
              'agent:claude',
            )
          else if (op === 'cancelled')
            write('task.cancelled', [{ ...base, type: 'task.cancelled', payload: {} }], 'user')
          else
            write(
              'task.failed',
              [{ ...base, type: 'task.failed', payload: { message: '放弃' } }],
              'user',
            )
          break
        }
        default:
          break
      }
    }

    const incremental = store.snapshot({ includeSoft: false })
    const seq = store.seq()
    const r = store.rebuild()
    expect(r.ok).toBe(true)
    expect(store.seq()).toBe(seq + 1)
    const rebuilt = store.snapshot({ includeSoft: false })
    expect(rebuilt).toEqual(incremental)
    // 软状态已按 D2 重置
    const soft = store.snapshot()
    for (const row of soft.tasks) {
      expect(row.last_activity_at).toBeNull()
      expect(row.activity_json).toBe('[]')
    }
    for (const row of soft.nodes) expect(row.last_seen_at).toBeNull()
    return incremental.tasks.length
  } finally {
    store.close()
  }
}

describe('性质：增量投影 == 重建投影', () => {
  test(`${SEEDS} 组随机合法事件序列`, async () => {
    let totalTasks = 0
    for (let seed = 1; seed <= SEEDS; seed++) totalTasks += await runSeed(seed)
    expect(totalTasks).toBeGreaterThan(SEEDS)
    // 覆盖：创建 / 开始 / 验收 / 完成 / 失败 / 卡住 / 解除 / 取消 / 重排队 / 租约过期 等
    const kinds = [
      'task.created',
      'task.started+lease.granted',
      'task.verifying',
      'task.done',
      'task.failed',
      'task.blocked',
      'task.blocked(lease_held)',
      'task.unblocked',
      'task.unblocked(reply)',
      'task.replied',
      'task.replied+requeued_with_reply',
      'task.requeued_with_reply',
      'task.cancel_requested(blocked)',
      'task.lease_expired(blocked)',
      'task.blocked(blocked→crashed)',
      'task.requeued(manual)',
      'task.cancel_requested',
      'task.cancelled',
      'task.lease_expired+task.requeued',
      'task.lease_expired+task.blocked',
      'node.registered',
      'schedule.fired',
      'hub.started',
      'hub.resumed',
      'hub.backup_done',
      'hub.rebuilt',
      'soft-state',
      'rejected',
      'inbox.item_created',
      'inbox.item_updated',
      'inbox.item_closed',
      'inbox.rejected',
    ]
    expect(kinds.filter((k) => (coverage.get(k) ?? 0) === 0)).toEqual([])
  }, 120_000)
})
