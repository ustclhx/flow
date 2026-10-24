import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@flow/core'
import {
  createNodeProtocol,
  createTaskService,
  LEDGER_DDL,
  type LedgerStore,
  type NodeProtocol,
  openLedger,
  type TaskService,
} from '../src/index.ts'
import { contractInput, tempLedger } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/**
 * 中枢侧的回复（add-m1-executors 1.3；task-interaction spec、node-protocol 增量、design D7 / D7a）。
 * 直接调用任务服务与节点服务，不经 HTTP；HTTP 与真实节点的闭环见 packages/node/test/interaction.test.ts。
 */

const T0 = Date.parse('2026-10-25T08:00:00.000Z')
const TTL = 60

interface Ctx {
  ledger: LedgerStore
  clock: FakeClock
  protocol: NodeProtocol
  tasks: TaskService
  create(fake?: Record<string, unknown>): Promise<string>
}

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

async function setup(): Promise<Ctx> {
  const clock = new FakeClock(T0)
  const t = await tempLedger({ now: clock.now })
  const protocol = createNodeProtocol({ ledger: t.store, clock, leaseTtlS: TTL, leaseWaitMaxS: 30 })
  cleanups.push(() => {
    protocol.stop()
    t.cleanup()
  })
  let n = 0
  const tasks = createTaskService({
    ledger: t.store,
    workspaceExists: () => true,
    now: clock.now,
    newReplyId: () => `r-${++n}`,
  })
  const r = protocol.service.registerNode(
    { node_id: 'n1', hostname: 'host', version: '0.0.0', capabilities: ['executor:fake'] },
    'unknown',
  )
  if (!r.ok) throw new Error(r.error.message)
  return {
    ledger: t.store,
    clock,
    protocol,
    tasks,
    async create() {
      const c = await tasks.createTask(contractInput(), { actor: 'user' })
      if (!c.ok) throw new Error(c.error.message)
      return c.data.task.id
    },
  }
}

async function grant(ctx: Ctx) {
  const r = await ctx.protocol.service.acquire({
    node_id: 'n1',
    capabilities: ['executor:fake'],
    wait_s: 0,
  })
  if (!r.ok || !r.data.lease) throw new Error('没有领到租约')
  return r.data.lease
}

const types = (ctx: Ctx, id: string) => ctx.ledger.taskEvents(id).map((e) => e.type)
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

/** 交互式：经续约上报 blocked，租约继续持有。 */
async function blockedHeld(ctx: Ctx, reason: 'question' | 'awaiting_approval' = 'question') {
  const id = await ctx.create()
  const lease = await grant(ctx)
  const r = ctx.protocol.service.renew(lease.lease_id, {
    lease_token: lease.lease_token,
    blocked: { reason, message: reason === 'question' ? '用哪个分支？' : '允许执行 rm？' },
  })
  if (!r.ok) throw new Error(r.error.message)
  return { id, lease }
}

/** 无头：以 blocked 提交结束这一轮，附会话 id。 */
async function blockedEnded(ctx: Ctx) {
  const id = await ctx.create()
  const lease = await grant(ctx)
  const r = ctx.protocol.service.complete(lease.lease_id, {
    lease_token: lease.lease_token,
    outcome: 'blocked',
    blocked_reason: 'question',
    message: '用哪个分支？',
    session: 'sess-42',
  })
  if (!r.ok) throw new Error(r.error.message)
  return { id, lease }
}

