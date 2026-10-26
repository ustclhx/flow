import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSupervisorConfig,
  fail,
  ok,
  type Result,
  type Role,
  type SupervisorConfig,
  type TaskOrigin,
} from '@flow/core'
import { Hono } from 'hono'
import {
  createHubApp,
  createSupervisorRoutes,
  createTaskService,
  createWakeScheduler,
  createWakeTokenAuthority,
  type EventInput,
  type LedgerStore,
  openTokenStore,
  pauseMs,
  type QueuedEvent,
  type RoleLookup,
  type WakeScheduler,
  type WorkspaceInfo,
} from '../src/index.ts'
import { contract, must, result, tempLedger } from './ledger-helpers.ts'
import { FakeClock, testToken } from './server-fixtures.ts'

/**
 * add-m1-supervisor 3.1–3.4：唤醒事件识别、三条队列、合并与串行、代数与幂等键、重启恢复、
 * 每日上限、失败重试与暂停、手动放行、reply 队列骨架、user-only 路由。
 */

const WS = 'ws/demo'
const HOUR = 60 * 60 * 1000

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const READ_PERMS = {
  setting_sources: [],
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
}
const SUPERVISOR = {
  name: 'supervisor',
  executor: 'claude-sdk',
  kind: 'supervisor',
  permissions: READ_PERMS,
  creatable_by: [],
} as unknown as Role

const roles: RoleLookup = async (name) =>
  ok(name === 'supervisor' ? SUPERVISOR : { name, executor: 'fake', creatable_by: ['*'] })

/** UTC 日期计数，测试不依赖本机时区。 */
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const nextDay = (ms: number) => Date.parse(`${dayKey(ms)}T00:00:00.000Z`) + 24 * HOUR

interface SetupOptions {
  supervisor?: Partial<SupervisorConfig>
  role?: () => Promise<Result<Role | null>>
  store?: LedgerStore
  clock?: FakeClock
  /** workspace 配置能否整体加载（缺省能）。 */
  workspacesLoaded?: () => Promise<boolean>
  /** 包装建任务（测试创建失败）。 */
  wrapTasks?: (t: ReturnType<typeof createTaskService>) => ReturnType<typeof createTaskService>
}

