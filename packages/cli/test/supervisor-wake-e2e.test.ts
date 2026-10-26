import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  defaultSupervisorConfig,
  flowPaths,
  HUB_TOKEN_FILE_ENV,
  initFlowHome,
  ok,
  type Role,
  type TaskView,
  type WakeOrigin,
} from '@flow/core'
import {
  createHubApp,
  createNodeProtocol,
  createTaskRoutes,
  createTaskService,
  createWakeTokenAuthority,
  type LedgerStore,
  openLedger,
  type RoleLookup,
  serve,
  systemClock,
} from '@flow/hub'
import {
  type ClaudeQueryFn,
  createClaudeSdkExecutor,
  type RunningNode,
  startNode,
  wakeTokenDir,
} from '@flow/node'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// 策略路由未从 @flow/hub 的入口导出；与节点测试台一样直接引用源文件。
import { createPolicyRoutes } from '../../hub/src/policy/routes.ts'

/**
 * add-m1-supervisor 2.6 后一半、4.1、5.3 的端到端测试：
 * 真实中枢路由（任务、策略、节点协议、唤醒绑定 token）经 HTTP 提供服务 + 真实节点 + claude-sdk 执行器
 * （SDK 的 `query` 换成桩，绝不调用真实的 Claude）。桩按 SDK 的方式先经 canUseTool 申请 `task_create`，
 * 放行后按执行器给出的 MCP 配置（命令、参数、环境）**真实启动** `flow mcp` 子进程并调用 `task_create`，
 * 子进程从 `FLOW_HUB_TOKEN_FILE` 读取唤醒 token 访问中枢建出子任务。
 */

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const USER_TOKEN = 'u'.repeat(43)
const WS = 'ws/demo'
const RULE = '# - scope: supervisor\n#   action: task.create\n#   level: auto\n'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SUPERVISOR: Role = {
  name: 'supervisor',
  kind: 'supervisor',
  executor: 'claude-sdk',
  prompt: '你是 supervisor。',
  permissions: {
    permissionMode: 'default',
    setting_sources: [],
    read_scope: 'cwd',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  },
}

const HUB_ROLES: RoleLookup = async (name) =>
  ok(
    name === 'supervisor'
      ? { name, executor: 'claude-sdk', kind: 'supervisor' as const }
      : name === 'triage'
        ? {
            name,
            executor: 'codex-exec',
            permissions: { sandbox: 'read-only' },
            creatable_by: ['*'],
          }
        : null,
  )

type Doc = { ok: boolean; data?: { task: TaskView }; error?: { code: string } }

interface McpCall {
  args: string[]
  env: Record<string, string>
  /** 会话（Claude 进程）的 env。 */
  sessionEnv: Record<string, string | undefined>
  result?: Doc
  /** 运行中 token 文件与目录的权限位。 */
  fileMode?: number
  dirMode?: number
  /** reply 唤醒：绕过本地检查直接用 token 调中枢的结果。 */
  direct?: Doc
}

/**
 * SDK `query` 的桩。`approve: true` 时按 SDK 的方式先经 canUseTool 申请 task_create；
 * 放行（或 reply 唤醒直接调用）后真实启动 flow mcp 子进程调用它。
 */
