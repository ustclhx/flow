import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cancelTaskData,
  createTaskData,
  errorBody,
  LEDGER_ID_RE,
  listTasksData,
  okBody,
  rebuildData,
  showTaskData,
} from '@flow/core'
import {
  createHubApp,
  createTaskRoutes,
  createTaskService,
  generateTaskId,
  type LedgerStore,
  workspaceCheckFromHome,
} from '../src/index.ts'
import {
  anyRole,
  contractInput,
  drafts,
  must,
  result,
  startTask,
  sys,
  tempLedger,
  WS,
} from './ledger-helpers.ts'
import { authHeaders, testToken } from './server-fixtures.ts'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

async function setup() {
  const l = await tempLedger()
  cleanups.push(l.cleanup)
  let n = 0
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: (ref) => ref === WS || ref === 'ws/global',
    roles: anyRole,
    newTaskId: () => `t-test-${++n}`,
  })
  // 经过真实的鉴权中间件：身份由 user token 决定，X-Flow-Actor 只能降级。
  const app = createHubApp({
    token: testToken,
    mount: [{ path: '/', app: createTaskRoutes({ ledger: l.store, tasks }) }],
  })
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...authHeaders, ...headers },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  return { store: l.store, tasks, app, call }
}

const createdCount = (store: LedgerStore) =>
  store.eventsAfter(0).filter((e) => e.type === 'task.created').length

describe('generateTaskId', () => {
  test('形如 t-yyyymmdd-hhmmss-xxxxxx，满足账本 id 正则', () => {
    const id = generateTaskId(Date.parse('2026-10-24T08:30:15.123Z'), () => '3fa9c2')
    expect(id).toBe('t-20261024-083015-3fa9c2')
    expect(LEDGER_ID_RE.test(id)).toBe(true)
    const real = generateTaskId(Date.now())
    expect(real).toMatch(/^t-\d{8}-\d{6}-[0-9a-f]{6}$/)
  })
})

describe('任务合同（POST /v1/tasks）', () => {
  test('创建：201，task.created 记录操作者，默认值已补齐', async () => {
    const { call, store } = await setup()
    const res = await call('POST', '/v1/tasks', contractInput(), { 'X-Flow-Actor': 'agent:claude' })
    expect(res.status).toBe(201)
    const { data } = okBody(createTaskData).parse(await res.json())
    expect(data.created).toBe(true)
    expect(data.task).toMatchObject({
      id: 't-test-1',
      status: 'queued',
      workspace: WS,
      created_by: 'agent:claude',
      contract: { timeout_s: 3600, requires: [] },
    })
    expect(store.eventsAfter(0)).toMatchObject([{ type: 'task.created', actor: 'agent:claude' }])
  })

  test('user token 不声明 X-Flow-Actor 时操作者为 user；格式不合法时 400', async () => {
    const { call } = await setup()
    const res = await call('POST', '/v1/tasks', contractInput())
    expect(okBody(createTaskData).parse(await res.json()).data.task.created_by).toBe('user')
    const bad = await call('POST', '/v1/tasks', contractInput(), { 'X-Flow-Actor': 'a b' })
    expect(bad.status).toBe(400)
  })

  test('缺少 workspace：400，逐字段指出 workspace 缺失，账本不新增事件', async () => {
    const { call, store } = await setup()
    const { workspace: _ws, ...rest } = contractInput()
    const res = await call('POST', '/v1/tasks', rest)
    expect(res.status).toBe(400)
    const body = errorBody.parse(await res.json())
    expect(body.error.code).toBe('invalid_arguments')
    expect(body.error.details).toContainEqual({
      field: 'workspace',
      code: 'missing_field',
      message: '缺少必填字段 workspace',
    })
    expect(store.seq()).toBe(0)
  })

  test('多个字段错误逐一报告；未知字段与 inputs.fake 限制也被拒绝', async () => {
    const { call, store } = await setup()
    const res = await call('POST', '/v1/tasks', {
      ...contractInput({ executor: 'codex-orca' }),
      goal: '',
      timeout_s: -1,
      bogus: 1,
      inputs: { fake: { outcome: 'done' } },
    })
    expect(res.status).toBe(400)
    const fields = (errorBody.parse(await res.json()).error.details as { field?: string }[]).map(
      (d) => d.field ?? '',
    )
    expect(fields).toEqual(expect.arrayContaining(['goal', 'timeout_s']))
    expect(fields.some((f) => f === '' || f.startsWith('inputs'))).toBe(true)
    expect(store.seq()).toBe(0)
  })

  test('workspace 未定义：422 unknown_workspace，不写事件', async () => {
    const { call, store } = await setup()
    const res = await call('POST', '/v1/tasks', contractInput({ workspace: 'ws/unknown' }))
    expect(res.status).toBe(422)
    expect(errorBody.parse(await res.json()).error.code).toBe('unknown_workspace')
    expect(store.seq()).toBe(0)
  })

  test('请求体不是 JSON / 为空：400 invalid_arguments', async () => {
    const { call } = await setup()
    for (const body of ['{oops', '']) {
      const res = await call('POST', '/v1/tasks', body)
      expect(res.status).toBe(400)
      expect(errorBody.parse(await res.json()).error.code).toBe('invalid_arguments')
    }
  })

  test('workspaceCheckFromHome：读取临时 flow-home 的 config/workspaces', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flow-home-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'workspaces', 'demo.yaml'),
      'id: demo\nname: Demo\ndescription: 测试\nkind: product\nrepos: []\n',
    )
    const check = workspaceCheckFromHome(home)
    expect(await check('ws/demo')).toBe(true)
    expect(await check('ws/global')).toBe(true)
    expect(await check('ws/unknown')).toBe(false)
  })
})