async function setup(o: SetupOptions = {}) {
  const clock = o.clock ?? new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
  let store = o.store
  if (!store) {
    const l = await tempLedger({ now: clock.now })
    cleanups.push(l.cleanup)
    store = l.store
  }
  const root = mkdtempSync(join(tmpdir(), 'flow-sup-sched-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const config: { supervisor: SupervisorConfig } = {
    supervisor: { ...defaultSupervisorConfig(), ...o.supervisor },
  }
  const workspaces: Record<string, WorkspaceInfo> = {
    [WS]: { ref: WS, repos: [repo], supervisor: config.supervisor },
    'ws/global': { ref: 'ws/global', repos: [repo], supervisor: defaultSupervisorConfig() },
  }
  let n = 0
  const tasks = createTaskService({
    ledger: store,
    workspaceExists: async (ref) => ref in workspaces,
    workspaces: async (ref) => workspaces[ref] ?? null,
    roles,
    now: clock.now,
    newTaskId: () => `t-w${String(++n).padStart(3, '0')}`,
  })
  const unavailable: { workspace: string; reason: string; delegations: QueuedEvent[] }[] = []
  const scheduler = createWakeScheduler({
    ledger: store,
    tasks: o.wrapTasks ? o.wrapTasks(tasks) : tasks,
    clock,
    workspaces: async (ref) => workspaces[ref] ?? null,
    listWorkspaces: async () => Object.values(workspaces),
    supervisorRole: o.role ?? (async () => ok(SUPERVISOR)),
    ...(o.workspacesLoaded ? { workspacesLoaded: o.workspacesLoaded } : {}),
    dayKey,
    nextDay,
    logger: { warn() {} },
    onReplyUnavailable: (info) => unavailable.push(info),
  })
  scheduler.start()
  cleanups.push(() => scheduler.stop())
  const s = store
  return {
    store: s,
    clock,
    scheduler,
    workspaces,
    unavailable,
    tasks,
    settle: async () => {
      await scheduler.idle()
    },
    /** 账本中的唤醒（wake_started），按先后。 */
    wakes: () =>
      s
        .eventsAfter(0, {}, 10_000)
        .filter((e) => e.type === 'supervisor.wake_started')
        .map(
          (e) =>
            e.payload as { task_id: string; origin: string; events: number[]; generation: number },
        ),
  }
}

type Env = Awaited<ReturnType<typeof setup>>

const instruction = (store: LedgerStore, text = '修一下 README') =>
  must(
    store.append(
      { type: 'user.instruction', workspace: WS, payload: { text, via: 'cli' } },
      { actor: 'user' },
    ),
  ).seq

const patrol = (store: LedgerStore, at = '2026-10-26T09:00:00.000Z') =>
  must(
    store.append(
      {
        type: 'schedule.fired',
        workspace: WS,
        payload: { rule_id: 'patrol', planned_at: at, payload: { kind: 'supervisor_patrol' } },
      },
      { actor: 'hub' },
    ),
  ).seq

/** 账本里建一个带 origin 的派生任务（直接写事件）。 */
function derived(store: LedgerStore, id: string, origin?: TaskOrigin) {
  must(
    store.append(
      {
        type: 'task.created',
        task_id: id,
        workspace: WS,
        payload: { contract: contract(), ...(origin ? { origin } : {}) },
      },
      { actor: 'user' },
    ),
  )
}

function start(store: LedgerStore, id: string, attempt = 1) {
  must(
    store.appendMany(
      [
        {
          type: 'task.started',
          task_id: id,
          workspace: WS,
          payload: { node_id: 'n1', lease_id: `l-${id}-${attempt}`, attempt },
        },
        {
          type: 'lease.granted',
          task_id: id,
          workspace: WS,
          payload: {
            lease_id: `l-${id}-${attempt}`,
            node_id: 'n1',
            token_sha256: 'ab'.repeat(32),
            ttl_s: 60,
            expires_at: '2026-10-27T01:00:00.000Z',
          },
        },
      ],
      { actor: 'node:n1' },
    ),
  )
}

const finish = (store: LedgerStore, id: string) => {
  start(store, id)
  return must(
    store.append(
      { type: 'task.done', task_id: id, workspace: WS, payload: { result: result() } },
      { actor: 'node:n1' },
    ),
  ).seq
}

const failTask = (store: LedgerStore, id: string, attempt = 1) => {
  start(store, id, attempt)
  return must(
    store.append(
      { type: 'task.failed', task_id: id, workspace: WS, payload: { message: '会话崩溃' } },
      { actor: 'node:n1' },
    ),
  ).seq
}

const block = (store: LedgerStore, id: string, reason: string) =>
  must(
    store.append(
      {
        type: 'task.blocked',
        task_id: id,
        workspace: WS,
        payload: { reason, message: '卡住了', tail: ['最后一行'] },
      } as EventInput,
      { actor: 'node:n1' },
    ),
  ).seq

async function wakeCount(env: Env) {
  await env.settle()
  return env.wakes().length
}

describe('唤醒事件识别（3.1）', () => {
  test('用户指令唤醒：hub 创建唤醒任务，task.created 与 wake_started 同一次写入，代数与幂等键', async () => {
    const env = await setup()
    const seq = instruction(env.store)
    await env.settle()
    const [w] = env.wakes()
    expect(w).toMatchObject({ origin: 'instruction', events: [seq], generation: 1 })
    const task = env.store.getTask(w?.task_id ?? '')
    expect(task).toMatchObject({
      created_by: 'hub',
      origin: 'instruction',
      contract: {
        role: 'supervisor',
        executor: 'claude-sdk',
        idempotency_key: `supervisor:${WS}:1`,
        inputs: {
          wake: {
            origin: 'instruction',
            generation: 1,
            events: [{ seq, type: 'user.instruction', summary: '修一下 README' }],
          },
        },
      },
    })
    // 只有调度器一层重试：合同不带 retry，租约过期不重新排队（design D3）
    expect(task?.contract.retry).toBeUndefined()
    const events = env.store.taskEvents(w?.task_id ?? '')
    expect(events.map((e) => e.type)).toEqual(['task.created', 'supervisor.wake_started'])
    expect(events[1]?.seq).toBe((events[0]?.seq ?? 0) + 1)
    expect(events[1]?.actor).toBe('hub')
  })

  test('唤醒任务自身结束不自激；非 user 的指令、非巡检的定时不唤醒', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const [w] = env.wakes()
    finish(env.store, w?.task_id ?? '')
    expect(await wakeCount(env)).toBe(1)
    must(
      env.store.append(
        {
          type: 'schedule.fired',
          workspace: WS,
          payload: {
            rule_id: 'other',
            planned_at: '2026-10-26T10:00:00.000Z',
            payload: { kind: 'x' },
          },
        },
        { actor: 'hub' },
      ),
    )
    expect(await wakeCount(env)).toBe(1)
  })

  test('派生任务：终态与 crashed/node_lost/no_progress/other 卡住唤醒（同一任务同一原因一次）；question、无 origin 不唤醒', async () => {
    const env = await setup()
    derived(env.store, 'd1', 'instruction')
    derived(env.store, 'd2')
    start(env.store, 'd1')
    block(env.store, 'd1', 'question')
    expect(await wakeCount(env)).toBe(0)
    must(
      env.store.append(
        { type: 'task.failed', task_id: 'd1', workspace: WS, payload: { message: 'x' } },
        { actor: 'user' },
      ),
    )
    expect(await wakeCount(env)).toBe(1)
    finish(env.store, env.wakes()[0]?.task_id ?? '')

    derived(env.store, 'd3', 'autonomous')
    start(env.store, 'd3')
    const crashed = block(env.store, 'd3', 'crashed')
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [crashed] })
    finish(env.store, env.wakes()[1]?.task_id ?? '')
    // 同一原因再次卡住（blocked → blocked）不再唤醒
    block(env.store, 'd3', 'crashed')
    expect(await wakeCount(env)).toBe(2)

    finish(env.store, 'd2')
    expect(await wakeCount(env)).toBe(2)
  })

  test('冒充唤醒：inputs.wake 伪造的普通任务不被当作唤醒，它结束时按派生规则（无 origin 不唤醒）', async () => {
    const env = await setup()
    derived(env.store, 'fake-wake')
    finish(env.store, 'fake-wake')
    expect(await wakeCount(env)).toBe(0)
    expect(env.scheduler.projection().wake('fake-wake')).toBeNull()
  })
})

