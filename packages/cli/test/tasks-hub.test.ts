import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ENDPOINTS,
  flowPaths,
  HEADERS,
  HubClient,
  hubStatusData,
  invokeOperation,
  kbSearchOp,
  type Result,
  taskCancelOp,
  taskCreateOp,
  taskListOp,
  taskShowOp,
  toJsonDocument,
  VERSION,
} from '@flow/core'
import {
  createTaskRoutes,
  createTaskService,
  openLedger,
  type RunningHub,
  runHub,
  startHub,
  workspaceCheckFromHome,
} from '@flow/hub'
import { callJson, connect, initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

const contract = {
  goal: '验证任务操作',
  workspace: 'ws/product-res',
  role: 'developer',
  executor: 'fake',
}
function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.data
}

let home: string
let hub: RunningHub | undefined
let savedHome: string | undefined
const ctx = () => ({ home, actor: 'test-agent', via: 'cli' as const })
const client = () => new HubClient(ctx())
async function start() {
  hub = data(await runHub({ home, port: 0 }))
  await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
  return hub
}

beforeEach(async () => {
  home = await initTempHome('flow-tasks-hub-')
  savedHome = process.env.FLOW_HOME
  process.env.FLOW_HOME = home
})
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  if (savedHome === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('任务操作与真实中枢', () => {
  test('四个操作共享 HTTP 协议、保留 actor，并支持筛选和幂等创建', async () => {
    await start()
    const created = data(
      await invokeOperation(taskCreateOp, { ...contract, idempotency_key: 'same-task' }, ctx()),
    )
    expect(created.created).toBe(true)
    expect(created.task.created_by).toBe('test-agent')
    expect(
      data(await client().createTask({ ...contract, idempotency_key: 'same-task' })).task.id,
    ).toBe(created.task.id)
    const listed = data(
      await invokeOperation(taskListOp, { workspace: contract.workspace, status: 'queued' }, ctx()),
    )
    expect(listed.tasks.map((t) => t.id)).toEqual([created.task.id])
    expect(data(await client().listTasks({ status: 'done' })).tasks).toEqual([])
    const shown = data(await invokeOperation(taskShowOp, { id: created.task.id }, ctx()))
    expect(shown.events[0]?.actor).toBe('test-agent')
    const cancelled = data(
      await invokeOperation(taskCancelOp, { id: created.task.id, reason: '测试取消' }, ctx()),
    )
    expect(cancelled.task.status).toBe('cancelled')
    expect(data(await client().showTask(created.task.id)).events.at(-1)?.actor).toBe('test-agent')
    expect(taskListOp.human?.(listed)).toContain('Workspace')
    expect(taskCreateOp.human?.(created)).toContain(contract.goal)
    expect(taskCancelOp.human?.(cancelled)).toContain('已取消')
  })

  test('四个操作的错误路径：未知 workspace、非法筛选、不存在任务、终态取消', async () => {
    await start()
    const created = await invokeOperation(
      taskCreateOp,
      { ...contract, workspace: 'ws/unknown' },
      ctx(),
    )
    expect(toJsonDocument(created)).toMatchObject({
      ok: false,
      error: { kind: 'failure', code: 'unknown_workspace' },
    })
    const listed = await invokeOperation(taskListOp, { status: 'unknown' }, ctx())
    expect(toJsonDocument(listed)).toMatchObject({
      ok: false,
      error: { kind: 'usage', code: 'invalid_arguments' },
    })
    const shown = await invokeOperation(taskShowOp, { id: 'missing' }, ctx())
    expect(toJsonDocument(shown)).toMatchObject({
      ok: false,
      error: { kind: 'failure', code: 'not_found' },
    })
    const task = data(await client().createTask(contract)).task
    data(await client().cancelTask(task.id))
    const cancelled = await invokeOperation(taskCancelOp, { id: task.id }, ctx())
    expect(toJsonDocument(cancelled)).toMatchObject({
      ok: false,
      error: { kind: 'failure', code: 'invalid_transition' },
    })
  })

  test('CLI 常用字段、JSON 文件与 MCP 使用相同的任务合同', async () => {
    await start()
    const out = await runCli(
      [
        'task',
        'create',
        '--goal',
        contract.goal,
        '--workspace',
        contract.workspace,
        '--role',
        contract.role,
        '--executor',
        contract.executor,
        '--json',
        '--actor',
        'cli-agent',
      ],
      commands,
    )
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.stdout).data.task.created_by).toBe('cli-agent')
    const file = join(home, 'task.json')
    await writeFile(
      file,
      JSON.stringify({
        ...contract,
        inputs: { fake: { outcome: 'done', activity: ['测试输出'] } },
        verify: [{ cmd: ['bun', 'test'] }],
      }),
    )
    const fromFile = await runCli(['task', 'create', '--file', file, '--json'], commands)
    expect(fromFile.exitCode).toBe(0)
    expect(JSON.parse(fromFile.stdout).data.task.contract.inputs.fake.activity).toEqual([
      '测试输出',
    ])
    const mcp = await connect({ home, actor: 'mcp-agent' })
    try {
      const result = await callJson(mcp, 'task_show', {
        id: JSON.parse(fromFile.stdout).data.task.id,
      })
      expect(result.doc.ok).toBe(true)
      const cli = await runCli(
        ['task', 'show', JSON.parse(fromFile.stdout).data.task.id, '--json'],
        commands,
      )
      expect(result.doc).toEqual(JSON.parse(cli.stdout))
    } finally {
      await mcp.close()
    }
  })

  test('缺少 workspace 的文件保留字段错误，非法 JSON 与混合输入被拒绝', async () => {
    const file = join(home, 'task.json')
    await writeFile(file, JSON.stringify({ goal: '缺字段' }))
    const invalid = await runCli(['task', 'create', '--file', file, '--json'], commands)
    expect(invalid.exitCode).toBe(2)
    expect(
      JSON.parse(invalid.stdout).error.details.some((i: { path: string[] }) =>
        i.path.includes('workspace'),
      ),
    ).toBe(true)
    await writeFile(file, '{')
    expect((await runCli(['task', 'create', '--file', file, '--json'], commands)).exitCode).toBe(2)
    expect(
      (await runCli(['task', 'create', '--file', file, '--goal', '冲突', '--json'], commands))
        .exitCode,
    ).toBe(2)
    expect(
      (await runCli(['task', 'create', '--file', join(home, 'missing.json'), '--json'], commands))
        .exitCode,
    ).toBe(1)
  })

  test('中枢停止后任务可重试且 CLI 退出码 3，kb_search 仍可检索本地内容', async () => {
    const running = await start()
    await running.stop()
    await writeFile(
      join(home, 'brain', 'offline.md'),
      '---\ntype: note\ntitle: 离线知识\nsummary: 中枢停止也能检索\nscope: work\n---\n离线知识正文\n',
    )
    const result = await invokeOperation(taskCreateOp, contract, ctx())
    expect(toJsonDocument(result)).toMatchObject({
      ok: false,
      error: { code: 'hub_unavailable', kind: 'retryable', retryable: true },
    })
    if (!result.ok) expect(result.error.message).toContain('运行 flow daemon status 检查')
    const cli = await runCli(
      [
        'task',
        'create',
        '--goal',
        contract.goal,
        '--workspace',
        contract.workspace,
        '--role',
        contract.role,
        '--executor',
        contract.executor,
        '--json',
      ],
      commands,
    )
    expect(cli.exitCode).toBe(3)
    const search = data(await invokeOperation(kbSearchOp, { query: '离线知识' }, ctx()))
    expect(search.results.some((r) => r.title === '离线知识')).toBe(true)
  })

  test('四个任务操作在 token 缺失时都返回 hub_unavailable', async () => {
    const inputs = [contract, {}, { id: 'missing' }, { id: 'missing' }]
    const ops = [taskCreateOp, taskListOp, taskShowOp, taskCancelOp]
    for (let i = 0; i < ops.length; i++) {
      const result = await invokeOperation(ops[i] as never, inputs[i], ctx())
      expect(toJsonDocument(result)).toMatchObject({
        ok: false,
        error: { code: 'hub_unavailable', retryable: true },
      })
    }
  })
})