describe('幂等创建', () => {
  test('同一个幂等键提交两次：同一个任务 id，账本只有一条 task.created', async () => {
    const { call, store } = await setup()
    const body = contractInput({ idempotency_key: 'k-1' })
    const r1 = okBody(createTaskData).parse(await (await call('POST', '/v1/tasks', body)).json())
    const res2 = await call('POST', '/v1/tasks', { ...body, goal: '不同的目标' })
    expect(res2.status).toBe(200)
    const r2 = okBody(createTaskData).parse(await res2.json())
    expect(r1.data.created).toBe(true)
    expect(r2.data.created).toBe(false)
    expect(r2.data.task.id).toBe(r1.data.task.id)
    expect(createdCount(store)).toBe(1)
  })

  test('服务层：选项中的幂等键与合同字段等价；不一致时报错；并发提交只建一个', async () => {
    const { tasks, store } = await setup()
    const a = must(await tasks.createTask(contractInput(), { actor: 'user', idempotency_key: 'k' }))
    expect(a.task.contract.idempotency_key).toBe('k')
    const b = must(
      await tasks.createTask(contractInput({ idempotency_key: 'k' }), { actor: 'user' }),
    )
    expect(b).toMatchObject({ created: false, task: { id: a.task.id } })
    const bad = await tasks.createTask(contractInput({ idempotency_key: 'x' }), {
      actor: 'user',
      idempotency_key: 'y',
    })
    expect(bad.ok ? 'ok' : bad.error.code).toBe('invalid_arguments')
    const [c1, c2] = await Promise.all([
      tasks.createTask(contractInput({ idempotency_key: 'race' }), { actor: 'user' }),
      tasks.createTask(contractInput({ idempotency_key: 'race' }), { actor: 'user' }),
    ])
    expect([must(c1).created, must(c2).created].sort()).toEqual([false, true])
    expect(must(c1).task.id).toBe(must(c2).task.id)
    expect(createdCount(store)).toBe(2)
  })
})