describe('队列、合并与串行（3.2）', () => {
  test('运行中到达的两个事件在唤醒结束后合并成一个唤醒', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const a = env.wakes()[0]?.task_id ?? ''
    derived(env.store, 'd1', 'instruction')
    derived(env.store, 'd2', 'instruction')
    const s1 = finish(env.store, 'd1')
    const s2 = finish(env.store, 'd2')
    expect(await wakeCount(env)).toBe(1)
    finish(env.store, a)
    await env.settle()
    expect(env.wakes()).toHaveLength(2)
    expect(env.wakes()[1]).toMatchObject({ origin: 'instruction', events: [s1, s2], generation: 2 })
    expect(env.store.getTask(env.wakes()[1]?.task_id ?? '')?.contract.idempotency_key).toBe(
      `${'supervisor:'}${WS}:2`,
    )
  })

  test('不同来源不合并：先 instruction 再 autonomous', async () => {
    const env = await setup()
    instruction(env.store, '第一条')
    await env.settle()
    const p = patrol(env.store)
    const i = instruction(env.store, '第二条')
    await env.settle()
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ origin: 'instruction', events: [i] })
    finish(env.store, env.wakes()[1]?.task_id ?? '')
    await env.settle()
    expect(env.wakes()[2]).toMatchObject({ origin: 'autonomous', events: [p] })
    expect(env.store.getTask(env.wakes()[2]?.task_id ?? '')?.origin).toBe('autonomous')
  })

  test('卡住的唤醒期间事件排队；用户取消唤醒后随即创建下一次唤醒', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const a = env.wakes()[0]?.task_id ?? ''
    start(env.store, a)
    must(
      env.store.append(
        {
          type: 'task.blocked',
          task_id: a,
          workspace: WS,
          payload: { reason: 'awaiting_approval', message: '请批准', lease_held: true },
        },
        { actor: 'node:n1' },
      ),
    )
    const next = instruction(env.store, '又一条')
    expect(await wakeCount(env)).toBe(1)
    must(
      env.store.append(
        { type: 'task.cancelled', task_id: a, workspace: WS, payload: {} },
        { actor: 'user' },
      ),
    )
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ events: [next] })
  })

  test('连续两次正常唤醒是两个不同的任务；未启用、global、没有角色、角色可写时不唤醒', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    instruction(env.store)
    await env.settle()
    const ids = env.wakes().map((w) => w.task_id)
    expect(new Set(ids).size).toBe(2)

    for (const variant of [
      { supervisor: { enabled: false } },
      { role: async () => ok(null) },
      { role: async () => fail('failure', 'supervisor_role_writable', '可写') },
    ] as SetupOptions[]) {
      const off = await setup(variant)
      instruction(off.store)
      expect(await wakeCount(off)).toBe(0)
      const r = await off.scheduler.instruct(WS, '看看', 'cli')
      expect(r).toMatchObject({ ok: false, error: { code: 'supervisor_disabled' } })
      expect(
        off.store.eventsAfter(0, {}, 100).filter((e) => e.type === 'user.instruction'),
      ).toHaveLength(1)
    }
    const g = await setup()
    const r = await g.scheduler.instruct('ws/global', '看看', 'telegram')
    expect(r).toMatchObject({ ok: false, error: { code: 'supervisor_disabled' } })
    // 只有初始化标记，没有指令
    expect(g.store.eventsAfter(0, {}, 100).map((e) => e.type)).toEqual([
      'supervisor.scheduler_initialized',
    ])
  })

  test('中枢重启：待处理事件只创建一次唤醒，之后重启不重复', async () => {
    const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
    const l = await tempLedger({ now: clock.now })
    cleanups.push(l.cleanup)
    // 之前运行过一次（写下初始化标记）；停机期间到达一条指令，然后启动
    ;(await setup({ store: l.store, clock })).scheduler.stop()
    const seq = instruction(l.store)
    const first = await setup({ store: l.store, clock })
    await first.settle()
    expect(first.wakes()).toEqual([expect.objectContaining({ events: [seq], generation: 1 })])
    first.scheduler.stop()
    // 运行中又来一个事件，然后"重启"
    const pending = instruction(l.store, '重启前的第二条')
    const second = await setup({ store: l.store, clock })
    await second.settle()
    expect(second.wakes()).toHaveLength(1)
    expect(
      second.scheduler
        .projection()
        .pending(WS, 'instruction')
        .map((e) => e.seq),
    ).toEqual([pending])
    finish(l.store, second.wakes()[0]?.task_id ?? '')
    await second.settle()
    second.scheduler.stop()
    const third = await setup({ store: l.store, clock })
    await third.settle()
    expect(third.wakes()).toHaveLength(2)
    expect(third.wakes()[1]).toMatchObject({ events: [pending], generation: 2 })
  })

  test('抢注 supervisor: 幂等键返回 reserved_idempotency_key', async () => {
    const env = await setup()
    const tasks = createTaskService({
      ledger: env.store,
      workspaceExists: async () => true,
      roles,
    })
    const r = await tasks.createTask(
      { ...contract(), idempotency_key: `supervisor:${WS}:1` },
      { actor: 'user' },
    )
    expect(r).toMatchObject({ ok: false, error: { code: 'reserved_idempotency_key' } })
  })
})

