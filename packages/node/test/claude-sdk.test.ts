import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  type DeliveredReply,
  ok,
  operations,
  type Result,
  type Role,
  type TaskContract,
  taskResult,
} from '@flow/core'
import { DEFAULT_ROLE_FILES } from '../../core/src/role-templates.ts'
import {
  type ClaudeQueryFn,
  type ClaudeSdkExecutorOptions,
  classifyClaudeSdk,
  createClaudeSdkExecutor,
  type ExecutorOutcome,
  FLOW_MCP_AUTO_ALLOWED,
  type NodeClock,
  projectInstructions,
  summarizeToolInput,
  systemClock,
} from '../src/index.ts'
import { type Bench, bench, ManualClock } from './harness.ts'
import { waitFor } from './wait.ts'

/**
 * claude-sdk 执行器（add-m1-executors 3.1 / 3.2；executor-claude-sdk spec 全部场景）。
 * SDK 的 `query()` 换成模拟实现：脚本以异步生成器产出 SDK 消息，读取流式输入，调用 canUseTool。
 * 绝不加载真实 SDK、绝不调用 Claude。
 */

// ---------------------------------------------------------------------------
// 模拟 SDK
// ---------------------------------------------------------------------------

interface MockIO {
  options: Options
  /** 读取流式输入的下一条用户消息（文本）；输入关闭时为 undefined。 */
  nextUser(): Promise<string | undefined>
  /** 以 SDK 的方式调用 canUseTool。 */
  ask(
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionResult | null>
}
type Script = (io: MockIO) => AsyncGenerator<SDKMessage, void>

interface MockState {
  calls: Options[]
  prompts: string[]
  permissions: Array<PermissionResult | null>
  closed: number
  executed: string[]
  /** 调用顺序：abort（abortController 被中止）、end（脚本结束）、close。 */
  events: string[]
}

function mockSdk(script: Script): { query: ClaudeQueryFn; state: MockState } {
  const state: MockState = {
    calls: [],
    prompts: [],
    permissions: [],
    closed: 0,
    executed: [],
    events: [],
  }
  let n = 0
  const query: ClaudeQueryFn = ({ prompt, options }) => {
    state.calls.push(options)
    options.abortController?.signal.addEventListener('abort', () => state.events.push('abort'))
    const it = prompt[Symbol.asyncIterator]()
    const io: MockIO = {
      options,
      async nextUser() {
        const r = await it.next()
        if (r.done) return undefined
        const msg = r.value as SDKUserMessage
        const c = msg.message.content
        const t = typeof c === 'string' ? c : JSON.stringify(c)
        state.prompts.push(t)
        return t
      },
      async ask(tool, input, signal) {
        const canUseTool = options.canUseTool
        if (!canUseTool) throw new Error('没有 canUseTool')
        n++
        const r = await canUseTool(tool, input, {
          signal: signal ?? options.abortController?.signal ?? new AbortController().signal,
          toolUseID: `tu-${n}`,
          requestId: `rq-${n}`,
        })
        state.permissions.push(r)
        if (r?.behavior === 'allow') state.executed.push(String(r.updatedInput?.command ?? tool))
        return r
      },
    }
    const inner = script(io)
    const gen = (async function* () {
      try {
        yield* inner
      } finally {
        state.events.push('end')
      }
    })()
    return {
      [Symbol.asyncIterator]: () => gen,
      close() {
        state.closed++
        state.events.push('close')
      },
    }
  }
  return { query, state }
}

const SID = 's-review-1'
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage
const init = (sid = SID) =>
  msg({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    model: 'claude-opus-5-5',
    permissionMode: 'auto',
  })
const say = (text: string, sid = SID) =>
  msg({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: sid,
  })
const toolUse = (name: string, input: Record<string, unknown>, sid = SID) =>
  msg({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu', name, input }] },
    parent_tool_use_id: null,
    session_id: sid,
  })
const result = (over: Record<string, unknown> = {}) =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '（SDK 的结果文本）',
    num_turns: 3,
    duration_ms: 1200,
    duration_api_ms: 900,
    total_cost_usd: 0.42,
    usage: {},
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: 0.42,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    stop_reason: 'end_turn',
    queued_turn_count: 0,
    uuid: 'u-1',
    session_id: SID,
    ...over,
  })

// ---------------------------------------------------------------------------
// 角色与测试台
// ---------------------------------------------------------------------------

const reviewer = (permissions: Record<string, unknown> = {}): Role => ({
  name: 'reviewer',
  executor: 'claude-sdk',
  prompt: '只读审查 PR。',
  model: 'claude-opus-5-5',
  permissions: {
    permissionMode: 'auto',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(gh pr review:*)'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    ...permissions,
  },
})
const roleResolver =
  (role: Role) =>
  async (name: string): Promise<Result<Role>> =>
    name === role.name
      ? ok(role)
      : { ok: false, error: { kind: 'failure', code: 'unknown_role', message: `没有角色 ${name}` } }

