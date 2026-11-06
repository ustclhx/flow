import { afterEach, expect, test } from 'bun:test'
import {
  defaultSupervisorConfig,
  type EventOf,
  leaseGrant,
  ok,
  type PrEventPayload,
  renewLeaseData,
} from '@raindown/core'
import type { WorkspaceInfo } from '../src/ledger/tasks.ts'
import { createPrPassthrough } from '../src/pr/passthrough.ts'
import { observeAutonomous, prSourcedWake } from '../src/supervisor/observe.ts'
import { WakeProjection } from '../src/supervisor/projection.ts'
import { contract, must, startTask, tempLedger, WS } from './ledger-helpers.ts'

/** PR #87 第一轮审查的回归测试：订阅先后、检查点、恢复预算、PR 状态、合并中、来源与卡住去重。 */

const PR = 'https://github.com/acme/demo/pull/40'
const T0 = Date.parse('2026-10-24T00:00:00Z')
let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  cleanups = []
})

let n = 0
const payload = (over: Partial<PrEventPayload> = {}): PrEventPayload => ({
  pr: PR,
  kind: 'issue_comment',
  actor: 'acme',
  actor_kind: 'human',
  allowed: true,
  pr_state: 'open',
  text: '请再改一下',
  url: `${PR}#issuecomment-${++n}`,
  cursor: `2026-10-24T00:00:00.000Z|${n}`,
  ...over,
})