describe('每日上限、失败与放行（3.3）', () => {
  test('当天第 25 个事件：不创建唤醒，收件箱出现"今日唤醒已达上限"；次日自动继续', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, wakes_per_day: 2 } },
    })
    for (let i = 0; i < 2; i++) {
      instruction(env.store, `第 ${i} 条`)
      await env.settle()
      finish(env.store, env.wakes()[i]?.task_id ?? '')
    }
    const third = instruction(env.store, '第三条')
    expect(await wakeCount(env)).toBe(2)
    const item = env.store.getInboxItem('wake.limit.demo.2026-10-26.instruction')
    expect(item).toMatchObject({ level: 'decide', source: 'supervisor', state: 'open' })
    expect(item?.title).toContain('今日唤醒已达上限，instruction 队列')
    const placed = await env.scheduler.status(WS)
    expect(must(placed).workspaces[0]?.today).toMatchObject({ wakes: 2, wakes_per_day: 2 })
    await env.clock.advance(24 * HOUR)
    await env.settle()
    expect(env.wakes()[2]).toMatchObject({ events: [third] })
  })

  test('autonomous 单独计数：达上限后 instruction 照常唤醒', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, autonomous_wakes_per_day: 1 } },
    })
    patrol(env.store, '2026-10-26T08:00:00.000Z')
    await env.settle()
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    patrol(env.store, '2026-10-26T09:00:00.000Z')
    expect(await wakeCount(env)).toBe(1)
    expect(env.store.getInboxItem('wake.limit.demo.2026-10-26.autonomous')).not.toBeNull()
    instruction(env.store)
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ origin: 'instruction' })
  })

  test('失败重试一次 → Interrupt 并暂停 → 满 1 小时自动恢复 → 再失败退避翻倍 → 放行立即唤醒且不计入上限', async () => {
    const env = await setup()
    const p = patrol(env.store)
    await env.settle()
    failTask(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    // 立即重试，事件相同
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [p] })
    const retryId = env.wakes()[1]?.task_id ?? ''
    failTask(env.store, retryId)
    await env.settle()
    expect(env.wakes()).toHaveLength(2)
    expect(env.store.getInboxItem(`wake.fail.${retryId}`)).toMatchObject({
      level: 'interrupt',
      source: 'supervisor',
      task_id: retryId,
    })
    // 暂停期间新事件只排队
    const p2 = patrol(env.store, '2026-10-26T10:00:00.000Z')
    expect(await wakeCount(env)).toBe(2)
    const st = must(await env.scheduler.status(WS)).workspaces[0]
    expect(st?.paused.autonomous).toMatchObject({ failures: 2 })
    // 同一条巡检规则只保留最新一次触发
    expect(st?.queues.autonomous).toBe(1)
    // instruction 队列不受影响
    instruction(env.store)
    await env.settle()
    expect(env.wakes()[2]).toMatchObject({ origin: 'instruction' })
    finish(env.store, env.wakes()[2]?.task_id ?? '')
    expect(await wakeCount(env)).toBe(3)

    await env.clock.advance(pauseMs(2))
    await env.settle()
    expect(env.wakes()[3]).toMatchObject({ origin: 'autonomous', events: [p2] })
    const resumed = env.wakes()[3]?.task_id ?? ''
    failTask(env.store, resumed)
    await env.settle()
    expect(env.wakes()).toHaveLength(4)
    expect(pauseMs(3)).toBe(2 * HOUR)
    await env.clock.advance(HOUR)
    expect(await wakeCount(env)).toBe(4)

    const before = must(await env.scheduler.status(WS)).workspaces[0]?.today.wakes
    const r = must(await env.scheduler.release(WS, 'autonomous'))
    expect(r).toMatchObject({ state: 'started', wake: { origin: 'autonomous' } })
    expect(env.wakes()[4]).toMatchObject({ origin: 'autonomous', events: [p2] })
    expect(must(await env.scheduler.status(WS)).workspaces[0]?.today.wakes).toBe(before)
    expect(
      env.store.eventsAfter(0, {}, 1000).find((e) => e.type === 'supervisor.release')?.actor,
    ).toBe('user')
  })

  test('暂停的退避最长 24 小时', () => {
    expect(pauseMs(2)).toBe(HOUR)
    expect(pauseMs(4)).toBe(4 * HOUR)
    expect(pauseMs(10)).toBe(24 * HOUR)
  })

  test('放行时前面有唤醒在运行：结束后立即处理该队列；空队列放行返回 empty', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, autonomous_wakes_per_day: 0 } },
    })
    const empty = must(await env.scheduler.release(WS, 'instruction'))
    expect(empty.state).toBe('empty')
    instruction(env.store)
    await env.settle()
    const p = patrol(env.store)
    const r = must(await env.scheduler.release(WS, 'autonomous'))
    expect(r).toMatchObject({ state: 'queued', reason: 'busy' })
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    // 上限为 0 也能放行
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [p] })
  })
})

describe('reply 队列骨架（3.2，D15）', () => {
  /** 一个卡在提问的任务，并写入委托（3.5 之前由测试直接写 task.reply_delegated）。 */
  function delegate(store: LedgerStore, id: string) {
    derived(store, id)
    start(store, id)
    const blockSeq = block(store, id, 'question')
    return must(
      store.append(
        {
          type: 'task.reply_delegated',
          task_id: id,
          workspace: WS,
          payload: {
            task_id: id,
            block_seq: blockSeq,
            kind: 'question',
            deadline: '2026-10-26T08:10:00.000Z',
          },
        },
        { actor: 'hub' },
      ),
    ).seq
  }

  test('与普通唤醒并行；inputs.wake 带卡住上下文；失败不重试、不暂停', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const d = delegate(env.store, 'q1')
    await env.settle()
    const reply = env.wakes()[1]
    expect(reply).toMatchObject({ origin: 'reply', events: [d], generation: 2 })
    const task = env.store.getTask(reply?.task_id ?? '')
    expect(task?.origin).toBeNull()
    expect(task?.contract.retry).toBeUndefined()
    expect(task?.contract.inputs?.wake?.events[0]).toMatchObject({
      type: 'task.reply_delegated',
      task_id: 'q1',
      data: { kind: 'question', message: '卡住了', tail: ['最后一行'], goal: '写一个测试' },
    })
    failTask(env.store, reply?.task_id ?? '')
    expect(await wakeCount(env)).toBe(2)
    // 新的委托照常唤醒（队列不暂停）
    const d2 = delegate(env.store, 'q2')
    await env.settle()
    expect(env.wakes()[2]).toMatchObject({ origin: 'reply', events: [d2] })
  })

  test('开始前剔除失效委托：全部失效不唤醒；配额用尽与未启用交给 3.5 的钩子', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, reply_wakes_per_day: 1 } },
    })
    // 先占住 reply 槽位，再让 q1 的委托失效
    const first = delegate(env.store, 'q0')
    await env.settle()
    expect(env.wakes()[0]).toMatchObject({ origin: 'reply', events: [first] })
    delegate(env.store, 'q1')
    must(
      env.store.append(
        { type: 'task.cancelled', task_id: 'q1', workspace: WS, payload: {} },
        { actor: 'user' },
      ),
    )
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    expect(await wakeCount(env)).toBe(1)
    expect(env.unavailable).toEqual([])

    const d = delegate(env.store, 'q2')
    await env.settle()
    expect(env.wakes()).toHaveLength(1)
    expect(env.unavailable.at(-1)).toMatchObject({ reason: 'quota', delegations: [{ seq: d }] })

    const off = await setup({ supervisor: { enabled: false } })
    delegate(off.store, 'q3')
    await off.settle()
    expect(off.unavailable.at(-1)).toMatchObject({ reason: 'unavailable' })
  })
})

