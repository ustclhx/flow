import { afterEach, expect, spyOn, test } from 'bun:test'
import { fail, ok, type WorkerReport, workerReportInput } from '@raindown/core'
import { Hono } from 'hono'
import { createNodeService } from '../src/nodes/service.ts'
import {
  createWorkerReportRoutes,
  verifyReportDeliverable,
  type WorkerReportRoutesDeps,
} from '../src/worker-report/routes.ts'
import { contract, must, tempLedger, WS } from './ledger-helpers.ts'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups) fn()
  cleanups = []
})
const readBody = (response: Response) =>
  response.json() as Promise<{ data: { seq: number }; error: { code: string } }>
const question = {
  status: 'question' as const,
  summary: '需要选定标题',
  question: '标题用哪个？',
  options: [
    { label: 'A', description: '简短标题' },
    { label: 'B', description: '详细标题' },
  ],
  recommended: 'A',
}

async function setup(
  verifyDeliverable?: WorkerReportRoutesDeps['verifyDeliverable'],
  now = Date.now,
) {
  const t = await tempLedger({ now })
  const ledger = t.store
  const service = createNodeService({ ledger, leaseTtlS: 60, leaseWaitMaxS: 0 })
  cleanups.push(() => {
    service.close()
    t.cleanup()
  })
  must(
    ledger.append(
      {
        type: 'task.created',
        task_id: 't-report',
        workspace: WS,
        payload: { contract: contract() },
      },
      { actor: 'user' },
    ),
  )
  must(
    service.registerNode(
      { node_id: 'n1', hostname: 'host', version: '1', capabilities: ['executor:fake'] },
      'user',
    ),
  )
  const lease = must(
    await service.acquire({ node_id: 'n1', capabilities: ['executor:fake'] }, { actor: 'user' }),
  ).lease
  if (!lease) throw new Error('未派工')
  const mountRoutes = () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('actor', 'developer')
      c.set('auth', {
        kind: 'task',
        task: {
          actor: 'developer',
          task_id: lease.task_id,
          workspace: WS,
          lease_id: lease.lease_id,
          attempt: lease.attempt,
        },
      })
      await next()
    })
    app.route(
      '/',
      createWorkerReportRoutes({
        ledger,
        now,
        ...(verifyDeliverable ? { verifyDeliverable } : {}),
      }),
    )
    return app
  }
  let app = mountRoutes()
  const report = (body: WorkerReport | Record<string, unknown>, id = lease.task_id) =>
    app.request(`/v1/tasks/${id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const renew = (extra: Record<string, unknown> = {}) =>
    must(service.renew(lease.lease_id, { lease_token: lease.lease_token, ...extra }))
  return {
    ledger,
    service,
    lease,
    report,
    renew,
    app,
    restartRoutes: () => {
      app = mountRoutes()
    },
  }
}

test('结构化报告校验问题选项、推荐项与状态必填字段，拒绝额外身份', () => {
  expect(workerReportInput.safeParse(question).success).toBe(true)
  for (const body of [
    { ...question, options: [question.options[0]] },
    { ...question, options: [question.options[0], question.options[0]] },
    { ...question, recommended: 'C' },
    { ...question, actor: 'other' },
    {
      status: 'dropped',
      summary: '无需处理',
      reason: '已核实',
      deliverables: ['https://github.com/a/b/pull/1'],
    },
    { status: 'blocked', summary: '缺少前提', missing: '环境' },
    { status: 'failed', summary: '失败' },
    { status: 'dropped', summary: '无需处理' },
    { status: 'ready', summary: '已就绪' },
  ])
    expect(workerReportInput.safeParse(body).success).toBe(false)
})

test('progress只写报告；跨任务与不再running的调用不写事件', async () => {
  const c = await setup()
  const before = c.ledger.seq()
  expect((await c.report({ status: 'progress', summary: '完成数据层' })).status).toBe(200)
  expect(c.ledger.eventsAfter(before).map((e) => e.type)).toEqual(['task.reported'])
  expect(c.ledger.getTask(c.lease.task_id)?.status).toBe('running')
  const progress = c.renew().report
  expect(progress?.status).toBe('progress')
  expect(c.renew({ report_seq: progress?.seq }).report).toBeUndefined()
  const seq = c.ledger.seq()
  expect((await c.report(question, 't-other')).status).toBe(403)
  expect(c.ledger.seq()).toBe(seq)
  must(c.service.renew(c.lease.lease_id, { lease_token: c.lease.lease_token, phase: 'verifying' }))
  const after = c.ledger.seq()
  const response = await c.report(question)
  expect((await readBody(response)).error.code).toBe('not_running')
  expect(c.ledger.seq()).toBe(after)
})

test('ready必须核对交付物，查询失败不记录报告', async () => {
  const refs: string[] = []
  const c = await setup(async (ref) => {
    refs.push(ref)
    return fail('failure', 'deliverable_check_failed', '查询失败')
  })
  const seq = c.ledger.seq()
  const response = await c.report({
    status: 'ready',
    summary: '已就绪',
    deliverables: ['https://github.com/org/repo/pull/1'],
  })
  expect(response.status).toBe(502)
  expect(refs).toEqual(['https://github.com/org/repo/pull/1'])
  expect(c.ledger.seq()).toBe(seq)
  expect((await verifyReportDeliverable('https://example.com/file', { branch: null })).ok).toBe(
    false,
  )
})

test('交付物核对期间派工结束时拒绝迟到ready', async () => {
  let finish = () => {}
  const c = await setup(async () => {
    finish()
    return ok(null)
  })
  finish = () => {
    must(
      c.service.complete(c.lease.lease_id, {
        lease_token: c.lease.lease_token,
        outcome: 'failed',
        result: { summary: '退出', node_id: 'n1', executor: 'fake' },
      }),
    )
  }
  const response = await c.report({
    status: 'ready',
    summary: '就绪',
    deliverables: ['https://github.com/org/repo/pull/1'],
  })
  expect((await readBody(response)).error.code).toBe('not_running')
  expect(c.ledger.taskEvents(c.lease.task_id).some((e) => e.type === 'task.reported')).toBe(false)
})

test('报告通过续约下发，消费水位幂等且重建后不复现旧报告', async () => {
  const c = await setup()
  await c.report(question)
  const response = await c.report({ ...question, summary: '新问题' })
  const { data } = await readBody(response)
  expect(c.renew().report?.seq).toBe(data.seq)
  expect(c.renew({ report_seq: data.seq }).report).toBeUndefined()
  c.renew({ report_seq: data.seq })
  expect(
    c.ledger.taskEvents(c.lease.task_id).filter((e) => e.type === 'task.report_consumed'),
  ).toHaveLength(1)
  must(c.ledger.rebuild())
  expect(c.renew().report).toBeUndefined()
})

test('完成引用question从账本取结构化问题并标记reported，重建保留', async () => {
  const c = await setup()
  const { data } = await readBody(await c.report(question))
  const result = must(
    c.service.complete(c.lease.lease_id, {
      lease_token: c.lease.lease_token,
      outcome: 'blocked',
      report_seq: data.seq,
      blocked_reason: 'other',
      message: '节点猜测',
    }),
  )
  expect(result.task.blocked).toMatchObject({
    basis: 'reported',
    reason: 'question',
    message: question.question,
    question: { text: question.question, options: question.options, recommended: 'A' },
  })
  must(c.ledger.rebuild())
  expect(c.ledger.getTask(c.lease.task_id)?.blocked).toEqual(result.task.blocked)
})

test.each(['failed', 'dropped'] as const)(
  '%s按报告结束，错误引用或不匹配outcome不写事件',
  async (status) => {
    const c = await setup()
    const { data } = await readBody(await c.report({ status, summary: '报告摘要', reason: '原因' }))
    const before = c.ledger.seq()
    const base = {
      lease_token: c.lease.lease_token,
      outcome: 'done',
      result: { summary: '节点摘要', node_id: 'n1', executor: 'fake' },
    }
    expect(c.service.complete(c.lease.lease_id, { ...base, report_seq: 1 }).ok).toBe(false)
    if (status === 'failed')
      expect(c.service.complete(c.lease.lease_id, { ...base, report_seq: data.seq }).ok).toBe(false)
    expect(c.ledger.seq()).toBe(before)
    const result = must(
      c.service.complete(c.lease.lease_id, {
        ...base,
        outcome: status === 'failed' ? 'failed' : 'done',
        report_seq: data.seq,
      }),
    )
    expect(result.task.status).toBe(status === 'failed' ? 'failed' : 'done')
    expect(result.task.result?.summary).toBe('报告摘要')
    expect(result.task.result?.reported_reason).toBe('原因')
    expect(
      c.ledger.taskEvents(c.lease.task_id).findLast((e) => e.type === 'task.attempt_ended')
        ?.payload,
    ).toMatchObject({ last_report: '报告摘要' })
    expect(result.task.result?.dropped).toBe(status === 'dropped' ? true : undefined)
  },
)

test('报告的自由文本及结构化选项在入账时脱敏', async () => {
  const c = await setup()
  expect(
    (await c.report({ ...question, summary: 'token=sk-secret0123456789secret0123456789' })).status,
  ).toBe(200)
  const event = c.ledger.taskEvents(c.lease.task_id).findLast((e) => e.type === 'task.reported')
  expect(JSON.stringify(event)).not.toContain('sk-secret0123456789secret0123456789')
})

test('核对交付物期间派工已结束时拒绝上报', async () => {
  const c = await setup(async () => {
    must(
      c.ledger.append(
        {
          type: 'task.attempt_ended',
          task_id: c.lease.task_id,
          workspace: WS,
          payload: { attempt: c.lease.attempt, reason: 'retry' },
        },
        { actor: 'hub' },
      ),
    )
    return ok(null)
  })
  const response = await c.report({
    status: 'ready',
    summary: '交付物就绪',
    deliverables: ['https://github.com/a/b/pull/1'],
  })
  expect(await readBody(response)).toMatchObject({ error: { code: 'not_running' } })
  expect(c.ledger.taskEvents(c.lease.task_id).some((event) => event.type === 'task.reported')).toBe(
    false,
  )
})

test('续约将报告消费确认与reported卡住同时入账', async () => {
  const c = await setup()
  const { data } = await readBody(await c.report(question))
  const before = c.ledger.seq()
  c.renew({
    report_seq: data.seq,
    blocked: {
      basis: 'reported',
      reason: 'question',
      message: question.question,
      question: { text: question.question, options: question.options, recommended: 'A' },
    },
  })
  expect(c.ledger.eventsAfter(before).map((e) => e.type)).toEqual([
    'task.report_consumed',
    'task.blocked',
  ])
  expect(c.ledger.getTask(c.lease.task_id)?.blocked?.basis).toBe('reported')
  expect(c.renew().report).toBeUndefined()
})

test('核实ready后完成合并节点与账本中的交付物', async () => {
  const c = await setup(async () => ok(null))
  const pr = 'https://github.com/org/repo/pull/1'
  const { data } = await readBody(
    await c.report({ status: 'ready', summary: 'PR 已就绪', deliverables: [pr] }),
  )
  const result = must(
    c.service.complete(c.lease.lease_id, {
      lease_token: c.lease.lease_token,
      outcome: 'done',
      report_seq: data.seq,
      result: {
        summary: '节点摘要',
        node_id: 'n1',
        executor: 'fake',
        artifacts: [{ kind: 'url', ref: 'https://example.com/other' }],
      },
    }),
  )
  expect(result.task.result).toMatchObject({
    summary: 'PR 已就绪',
    artifacts: [
      { kind: 'url', ref: 'https://example.com/other' },
      { kind: 'pr', ref: pr },
    ],
  })
})

const taskRepo = {
  branch: 'task/report',
  repo_snapshot: { remote_url: 'git@github.com:org/repo.git' },
}
const reportPr = 'https://github.com/org/repo/pull/1'
const ready = {
  status: 'ready' as const,
  summary: '已就绪',
  deliverables: [reportPr],
}
const prInfo = {
  url: reportPr,
  headRefName: taskRepo.branch,
  headRepository: { nameWithOwner: 'org/repo' },
  isCrossRepository: false,
}

test('默认交付物核对在调用gh之前拒绝其他仓库和缺少可信元数据的任务', async () => {
  let calls = 0
  const run = async () => {
    calls++
    return { stdout: JSON.stringify(prInfo) }
  }
  for (const [ref, task] of [
    ['https://github.com/private/other/pull/1', taskRepo],
    [reportPr, { ...taskRepo, branch: null }],
    [reportPr, { ...taskRepo, repo_snapshot: null }],
  ] as const)
    expect((await verifyReportDeliverable(ref, task, run)).ok).toBe(false)
  expect(calls).toBe(0)
  expect((await verifyReportDeliverable(reportPr, taskRepo, run)).ok).toBe(true)
  expect(calls).toBe(1)
})

test('默认交付物核对拒绝分支、fork、仓库、URL及gh响应schema不匹配，隐藏诊断', async () => {
  const ref = reportPr
  const rejected = await verifyReportDeliverable(ref, taskRepo, async () => {
    throw Object.assign(new Error('private secret diagnostic'), {
      stderr: 'private/repository exists',
    })
  })
  expect(rejected).toEqual({
    ok: false,
    error: { kind: 'failure', code: 'deliverable_check_failed', message: '无法核实本任务的交付物' },
  })
  for (const changes of [
    { headRefName: 'other-task' },
    { isCrossRepository: true },
    { headRepository: { nameWithOwner: 'other/repo' } },
    { url: 'https://github.com/org/repo/pull/2' },
    { isCrossRepository: 'false' },
    { headRepository: null },
  ]) {
    expect(
      await verifyReportDeliverable(ref, taskRepo, async (_file, args, options) => {
        expect(args).toEqual([
          'pr',
          'view',
          ref,
          '--json',
          'url,headRefName,headRepository,isCrossRepository',
        ])
        expect(options).toEqual({ timeout: 15_000, maxBuffer: 64 * 1024 })
        return { stdout: JSON.stringify({ ...prInfo, ...changes }) }
      }),
    ).toEqual(rejected)
  }
})

test('ready上报期间同租约返回可重试busy，核对失败后finally释放', async () => {
  let release: (result: ReturnType<typeof ok<null>>) => void = () => {}
  let started: () => void = () => {}
  const didStart = new Promise<void>((resolve) => {
    started = resolve
  })
  let first = true
  const c = await setup(async () => {
    if (!first) return ok(null)
    first = false
    started()
    await new Promise<ReturnType<typeof ok<null>>>((resolve) => {
      release = resolve
    })
    return fail('failure', 'deliverable_check_failed', '无法核实交付物')
  })
  const before = c.ledger.seq()
  const firstReport = c.report(ready)
  await didStart
  const busy = await readBody(await c.report(ready))
  expect(busy).toMatchObject({ error: { kind: 'retryable', code: 'report_busy' } })
  expect(c.ledger.seq()).toBe(before)
  release(ok(null))
  expect((await firstReport).status).toBe(502)
  expect(c.ledger.seq()).toBe(before)
  expect((await c.report(ready)).status).toBe(200)
})

test('每分钟最多10条，成功计数在路由重建后保留，且不扫描任务历史', async () => {
  const c = await setup()
  const scan = spyOn(c.ledger, 'taskEvents').mockImplementation(() => {
    throw new Error('上报不能全量扫描任务事件')
  })
  try {
    for (let i = 0; i < 10; i++)
      expect((await c.report({ status: 'progress', summary: `进度 ${i}` })).status).toBe(200)
    c.restartRoutes()
    const before = c.ledger.seq()
    expect(await readBody(await c.report({ status: 'progress', summary: '超额' }))).toMatchObject({
      error: { kind: 'retryable', code: 'report_rate_limited' },
    })
    expect(c.ledger.seq()).toBe(before)
  } finally {
    scan.mockRestore()
  }
})

test('失败的ready也消耗每分钟额度，超额时不调用核对器', async () => {
  let checks = 0
  const c = await setup(async () => {
    checks++
    return fail('failure', 'deliverable_check_failed', '无法核实交付物')
  })
  const before = c.ledger.seq()
  for (let i = 0; i < 10; i++) expect((await c.report(ready)).status).toBe(502)
  expect(await readBody(await c.report(ready))).toMatchObject({
    error: { code: 'report_rate_limited' },
  })
  expect(checks).toBe(10)
  expect(c.ledger.seq()).toBe(before)
})

test('每attempt最多200条，跨分钟和路由重建仍保持上限', async () => {
  let clock = Date.now()
  const c = await setup(undefined, () => clock)
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 10; i++)
      expect((await c.report({ status: 'progress', summary: `进度 ${batch}/${i}` })).status).toBe(
        200,
      )
    clock += 61_000
  }
  c.restartRoutes()
  const before = c.ledger.seq()
  expect(await readBody(await c.report({ status: 'progress', summary: '超额' }))).toMatchObject({
    error: { code: 'report_rate_limited' },
  })
  expect(c.ledger.seq()).toBe(before)
})

test('交付物最多5个，过大的实际请求体不写账本且释放busy锁', async () => {
  let checks = 0
  const c = await setup(async () => {
    checks++
    return ok(null)
  })
  const before = c.ledger.seq()
  const tooMany = {
    ...ready,
    deliverables: Array.from({ length: 6 }, (_, i) => `https://github.com/org/repo/pull/${i + 1}`),
  }
  expect((await c.report(tooMany)).status).toBe(400)
  expect(workerReportInput.safeParse(tooMany).success).toBe(false)
  expect(checks).toBe(0)
  // 无 Content-Length 的流也受同一个字节上限保护。
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ status: 'progress', summary: 'x'.repeat(100_000) }),
        ),
      )
      controller.close()
    },
  })
  const response = await c.app.request(`/v1/tasks/${c.lease.task_id}/report`, {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit)
  expect(response.status).toBe(400)
  expect(c.ledger.seq()).toBe(before)
  expect((await c.report({ status: 'progress', summary: '正常请求' })).status).toBe(200)
})

test('租约暂时超过expires_at但仍active时接受上报', async () => {
  const c = await setup(undefined, () => Date.now() + 120_000)
  expect((await c.report({ status: 'progress', summary: '清扫前恢复' })).status).toBe(200)
})

test('读取请求体期间持有同租约busy锁', async () => {
  const c = await setup()
  let started: () => void = () => {}
  const didStart = new Promise<void>((resolve) => {
    started = resolve
  })
  let release: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        started()
        return new Promise<void>((resolve) => {
          release = () => {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ status: 'progress', summary: '延迟请求体' }),
              ),
            )
            controller.close()
            resolve()
          }
        })
      },
    },
    { highWaterMark: 0 },
  )
  const pending = c.app.request(`/v1/tasks/${c.lease.task_id}/report`, {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit)
  await didStart
  expect(await readBody(await c.report({ status: 'progress', summary: '并发请求' }))).toMatchObject(
    {
      error: { code: 'report_busy' },
    },
  )
  release()
  expect((await pending).status).toBe(200)
  expect((await c.report({ status: 'progress', summary: '随后请求' })).status).toBe(200)
})