async function setup(github: WorkspaceInfo['github'] = { watch: true }) {
  let now = T0
  const t = await tempLedger({ now: () => now })
  const ledger = t.store
  const workspace: WorkspaceInfo = {
    ref: WS,
    repos: [],
    supervisor: defaultSupervisorConfig(),
    ...(github ? { github } : {}),
  }
  const make = () =>
    createPrPassthrough({
      ledger,
      workspaces: async () => workspace,
      roles: async (name) => ok({ name, creatable_by: ['*'] }),
      supervisorActive: async () => true,
      now: () => now,
    })
  let passthrough = make()
  passthrough.start()
  cleanups.push(async () => {
    await passthrough.stop()
    t.cleanup()
  })
  const create = (id: string, over: Parameters<typeof contract>[0] = {}) =>
    must(
      ledger.append(
        { type: 'task.created', task_id: id, workspace: WS, payload: { contract: contract(over) } },
        { actor: 'user' },
      ),
    )
  const subscribe = (id: string) =>
    must(
      ledger.append(
        { type: 'pr.subscribed', task_id: id, workspace: WS, payload: { pr: PR, role: 'author' } },
        { actor: 'hub' },
      ),
    )
  /** 建一个已完成并订阅 PR 的任务。 */
  const doneTask = (id: string) => {
    create(id)
    subscribe(id)
    startTask(ledger, id)
    must(
      ledger.appendMany(
        [
          {
            type: 'task.attempt_ended',
            task_id: id,
            workspace: WS,
            payload: { attempt: 1, reason: 'done' },
          },
          {
            type: 'task.done',
            task_id: id,
            workspace: WS,
            payload: { result: { summary: '完成', executor: 'fake', node_id: 'n1' } },
          },
        ],
        { actor: 'hub' },
      ),
    )
  }
  const comment = async (over: Partial<PrEventPayload> = {}) => {
    const e = must(
      ledger.append({ type: 'pr.event', workspace: WS, payload: payload(over) }, { actor: 'hub' }),
    ) as EventOf<'pr.event'>
    await passthrough.idle()
    return e
  }
  const stopPassthrough = async () => {
    await passthrough.stop()
  }
  const restart = async () => {
    await passthrough.stop()
    passthrough = make()
    passthrough.start()
    await passthrough.idle()
  }
  const wakes = () =>
    ledger.eventsAfter(0, {}, 100_000).filter((e) => e.type === 'pr.wake_requested')
  const finish = (id: string, attempt: number) =>
    must(
      ledger.appendMany(
        [
          {
            type: 'task.started',
            task_id: id,
            workspace: WS,
            payload: { node_id: 'n1', lease_id: `l-${id}-${attempt}`, attempt },
          },
          {
            type: 'task.attempt_ended',
            task_id: id,
            workspace: WS,
            payload: { attempt, reason: 'done' },
          },
          {
            type: 'task.done',
            task_id: id,
            workspace: WS,
            payload: { result: { summary: '完成', executor: 'fake', node_id: 'n1' } },
          },
        ],
        { actor: 'hub' },
      ),
    )
  return {
    ledger,
    workspace,
    create,
    subscribe,
    doneTask,
    comment,
    restart,
    stopPassthrough,
    wakes,
    finish,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('后来才订阅的任务收不到更早的 PR 事件，重启补处理也不会重放给它；store 同样拒绝', async () => {
  const s = await setup()
  s.create('early')
  s.subscribe('early')
  const e = await s.comment({ actor: 'mallory', allowed: false })
  s.create('late')
  s.subscribe('late')
  await s.restart()
  const inputs = (id: string) =>
    s.ledger.taskEvents(id).filter((x) => x.type === 'task.input_added')
  expect(inputs('early')).toHaveLength(1)
  expect(inputs('late')).toEqual([])
  expect(
    s.ledger.append(
      {
        type: 'task.input_added',
        task_id: 'late',
        workspace: WS,
        payload: { source: 'pr', pr_event_seq: e.seq },
      },
      { actor: 'hub' },
    ),
  ).toMatchObject({ ok: false, error: { code: 'not_subscribed' } })
})

test('持久化检查点：每条事件处理后写 pr.dispatched，重启只处理检查点之后的事件', async () => {
  const s = await setup()
  s.create('t1')
  s.subscribe('t1')
  const first = await s.comment({ actor: 'mallory', allowed: false })
  expect(s.ledger.prDispatchedUpTo()).toBe(first.seq)
  expect(s.ledger.taskEvents('t1').filter((x) => x.type === 'task.input_added')).toHaveLength(1)
  const before = s.ledger.eventsAfter(0, {}, 100_000).length
  await s.restart()
  // 检查点之前的事件不再处理：没有任何新写入。
  expect(s.ledger.eventsAfter(0, {}, 100_000)).toHaveLength(before)
})

test('恢复预算：每个任务每天最多恢复 N 次，超出后转收件箱、不唤醒 supervisor', async () => {
  const s = await setup({ watch: true, resume_per_day: 1 })
  s.doneTask('t1')
  await s.comment()
  expect(s.ledger.getTask('t1')?.status).toBe('queued')
  s.finish('t1', 2)
  await s.comment({ text: '再来一次' })
  expect(s.ledger.getTask('t1')?.status).toBe('done')
  expect(s.wakes()).toEqual([])
  const items = s.ledger.listInboxItems({ state: 'open' })
  expect(items).toMatchObject([{ source: 'pr_comment', task_id: 't1' }])
  expect(items[0]?.body).toContain('github.resume_per_day')
  // 过了 24 小时预算恢复。
  s.advance(25 * 3600_000)
  await s.comment({ text: '第二天' })
  expect(s.ledger.getTask('t1')?.status).toBe('queued')
})

test('PR 已合并或关闭时不恢复，转给 supervisor', async () => {
  for (const pr_state of ['merged', 'closed'] as const) {
    const s = await setup()
    s.doneTask('t1')
    const e = await s.comment({ pr_state })
    expect(s.ledger.getTask('t1')?.status).toBe('done')
    expect(s.wakes()).toMatchObject([
      { task_id: 't1', payload: { pr_event_seq: e.seq, reason: 'resume_rejected' } },
    ])
    expect(s.wakes()[0]?.payload.note).toContain(pr_state === 'merged' ? '已合并' : '已关闭')
  }
})

test('开发任务的 PR 有进行中的 merger 任务时不恢复，转给 supervisor', async () => {
  const s = await setup()
  s.doneTask('dev')
  s.create('merger', {
    role: 'merger',
    executor: 'pr-merge',
    inputs: { merge: { pr: PR, review_task: 'rev', branch: 'raindown/dev' } },
  })
  await s.comment()
  expect(s.ledger.getTask('dev')?.status).toBe('done')
  expect(s.wakes()[0]?.payload.note).toContain('merger')
})

test('审查正文即使来自名单内用户也不恢复', async () => {
  const s = await setup()
  s.doneTask('t1')
  await s.comment({ kind: 'review', state: 'changes_requested' })
  expect(s.ledger.getTask('t1')?.status).toBe('done')
  expect(s.wakes()).toEqual([])
})

test('task.requeued{reason: input} 清除该任务的卡住唤醒去重', () => {
  const projection = new WakeProjection({ item: () => null })
  let seq = 0
  const ev = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    projection.apply({
      seq: ++seq,
      ts: '2026-10-24T00:00:00.000Z',
      type,
      workspace: WS,
      task_id: 't1',
      actor: 'hub',
      payload,
      ...extra,
    } as never)
  ev('task.created', { contract: contract(), origin: 'instruction' })
  ev('task.blocked', { reason: 'crashed', message: '崩溃', lease_held: false })
  ev('task.blocked', { reason: 'crashed', message: '又崩溃', lease_held: false })
  expect(
    projection.pending(WS, 'instruction').filter((q) => q.type === 'task.blocked'),
  ).toHaveLength(1)
  ev('task.requeued', { reason: 'input', pr_event_seq: 1 })
  ev('task.blocked', { reason: 'crashed', message: '新一轮崩溃', lease_held: false })
  expect(
    projection.pending(WS, 'instruction').filter((q) => q.type === 'task.blocked'),
  ).toHaveLength(2)
})

test('来源 instruction:pr：与 autonomous 同样受 observe 约束', async () => {
  const config = {
    ...defaultSupervisorConfig(),
    observe: { ...defaultSupervisorConfig().observe, autonomous: true },
  }
  expect(observeAutonomous('instruction', config)).toBe(false)
  expect(observeAutonomous('instruction', config, 'pr')).toBe(true)
  const s = await setup()
  expect(prSourcedWake(s.ledger, undefined)).toBe(false)
  expect(prSourcedWake(s.ledger, 'no-such-wake')).toBe(false)
})

test('输入逐条宽松解析：单条格式错误不让整批丢失', () => {
  const good = {
    input_seq: 3,
    source: 'pr' as const,
    pr_event_seq: 2,
    text: '<untrusted-pr-event>{}</untrusted-pr-event>',
  }
  const grant = leaseGrant.parse({
    lease_id: 'l1',
    lease_token: 'x'.repeat(16),
    task_id: 't1',
    workspace: WS,
    contract: contract(),
    attempt: 1,
    ttl_s: 60,
    expires_at: '2026-10-24T00:01:00.000Z',
    inputs: [good, { input_seq: 'bad' }],
  })
  expect(grant.inputs).toEqual([good])
  const renewed = renewLeaseData.parse({
    lease_id: 'l1',
    expires_at: '2026-10-24T00:01:00.000Z',
    cancel_requested: false,
    inputs: [{ source: 'email' }, good],
  })
  expect(renewed.inputs).toEqual([good])
})

test('检查点只推进到第一个缺口：处理失败的事件在重启后补处理，已处理的不重复', async () => {
  const s = await setup()
  s.create('t1')
  s.subscribe('t1')
  await s.stopPassthrough()
  const a = must(
    s.ledger.append(
      { type: 'pr.event', workspace: WS, payload: payload({ actor: 'mallory', allowed: false }) },
      { actor: 'hub' },
    ),
  )
  const b = must(
    s.ledger.append(
      { type: 'pr.event', workspace: WS, payload: payload({ actor: 'mallory', allowed: false }) },
      { actor: 'hub' },
    ),
  )
  // b 已处理（例如追赶中先完成），a 处理失败没有检查点。
  must(
    s.ledger.append(
      { type: 'pr.dispatched', workspace: WS, payload: { pr_event_seq: b.seq } },
      { actor: 'hub' },
    ),
  )
  expect(s.ledger.prDispatchedUpTo()).toBe(a.seq - 1)
  await s.restart()
  const inputs = s.ledger.taskEvents('t1').filter((x) => x.type === 'task.input_added')
  expect(inputs.map((x) => (x.payload as { pr_event_seq: number }).pr_event_seq)).toEqual([a.seq])
  expect(s.ledger.prDispatchedUpTo()).toBe(b.seq)
})