/** 执行器构造时还没有测试台的虚拟时钟：用一个转发的时钟。 */
function deferredClock() {
  let target: NodeClock = systemClock
  const clock: NodeClock = {
    now: () => target.now(),
    setTimeout: (cb, ms) => target.setTimeout(cb, ms),
  }
  return { clock, set: (c: NodeClock) => (target = c) }
}

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function sdkBench(
  script: Script,
  role: Role = reviewer(),
  extra: Partial<ClaudeSdkExecutorOptions> = {},
) {
  const { query, state } = mockSdk(script)
  const dc = deferredClock()
  const executor = createClaudeSdkExecutor({
    home: '/tmp/flow-home-not-used',
    clock: dc.clock,
    query,
    resolveRole: roleResolver(role),
    ...extra,
  })
  const b = await bench({ executors: [executor] })
  dc.set(b.clock)
  current = b
  const create = (over: Record<string, unknown> = {}) =>
    b.create({
      goal: '审查 PR #42',
      role: 'reviewer',
      executor: 'claude-sdk',
      cwd: '/repo/demo',
      ...over,
    })
  return { b, state, create }
}

const reply = (b: Bench, id: string, body: unknown) =>
  b.api<{ ok: boolean; error?: { code: string } }>('POST', `/v1/tasks/${id}/reply`, body)

const MIN = 60_000

// ---------------------------------------------------------------------------
// 按角色运行 / 注入 Flow MCP / 结果
// ---------------------------------------------------------------------------

describe('按角色运行', () => {
  test('审查一个 PR：在仓库目录运行，账本可见活动，结果含审查摘要、会话 id 与费用', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield init()
      yield toolUse('Bash', { command: 'gh pr diff 42' })
      yield say('正在阅读 diff')
      yield say('审查结论：改动正确，建议补一条回归测试。')
      yield result()
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'done')
    expect(t.result).toMatchObject({
      summary: '审查结论：改动正确，建议补一条回归测试。',
      executor: 'claude-sdk',
      session: SID,
      cost: {
        usd: 0.42,
        turns: 3,
        duration_ms: 1200,
        input_tokens: 115,
        output_tokens: 50,
      },
    })
    const texts = b.ledger.taskActivity(id).map((a) => a.text ?? '')
    expect(texts).toContain('→ Bash：gh pr diff 42')
    expect(texts).toContain('正在阅读 diff')
    expect(texts.some((x) => x.includes(`Claude 会话 ${SID} 已启动`))).toBe(true)

    const o = state.calls[0]
    expect(o?.cwd).toBe('/repo/demo')
    // 子进程环境来自节点（executorEnv），不含中枢凭证。
    expect(o?.env?.PATH).toBe(process.env.PATH)
    expect(o?.env?.FLOW_ACTOR).toBe('reviewer')
    expect(o?.env && 'FLOW_HUB_TOKEN' in o.env).toBe(false)
    expect(o?.model).toBe('claude-opus-5-5')
    expect(o?.settingSources).toEqual(['project'])
    expect(o?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '只读审查 PR。',
    })
    expect(o?.permissionMode).toBe('auto')
    expect(o?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
    expect(o?.allowedTools).toContain('Bash(gh pr review:*)')
    expect(o?.resume).toBeUndefined()
    // 首条用户消息是任务说明。
    expect(state.prompts[0]).toContain('审查 PR #42')
    expect(state.prompts[0]).toContain('/repo/demo')
  })

  test('默认 reviewer 角色模板：权限模式、允许与禁止列表原样传给 SDK，模型默认 claude-opus-5-5', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flow-claude-sdk-'))
    try {
      const dir = join(home, 'config', 'roles')
      mkdirSync(dir, { recursive: true })
      for (const name of ['reviewer.yaml', 'reviewer.md']) {
        writeFileSync(join(dir, name), DEFAULT_ROLE_FILES[name] ?? '')
      }
      // 去掉 model 的变体，验证默认模型。
      writeFileSync(
        join(dir, 'plain.yaml'),
        'name: plain\nexecutor: claude-sdk\nprompt: 只看不改。\n',
      )
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        yield say('好')
        yield result()
      })
      const ex = createClaudeSdkExecutor({ home, query, flowCommand: ['bun', '/x/flow.ts'] })
      for (const role of ['reviewer', 'plain']) {
        const run = ex.run(contract({ role }), ctx())
        for await (const _ of run.activity) {
        }
        const r = await run.done
        expect(r.ok && r.data.outcome).toBe('done')
      }
      const [rev, plain] = state.calls
      expect(rev?.model).toBe('claude-opus-5-5')
      expect(rev?.permissionMode).toBe('default')
      expect(rev?.settingSources).toEqual([])
      expect(rev?.allowedTools).toEqual([
        'Read',
        'Glob',
        'Grep',
        'Bash(gh pr comment:*)',
        'Bash(gh pr review:*)',
        ...FLOW_MCP_AUTO_ALLOWED.map((n) => `mcp__flow__${n}`),
      ])
      expect(rev?.disallowedTools).toEqual(['NotebookEdit'])
      expect(rev?.hooks?.PreToolUse).toHaveLength(1)
      expect(String((rev?.systemPrompt as { append?: string } | undefined)?.append)).toContain(
        '可以新建或修改文档文件',
      )
      expect(rev?.mcpServers?.flow).toEqual({
        type: 'stdio',
        command: 'bun',
        args: ['/x/flow.ts', 'mcp', '--actor', 'reviewer'],
        env: { FLOW_HOME: home },
      })
      expect(plain?.model).toBe('claude-opus-5-5')
      // 角色没写：默认 default，设置来源默认 ['project']。
      expect(plain?.permissionMode).toBe('default')
      expect(plain?.settingSources).toEqual(['project'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('角色不存在或 permissions 不合法：任务 failed，不启动 SDK', async () => {
    const { query, state } = mockSdk(async function* () {})
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer({ permissionMode: 'yolo' })),
    })
    const a = await ex.run(contract({ role: 'ghost' }), ctx()).done
    expect(a.ok && a.data.outcome === 'failed' && a.data.result.reason).toBe('unknown_role')
    const b2 = await ex.run(contract(), ctx()).done
    expect(b2.ok && b2.data.outcome === 'failed' && b2.data.result.reason).toBe('invalid_role')
    expect(state.calls).toHaveLength(0)
  })
})