describe('列表与详情', () => {
  test('GET /v1/tasks：按创建时间倒序，支持 workspace / status / parent / limit 过滤', async () => {
    const { call, tasks, store } = await setup()
    const a = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    must(await tasks.createTask(contractInput({ workspace: 'ws/global' }), { actor: 'user' }))
    must(await tasks.createTask(contractInput({ parent: a.id }), { actor: 'user' }))
    startTask(store, a.id)
    const list = async (q: string) =>
      okBody(listTasksData)
        .parse(await (await call('GET', `/v1/tasks${q}`)).json())
        .data.tasks.map((t) => t.id)
    expect(await list('')).toEqual(['t-test-3', 't-test-2', 't-test-1'])
    expect(await list('?workspace=ws/global')).toEqual(['t-test-2'])
    expect(await list('?status=running')).toEqual(['t-test-1'])
    expect(await list(`?parent=${a.id}`)).toEqual(['t-test-3'])
    expect(await list('?limit=1')).toEqual(['t-test-3'])
    const bad = await call('GET', '/v1/tasks?status=nope&x=1')
    expect(bad.status).toBe(400)
  })

  test('GET /v1/tasks/:id：任务与全部事件；不存在时 404', async () => {
    const { call, tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    const res = await call('GET', `/v1/tasks/${t.id}`)
    const { data } = okBody(showTaskData).parse(await res.json())
    expect(data.task.status).toBe('running')
    expect(data.events.map((e) => e.type)).toEqual([
      'task.created',
      'task.started',
      'lease.granted',
    ])
    const missing = await call('GET', '/v1/tasks/nope')
    expect(missing.status).toBe(404)
    expect(errorBody.parse(await missing.json()).error.code).toBe('not_found')
  })

  test('任务结果：已完成任务的详情包含摘要、产物与每条验收命令的退出码', async () => {
    const { call, tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    must(
      store.append(
        {
          ...drafts(t.id)['task.done'],
          payload: {
            result: {
              ...result(),
              artifacts: [{ kind: 'pr', ref: 'https://github.com/x/y/pull/1' }],
              verify: [{ cmd: ['bun', 'test'], exit_code: 0, duration_ms: 1200 }],
            },
          },
        },
        { actor: 'node:n1' },
      ),
    )
    const { data } = okBody(showTaskData).parse(
      await (await call('GET', `/v1/tasks/${t.id}`)).json(),
    )
    expect(data.task.status).toBe('done')
    expect(data.task.result).toMatchObject({
      summary: '完成',
      artifacts: [{ kind: 'pr', ref: 'https://github.com/x/y/pull/1' }],
      verify: [{ cmd: ['bun', 'test'], exit_code: 0 }],
    })
  })
})

describe('取消（POST /v1/tasks/:id/cancel）', () => {
  test('queued 任务直接 cancelled', async () => {
    const { call, tasks } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    const res = await call(
      'POST',
      `/v1/tasks/${t.id}/cancel`,
      { reason: '不要了' },
      { 'X-Flow-Actor': 'user' },
    )
    expect(res.status).toBe(200)
    const { data } = okBody(cancelTaskData).parse(await res.json())
    expect(data.task).toMatchObject({ status: 'cancelled' })
    expect(data.task.finished_at).not.toBeNull()
  })

  test('blocked 任务直接 cancelled（空请求体也可以）', async () => {
    const { call, tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    must(store.append(drafts(t.id)['task.blocked'], sys))
    const res = await call('POST', `/v1/tasks/${t.id}/cancel`)
    expect(okBody(cancelTaskData).parse(await res.json()).data.task.status).toBe('cancelled')
  })

  test('取消运行中的任务：写 cancel_requested（重复取消不重复写）；节点确认后变为 cancelled', async () => {
    const { call, tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    const res = await call('POST', `/v1/tasks/${t.id}/cancel`, {}, { 'X-Flow-Actor': 'user' })
    const { data } = okBody(cancelTaskData).parse(await res.json())
    expect(data.task).toMatchObject({ status: 'running', cancel_requested: true })
    const seq = store.seq()
    await call('POST', `/v1/tasks/${t.id}/cancel`)
    expect(store.seq()).toBe(seq)
    // 节点在续约时看到 cancel_requested，提交 cancelled（租约 API 属第 4 组，这里直接写事件）
    must(
      store.append(
        { ...drafts(t.id)['task.cancelled'], payload: { node_id: 'n1' } },
        { actor: 'node:n1' },
      ),
    )
    expect(store.getTask(t.id)).toMatchObject({ status: 'cancelled', lease: null })
    expect(store.taskEvents(t.id).map((e) => e.type)).toEqual([
      'task.created',
      'task.started',
      'lease.granted',
      'task.cancel_requested',
      'task.cancelled',
    ])
  })

  test('verifying 任务同样只写 cancel_requested', async () => {
    const { tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    must(store.append(drafts(t.id)['task.verifying'], sys))
    expect(must(tasks.cancelTask(t.id, { actor: 'user' })).task).toMatchObject({
      status: 'verifying',
      cancel_requested: true,
    })
  })

  test('终态任务：409 invalid_transition，不写事件；不存在：404；请求体不合法：400', async () => {
    const { call, tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    must(tasks.cancelTask(t.id, { actor: 'user' }))
    const seq = store.seq()
    const res = await call('POST', `/v1/tasks/${t.id}/cancel`)
    expect(res.status).toBe(409)
    expect(errorBody.parse(await res.json()).error.code).toBe('invalid_transition')
    expect(store.seq()).toBe(seq)
    expect((await call('POST', '/v1/tasks/nope/cancel')).status).toBe(404)
    expect((await call('POST', `/v1/tasks/${t.id}/cancel`, { reason: 1 })).status).toBe(400)
  })
})

describe('状态机经由 API 体现', () => {
  test('已完成的任务不能再运行：invalid_transition，状态保持 done', async () => {
    const { call, tasks, store } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    must(store.append(drafts(t.id)['task.done'], sys))
    const r = store.append(drafts(t.id, { attempt: 2 })['task.started'], sys)
    expect(r.ok ? 'ok' : r.error.code).toBe('invalid_transition')
    const { data } = okBody(showTaskData).parse(
      await (await call('GET', `/v1/tasks/${t.id}`)).json(),
    )
    expect(data.task.status).toBe('done')
    expect(data.events.filter((e) => e.type === 'task.started')).toHaveLength(1)
  })
})

describe('POST /v1/hub/rebuild（投影可重建）', () => {
  test('重建后每个任务的状态、尝试次数与时间戳不变；返回 events_replayed 与 ledger_seq', async () => {
    const { call, tasks, store } = await setup()
    for (let i = 0; i < 3; i++) must(await tasks.createTask(contractInput(), { actor: 'user' }))
    startTask(store, 't-test-1')
    must(store.append(drafts('t-test-1')['task.done'], sys))
    must(tasks.cancelTask('t-test-2', { actor: 'user' }))
    const pick = (
      ts: {
        id: string
        status: string
        attempt: number
        created_at: string
        updated_at: string
        started_at: string | null
        finished_at: string | null
      }[],
    ) =>
      ts.map(({ id, status, attempt, created_at, updated_at, started_at, finished_at }) => ({
        id,
        status,
        attempt,
        created_at,
        updated_at,
        started_at,
        finished_at,
      }))
    const before = pick(must(tasks.listTasks()).tasks)
    const seq = store.seq()
    const res = await call('POST', '/v1/hub/rebuild', undefined, { 'X-Flow-Actor': 'user' })
    expect(res.status).toBe(200)
    const { data } = okBody(rebuildData).parse(await res.json())
    expect(data).toMatchObject({ events_replayed: seq, ledger_seq: seq + 1 })
    expect(pick(must(tasks.listTasks()).tasks)).toEqual(before)
    expect(store.eventsAfter(seq)).toMatchObject([{ type: 'hub.rebuilt', actor: 'user' }])
  })
})
