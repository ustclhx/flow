import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ok, type PolicyCheckData, type Result, type Role, type TaskView } from '@flow/core'
import { openTokenStore } from '@flow/hub'
import {
  type ClaudeQueryFn,
  claudePrecheckRequest,
  createClaudeSdkExecutor,
  createNodeHubClient,
  createPolicyPrecheck,
  type FetchLike,
  isAutoDecision,
  PRECHECK_TIMEOUT_MS,
  type PrecheckVerdict,
} from '../src/index.ts'
import { type Bench, bench, type Intercept, ManualClock } from './harness.ts'

/**
 * 节点侧策略预检（add-m1-inbox 2.3；design D2）。
 * - 预检函数本身：经真实的 NodeHubClient 与假 fetch，覆盖放行、需要用户与各种调用失败；
 * - 端到端：进程内的真实中枢路由（policy/check + 真实 decide）+ 节点 + fake / 模拟 SDK 执行器。
 * 不调用真实的 Claude、Codex 或 Orca；所有文件都在临时目录中。
 */

const TOKEN = 'k'.repeat(43)
const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const decision = (level: string, actionLevel = level): PolicyCheckData =>
  ({
    level,
    matched_rules: [],
    actions: [
      { action: 'tool:Bash', level: 'skipped', matched_rules: [], guarded: false },
      { action: 'git.push', level: actionLevel, matched_rules: [], guarded: false },
    ],
  }) as PolicyCheckData

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const errorJson = (status: number, kind: string, code: string) =>
  json(status, { ok: false, error: { kind, code, message: `模拟 ${code}` } })

function precheckWith(fetch: FetchLike, clock = new ManualClock()) {
  const bodies: unknown[] = []
  const client = createNodeHubClient({
    url: 'http://hub.test',
    token: TOKEN,
    fetch: async (input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')))
      return fetch(input, init)
    },
  })
  return { precheck: createPolicyPrecheck({ client, taskId: 't-pre-1', clock }), bodies, clock }
}