describe('用户接口（3.4）', () => {
  function app(scheduler: WakeScheduler, actor: string) {
    const a = new Hono()
    a.use('*', async (c, next) => {
      c.set('actor', actor)
      await next()
    })
    a.route('/', createSupervisorRoutes({ scheduler: () => scheduler }))
    return a
  }
  const post = (a: Hono, body: unknown) =>
    a.request('/v1/supervisor/wake', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })

  test('flow ask：写入 actor 为 user、via cli 的指令并返回唤醒任务；第二条返回已排队', async () => {
    const env = await setup()
    const a = app(env.scheduler, 'user')
    const r1 = await post(a, { workspace: WS, text: '修一下 README' })
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as { data: { state: string; wake: { task_id: string } } }
    expect(b1.data.state).toBe('started')
    const ev = env.store.eventsAfter(0, {}, 100).find((e) => e.type === 'user.instruction')
    expect(ev).toMatchObject({ actor: 'user', payload: { text: '修一下 README', via: 'cli' } })
    expect(env.wakes()[0]?.task_id).toBe(b1.data.wake.task_id)

    const r2 = await post(a, { workspace: WS })
    const b2 = (await r2.json()) as {
      data: { state: string; reason: string; running: { task_id: string } }
    }
    expect(b2.data).toMatchObject({
      state: 'queued',
      reason: 'busy',
      running: { task_id: b1.data.wake.task_id },
    })
    expect(
      env.store
        .eventsAfter(0, {}, 100)
        .filter((e) => e.type === 'user.instruction')
        .at(-1)?.payload,
    ).toMatchObject({
      text: '（用户手动唤醒，没有附加说明）',
    })

    const st = await a.request(`/v1/supervisor/status?workspace=${encodeURIComponent(WS)}`)
    const body = (await st.json()) as {
      data: { workspaces: { current: { task_id: string }; queues: { instruction: number } }[] }
    }
    expect(body.data.workspaces[0]).toMatchObject({
      current: { task_id: b1.data.wake.task_id },
      queues: { instruction: 1 },
    })

    const bad = await post(a, { workspace: WS, text: 'x', release: 'instruction' })
    expect(bad.status).toBe(400)
  })

  test('AI 与 supervisor 身份调用指令、放行、状态接口返回 403 user_only，不写任何事件', async () => {
    for (const actor of ['reviewer', 'supervisor', 'hub']) {
      const env = await setup()
      const before = env.store.seq()
      const a = app(env.scheduler, actor)
      const r = await post(a, { workspace: WS, text: '越权' })
      expect(r.status).toBe(403)
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('user_only')
      const rel = await post(a, { workspace: WS, release: 'autonomous' })
      expect(rel.status).toBe(403)
      const st = await a.request('/v1/supervisor/status')
      expect(st.status).toBe(403)
      expect(env.store.seq()).toBe(before)
    }
  })

  test('store 兜底：user.instruction 与 supervisor.release 只接受 user 写入', async () => {
    const env = await setup()
    const r = env.store.append(
      { type: 'user.instruction', workspace: WS, payload: { text: 'x', via: 'cli' } },
      { actor: 'reviewer' },
    )
    expect(r).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
    const rel = env.store.append(
      { type: 'supervisor.release', workspace: WS, payload: { queue: 'instruction' } },
      { actor: 'hub' },
    )
    expect(rel).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
  })
})

const drops = (store: LedgerStore) =>
  store
    .eventsAfter(0, {}, 10_000)
    .filter((e) => e.type === 'supervisor.queue_dropped')
    .map((e) => ({ actor: e.actor, ...(e.payload as { reason: string }) }))