describe('注入 Flow MCP', () => {
  test('worker 写 journal：flow MCP 以 --actor <角色名> 启动，操作者是 reviewer，工具默认放行', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield toolUse('mcp__flow__kb_journal', { text: '审查了 PR #42' })
      yield say('已记录 journal')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'done')
    const flow = state.calls[0]?.mcpServers?.flow
    expect(flow).toMatchObject({
      type: 'stdio',
      command: 'flow',
      args: ['mcp', '--actor', 'reviewer'],
    })
    const allowed = state.calls[0]?.allowedTools ?? []
    expect(allowed).toContain('mcp__flow__kb_journal')
    // 不再整体放行 flow 服务；创建、取消任务等不在清单里。
    expect(allowed).not.toContain('mcp__flow')
    for (const tool of ['task_create', 'task_cancel', 'task_reply', 'kb_proposals_accept']) {
      expect(allowed).not.toContain(`mcp__flow__${tool}`)
    }
  })

  test('放行清单与 flow 的实际工具名一致', () => {
    const names = new Set(operations.map((op) => op.name))
    for (const n of FLOW_MCP_AUTO_ALLOWED) expect(names.has(n)).toBe(true)
  })

  test('worker 创建任务需要审批：task_create 进 canUseTool，批准前不创建', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      const r = await io.ask('mcp__flow__task_create', { role: 'dev', goal: '改 main' })
      yield say(r?.behavior === 'allow' ? '已创建' : '未创建')
      yield result()
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    expect(t.blocked?.message).toContain('mcp__flow__task_create')
    expect(state.executed).toEqual([])
    await reply(b, id, { kind: 'deny', text: '不允许' })
    const done = await b.until(id, (t) => t.status === 'done')
    expect(done.result?.summary).toBe('未创建')
  })
})

