import { afterEach, expect, test } from 'bun:test'
import {
  NO_ADAPTER_CAPABILITIES,
  ok,
  type Result,
  type TaskContractInput,
  type WorkerReport,
} from '@raindown/core'
import {
  ActivityQueue,
  type ExecutorOutcome,
  type ExecutorPlugin,
  idleSignal,
  resumedSignal,
} from '../src/executor.ts'
import { type Bench, bench, type Intercept } from './harness.ts'

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

const question: WorkerReport = {
  status: 'question',
  summary: '需要选定标题',
  question: '标题用哪个？',
  options: [
    { label: 'A', description: '简短标题' },
    { label: 'B', description: '详细标题' },
  ],
  recommended: 'A',
}

async function setup(intercept?: Intercept, over: Partial<TaskContractInput> = {}) {
  const activity = new ActivityQueue()
  let finish: (result: Result<ExecutorOutcome>) => void = () => {}
  let cancelled = 0
  let classifications = 0
  const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
    finish = resolve
  })
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => {
      classifications++
      return { reason: 'question', message: '终端猜测的问题' }
    },
    run: () => ({
      activity,
      done,
      async cancel() {
        cancelled++
        activity.close()
        finish(ok({ outcome: 'cancelled' }))
      },
    }),
  }
  const b = await bench({ executors: [executor] }, 60, intercept)
  current = b
  const id = await b.create({ executor: 'probe', no_progress_minutes: 1, ...over })
  await b.until(id, (t) => t.status === 'running')
  return {
    b,
    id,
    activity,
    idle: () => activity.push(idleSignal(new Date(b.clock.now()).toISOString(), '停下')),
    finish: (outcome: ExecutorOutcome = { outcome: 'exited', exit_code: 0 }) => {
      activity.close()
      finish(ok(outcome))
    },
    report(report: WorkerReport) {
      const lease = b.ledger.activeLease(id)
      if (!lease) throw new Error('没有租约')
      const r = b.ledger.append(
        {
          type: 'task.reported',
          task_id: id,
          workspace: 'ws/demo',
          payload: { ...report, lease_id: lease.lease_id, attempt: lease.attempt },
        },
        { actor: 'dev' },
      )
      if (!r.ok) throw new Error(r.error.message)
      return r.data.seq
    },
    cancelled: () => cancelled,
    classifications: () => classifications,
  }
}

test('idle先读取未消费的question，完整保留选项并且只消费一次', async () => {
  const c = await setup()
  const seq = c.report(question)
  c.idle()
  const t = await c.b.until(c.id, (task) => task.status === 'blocked')
  expect(t.blocked).toMatchObject({
    basis: 'reported',
    reason: 'question',
    question: { text: question.question, options: question.options, recommended: 'A' },
  })
  expect(c.classifications()).toBe(0)
  await c.b.clock.advance(60_000)
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_consumed')).toMatchObject([
    { payload: { report_seq: seq } },
  ])
})

test('推断blocked续约期间到达的上报立即消费：worker恢复后持续忙碌超过两分钟也不再以旧问题blocked', async () => {
  // 复现：idle → 续约没有上报 → 按推断分类 → diffStat 期间 worker 的 MCP question 到达 →
  // blocked 续约的响应带回该上报。节点不得把它存为待处理上报并启动两分钟计时。
  let inject: (() => void) | undefined
  const c = await setup((url, init) => {
    const body = String(init?.body ?? '')
    if (url.endsWith('/renew') && body.includes('"blocked"') && inject) {
      const run = inject
      inject = undefined
      run()
    }
    return undefined
  })
  let seq = 0
  inject = () => {
    seq = c.report(question)
  }
  c.idle()
  const t = await c.b.until(c.id, (task) => task.status === 'blocked')
  expect(t.blocked?.basis).toBe('inferred')
  expect(seq).toBeGreaterThan(0)
  // 下一次续约即确认消费，不再重复下发。
  await c.b.clock.advance(30_000)
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_consumed')).toMatchObject([
    { payload: { report_seq: seq } },
  ])
  c.activity.push(resumedSignal(new Date(c.b.clock.now()).toISOString(), '继续工作'))
  await c.b.until(c.id, (task) => task.status === 'running')
  for (let i = 0; i < 8; i++) {
    c.activity.push({ ts: new Date(c.b.clock.now()).toISOString(), kind: 'output', text: '忙碌中' })
    await c.b.clock.advance(25_000)
  }
  expect(c.b.task(c.id).status).toBe('running')
  const blocked = c.b.events(c.id).filter((e) => e.type === 'task.blocked')
  expect(blocked).toHaveLength(1)
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_conflict')).toHaveLength(0)
  // 遗留上报也不得接管下一次真正的 idle：按推断分类。
  c.idle()
  const again = await c.b.until(
    c.id,
    (task) =>
      task.status === 'blocked' &&
      c.b.events(c.id).filter((e) => e.type === 'task.blocked').length === 2,
  )
  expect(again.blocked?.basis).toBe('inferred')
})

test('blocked报告保留missing与tried，不从终端重建说明', async () => {
  const c = await setup()
  c.report({
    status: 'blocked',
    summary: '无法连接测试环境',
    missing: '测试环境凭据',
    tried: '检查环境变量与配置',
  })
  c.idle()
  const t = await c.b.until(c.id, (task) => task.status === 'blocked')
  expect(t.blocked).toMatchObject({
    basis: 'reported',
    reason: 'other',
    missing: '测试环境凭据',
    tried: '检查环境变量与配置',
  })
})

