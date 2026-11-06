import { afterEach, expect, test } from 'bun:test'
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

async function setup(verifyDeliverable?: WorkerReportRoutesDeps['verifyDeliverable']) {
  const t = await tempLedger({ now: Date.now })
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
    createWorkerReportRoutes({ ledger, ...(verifyDeliverable ? { verifyDeliverable } : {}) }),
  )
  const report = (body: WorkerReport | Record<string, unknown>, id = lease.task_id) =>
    app.request(`/v1/tasks/${id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const renew = (extra: Record<string, unknown> = {}) =>
    must(service.renew(lease.lease_id, { lease_token: lease.lease_token, ...extra }))
  return { ledger, service, lease, report, renew }
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
  expect((await verifyReportDeliverable('https://example.com/file')).ok).toBe(false)
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

test('核实ready后完成只使用账本中的交付物', async () => {
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
    artifacts: [{ kind: 'pr', ref: pr }],
  })
})