describe('结果', () => {
  test('轮次耗尽：任务 failed，原因注明轮次上限', async () => {
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('还在看')
      yield result({ subtype: 'error_max_turns', num_turns: 30, errors: [] })
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'failed')
    expect(t.result?.reason).toBe('max_turns')
    expect(t.result?.summary).toContain('最大轮次上限')
    expect(t.result?.session).toBe(SID)
  })

  test('SDK 报告执行错误：failed(sdk_error)，摘要附带错误', async () => {
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield result({ subtype: 'error_during_execution', errors: ['API 不可用'] })
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'failed')
    expect(t.result?.reason).toBe('sdk_error')
    expect(t.result?.summary).toContain('API 不可用')
  })

  test('Claude 进程异常（迭代器抛错）：blocked(crashed)', async () => {
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('开始')
      throw new Error('Claude Code process exited with code 1')
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.reason).toBe('crashed')
    expect(t.blocked?.message).toContain('exited with code 1')
  })

  test('取消：abortController 被中止并调用 close()，任务 cancelled', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('开始')
      await io.ask('Bash', { command: 'make deploy' })
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    await b.api('POST', `/v1/tasks/${id}/cancel`, {})
    await b.until(id, (t) => t.status === 'cancelled', 2 * MIN)
    expect(state.closed).toBeGreaterThanOrEqual(1)
    expect(state.calls[0]?.abortController?.signal.aborted).toBe(true)
    expect(state.executed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 工具审批挂起等待
// ---------------------------------------------------------------------------

describe('工具审批挂起等待', () => {
  test('带 path 的 MCP 工具仍等待现有审批，不能被未知文件工具兜底拒绝或自动放行', async () => {
    const { b, state, create } = await sdkBench(
      async function* (io) {
        await io.nextUser()
        await io.ask('mcp__external__read', { path: 'docs/review.md' })
        yield result()
      },
      reviewer({ writable_paths: ['**/*.md'] }),
    )
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    expect(state.executed).toEqual([])
    await reply(b, id, { kind: 'approve' })
    await b.until(id, (t) => t.status === 'done')
    expect(state.permissions[0]).toMatchObject({ behavior: 'allow' })
  })

  test('writable_paths 先于策略与用户审批：文档直接放行，其余写入直接拒绝', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'flow-reviewer-docs-'))
    let prechecks = 0
    try {
      const { query, state } = mockSdk(async function* (io) {
        await io.nextUser()
        for (const path of [
          'docs/reviews/new.md',
          'src/design.mdx',
          'src/code.ts',
          '../outside.md',
        ]) {
          await io.ask('Write', { file_path: path })
        }
        await io.ask('NotebookEdit', { notebook_path: 'docs/review.ipynb' })
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home: repo,
        query,
        resolveRole: roleResolver(
          reviewer({
            disallowedTools: ['NotebookEdit'],
            writable_paths: ['docs/**', '**/*.md', '**/*.mdx'],
          }),
        ),
      })
      const run = ex.run(
        contract(),
        ctx({
          cwd: repo,
          precheck: async () => {
            prechecks++
            return { allow: true, level: 'auto', actions: ['file.write'] }
          },
        }),
      )
      const r = await run.done
      expect(r.ok && r.data.outcome).toBe('done')
      expect(state.permissions.map((p) => p?.behavior)).toEqual([
        'allow',
        'allow',
        'deny',
        'deny',
        'deny',
      ])
      expect(prechecks).toBe(0)
      // 允许工具不等于实际写入，不能据此生成产物。
      expect(r.ok && 'result' in r.data && r.data.result?.artifacts).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('SDK 提前放行时 PreToolUse 仍执行边界；只将成功的文件操作去重写入 artifacts', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'flow-reviewer-hooks-'))
    try {
      const { query } = mockSdk(async function* (io) {
        await io.nextUser()
        const pre = io.options.hooks?.PreToolUse?.[0]?.hooks[0]
        const post = io.options.hooks?.PostToolUse?.[0]?.hooks[0]
        if (!pre || !post) throw new Error('缺少文件工具 hooks')
        expect(io.options.hooks?.PreToolUse?.[0]?.matcher).toBe('.*')
        const base = {
          session_id: SID,
          transcript_path: '',
          cwd: '/sdk-changed-cwd',
          tool_use_id: 'write-1',
        }
        const opts = { signal: new AbortController().signal }
        for (const [name, path, decision] of [
          ['Write', 'docs/review.md', 'allow'],
          ['Edit', 'src/code.ts', 'deny'],
          ['MultiEdit', '.git/report.md', 'deny'],
          ['NotebookEdit', 'docs/review.md', 'deny'],
          ['FutureWrite', 'docs/review.md', 'deny'],
          ['Write', 'docs/AGENTS.md', 'deny'],
        ]) {
          const r = await pre(
            {
              ...base,
              hook_event_name: 'PreToolUse',
              tool_name: name as string,
              tool_input: { file_path: path },
            },
            'write-1',
            opts,
          )
          expect(r).toMatchObject({ hookSpecificOutput: { permissionDecision: decision } })
          if (decision === 'allow')
            expect(r).toMatchObject({
              hookSpecificOutput: {
                updatedInput: {
                  file_path: join(realpathSync(repo), 'docs/review.md'),
                },
              },
            })
        }
        for (const tool_name of ['Read', 'Glob', 'Grep', 'LSP', 'mcp__external__read']) {
          expect(
            await pre(
              {
                ...base,
                hook_event_name: 'PreToolUse',
                tool_name,
                tool_input: { path: 'docs/review.md' },
              },
              'read-1',
              opts,
            ),
          ).toEqual({})
        }
        const input = {
          ...base,
          hook_event_name: 'PostToolUse' as const,
          tool_name: 'Write',
          tool_input: { file_path: join(realpathSync(repo), 'docs/review.md') },
          tool_response: { success: true },
        }
        // 模拟成功工具的 PostToolUse；拒绝、失败及仅批准的调用没有此事件。
        await post(input, 'write-1', opts)
        await post(input, 'write-1', opts)
        yield result()
      })
      const ex = createClaudeSdkExecutor({
        home: repo,
        query,
        resolveRole: roleResolver(
          reviewer({
            permissionMode: 'bypassPermissions',
            allowedTools: ['Edit', 'Write'],
            disallowedTools: ['NotebookEdit'],
            writable_paths: ['docs/**', '**/*.md', '**/*.mdx'],
          }),
        ),
      })
      const r = await ex.run(contract(), ctx({ cwd: repo })).done
      expect(r.ok && r.data.outcome).toBe('done')
      expect(r.ok && 'result' in r.data && r.data.result?.artifacts).toEqual([
        { kind: 'file', ref: join(realpathSync(repo), 'docs/review.md') },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('审批后继续：不在允许列表的 Bash 命令 → blocked(awaiting_approval) → --approve → 命令执行、回到 running', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('需要跑一下测试')
      const r = await io.ask('Bash', { command: 'bun test --coverage' })
      yield say(r?.behavior === 'allow' ? '测试通过' : '没能运行测试')
      yield result()
    })
    const id = await create()
    const blocked = await b.until(id, (t) => t.status === 'blocked')
    expect(blocked.blocked).toMatchObject({
      reason: 'awaiting_approval',
      lease_held: true,
      session: SID,
    })
    expect(blocked.blocked?.message).toContain('bun test --coverage')
    expect(blocked.blocked?.tail?.some((l) => l.includes('bun test --coverage'))).toBe(true)

    expect((await reply(b, id, { kind: 'approve' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual(['bun test --coverage'])
    expect(state.permissions[0]).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'bun test --coverage' },
    })
    expect(t.result?.summary).toBe('测试通过')
    const types = b.types(id)
    expect(types.indexOf('task.unblocked')).toBeGreaterThan(types.indexOf('task.replied'))
  })

  test('--deny 附带理由：拒绝这次调用，理由交给 Claude', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      const r = await io.ask('Bash', { command: 'git push --force' })
      yield say(r?.behavior === 'deny' ? `收到拒绝：${r.message}` : '已推送')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    expect((await reply(b, id, { kind: 'deny', text: '不要强推' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual([])
    expect(state.permissions[0]).toMatchObject({ behavior: 'deny' })
    expect((state.permissions[0] as { message: string }).message).toContain('不要强推')
    expect(t.result?.summary).toContain('不要强推')
  })

  test('审批挂起时的文字回复：拒绝这次调用，并把文字作为理由交给 Claude', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      const r = await io.ask('Bash', { command: 'rm -rf dist' })
      yield say(r?.behavior === 'deny' ? r.message : '已删除')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    expect((await reply(b, id, { kind: 'text', text: '先别删，改用 bun run clean' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual([])
    expect(t.result?.summary).toContain('改用 bun run clean')
  })

  test('连续两次审批：第一次批准后，第二次重新上报 blocked(awaiting_approval)', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', { command: 'bun install' })
      await io.ask('Bash', { command: 'bun run build' })
      yield say('构建完成')
      yield result()
    })
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'approve' })
    await b.until(
      id,
      (t) => t.status === 'blocked' && (t.blocked?.message ?? '').includes('bun run build'),
      5 * MIN,
    )
    await reply(b, id, { kind: 'approve' })
    await b.until(id, (t) => t.status === 'done')
    expect(state.executed).toEqual(['bun install', 'bun run build'])
  })

  test('审批超时：超过角色设定的时限，任务 failed(approval_timeout)', async () => {
    const { b, state, create } = await sdkBench(
      async function* (io) {
        await io.nextUser()
        await io.ask('Bash', { command: 'make release' })
        yield result()
      },
      reviewer({ approval_timeout_minutes: 3 }),
    )
    const id = await create()
    await b.until(id, (t) => t.status === 'blocked')
    const t = await b.until(id, (t) => t.status === 'failed', 10 * MIN)
    expect(t.result?.reason).toBe('approval_timeout')
    expect(t.result?.summary).toContain('make release')
    expect(state.permissions[0]).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(state.executed).toEqual([])
  })

  test('审批说明中的工具输入经脱敏、限长', async () => {
    // 运行时拼出的令牌形状文本，不是真的密钥。
    const token = ['gh', 'p_', 'A'.repeat(36)].join('')
    const { b, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', {
        command: `curl -H "Authorization: Bearer ${token}" ${'x'.repeat(3000)}`,
      })
      yield result()
    })
    const id = await create()
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.message).not.toContain(token)
    expect(t.blocked?.message).toContain('[REDACTED:')
    expect((t.blocked?.message ?? '').length).toBeLessThanOrEqual(1000)
    expect(JSON.stringify(t.blocked?.tail)).not.toContain(token)
  })
})