describe('预检函数：只有明确的 auto / auto-report 才放行', () => {
  test('auto 与 auto-report 放行；请求带任务 id，不带 dry_run', async () => {
    for (const level of ['auto', 'auto-report'] as const) {
      const { precheck, bodies } = precheckWith(async () =>
        json(200, { ok: true, data: decision(level) }),
      )
      const v = await precheck({ tool: 'Bash', command: 'git push origin feat' })
      expect(v).toEqual({ allow: true, level, actions: ['git.push'] })
      expect(bodies[0]).toEqual({
        task_id: 't-pre-1',
        tool: 'Bash',
        command: 'git push origin feat',
      })
      expect(bodies[0]).not.toHaveProperty('dry_run')
    }
  })

  test('draft-approve / notify / user：交给用户，带上档位', async () => {
    for (const level of ['draft-approve', 'notify', 'user'] as const) {
      const { precheck } = precheckWith(async () => json(200, { ok: true, data: decision(level) }))
      expect(await precheck({ tool: 'Bash', command: 'git push' })).toEqual({ allow: false, level })
    }
  })

  test('响应自相矛盾（汇总 auto 但某个动作是 user）或没有参与判定的动作：不放行', async () => {
    const { precheck } = precheckWith(async () =>
      json(200, { ok: true, data: decision('auto', 'user') }),
    )
    expect((await precheck({ tool: 'Bash', command: 'git push' })).allow).toBe(false)
    expect(
      isAutoDecision({
        level: 'auto',
        matched_rules: [],
        actions: [{ action: 'tool:Bash', level: 'skipped', matched_rules: [], guarded: false }],
      }),
    ).toBe(false)
  })

  const failures: Array<[string, FetchLike]> = [
    [
      '中枢不可达',
      async () => {
        throw new TypeError('fetch failed: ECONNREFUSED')
      },
    ],
    ['5xx', async () => errorJson(500, 'failure', 'internal_error')],
    ['502 非 JSON', async () => new Response('<html>bad gateway</html>', { status: 502 })],
    ['401', async () => errorJson(401, 'usage', 'unauthorized')],
    ['403', async () => errorJson(403, 'usage', 'forbidden')],
    ['响应不合 schema', async () => json(200, { ok: true, data: { level: 'auto' } })],
    ['level 不在枚举中', async () => json(200, { ok: true, data: decision('always') })],
    ['HTTP 500 却带 ok:true', async () => json(500, { ok: true, data: decision('auto') })],
  ]
  for (const [name, fetch] of failures) {
    test(`调用失败（${name}）：按需要用户处理`, async () => {
      const { precheck } = precheckWith(fetch)
      const v = await precheck({ tool: 'Bash', command: 'ls' })
      expect(v.allow).toBe(false)
      expect(v.allow === false && v.error).toBeTruthy()
    })
  }

  test('超时：底层请求不响应中止也会在 5 秒后按需要用户处理', async () => {
    const clock = new ManualClock()
    const { precheck } = precheckWith(() => new Promise<Response>(() => {}), clock)
    let v: PrecheckVerdict | undefined
    void precheck({ tool: 'Bash', command: 'ls' }).then((r) => {
      v = r
    })
    await clock.advance(PRECHECK_TIMEOUT_MS - 1)
    expect(v).toBeUndefined()
    await clock.advance(1)
    expect(v?.allow).toBe(false)
    expect(v?.allow === false && v.error).toContain('timeout')
  })

  test('客户端抛出异常、任务已取消：按需要用户处理', async () => {
    const thrower = createPolicyPrecheck({
      client: {
        policyCheck: async () => {
          throw new Error('boom')
        },
      },
      taskId: 't-1',
      clock: new ManualClock(),
    })
    expect((await thrower({ tool: 'Bash' })).allow).toBe(false)
    const abort = new AbortController()
    abort.abort()
    let called = false
    const aborted = createPolicyPrecheck({
      client: {
        policyCheck: async () => {
          called = true
          return ok(decision('auto'))
        },
      },
      taskId: 't-1',
      signal: abort.signal,
    })
    expect((await aborted({ tool: 'Bash' })).allow).toBe(false)
    expect(called).toBe(false)
  })
})