function stubQuery(repo: string, calls: McpCall[], hubUrl: () => string): ClaudeQueryFn {
  return ({ prompt, options }) => {
    const gen = (async function* () {
      await prompt[Symbol.asyncIterator]().next()
      const reply = (options.mcpServers?.flow as { args?: string[] } | undefined)?.args?.includes(
        '--reply-only',
      )
      const input = {
        goal: '收集证据',
        workspace: WS,
        role: 'triage',
        executor: 'codex-exec',
        cwd: repo,
      }
      let allowed = reply === true
      if (!reply) {
        const canUseTool = options.canUseTool
        if (!canUseTool) throw new Error('没有 canUseTool')
        const decision = await canUseTool('mcp__flow__task_create', input, {
          signal: options.abortController?.signal ?? new AbortController().signal,
          toolUseID: 'tu-1',
          requestId: 'rq-1',
          mcpServer: { name: 'flow', source: 'dynamic' },
        } as never)
        allowed = decision?.behavior === 'allow'
      }
      if (allowed) {
        const flow = options.mcpServers?.flow as {
          command: string
          args: string[]
          env: Record<string, string>
        }
        // 与 Claude Code 一致：MCP 进程继承会话进程的 env，再叠加服务配置的 env。
        const base = Object.fromEntries(
          Object.entries(options.env ?? {}).filter(
            (e): e is [string, string] => e[1] !== undefined,
          ),
        )
        const tokenFile = flow.env[HUB_TOKEN_FILE_ENV] as string
        const call: McpCall = {
          args: flow.args,
          env: flow.env,
          sessionEnv: { ...options.env },
          fileMode: statSync(tokenFile).mode & 0o777,
          dirMode: statSync(dirname(tokenFile)).mode & 0o777,
        }
        const transport = new StdioClientTransport({
          command: flow.command,
          args: flow.args,
          env: { ...base, ...flow.env },
          stderr: 'pipe',
        })
        const client = new Client({ name: 'stub-claude', version: '0.0.0' })
        await client.connect(transport)
        try {
          const res = await client.callTool({ name: 'task_create', arguments: input })
          call.result = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}')
        } finally {
          await client.close()
        }
        if (reply) {
          // 绕过 MCP 本地检查：直接以唤醒 token 调中枢，中枢同样拒绝。
          const token = readFileSync(tokenFile, 'utf8').trim()
          const res = await fetch(`${hubUrl()}/v1/tasks`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Flow-Actor': 'supervisor',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...input, parent: undefined }),
          })
          call.direct = (await res.json()) as Doc
        }
        calls.push(call)
      }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '已处理唤醒' }] },
        parent_tool_use_id: null,
        session_id: 's-1',
      } as never
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '已处理唤醒',
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        stop_reason: 'end_turn',
        queued_turn_count: 0,
        uuid: 'u-1',
        session_id: 's-1',
      } as never
    })()
    return { [Symbol.asyncIterator]: () => gen, close() {} }
  }
}