// ---------------------------------------------------------------------------
// 运行中的回复与会话恢复
// ---------------------------------------------------------------------------

describe('运行中的回复与会话恢复', () => {
  test('无进展后的文字回复：作为用户消息推入流式输入，Claude 接着完成', async () => {
    const { b, state, create } = await sdkBench(async function* (io) {
      await io.nextUser()
      yield say('要审查哪个提交范围？')
      const answer = await io.nextUser()
      yield say(`按回复处理：${answer}`)
      yield result()
    })
    const id = await create({ no_progress_minutes: 1 })
    const blocked = await b.until(id, (t) => t.status === 'blocked', 5 * MIN)
    expect(blocked.blocked?.reason).toBe('no_progress')
    expect((await reply(b, id, { kind: 'text', text: '只看最后两个提交' })).ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done')
    expect(state.prompts[1]).toContain('只看最后两个提交')
    expect(t.result?.summary).toContain('只看最后两个提交')
  })

  test('ctx.resume 带会话 id：用 SDK 的 resume 恢复会话，首条消息是回复本身', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('继续审查', 's-old')
      yield result({ session_id: 's-old' })
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(
      contract(),
      ctx({
        resume: {
          session: 's-old',
          reply: { reply_id: 'r-1', kind: 'text', text: '看 main 分支', by: 'user' },
        },
      }),
    )
    for await (const _ of run.activity) {
    }
    const r = await run.done
    expect(state.calls[0]?.resume).toBe('s-old')
    expect(state.prompts[0]).toContain('看 main 分支')
    expect(state.prompts[0]).not.toContain('# 任务')
    expect(r.ok && r.data.outcome === 'done' && r.data.result.session).toBe('s-old')
  })

  test('ctx.resume 没有会话 id：重新开始，任务说明后附上回复', async () => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    await ex.run(
      contract(),
      ctx({ resume: { reply: { reply_id: 'r-2', kind: 'text', text: '补充说明', by: 'user' } } }),
    ).done
    expect(state.calls[0]?.resume).toBeUndefined()
    expect(state.prompts[0]).toContain('# 任务')
    expect(state.prompts[0]).toContain('补充说明')
  })

  test('deliver 按 reply_id 幂等；结束后返回 not_running', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      await io.ask('Bash', { command: 'ls' })
      await gate
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
      reannounceMs: 60_000,
    })
    const run = ex.run(contract(), ctx())
    const outcomes: ExecutorOutcome[] = []
    let awaitingApproval = false
    const pumped = (async () => {
      for await (const a of run.activity) {
        if (a.data?.idle) awaitingApproval = true
      }
    })()
    await waitFor(() => awaitingApproval, 'canUseTool 挂起审批')
    const approve: DeliveredReply = { reply_id: 'r-a', kind: 'approve', by: 'user' }
    expect(await run.deliver?.(approve)).toBe('delivered')
    expect(await run.deliver?.(approve)).toBe('delivered')
    await waitFor(() => state.permissions.length === 1, 'SDK 收到审批结果')
    expect(state.permissions).toHaveLength(1)
    release()
    const r = await run.done
    if (r.ok) outcomes.push(r.data)
    await pumped
    expect(outcomes[0]?.outcome).toBe('done')
    expect(await run.deliver?.({ reply_id: 'r-b', kind: 'text', text: 'x', by: 'user' })).toBe(
      'not_running',
    )
  })
})