test('没有上报时继续classify并记录inferred', async () => {
  const c = await setup()
  c.idle()
  const t = await c.b.until(c.id, (task) => task.status === 'blocked')
  expect(t.blocked).toMatchObject({
    basis: 'inferred',
    reason: 'question',
    message: '终端猜测的问题',
  })
  expect(c.classifications()).toBe(1)
})

test('question上报后持续忙两分钟也转blocked并记录冲突，消费失败重试幂等', async () => {
  let failures = 0
  const c = await setup((url, init) => {
    if (
      url.endsWith('/renew') &&
      String(init?.body).includes('report_conflict') &&
      failures++ === 0
    )
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: 'retryable', code: 'hub_busy', message: '重试' },
        }),
        { status: 503 },
      )
    return undefined
  })
  const seq = c.report(question)
  await c.b.clock.advance(130_000)
  expect(c.b.task(c.id).status).toBe('running')
  await c.b.until(c.id, (t) => t.status === 'blocked', 20_000)
  expect(c.b.task(c.id).blocked?.basis).toBe('reported')
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_conflict')).toMatchObject([
    { payload: { report_seq: seq, observed: 'busy' } },
  ])
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_consumed')).toHaveLength(1)
  expect(failures).toBeGreaterThanOrEqual(2)
})

test('progress与持续idle矛盾时等阈值后按观察分类并消费', async () => {
  const c = await setup()
  const seq = c.report({ status: 'progress', summary: '仍在修改' })
  c.idle()
  await c.b.clock.advance(50_000)
  expect(c.b.task(c.id).status).toBe('running')
  const t = await c.b.until(c.id, (task) => task.status === 'blocked', 20_000)
  expect(t.blocked?.basis).toBe('inferred')
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_conflict')).toMatchObject([
    { payload: { report_seq: seq, observed: 'idle' } },
  ])
})

for (const status of ['ready', 'failed', 'dropped'] as const) {
  test(`${status}直接结束派工，上报结果优先于cancelled并原子消费`, async () => {
    const c = await setup()
    const deliverables = ['https://github.com/org/repo/pull/1'] as const
    const seq = c.report(
      status === 'ready'
        ? { status, summary: '交付就绪', deliverables: [...deliverables] }
        : { status, summary: '已经核实', reason: '原因原文' },
    )
    const t = await c.b.until(
      c.id,
      (task) => task.status === (status === 'failed' ? 'failed' : 'done'),
    )
    expect(t.result?.summary).toBe(status === 'ready' ? '交付就绪' : '已经核实')
    if (status === 'ready')
      expect(t.result?.artifacts).toContainEqual({ kind: 'pr', ref: deliverables[0] })
    if (status === 'dropped') expect(t.result?.dropped).toBe(true)
    expect(c.cancelled()).toBe(1)
    expect(c.b.events(c.id).filter((e) => e.type === 'task.report_consumed')).toMatchObject([
      { payload: { report_seq: seq } },
    ])
  })
}

test('harness先结束时最后续约仍读取并采纳上报', async () => {
  const c = await setup()
  c.report({ status: 'dropped', summary: '已排除问题', reason: '无法复现' })
  c.finish()
  const t = await c.b.until(c.id, (task) => task.status === 'done')
  expect(t.result).toMatchObject({ summary: '已排除问题', dropped: true })
})

test('question后harness正常完成仍按上报blocked并消费', async () => {
  const c = await setup()
  c.report(question)
  c.finish({
    outcome: 'done',
    result: {
      summary: 'harness完成',
      artifacts: [],
      verify: [],
      executor: 'probe',
      node_id: 'n-bench',
    },
  })
  const t = await c.b.until(c.id, (task) => task.status === 'blocked' && !task.blocked?.lease_held)
  expect(t.blocked).toMatchObject({ basis: 'reported', question: { text: question.question } })
  expect(c.b.events(c.id).filter((e) => e.type === 'task.report_consumed')).toHaveLength(1)
})

test('最终ready合并adapter已有产物，保留适配器附加结果', async () => {
  const c = await setup()
  c.report({
    status: 'ready',
    summary: '已就绪',
    deliverables: ['https://github.com/org/repo/pull/2'],
  })
  c.finish({
    outcome: 'done',
    workdir: c.b.home,
    result: {
      summary: 'harness完成',
      artifacts: [{ kind: 'file', ref: 'report.md' }],
      verify: [],
      executor: 'probe',
      node_id: 'n-bench',
      cost: { usd: 0.5 },
    },
  })
  const t = await c.b.until(c.id, (task) => task.status === 'done')
  expect(t.result?.artifacts).toEqual([
    { kind: 'file', ref: 'report.md' },
    { kind: 'pr', ref: 'https://github.com/org/repo/pull/2' },
  ])
  expect(t.result?.cost).toEqual({ usd: 0.5 })
})

for (const missing of [false, true]) {
  test(`ready后验收${missing ? '目录缺失' : '失败'}保留观察结果并消费上报`, async () => {
    const c = await setup(undefined, {
      verify: [
        { cmd: ['__raindown_missing_verify_command__'], ...(missing ? { cwd: 'removed' } : {}) },
      ],
    })
    const seq = c.report({
      status: 'ready',
      summary: '已就绪',
      deliverables: ['https://github.com/org/repo/pull/3'],
    })
    const t = await c.b.until(c.id, (task) => task.status === (missing ? 'blocked' : 'failed'))
    if (missing) expect(t.blocked).toMatchObject({ reason: 'workdir_missing', basis: 'inferred' })
    else expect(t.result).toMatchObject({ reason: 'verify_failed', verify: [{ exit_code: null }] })
    expect(c.b.events(c.id).filter((e) => e.type === 'task.report_consumed')).toMatchObject([
      { payload: { report_seq: seq } },
    ])
  })
}