describe('积压丢弃与合并上限（G10 审查）', () => {
  test('升级：首次启动写初始化标记，库里已有的旧指令不唤醒；之后的新指令照常；标记只写一次', async () => {
    const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
    const l = await tempLedger({ now: clock.now })
    cleanups.push(l.cleanup)
    instruction(l.store, '调度器上线前写下的旧指令')
    const upTo = patrol(l.store)
    const env = await setup({ store: l.store, clock })
    await env.settle()
    expect(env.wakes()).toEqual([])
    const marks = () =>
      l.store
        .eventsAfter(0, {}, 10_000)
        .filter((e) => e.type === 'supervisor.scheduler_initialized')
    expect(marks()).toEqual([
      expect.objectContaining({ actor: 'hub', payload: { up_to_seq: upTo } }),
    ])
    expect(drops(l.store)).toEqual([])
    const fresh = instruction(l.store, '新指令')
    await env.settle()
    expect(env.wakes()).toEqual([expect.objectContaining({ events: [fresh] })])
    env.scheduler.stop()
    const again = await setup({ store: l.store, clock })
    await again.settle()
    expect(marks()).toHaveLength(1)
    // store 兜底：只接受 hub、只写一次
    expect(
      l.store.append(
        { type: 'supervisor.scheduler_initialized', payload: { up_to_seq: 0 } },
        { actor: 'user' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
    expect(
      l.store.append(
        { type: 'supervisor.scheduler_initialized', payload: { up_to_seq: 0 } },
        { actor: 'hub' },
      ),
    ).toMatchObject({ ok: false })
  })

  test('探针 A：全新安装、首次创建唤醒失败后重启，第一条指令不丢', async () => {
    const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
    const l = await tempLedger({ now: clock.now })
    cleanups.push(l.cleanup)
    const first = await setup({
      store: l.store,
      clock,
      wrapTasks: (t) => ({
        ...t,
        createTask: async () => fail('failure', 'internal_error', '失败'),
      }),
    })
    const seq = instruction(l.store, '首条真实指令')
    await first.settle()
    expect(first.wakes()).toEqual([])
    first.scheduler.stop()
    const second = await setup({ store: l.store, clock })
    await second.settle()
    expect(second.wakes()).toEqual([expect.objectContaining({ events: [seq] })])
    expect(drops(l.store)).toEqual([])
  })

  test('禁用期间的事件被丢弃（重放确定），再启用不会带出旧事件', async () => {
    const env = await setup({ supervisor: { enabled: false } })
    instruction(env.store, '禁用时的指令')
    for (let i = 0; i < 3; i++) patrol(env.store, `2026-10-2${i}T09:00:00.000Z`)
    await env.settle()
    expect(env.wakes()).toEqual([])
    expect(drops(env.store).map((d) => d.reason)).toContain('disabled')
    expect(env.scheduler.projection().pending(WS, 'instruction')).toEqual([])
    expect(env.scheduler.projection().pending(WS, 'autonomous')).toEqual([])
    // 重放得到同样的结果
    env.scheduler.stop()
    const ws = env.workspaces[WS] as WorkspaceInfo
    ws.supervisor = { ...ws.supervisor, enabled: true }
    const replay = await setup({ store: env.store, clock: env.clock })
    await replay.settle()
    expect(replay.wakes()).toEqual([])
    const fresh = instruction(env.store, '启用后的指令')
    await replay.settle()
    expect(replay.wakes()).toEqual([expect.objectContaining({ events: [fresh] })])
  })

  test('合并取最新的 200 条；inputs.wake 超出字符预算时只带事件引用', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const seqs: number[] = []
    for (let i = 0; i < 230; i++)
      seqs.push(instruction(env.store, `第 ${i} 条 ${'很长的说明'.repeat(20)}`))
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    const w = env.wakes()[1]
    expect(w?.events).toEqual(seqs.slice(-200))
    const events = env.store.getTask(w?.task_id ?? '')?.contract.inputs?.wake?.events ?? []
    expect(events).toHaveLength(200)
    // 逐级降级：最旧的只带引用，最新的指令保留原文
    expect(events[0]).toEqual({
      seq: seqs[30] as number,
      type: 'user.instruction',
      ts: expect.any(String),
    })
    expect(events.at(-1)?.summary).toContain('第 229 条')
    expect(JSON.stringify(events).length).toBeLessThanOrEqual(16_000)
  })

  test('放行只作用于当时已有的事件；空队列放行不留通行证', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, wakes_per_day: 1 } },
    })
    instruction(env.store)
    await env.settle()
    const before = instruction(env.store, '放行前')
    must(await env.scheduler.release(WS, 'instruction'))
    const after = instruction(env.store, '放行后')
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ events: [before] })
    finish(env.store, env.wakes()[1]?.task_id ?? '')
    await env.settle()
    // 上限已满，放行后到达的事件不跟着放行
    expect(env.wakes()).toHaveLength(2)
    expect(
      env.scheduler
        .projection()
        .pending(WS, 'instruction')
        .map((e) => e.seq),
    ).toEqual([after])

    const empty = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, wakes_per_day: 0 } },
    })
    expect(must(await empty.scheduler.release(WS, 'instruction')).state).toBe('empty')
    instruction(empty.store)
    expect(await wakeCount(empty)).toBe(0)
    expect(empty.scheduler.projection().workspace(WS).queues.instruction.releasePending).toBe(false)
  })

  test('唤醒创建失败：按退避重试，连续失败写一条 Interrupt（去重），恢复后正常', async () => {
    let failing = 4
    const env = await setup({
      wrapTasks: (t) => ({
        ...t,
        createTask: async (c, opts) =>
          failing-- > 0 ? fail('failure', 'internal_error', '磁盘满了') : t.createTask(c, opts),
      }),
    })
    instruction(env.store)
    expect(await wakeCount(env)).toBe(0)
    await env.clock.advance(30_000)
    await env.clock.advance(60_000)
    await env.settle()
    const item = env.store.getInboxItem('wake.create.demo.2026-10-26')
    expect(item).toMatchObject({ level: 'interrupt', source: 'supervisor' })
    await env.clock.advance(120_000)
    expect(await wakeCount(env)).toBe(0)
    expect(env.store.listInboxItems({ source: 'supervisor' })).toHaveLength(1)
    await env.clock.advance(240_000)
    expect(await wakeCount(env)).toBe(1)
  })
})

describe('reply 委托出队与 G13 衔接', () => {
  test('委托被转交（task.reply_escalated）或任务离开卡住后出队', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, reply_wakes_per_day: 0 } },
    })
    derived(env.store, 'q1')
    start(env.store, 'q1')
    const b = block(env.store, 'q1', 'question')
    must(
      env.store.append(
        {
          type: 'task.reply_delegated',
          task_id: 'q1',
          workspace: WS,
          payload: {
            task_id: 'q1',
            block_seq: b,
            kind: 'question',
            deadline: '2026-10-26T08:10:00.000Z',
          },
        },
        { actor: 'hub' },
      ),
    )
    await env.settle()
    expect(env.scheduler.projection().pending(WS, 'reply')).toHaveLength(1)
    must(
      env.store.append(
        {
          type: 'task.reply_escalated',
          task_id: 'q1',
          workspace: WS,
          payload: { reason: 'wake_unavailable', block_seq: b },
        },
        { actor: 'hub' },
      ),
    )
    await env.settle()
    expect(env.scheduler.projection().pending(WS, 'reply')).toEqual([])
  })

  test('supervisor.answered 的 origin 取自条目 source_ref 指向的唤醒', async () => {
    const env = await setup()
    patrol(env.store)
    await env.settle()
    const wake = env.wakes()[0]?.task_id ?? ''
    must(
      env.store.append(
        {
          type: 'inbox.item_created',
          workspace: WS,
          payload: {
            item_id: 'ask.1',
            level: 'decide',
            source: 'supervisor',
            source_ref: wake,
            title: '用 A 还是 B？',
            actions: ['reply'],
          },
        },
        { actor: 'hub' },
      ),
    )
    finish(env.store, wake)
    const answered = must(
      env.store.append(
        { type: 'supervisor.answered', workspace: WS, payload: { item_id: 'ask.1', text: 'A' } },
        { actor: 'user' },
      ),
    ).seq
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [answered] })
  })
})