describe('权限模式与设置来源', () => {
  const runOnce = async (role: Role, cwd = '/repo/demo') => {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(role),
    })
    const r = await ex.run(contract(), ctx({ cwd })).done
    expect(r.ok && r.data.outcome).toBe('done')
    return state.calls[0]
  }

  test('角色显式写 auto / bypassPermissions：照原样传递（bypass 同时声明 allowDangerouslySkipPermissions）', async () => {
    expect((await runOnce(reviewer({ permissionMode: 'auto' })))?.permissionMode).toBe('auto')
    const bypass = await runOnce(reviewer({ permissionMode: 'bypassPermissions' }))
    expect(bypass?.permissionMode).toBe('bypassPermissions')
    expect(bypass?.allowDangerouslySkipPermissions).toBe(true)
    const { permissionMode: _drop, ...rest } = reviewer().permissions ?? {}
    const def = await runOnce({ ...reviewer(), permissions: rest })
    expect(def?.permissionMode).toBe('default')
    expect(def?.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('审查不受被审查仓库的设置影响：setting_sources 为 [] 时不加载设置，CLAUDE.md / AGENTS.md 以纯文本追加（限长、脱敏）', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'flow-claude-sdk-repo-'))
    try {
      // 运行时拼出的令牌形状文本，不是真的密钥。
      const token = ['gh', 'p_', 'B'.repeat(36)].join('')
      mkdirSync(join(repo, '.claude'))
      writeFileSync(
        join(repo, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { allow: ['Bash(*)'] } }),
      )
      writeFileSync(join(repo, 'CLAUDE.md'), `本仓库用 bun。\nCI_TOKEN=${token}\n`)
      writeFileSync(join(repo, 'AGENTS.md'), `注释用中文。\n${'长'.repeat(40_000)}`)
      const o = await runOnce(reviewer({ permissionMode: 'default', setting_sources: [] }), repo)
      expect(o?.settingSources).toEqual([])
      expect(o?.permissionMode).toBe('default')
      const append = String((o?.systemPrompt as { append?: string } | undefined)?.append)
      expect(append.startsWith('只读审查 PR。')).toBe(true)
      expect(append).toContain('本仓库用 bun。')
      expect(append).toContain('注释用中文。')
      expect(append).not.toContain(token)
      expect(append).toContain('[REDACTED:')
      expect(append).not.toContain('Bash(*)')
      expect(append.length).toBeLessThan(40_000)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('setting_sources 含 project 时不另外读取约定文件；都不存在时不追加', async () => {
    const reads: string[] = []
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
      readProjectFile: async (path) => {
        reads.push(path)
        return '不应读取'
      },
    })
    await ex.run(contract(), ctx()).done
    expect(reads).toEqual([])
    expect(state.calls[0]?.settingSources).toEqual(['project'])
    expect(await projectInstructions('/nowhere', async () => undefined)).toBeUndefined()
  })
})