describe('claude-sdk 的请求映射', () => {
  test('Bash 取命令，编辑类工具取路径，其他工具只有工具名', () => {
    expect(claudePrecheckRequest('Bash', { command: 'git push', description: 'x' })).toEqual({
      tool: 'Bash',
      command: 'git push',
    })
    expect(claudePrecheckRequest('Edit', { file_path: '/r/src/a.ts', old_string: 'a' })).toEqual({
      tool: 'Edit',
      paths: ['/r/src/a.ts'],
    })
    expect(claudePrecheckRequest('NotebookEdit', { notebook_path: '/r/n.ipynb' })).toEqual({
      tool: 'NotebookEdit',
      paths: ['/r/n.ipynb'],
    })
    expect(claudePrecheckRequest('Grep', { pattern: 'x', path: '/r' })).toEqual({
      tool: 'Grep',
      paths: ['/r'],
    })
    expect(claudePrecheckRequest('WebFetch', { url: 'https://x' })).toEqual({ tool: 'WebFetch' })
    // 无法可靠构造请求：交给用户。
    expect(claudePrecheckRequest('Bash', { command: 42 })).toBeUndefined()
    expect(claudePrecheckRequest('Bash', {})).toBeUndefined()
    expect(claudePrecheckRequest('Write', { content: 'x' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 端到端：真实中枢路由 + 节点
// ---------------------------------------------------------------------------

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

/** 拨动虚拟时钟并让出真实时间（策略文件的读取是真实 I/O），直到满足条件。 */
async function settle(b: Bench, id: string, pred: (t: TaskView) => boolean, what: string) {
  for (let i = 0; i < 600; i++) {
    const t = b.task(id)
    if (pred(t)) return t
    await b.clock.advance(200)
    await realWait(2)
  }
  throw new Error(`等待超时（${what}）：${b.task(id).status} ${b.types(id).join(',')}`)
}

async function fakeBench(policies: unknown[], intercept?: Intercept) {
  // 预检超时设长：虚拟时钟在等待真实 I/O 时持续前进，不能让它误判超时（超时另有单元测试）。
  const b = await bench({ policies, precheckTimeoutMs: 3_600_000 }, 60, intercept)
  current = b
  return b
}

const approvalTask = (b: Bench, step: { tool: string; command?: string; paths?: string[] }) =>
  b.create({
    workspace: 'ws/xuanxue-saas',
    inputs: { fake: { script: [{ do: 'approval' as const, ...step }], message: '完成' } },
  })

const texts = (b: Bench, id: string) => b.ledger.taskActivity(id).map((a) => a.text ?? '')
const decided = (b: Bench, id: string) => b.events(id).filter((e) => e.type === 'policy.decided')

describe('端到端（fake 执行器 + 真实 policy/check）', () => {
  test('auto：本地放行，任务不进入 blocked；中枢以 policy 身份记录 policy.decided', async () => {
    const b = await fakeBench([{ scope: '*', action: 'tool:Bash', level: 'auto' }])
    const id = await approvalTask(b, { tool: 'Bash', command: 'ls -la' })
    await settle(b, id, (t) => t.status === 'done', 'done')
    expect(b.types(id)).not.toContain('task.blocked')
    const ev = decided(b, id)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      actor: 'policy',
      payload: { level: 'auto', request: { tool: 'Bash', command: 'ls -la' } },
    })
    expect(texts(b, id).some((t) => t.startsWith('策略自动放行：Bash ls -la'))).toBe(true)
  })

  test('auto-report：命中 pr.create 时同样放行，不进入 blocked', async () => {
    const b = await fakeBench([{ scope: '*', action: 'pr.create', level: 'auto-report' }])
    const id = await approvalTask(b, { tool: 'Bash', command: 'gh pr create --fill' })
    await settle(b, id, (t) => t.status === 'done', 'done')
    expect(b.types(id)).not.toContain('task.blocked')
    expect(decided(b, id)[0]?.payload).toMatchObject({ level: 'auto-report' })
  })

  test('draft-approve：照常 blocked(awaiting_approval)，用户批准后继续完成', async () => {
    const b = await fakeBench([
      { scope: '*', action: 'git.push', level: 'auto' },
      { scope: 'ws/xuanxue-saas', action: 'git.push', level: 'draft-approve' },
    ])
    const id = await approvalTask(b, { tool: 'Bash', command: 'git push origin feat-x' })
    const t = await settle(b, id, (t) => t.status === 'blocked', 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    expect(decided(b, id)[0]?.payload).toMatchObject({ level: 'draft-approve' })
    const r = await b.api<{ ok: boolean }>('POST', `/v1/tasks/${id}/reply`, { kind: 'approve' })
    expect(r.ok).toBe(true)
    await settle(b, id, (t) => t.status === 'done', 'done')
  })

  test('只有 `* * auto` 时请求 gh pr merge：交给用户（经真实 decide 的 guarded）', async () => {
    const b = await fakeBench([{ scope: '*', action: '*', level: 'auto' }])
    const id = await approvalTask(b, { tool: 'Bash', command: 'gh pr merge 42 --squash' })
    const t = await settle(b, id, (t) => t.status === 'blocked', 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    const payload = decided(b, id)[0]?.payload as {
      level: string
      actions: Array<{ action: string; guarded: boolean }>
    }
    expect(payload.level).toBe('draft-approve')
    expect(payload.actions.find((a) => a.action === 'pr.merge')?.guarded).toBe(true)
  })

  const broken: Array<[string, Intercept]> = [
    [
      '中枢不可达',
      (url) => {
        if (url.endsWith('/v1/policy/check')) throw new TypeError('fetch failed: ECONNREFUSED')
        return undefined
      },
    ],
    [
      '5xx',
      (url) =>
        url.endsWith('/v1/policy/check') ? errorJson(500, 'failure', 'internal_error') : undefined,
    ],
    [
      '响应畸形',
      (url) =>
        url.endsWith('/v1/policy/check')
          ? json(200, { ok: true, data: { level: 'auto', extra: 1 } })
          : undefined,
    ],
  ]
  for (const [name, intercept] of broken) {
    test(`预检失败（${name}）：即使规则是 auto 也进入 blocked`, async () => {
      const b = await fakeBench([{ scope: '*', action: '*', level: 'auto' }], intercept)
      const id = await approvalTask(b, { tool: 'Bash', command: 'ls' })
      const t = await settle(b, id, (t) => t.status === 'blocked', 'blocked')
      expect(t.blocked?.reason).toBe('awaiting_approval')
      expect(texts(b, id).some((x) => x.startsWith('策略预检失败，按需要用户处理'))).toBe(true)
    })
  }

  test('策略文件损坏（中枢 500）：进入 blocked', async () => {
    const b = await fakeBench([])
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(b.home, 'config', 'policies.yaml'), 'rules: [unclosed')
    const id = await approvalTask(b, { tool: 'Bash', command: 'ls' })
    const t = await settle(b, id, (t) => t.status === 'blocked', 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    expect(decided(b, id)).toHaveLength(0)
  })

  test('中枢拒绝调用方的身份（真实鉴权中间件）：预检按需要用户处理', async () => {
    const b = await fakeBench([{ scope: '*', action: '*', level: 'auto' }])
    const created = await b.tasks.createTask(
      { goal: '无人领取', workspace: 'ws/demo', role: 'dev', executor: 'no-such-executor' },
      { actor: 'user' },
    )
    if (!created.ok) throw new Error(created.error.message)
    const client = createNodeHubClient({
      url: 'http://hub.test',
      token: TOKEN,
      actor: 'node:n-other',
      fetch: b.hubFetch,
    })
    const precheck = createPolicyPrecheck({ client, taskId: created.data.task.id })
    const v = await precheck({ tool: 'Bash', command: 'ls' })
    expect(v.allow).toBe(false)
    // user token 不能声明 node:*（绑定 token 与租约范围的 403 由中枢测试覆盖，这里只验证节点的处理）。
    expect(v.allow === false && v.error).toContain('reserved_actor')
    expect(decided(b, created.data.task.id)).toHaveLength(0)
  })
})

describe('节点身份与租约范围（真实鉴权中间件）', () => {
  test('绑定 token 的节点持有活动租约：预检通过租约范围校验并放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-precheck-tokens-'))
    try {
      const store = await openTokenStore(dir)
      if (!store.ok) throw new Error(store.error.message)
      const issued = await store.data.issue({ actor: 'node:n-bench' })
      if (!issued.ok) throw new Error(issued.error.message)
      const b = await bench({
        policies: [{ scope: '*', action: 'tool:Bash', level: 'auto' }],
        tokens: store.data,
        token: issued.data.secret,
        precheckTimeoutMs: 3_600_000,
      })
      current = b
      const id = await approvalTask(b, { tool: 'Bash', command: 'ls' })
      await settle(b, id, (t) => t.status === 'done', 'done')
      expect(b.types(id)).not.toContain('task.blocked')
      expect(decided(b, id)[0]?.payload).toMatchObject({ level: 'auto' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('绑定 token 的节点：没有该任务的活动租约时中枢拒绝（scope_denied），预检按需要用户处理', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-precheck-tokens-'))
    try {
      const store = await openTokenStore(dir)
      if (!store.ok) throw new Error(store.error.message)
      const issued = await store.data.issue({ actor: 'node:n-other' })
      if (!issued.ok) throw new Error(issued.error.message)
      const b = await bench({
        policies: [{ scope: '*', action: '*', level: 'auto' }],
        tokens: store.data,
      })
      current = b
      const created = await b.tasks.createTask(
        { goal: '无人领取', workspace: 'ws/demo', role: 'dev', executor: 'no-such-executor' },
        { actor: 'user' },
      )
      if (!created.ok) throw new Error(created.error.message)
      const client = createNodeHubClient({
        url: 'http://hub.test',
        token: issued.data.secret,
        fetch: b.hubFetch,
      })
      const v = await createPolicyPrecheck({ client, taskId: created.data.task.id })({
        tool: 'Bash',
        command: 'ls',
      })
      expect(v.allow).toBe(false)
      expect(v.allow === false && v.error).toContain('scope_denied')
      expect(decided(b, created.data.task.id)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 端到端：claude-sdk（模拟 SDK）
// ---------------------------------------------------------------------------

const role: Role = {
  name: 'dev',
  executor: 'claude-sdk',
  prompt: '开发。',
  model: 'claude-opus-5-5',
  permissions: {},
}

/** 模拟 SDK：依次请求每个工具调用的审批，记录结果，然后以成功结束。 */
function mockQuery(calls: Array<[string, Record<string, unknown>]>) {
  const permissions: Array<PermissionResult | null> = []
  const query: ClaudeQueryFn = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>
    options: Options
  }) => {
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      await prompt[Symbol.asyncIterator]().next()
      let n = 0
      for (const [tool, input] of calls) {
        n++
        const r = await options.canUseTool?.(tool, input, {
          signal: options.abortController?.signal ?? new AbortController().signal,
          toolUseID: `tu-${n}`,
          requestId: `rq-${n}`,
        })
        permissions.push(r ?? null)
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '完成',
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        stop_reason: 'end_turn',
        uuid: 'u-1',
        session_id: 's-1',
      } as unknown as SDKMessage
    })()
    return { [Symbol.asyncIterator]: () => gen, close() {} }
  }
  return { query, permissions }
}

async function sdkBench(policies: unknown[], calls: Array<[string, Record<string, unknown>]>) {
  const { query, permissions } = mockQuery(calls)
  const executor = createClaudeSdkExecutor({
    home: '/tmp/flow-home-not-used',
    query,
    resolveRole: async (): Promise<Result<Role>> => ok(role),
  })
  const b = await bench({ policies, executors: [executor], precheckTimeoutMs: 3_600_000 })
  current = b
  const id = await b.create({
    workspace: 'ws/xuanxue-saas',
    executor: 'claude-sdk',
    cwd: '/repo/demo',
  })
  return { b, id, permissions }
}

describe('端到端（claude-sdk 模拟 SDK + 真实 policy/check）', () => {
  test('auto：canUseTool 直接 allow，原样带回输入，不进入 blocked', async () => {
    const { b, id, permissions } = await sdkBench(
      [
        { scope: '*', action: 'tool:Bash', level: 'auto' },
        { scope: 'dev', action: 'tool:Edit', level: 'auto-report' },
      ],
      [
        ['Bash', { command: 'ls' }],
        ['Edit', { file_path: '/repo/demo/src/a.ts', old_string: 'a', new_string: 'b' }],
      ],
    )
    await settle(b, id, (t) => t.status === 'done', 'done')
    expect(b.types(id)).not.toContain('task.blocked')
    expect(permissions).toEqual([
      { behavior: 'allow', updatedInput: { command: 'ls' } },
      {
        behavior: 'allow',
        updatedInput: { file_path: '/repo/demo/src/a.ts', old_string: 'a', new_string: 'b' },
      },
    ])
    const ev = decided(b, id)
    expect(ev.map((e) => (e.payload as { level: string }).level)).toEqual(['auto', 'auto-report'])
    expect(ev[1]?.payload).toMatchObject({
      request: { tool: 'Edit', paths: ['/repo/demo/src/a.ts'] },
    })
    expect(texts(b, id).filter((t) => t.startsWith('策略自动放行'))).toHaveLength(2)
  })

  test('gh pr merge 只有 `* * auto`：挂起审批、进入 blocked，用户批准后放行', async () => {
    const { b, id, permissions } = await sdkBench(
      [{ scope: '*', action: '*', level: 'auto' }],
      [['Bash', { command: 'gh pr merge 42' }]],
    )
    const t = await settle(b, id, (t) => t.status === 'blocked', 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    expect(permissions).toEqual([])
    await b.api('POST', `/v1/tasks/${id}/reply`, { kind: 'approve' })
    await settle(b, id, (t) => t.status === 'done', 'done')
    expect(permissions[0]).toMatchObject({ behavior: 'allow' })
  })
})