describe('经 hubAuth 的身份检查', () => {
  test('唤醒绑定 token 与绑定 token 调用 /v1/supervisor/wake|status 返回 403', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const wakeId = env.wakes()[0]?.task_id ?? ''
    start(env.store, wakeId)
    const wakeTokens = createWakeTokenAuthority({ ledger: () => env.store, now: env.clock.now })
    const wakeSecret = wakeTokens.issue({ lease_id: `l-${wakeId}-1`, task_id: wakeId }) ?? ''
    expect(wakeSecret).not.toBe('')
    const root = mkdtempSync(join(tmpdir(), 'flow-sup-auth-'))
    mkdirSync(join(root, 'state'), { recursive: true })
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const tokens = must(await openTokenStore(root))
    const bound = must(await tokens.issue({ actor: 'reviewer' })).secret
    const app = createHubApp({
      token: testToken,
      tokens,
      wakeTokens,
      ledger: env.store,
      mount: [{ path: '/', app: createSupervisorRoutes({ scheduler: () => env.scheduler }) }],
    })
    const before = env.store.seq()
    for (const secret of [wakeSecret, bound]) {
      const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
      const w = await app.request('/v1/supervisor/wake', {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace: WS, text: '越权' }),
      })
      expect(w.status).toBe(403)
      expect(((await w.json()) as { error: { code: string } }).error.code).toBe('user_only')
      const st = await app.request('/v1/supervisor/status', { headers })
      expect(st.status).toBe(403)
    }
    expect(env.store.seq()).toBe(before)
    const user = await app.request('/v1/supervisor/status', {
      headers: { Authorization: `Bearer ${testToken}` },
    })
    expect(user.status).toBe(200)
  })
})

describe('第二轮审查', () => {
  test('探针 B：放行后同一巡检规则再次触发，放行前的事件仍被放行处理，队列不会卡住', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, autonomous_wakes_per_day: 0 } },
    })
    instruction(env.store)
    await env.settle()
    const p1 = patrol(env.store, '2026-10-26T09:00:00.000Z')
    must(await env.scheduler.release(WS, 'autonomous'))
    const p2 = patrol(env.store, '2026-10-26T10:00:00.000Z')
    await env.settle()
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [p1] })
    const q = env.scheduler.projection().workspace(WS).queues.autonomous
    expect(q.releasePending).toBe(false)
    expect(
      env.scheduler
        .projection()
        .pending(WS, 'autonomous')
        .map((e) => e.seq),
    ).toEqual([p2])
  })

  test('失败唤醒退回的巡检事件也去重：已有更新的同一规则触发时不再退回', async () => {
    const env = await setup()
    const p1 = patrol(env.store, '2026-10-26T09:00:00.000Z')
    await env.settle()
    expect(env.wakes()[0]).toMatchObject({ events: [p1] })
    const p2 = patrol(env.store, '2026-10-26T10:00:00.000Z')
    failTask(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    // 重试只带最新的一次触发
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [p2] })
  })

  test('探针 C：超出预算时仍保留最新指令的原文', async () => {
    const env = await setup()
    instruction(env.store)
    await env.settle()
    const seqs: number[] = []
    for (let i = 0; i < 5; i++) seqs.push(instruction(env.store, `需求${i} ${'a'.repeat(3900)}`))
    finish(env.store, env.wakes()[0]?.task_id ?? '')
    await env.settle()
    const events =
      env.store.getTask(env.wakes()[1]?.task_id ?? '')?.contract.inputs?.wake?.events ?? []
    expect(events).toHaveLength(5)
    const withText = events.filter((e) => e.summary !== undefined)
    expect(withText.length).toBeGreaterThanOrEqual(3)
    expect(events.at(-1)?.summary).toContain('需求4')
    expect(events[0]?.summary).toBeUndefined()
    expect(JSON.stringify(events).length).toBeLessThanOrEqual(16_000)
  })

  test('暂时不可唤醒（角色有错）：保留队列按退避重查，恢复后照常唤醒；超过 24 小时才丢弃并写 Interrupt', async () => {
    let role: Result<Role | null> = fail(
      'failure',
      'multiple_supervisor_roles',
      '有两个 supervisor 角色',
    )
    const env = await setup({ role: async () => role })
    const keep = instruction(env.store, '角色修好前的指令')
    await env.settle()
    expect(drops(env.store)).toEqual([])
    expect(
      env.scheduler
        .projection()
        .pending(WS, 'instruction')
        .map((e) => e.seq),
    ).toEqual([keep])
    role = ok(SUPERVISOR)
    await env.clock.advance(60_000)
    await env.settle()
    expect(env.wakes()).toEqual([expect.objectContaining({ events: [keep] })])
    finish(env.store, env.wakes()[0]?.task_id ?? '')

    role = fail('failure', 'supervisor_role_writable', '角色可写')
    const old = instruction(env.store, '角色一直有错')
    await env.clock.advance(23 * HOUR)
    await env.settle()
    expect(drops(env.store)).toEqual([])
    const late = instruction(env.store, '宽限期内的新指令')
    await env.clock.advance(2 * HOUR)
    await env.settle()
    expect(drops(env.store)).toEqual([
      expect.objectContaining({ queue: 'instruction', up_to_seq: old, reason: 'role_invalid' }),
    ])
    expect(
      env.scheduler
        .projection()
        .pending(WS, 'instruction')
        .map((e) => e.seq),
    ).toEqual([late])
    expect(
      env.store
        .listInboxItems({ source: 'supervisor' })
        .filter((i) => i.id.startsWith('wake.unavail.')),
    ).toHaveLength(1)
    // 宽限期内的事件也过期丢弃后，队列为空：不再按退避重查，等下一个事件
    await env.clock.advance(24 * HOUR)
    await env.settle()
    expect(env.scheduler.projection().pending(WS, 'instruction')).toEqual([])
    expect(env.clock.pending).toBe(0)
  })

  test('稳定不可唤醒（没有仓库）立即丢弃', async () => {
    const env = await setup()
    ;(env.workspaces[WS] as WorkspaceInfo).repos = []
    const seq = instruction(env.store)
    await env.settle()
    expect(drops(env.store)).toEqual([
      expect.objectContaining({ queue: 'instruction', up_to_seq: seq, reason: 'no_repo' }),
    ])
  })

  test('blocked(node_lost) 的唤醒自动转为失败，由调度器重试一次', async () => {
    const env = await setup()
    const seq = instruction(env.store)
    await env.settle()
    const w = env.wakes()[0]?.task_id ?? ''
    start(env.store, w)
    must(
      env.store.append(
        {
          type: 'task.blocked',
          task_id: w,
          workspace: WS,
          payload: { reason: 'node_lost', message: '节点掉线' },
        },
        { actor: 'hub' },
      ),
    )
    await env.settle()
    expect(env.store.getTask(w)?.status).toBe('failed')
    expect(env.wakes()[1]).toMatchObject({ origin: 'instruction', events: [seq] })
  })
})