describe('健壮性', () => {
  test('结果到达时输入流里还有未读取的回复：继续等下一个结果，回复不丢', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { query } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('第一轮')
      await gate
      // SDK 还没读取运行中推入的回复，就报告了这一轮的结果。
      yield result({ queued_turn_count: 0 })
      const answer = await io.nextUser()
      yield say(`第二轮：${answer}`)
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    let firstTurn = false
    const pumped = (async () => {
      for await (const a of run.activity) {
        if (a.text === '第一轮') firstTurn = true
      }
    })()
    await waitFor(() => firstTurn, 'SDK 读完首条输入并开始第一轮')
    expect(
      await run.deliver?.({ reply_id: 'r-q', kind: 'text', text: '再看 CI', by: 'user' }),
    ).toBe('delivered')
    release()
    const r = await run.done
    await pumped
    expect(r.ok && r.data.outcome === 'done' && r.data.result.summary).toContain('再看 CI')
  })

  test('审批按 tool_use_id 匹配：用户答复的请求已被中止时不套到下一条，重新上报队首', async () => {
    const clock = new ManualClock()
    const abortA = new AbortController()
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      const a = io.ask('Bash', { command: 'A' }, abortA.signal)
      const b = io.ask('Bash', { command: 'B' })
      await Promise.all([a, b])
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      clock,
      query,
      resolveRole: roleResolver(reviewer()),
      reannounceMs: 1000,
    })
    const run = ex.run(contract(), ctx())
    const idles: string[] = []
    const pumped = (async () => {
      for await (const a of run.activity) {
        const hint = a.data?.hint as { tool_use_id?: string } | undefined
        if (a.data?.idle && hint?.tool_use_id) idles.push(hint.tool_use_id)
      }
    })()
    await clock.advance(0)
    expect(idles).toEqual(['tu-1'])
    // Claude 中止了用户看到的 A；队首变成 B，但节点仍显示 A。
    abortA.abort()
    await clock.advance(0)
    expect(state.permissions[0]).toMatchObject({ behavior: 'deny', message: '已中止' })
    // 用户对 A 的批准不能落到 B 上。
    expect(await run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' })).toBe('delivered')
    expect(state.executed).toEqual([])
    // 重新上报队首 B，之后的批准才作用于 B。
    await clock.advance(1000)
    expect(idles.at(-1)).toBe('tu-2')
    expect(await run.deliver?.({ reply_id: 'r-2', kind: 'approve', by: 'user' })).toBe('delivered')
    await clock.advance(0)
    const r = await run.done
    await pumped
    expect(r.ok && r.data.outcome).toBe('done')
    expect(state.executed).toEqual(['B'])
  })

  test('stderr 末尾上报前脱敏', async () => {
    const token = ['gh', 'p_', 'C'.repeat(36)].join('')
    const { query } = mockSdk(async function* (io) {
      await io.nextUser()
      io.options.stderr?.(`auth failed: --token ${token}\nfatal`)
      yield say('启动失败')
      throw new Error('Claude Code process exited with code 1')
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    const texts: string[] = []
    for await (const a of run.activity) texts.push(a.text ?? '')
    const r = await run.done
    expect(r.ok && r.data.outcome).toBe('exited')
    expect(texts.join('\n')).not.toContain(token)
    expect(texts.some((t) => t.includes('[REDACTED:'))).toBe(true)
    expect(texts).toContain('fatal')
  })

  test('取消：先 abort，等 SDK 子进程退出后再 close（flow MCP 孙进程随之结束）', async () => {
    const clock = new ManualClock()
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('开始')
      // 模拟子进程：收到 abort 后过一会儿才退出。
      await new Promise<void>((resolve) =>
        io.options.abortController?.signal.addEventListener('abort', () =>
          clock.setTimeout(resolve, 2000),
        ),
      )
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      clock,
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    const pumped = (async () => {
      for await (const _ of run.activity) {
      }
    })()
    await clock.advance(0)
    let settled = false
    void run.done.then(() => {
      settled = true
    })
    await run.cancel()
    await clock.advance(1000)
    expect(settled).toBe(false)
    expect(state.events).toEqual(['abort'])
    await clock.advance(1000)
    const r = await run.done
    await pumped
    expect(r.ok && r.data.outcome).toBe('cancelled')
    expect(state.events).toEqual(['abort', 'end', 'close'])
  })

  test('取消：子进程 10 秒内不退出，close() 强制结束', async () => {
    const clock = new ManualClock()
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield say('开始')
      await new Promise<void>(() => {})
    })
    const ex = createClaudeSdkExecutor({
      home: '/nonexistent',
      clock,
      query,
      resolveRole: roleResolver(reviewer()),
    })
    const run = ex.run(contract(), ctx())
    void (async () => {
      for await (const _ of run.activity) {
      }
    })()
    await clock.advance(0)
    let settled = false
    void run.done.then(() => {
      settled = true
    })
    await run.cancel()
    await clock.advance(9_999)
    expect(settled).toBe(false)
    expect(state.closed).toBe(0)
    await clock.advance(1)
    const r = await run.done
    expect(r.ok && r.data.outcome).toBe('cancelled')
    expect(state.events).toEqual(['abort', 'close'])
  })

  test('结果中的 session 上限与 blocked 一致：512', () => {
    const base = { summary: 's', executor: 'claude-sdk', node_id: 'n-test' }
    expect(taskResult.safeParse({ ...base, session: 'x'.repeat(512) }).success).toBe(true)
    expect(taskResult.safeParse({ ...base, session: 'x'.repeat(513) }).success).toBe(false)
  })
})