describe('HubClient 协议边界', () => {
  test('认证失败保留中枢错误类别和错误码', async () => {
    await start()
    await writeFile(flowPaths(home).hubToken, randomUUID())
    expect(toJsonDocument(await client().listTasks())).toMatchObject({
      ok: false,
      error: { kind: 'failure', code: 'unauthorized', retryable: false },
    })
  })

  test('每个请求传 token 与 actor；中枢错误的 details 和类别原样转换', async () => {
    await mkdir(flowPaths(home).state, { recursive: true })
    const token = randomUUID()
    await writeFile(flowPaths(home).hubToken, token)
    const error = {
      kind: 'retryable' as const,
      code: 'hub_busy',
      message: '稍后再试',
      details: { queue: 2 },
    }
    const probe = new HubClient({
      ...ctx(),
      fetch: async (request) => {
        expect(request.headers.get(HEADERS.authorization)).toBe(`Bearer ${token}`)
        expect(request.headers.get(HEADERS.actor)).toBe('test-agent')
        expect(new URL(request.url).pathname).toBe(ENDPOINTS['tasks-list'].path)
        return Response.json(toJsonDocument({ ok: false, error }), { status: 503 })
      },
    })
    expect(await probe.listTasks()).toEqual({ ok: false, error })
  })

  test('超时覆盖响应体读取，返回可重试错误', async () => {
    await mkdir(flowPaths(home).state, { recursive: true })
    await writeFile(flowPaths(home).hubToken, randomUUID())
    const probe = new HubClient({
      ...ctx(),
      timeoutMs: 10,
      fetch: async (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true },
              )
            },
          }),
        ),
    })
    expect(toJsonDocument(await probe.health())).toMatchObject({
      ok: false,
      error: { code: 'hub_unavailable', retryable: true },
    })
  })

  test('非法 JSON 或不符合 schema 的响应不能当作成功', async () => {
    await mkdir(flowPaths(home).state, { recursive: true })
    await writeFile(flowPaths(home).hubToken, randomUUID())
    for (const response of [
      new Response('invalid'),
      Response.json({ ok: true, data: { tasks: [{}] } }),
    ]) {
      const probe = new HubClient({ ...ctx(), fetch: async () => response })
      expect(toJsonDocument(await probe.listTasks())).toMatchObject({
        ok: false,
        error: { code: 'invalid_hub_response', retryable: false },
      })
    }
  })

  test('status 有端点时使用协议响应，并显示定时规则错误', async () => {
    await mkdir(flowPaths(home).state, { recursive: true })
    await writeFile(flowPaths(home).hubToken, randomUUID())
    const status = hubStatusData.parse({
      version: VERSION,
      uptime: 10,
      ledger_seq: 7,
      pid: process.pid,
      started_at: new Date().toISOString(),
      runtime: 'bun',
      schedules: { loaded: 1, errors: [{ rule_id: 'bad-rule', message: 'cron 不合法' }] },
      last_backup: null,
    })
    const probe = new HubClient({
      ...ctx(),
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe(ENDPOINTS['hub-status'].path)
        return Response.json({ ok: true, data: status })
      },
    })
    expect(data(await probe.status())).toEqual(status)
    const command = commands.find((c) => c.name === 'hub status')
    expect(command?.human?.(status)).toContain('bad-rule cron 不合法')
  })

  test('旧中枢缺少 status 路由时回退显示 health、pid、最新备份，rebuild 显示事件数和耗时', async () => {
    // 显式构造没有 status 路由的旧服务，保留客户端回退与 CLI 渲染的回归覆盖。
    let routes: ReturnType<typeof createTaskRoutes>
    hub = data(
      await startHub({
        home,
        port: 0,
        openLedger: async () => {
          const ledger = await openLedger(flowPaths(home).ledgerDb)
          routes = createTaskRoutes({
            ledger,
            tasks: createTaskService({ ledger, workspaceExists: workspaceCheckFromHome(home) }),
          })
          return ledger
        },
        routes: () => [{ path: '/', app: routes }],
      }),
    )
    await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
    await client().createTask(contract)
    const backups = flowPaths(home).backups
    await mkdir(backups, { recursive: true })
    await writeFile(join(backups, 'old.db'), '')
    await utimes(join(backups, 'old.db'), new Date(0), new Date(0))
    const latest = join(backups, 'new.db')
    await writeFile(latest, '')
    await utimes(latest, new Date('2100-01-01'), new Date('2100-01-01'))
    const status = data(await client().status())
    expect(status).toMatchObject({
      version: VERSION,
      pid: process.pid,
      schedules: { errors: [] },
      last_backup: { path: latest },
    })
    expect(status.uptime).toBeGreaterThanOrEqual(0)
    expect(status.ledger_seq).toBeGreaterThan(0)
    const out = await runCli(['hub', 'status'], commands)
    for (const field of ['版本', '运行时长', '账本序号', '定时规则错误', latest])
      expect(out.stdout).toContain(field)
    const rebuilt = await runCli(['hub', 'rebuild'], commands)
    expect(rebuilt.exitCode).toBe(0)
    expect(rebuilt.stdout).toMatch(/已重放 \d+ 条事件，耗时 \d+ 毫秒/)
  })

  test('status 与 rebuild 不吞掉中枢不可用错误', async () => {
    for (const command of ['status', 'rebuild']) {
      const out = await runCli(['hub', command, '--json'], commands)
      expect(out.exitCode).toBe(3)
      expect(JSON.parse(out.stdout).error.code).toBe('hub_unavailable')
    }
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`hub start 前台存活、拒绝重复启动并在 ${signal} 时释放 pid 锁`, async () => {
    const portProbe = data(await runHub({ home, port: 0 }))
    const port = portProbe.port
    await portProbe.stop()
    await writeFile(flowPaths(home).hubConfig, `port: ${port}\n`)
    const proc = Bun.spawn(
      [
        process.execPath,
        'packages/cli/src/main.ts',
        'hub',
        'start',
        ...(signal === 'SIGTERM' ? ['--json'] : []),
      ],
      {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, FLOW_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    try {
      const reader = proc.stderr.getReader()
      let startup = ''
      while (!startup.includes('中枢监听于')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('中枢在监听前退出')
        startup += new TextDecoder().decode(chunk.value)
      }
      reader.releaseLock()
      expect(proc.exitCode).toBeNull()
      const pid = JSON.parse(await readFile(flowPaths(home).hubPid, 'utf8')).pid
      expect(pid).toBe(proc.pid)
      const duplicate = await runCli(['hub', 'start', '--json'], commands)
      expect(duplicate.exitCode).toBe(1)
      expect(JSON.parse(duplicate.stdout).error.message).toContain(String(proc.pid))
      proc.kill(signal)
      expect(await proc.exited).toBe(0)
      expect(existsSync(flowPaths(home).hubPid)).toBe(false)
      const stdout = await new Response(proc.stdout).text()
      if (signal === 'SIGTERM') expect(JSON.parse(stdout)).toMatchObject({ ok: true })
      else expect(stdout).toContain('中枢已停止')
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL')
      await proc.exited
    }
  }, 15000)
}