describe('回复卡住的任务（task-interaction）', () => {
  test('对运行中的任务回复：not_blocked，账本不新增事件', async () => {
    const ctx = await setup()
    const id = await ctx.create()
    await grant(ctx)
    const before = ctx.ledger.seq()
    const r = ctx.tasks.replyTask(id, { kind: 'text', text: '好的' }, { actor: 'user' })
    expect(code(r)).toBe('not_blocked')
    expect(ctx.ledger.seq()).toBe(before)
  })

  test('对提问点了批准：reply_kind_mismatch，账本不变', async () => {
    const ctx = await setup()
    const { id } = await blockedHeld(ctx, 'question')
    const before = ctx.ledger.seq()
    for (const kind of ['approve', 'deny'] as const) {
      expect(code(ctx.tasks.replyTask(id, { kind }, { actor: 'user' }))).toBe('reply_kind_mismatch')
    }
    expect(ctx.ledger.seq()).toBe(before)
  })

  test('awaiting_approval 接受 approve / deny（带理由）/ 文字', async () => {
    for (const body of [
      { kind: 'approve' },
      { kind: 'deny', text: '不要删' },
      { kind: 'text', text: '先备份再删' },
    ]) {
      const ctx = await setup()
      const { id } = await blockedHeld(ctx, 'awaiting_approval')
      const r = ctx.tasks.replyTask(id, body, { actor: 'user' })
      expect(code(r)).toBe('ok')
      if (r.ok)
        expect(r.data.reply).toMatchObject({ kind: body.kind, by: 'user', state: 'pending' })
    }
  })

  test('其他原因只接受文字；文字回复不能为空；任务不存在', async () => {
    const ctx = await setup()
    const id = await ctx.create()
    const lease = await grant(ctx)
    ctx.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: { reason: 'no_progress', message: '15 分钟没有活动' },
    })
    expect(code(ctx.tasks.replyTask(id, { kind: 'approve' }, { actor: 'user' }))).toBe(
      'reply_kind_mismatch',
    )
    expect(code(ctx.tasks.replyTask(id, { kind: 'text' }, { actor: 'user' }))).toBe(
      'invalid_arguments',
    )
    expect(code(ctx.tasks.replyTask(id, { kind: 'text', text: '  ' }, { actor: 'user' }))).toBe(
      'invalid_arguments',
    )
    expect(
      code(ctx.tasks.replyTask('t-missing', { kind: 'text', text: 'x' }, { actor: 'u' })),
    ).toBe('not_found')
    expect(code(ctx.tasks.replyTask(id, { kind: 'text', text: '继续' }, { actor: 'user' }))).toBe(
      'ok',
    )
  })

  test('交互式任务的回复：续约取得 → 确认送达 → 依次记录 task.replied 与 task.unblocked', async () => {
    const ctx = await setup()
    const { id, lease } = await blockedHeld(ctx)
    expect(ctx.ledger.getTask(id)?.blocked).toMatchObject({ reason: 'question', lease_held: true })
    expect(ctx.ledger.activeLease(id)).not.toBeNull()

    const replied = ctx.tasks.replyTask(id, { kind: 'text', text: '用 main' }, { actor: 'user' })
    expect(replied.ok && replied.data.requeued).toBe(false)
    const renew = () =>
      ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token })
    const r1 = renew()
    expect(r1.ok && r1.data.reply).toEqual({
      reply_id: 'r-1',
      kind: 'text',
      text: '用 main',
      by: 'user',
    })
    // 确认之前每次续约都带着它。
    const r2 = renew()
    expect(r2.ok && r2.data.reply?.reply_id).toBe('r-1')

    const ack = ctx.protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-1',
    })
    expect(ack.ok && ack.data.task.status).toBe('running')
    // 节点确认后，后续续约不再返回它；重复确认是幂等的。
    const r3 = renew()
    expect(r3.ok && r3.data.reply).toBeNull()
    const again = ctx.protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-1',
    })
    expect(code(again)).toBe('ok')
    expect(types(ctx, id).slice(-3)).toEqual(['task.blocked', 'task.replied', 'task.unblocked'])
    const events = ctx.ledger.taskEvents(id)
    expect(events.at(-2)).toMatchObject({ actor: 'user', payload: { reply_id: 'r-1' } })
    expect(events.at(-1)).toMatchObject({ actor: 'node:n1', payload: { reply_id: 'r-1' } })
    expect(ctx.ledger.getReply('r-1')).toMatchObject({ state: 'delivered' })
    expect(ctx.ledger.getReply('r-1')?.delivered_at).not.toBeNull()
  })

  test('尚未送达时再次回复：reply_pending', async () => {
    const ctx = await setup()
    const { id } = await blockedHeld(ctx)
    ctx.tasks.replyTask(id, { kind: 'text', text: '用 main' }, { actor: 'user' })
    expect(code(ctx.tasks.replyTask(id, { kind: 'text', text: '改主意' }, { actor: 'user' }))).toBe(
      'reply_pending',
    )
  })

  test('无头任务的回复：带着回复与会话 id 重新排队，下一次执行据此恢复', async () => {
    const ctx = await setup()
    const { id } = await blockedEnded(ctx)
    expect(ctx.ledger.getTask(id)?.blocked).toMatchObject({ session: 'sess-42', lease_held: false })
    const r = ctx.tasks.replyTask(id, { kind: 'text', text: '用 main' }, { actor: 'user' })
    expect(r.ok && r.data).toMatchObject({ requeued: true, task: { status: 'queued' } })
    expect(types(ctx, id).slice(-3)).toEqual([
      'task.blocked',
      'task.replied',
      'task.requeued_with_reply',
    ])
    const next = await grant(ctx)
    expect(next).toMatchObject({
      task_id: id,
      attempt: 2,
      resume: {
        session: 'sess-42',
        reply: { reply_id: 'r-1', kind: 'text', text: '用 main', by: 'user' },
      },
    })
    expect(ctx.ledger.getReply('r-1')?.state).toBe('requeued')
  })

  test('确认时 worker 已不在（not_running）：带着回复重新排队，租约释放', async () => {
    const ctx = await setup()
    const { id, lease } = await blockedHeld(ctx)
    ctx.tasks.replyTask(id, { kind: 'text', text: '用 main' }, { actor: 'user' })
    const ack = ctx.protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-1',
      outcome: 'not_running',
    })
    expect(ack.ok && ack.data.task.status).toBe('queued')
    expect(ctx.ledger.activeLease(id)).toBeNull()
    expect(
      code(ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token })),
    ).toBe('lease_expired')
  })

  test('ack-reply 的错误：未知回复、令牌不符', async () => {
    const ctx = await setup()
    const { lease } = await blockedHeld(ctx)
    expect(
      code(
        ctx.protocol.service.ackReply(lease.lease_id, {
          lease_token: lease.lease_token,
          reply_id: 'r-404',
        }),
      ),
    ).toBe('reply_not_found')
    expect(
      code(
        ctx.protocol.service.ackReply(lease.lease_id, {
          lease_token: 'y'.repeat(43),
          reply_id: 'r-1',
        }),
      ),
    ).toBe('invalid_lease_token')
  })

  test('续约 resumed：worker 自行恢复，写 task.unblocked；重复上报被忽略', async () => {
    const ctx = await setup()
    const { id, lease } = await blockedHeld(ctx)
    for (let i = 0; i < 2; i++) {
      const r = ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        resumed: { note: '用户在终端里答复了' },
      })
      expect(code(r)).toBe('ok')
    }
    expect(types(ctx, id).slice(-2)).toEqual(['task.blocked', 'task.unblocked'])
    expect(ctx.ledger.getTask(id)?.status).toBe('running')
  })

  test('卡住期间租约过期：有待送达回复时带着回复重新排队；没有时保持 blocked，之后的回复让它重新排队', async () => {
    const ctx = await setup()
    const a = await blockedHeld(ctx)
    ctx.tasks.replyTask(a.id, { kind: 'text', text: '用 main' }, { actor: 'user' })
    await ctx.clock.advance((TTL + 5) * 1000)
    expect(ctx.protocol.sweep()).toBe(1)
    expect(types(ctx, a.id).slice(-2)).toEqual(['task.lease_expired', 'task.requeued_with_reply'])
    expect(ctx.ledger.getTask(a.id)?.status).toBe('queued')

    const ctx2 = await setup()
    const b = await blockedHeld(ctx2)
    await ctx2.clock.advance((TTL + 5) * 1000)
    expect(ctx2.protocol.sweep()).toBe(1)
    expect(ctx2.ledger.getTask(b.id)).toMatchObject({
      status: 'blocked',
      lease: null,
      blocked: { reason: 'question', lease_held: false },
    })
    const r = ctx2.tasks.replyTask(b.id, { kind: 'text', text: '用 main' }, { actor: 'user' })
    expect(r.ok && r.data.requeued).toBe(true)
  })

  test('取消持有租约的 blocked 任务：经续约通知节点，节点提交 cancelled', async () => {
    const ctx = await setup()
    const { id, lease } = await blockedHeld(ctx)
    const c = ctx.tasks.cancelTask(id, { actor: 'user' })
    expect(c.ok && c.data.task).toMatchObject({ status: 'blocked', cancel_requested: true })
    const r = ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token })
    expect(r.ok && r.data.cancel_requested).toBe(true)
    const done = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: lease.lease_token,
      outcome: 'cancelled',
    })
    expect(done.ok && done.data.task.status).toBe('cancelled')
  })

  test('显示任务时带上回复列表', async () => {
    const ctx = await setup()
    const { id } = await blockedEnded(ctx)
    ctx.tasks.replyTask(id, { kind: 'text', text: '用 main' }, { actor: 'agent:claude' })
    const shown = ctx.tasks.getTask(id)
    expect(shown.ok && shown.data.replies).toMatchObject([
      { id: 'r-1', by: 'agent:claude', state: 'requeued', text: '用 main' },
    ])
  })
})

describe('旧账本迁移', () => {
  test('缺少 resume_json 列的旧库打开时补列', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-ledger-migrate-'))
    try {
      const path = join(dir, 'flow.db')
      const db = await openDatabase(path)
      // 旧版 DDL：去掉 resume_json 与 replies 表。
      db.exec(
        LEDGER_DDL.replace(',\n  resume_json      TEXT\n', '\n').replace(
          /CREATE TABLE IF NOT EXISTS replies[\s\S]*$/,
          '',
        ),
      )
      const before = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      expect(before.some((c) => c.name === 'resume_json')).toBe(false)
      db.close()
      const store = await openLedger(path)
      expect(store.taskResume('t-none')).toBeNull()
      expect(store.taskReplies('t-none')).toEqual([])
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