describe('辅助函数', () => {
  test('classify 只认 idle 信号 hint 中的合法原因', () => {
    const base = { trigger: 'idle' as const, tail: [], idle_ms: 0, contract: contract() }
    expect(
      classifyClaudeSdk({
        ...base,
        hint: { reason: 'awaiting_approval', message: '等待授权：Bash', session: 's' },
      }),
    ).toEqual({ reason: 'awaiting_approval', message: '等待授权：Bash', session: 's' })
    expect(classifyClaudeSdk({ ...base, hint: { reason: 'bogus' } })).toBeNull()
    expect(classifyClaudeSdk(base)).toBeNull()
  })

  test('工具输入摘要：Bash 取命令，文件类取路径，其余取 JSON，限长', () => {
    expect(summarizeToolInput('Bash', { command: 'ls  -la\n/tmp' })).toBe('ls -la /tmp')
    expect(summarizeToolInput('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('/a/b.ts')
    expect(summarizeToolInput('Task', { prompt: 'hi' })).toBe('{"prompt":"hi"}')
    expect(summarizeToolInput('Bash', { command: 'y'.repeat(5000) }).length).toBeLessThanOrEqual(
      500,
    )
  })
})

// ---------------------------------------------------------------------------

function contract(over: Partial<TaskContract> = {}): TaskContract {
  return {
    goal: '审查 PR #42',
    workspace: 'ws/demo',
    role: 'reviewer',
    executor: 'claude-sdk',
    requires: [],
    timeout_s: 3600,
    ...over,
  }
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    taskId: 't-1',
    attempt: 1,
    cwd: '/repo/demo',
    nodeId: 'n-test',
    signal: new AbortController().signal,
    ...over,
  }
}

test('SDK 会话覆盖继承的 FLOW_ACTOR，重新过滤 token；user 角色不启动会话', async () => {
  for (const name of ['reviewer', 'user']) {
    const { query, state } = mockSdk(async function* (io) {
      await io.nextUser()
      yield result()
    })
    const ex = createClaudeSdkExecutor({
      home: '/tmp/flow-home-not-used',
      query,
      resolveRole: roleResolver({ ...reviewer(), name }),
    })
    const run = ex.run(
      contract({ role: name }),
      ctx({
        env: { FLOW_ACTOR: 'user', FLOW_HUB_TOKEN: 'must-not-reach-worker' },
      }),
    )
    const outcome = await run.done
    if (name === 'user') {
      expect(outcome).toMatchObject({
        ok: true,
        data: { outcome: 'failed', result: { reason: 'invalid_actor' } },
      })
      expect(state.calls).toHaveLength(0)
    } else {
      expect(outcome.ok && outcome.data.outcome).toBe('done')
      expect(state.calls[0]?.env).toEqual({ FLOW_ACTOR: 'reviewer' })
    }
  }
})