async function setup(
  policiesYaml: (template: string) => string,
  origin: WakeOrigin = 'instruction',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-sup-e2e-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const init = await initFlowHome(home)
  if (!init.ok) throw new Error(init.error.message)
  const paths = flowPaths(home)
  const policiesFile = join(paths.config, 'policies.yaml')
  writeFileSync(policiesFile, policiesYaml(readFileSync(policiesFile, 'utf8')))
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(paths.hubToken, `${USER_TOKEN}\n`)
  // 上次运行残留的唤醒 token 文件：节点启动时清理。
  const stale = join(wakeTokenDir(home), 't-stale.token')
  mkdirSync(dirname(stale), { recursive: true })
  writeFileSync(stale, 'stale\n')

  const ledger: LedgerStore = await openLedger(':memory:')
  const wakeTokens = createWakeTokenAuthority({ ledger: () => ledger })
  const protocol = createNodeProtocol({
    ledger,
    clock: systemClock,
    leaseTtlS: 6,
    leaseWaitMaxS: 1,
    issueWakeToken: (g) => wakeTokens.issue(g),
  })
  const tasks = createTaskService({
    ledger,
    workspaceExists: async (ref) => ref === WS,
    workspaces: async (ref) =>
      ref === WS ? { ref, repos: [repo], supervisor: defaultSupervisorConfig() } : null,
    roles: HUB_ROLES,
  })
  const leaseHolders = (taskId: string) => {
    const lease = ledger.activeLease(taskId)
    return lease && Date.parse(lease.expires_at) > Date.now() ? [lease.node_id] : []
  }
  const app = createHubApp({
    token: USER_TOKEN,
    wakeTokens,
    ledger,
    clock: systemClock,
    leaseHolders,
    mount: [
      { path: '/', app: createTaskRoutes({ ledger, tasks }) },
      { path: '/', app: createPolicyRoutes({ home, ledger, leaseHolders }) },
      { path: '/', app: protocol.routes },
    ],
  })
  const server = await serve((req) => app.fetch(req), { port: 0 })
  writeFileSync(paths.hubConfig, `port: ${server.port}\n`)

  const calls: McpCall[] = []
  const logs: string[] = []
  const logger = {
    info: (...a: unknown[]) => logs.push(JSON.stringify(a)),
    warn: (...a: unknown[]) => logs.push(JSON.stringify(a)),
  }
  const executor = createClaudeSdkExecutor({
    home,
    query: stubQuery(repo, calls, () => server.url),
    resolveRole: async (name) =>
      name === 'supervisor'
        ? ok(SUPERVISOR)
        : { ok: false, error: { kind: 'failure', code: 'unknown_role', message: name } },
    flowCommand: [process.execPath, MAIN],
    reannounceMs: 200,
  })
  const started = await startNode({
    home,
    token: USER_TOKEN,
    hubUrl: server.url,
    executors: [executor],
    nodeId: 'n-e2e',
    hostname: 'e2e',
    logger,
    waitS: 1,
    retryMs: 100,
    noProgressMinutes: () => undefined,
  })
  if (!started.ok) throw new Error(started.error.message)
  expect(existsSync(stale)).toBe(false)
  const node: RunningNode = started.data
  cleanups.push(async () => {
    await node.stop()
    protocol.stop()
    await server.close()
    ledger.close()
  })

  // 中枢以 hub 建唤醒任务（调度器由 G10 实现；这里直接写 task.created 与 supervisor.wake_started）。
  const created = await tasks.createTask(
    {
      goal: origin === 'reply' ? '代回复委托的卡住' : '用户指令：拆任务',
      workspace: WS,
      role: 'supervisor',
      executor: 'claude-sdk',
      cwd: repo,
      idempotency_key: `supervisor:${WS}:1`,
      inputs: { wake: { origin, generation: 1, events: [] } },
    },
    {
      actor: 'hub',
      ...(origin === 'reply' ? {} : { origin }),
      withCreated: (id) => [
        {
          task_id: id,
          workspace: WS,
          type: 'supervisor.wake_started',
          payload: { task_id: id, workspace: WS, origin, events: [], generation: 1 },
        },
      ],
    },
  )
  if (!created.ok) throw new Error(created.error.message)
  const wakeId = created.data.task.id

  const until = async (pred: () => boolean, what: string, ms = 20_000) => {
    for (const deadline = Date.now() + ms; !pred(); ) {
      if (Date.now() > deadline) {
        throw new Error(
          `等待超时（${what}）：${ledger.getTask(wakeId)?.status} ${ledger
            .taskEvents(wakeId)
            .map((e) => e.type)
            .join(',')}`,
        )
      }
      await sleep(50)
    }
  }
  const reply = async (body: unknown) => {
    const res = await fetch(`${server.url}/v1/tasks/${wakeId}/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${USER_TOKEN}`,
        'X-Flow-Actor': 'user',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return (await res.json()) as { ok: boolean }
  }
  return { home, ledger, wakeId, calls, logs, until, reply }
}

/** 唤醒结束后核对：绑定参数、token 只以文件交给 MCP，文件已删除，日志、结果、活动、账本都不含 token。 */
function checkSecrecy(s: Awaited<ReturnType<typeof setup>>, extraArgs: string[] = []) {
  expect(s.calls).toHaveLength(1)
  const call = s.calls[0] as McpCall
  expect(call.args.slice(-6 - extraArgs.length)).toEqual([
    '--actor',
    'supervisor',
    '--workspace',
    WS,
    '--task',
    s.wakeId,
    ...extraArgs,
  ])
  expect(call.env.FLOW_WORKSPACE).toBe(WS)
  expect(call.env.FLOW_TASK_ID).toBe(s.wakeId)
  const tokenFile = call.env[HUB_TOKEN_FILE_ENV] as string
  // `<task>.<lease_id>.token`：按租约区分文件。
  expect(dirname(tokenFile)).toBe(wakeTokenDir(s.home))
  expect(basename(tokenFile).startsWith(`${s.wakeId}.l-`)).toBe(true)
  expect(tokenFile.endsWith('.token')).toBe(true)
  expect(call.fileMode).toBe(0o600)
  expect(call.dirMode).toBe(0o700)
  // 任务结束后文件已删除。
  expect(existsSync(tokenFile)).toBe(false)
  // argv、MCP env、会话 env 都不含 token 与 token 变量。
  expect(JSON.stringify([call.args, call.env, call.sessionEnv])).not.toContain('fwk_')
  expect(call.env).not.toHaveProperty('FLOW_HUB_TOKEN')
  expect(call.sessionEnv).not.toHaveProperty('FLOW_HUB_TOKEN')
  expect(call.sessionEnv).not.toHaveProperty(HUB_TOKEN_FILE_ENV)
  // 节点日志、唤醒任务的结果与活动（账本事件）都不含 token。
  expect(s.logs.join('\n')).not.toContain('fwk_')
  const ledgerText = JSON.stringify([s.ledger.taskEvents(s.wakeId), s.ledger.getTask(s.wakeId)])
  expect(ledgerText).not.toContain('fwk_')
  return call
}

/** 经唤醒 token 建出的子任务。 */
function checkChild(s: Awaited<ReturnType<typeof setup>>) {
  const call = checkSecrecy(s)
  expect(call.result?.ok).toBe(true)
  const child = call.result?.data?.task as TaskView
  // 子任务由 supervisor（中枢按唤醒 token 认定）创建，parent 由 MCP 自动填为唤醒任务，origin 继承 instruction。
  expect(child.created_by).toBe('supervisor')
  expect(child.contract.parent).toBe(s.wakeId)
  expect(child.origin).toBe('instruction')
  expect(s.ledger.getTask(child.id)?.workspace).toBe(WS)
  expect(JSON.stringify(s.ledger.taskEvents(child.id))).not.toContain('fwk_')
}

describe('supervisor 唤醒经 wake token 建子任务（2.6、4.1、5.3）', () => {
  test('启用 supervisor task.create auto 规则：唤醒直接建出子任务', async () => {
    const s = await setup((t) => {
      expect(t).toContain(RULE)
      return t.replace(RULE, RULE.replaceAll('# ', '').replaceAll('#   ', '  '))
    })
    await s.until(() => s.ledger.getTask(s.wakeId)?.status === 'done', 'done')
    expect(s.ledger.taskEvents(s.wakeId).map((e) => e.type)).not.toContain('task.blocked')
    checkChild(s)
  }, 30_000)

  test('未启用（模板原样）：task_create 进入审批，用户批准后建出子任务', async () => {
    const s = await setup((t) => t)
    await s.until(() => s.ledger.getTask(s.wakeId)?.status === 'blocked', 'blocked')
    expect(s.ledger.getTask(s.wakeId)?.blocked?.reason).toBe('awaiting_approval')
    expect(s.calls).toHaveLength(0)
    expect((await s.reply({ kind: 'approve' })).ok).toBe(true)
    await s.until(() => s.ledger.getTask(s.wakeId)?.status === 'done', 'done')
    checkChild(s)
  }, 30_000)

  test('reply 唤醒：MCP 本地以 --reply-only 拒绝 task_create，绕过本地直接调中枢也返回 reply_only_wake', async () => {
    const s = await setup((t) => t, 'reply')
    await s.until(() => s.ledger.getTask(s.wakeId)?.status === 'done', 'done')
    const call = checkSecrecy(s, ['--reply-only'])
    expect(call.result).toMatchObject({ ok: false, error: { code: 'reply_only_wake' } })
    expect(call.direct).toMatchObject({ ok: false, error: { code: 'reply_only_wake' } })
  }, 30_000)
})