describe('第三轮审查', () => {
  test('探针 3：没有 supervisor 角色是稳定原因，静默丢弃、不产生 Interrupt', async () => {
    const env = await setup({ role: async () => ok(null) })
    const seq = instruction(env.store)
    await env.settle()
    expect(drops(env.store)).toEqual([
      expect.objectContaining({ queue: 'instruction', up_to_seq: seq, reason: 'no_role' }),
    ])
    expect(env.store.listInboxItems({ source: 'supervisor' })).toEqual([])
    expect(env.clock.pending).toBe(0)
  })

  test('workspace 文件不存在静默丢弃；workspace 配置整体加载失败走宽限', async () => {
    const gone = await setup()
    delete gone.workspaces[WS]
    const a = instruction(gone.store)
    await gone.settle()
    expect(drops(gone.store)).toEqual([
      expect.objectContaining({ up_to_seq: a, reason: 'unknown_workspace' }),
    ])

    const broken = await setup({ workspacesLoaded: async () => false })
    delete broken.workspaces[WS]
    const b = instruction(broken.store)
    await broken.settle()
    expect(drops(broken.store)).toEqual([])
    expect(
      broken.scheduler
        .projection()
        .pending(WS, 'instruction')
        .map((e) => e.seq),
    ).toEqual([b])
    await broken.clock.advance(25 * HOUR)
    await broken.settle()
    expect(drops(broken.store)).toEqual([
      expect.objectContaining({ up_to_seq: b, reason: 'workspaces_invalid' }),
    ])
  })

  test('node_lost 真实路径：租约过期 → blocked(node_lost) → 自动失败并重试；旧唤醒 token 返回 401', async () => {
    const env = await setup()
    const seq = instruction(env.store)
    await env.settle()
    const w = env.wakes()[0]?.task_id ?? ''
    start(env.store, w)
    const wakeTokens = createWakeTokenAuthority({ ledger: () => env.store, now: env.clock.now })
    const secret = wakeTokens.issue({ lease_id: `l-${w}-1`, task_id: w }) ?? ''
    const app = createHubApp({
      token: testToken,
      wakeTokens,
      ledger: env.store,
      mount: [{ path: '/', app: createSupervisorRoutes({ scheduler: () => env.scheduler }) }],
    })
    const call = () =>
      app.request('/v1/supervisor/status', { headers: { Authorization: `Bearer ${secret}` } })
    expect((await call()).status).toBe(403)
    must(
      env.store.appendMany(
        [
          {
            type: 'task.lease_expired',
            task_id: w,
            workspace: WS,
            payload: {
              lease_id: `l-${w}-1`,
              node_id: 'n1',
              expired_at: '2026-10-26T08:01:00.000Z',
              attempt: 1,
            },
          },
          {
            type: 'task.blocked',
            task_id: w,
            workspace: WS,
            payload: { reason: 'node_lost', message: '节点掉线' },
          },
        ],
        { actor: 'hub' },
      ),
    )
    await env.settle()
    expect(env.store.getTask(w)?.status).toBe('failed')
    expect(env.wakes()[1]).toMatchObject({ origin: 'instruction', events: [seq] })
    expect((await call()).status).toBe(401)
  })

  test('G13：提问条目（ask.*、可回复）以 expired 关闭时唤醒一次，origin 取提问所在唤醒；非提问条目不唤醒', async () => {
    const env = await setup()
    patrol(env.store)
    await env.settle()
    const wake = env.wakes()[0]?.task_id ?? ''
    const item = (id: string, actions: 'reply'[]) =>
      must(
        env.store.append(
          {
            type: 'inbox.item_created',
            workspace: WS,
            payload: {
              item_id: id,
              level: 'decide',
              source: 'supervisor',
              source_ref: wake,
              title: '提问',
              actions,
            },
          },
          { actor: 'hub' },
        ),
      )
    item(`ask.${wake}.1`, ['reply'])
    item(`note.${wake}`, [])
    finish(env.store, wake)
    const close = (id: string) =>
      must(
        env.store.append(
          { type: 'inbox.item_closed', workspace: WS, payload: { item_id: id, reason: 'expired' } },
          { actor: 'hub' },
        ),
      ).seq
    const other = close(`note.${wake}`)
    const expired = close(`ask.${wake}.1`)
    await env.settle()
    expect(env.wakes()).toHaveLength(2)
    expect(env.wakes()[1]).toMatchObject({ origin: 'autonomous', events: [expired] })
    expect(env.wakes()[1]?.events).not.toContain(other)
    const ev = env.store.getTask(env.wakes()[1]?.task_id ?? '')?.contract.inputs?.wake?.events[0]
    expect(ev?.summary).toContain('已过期')
  })
})
