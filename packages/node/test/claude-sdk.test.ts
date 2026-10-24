import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { type DeliveredReply, ok, type Result, type Role, type TaskContract } from '@flow/core'
import { DEFAULT_ROLE_FILES } from '../../core/src/role-templates.ts'
import {
  type ClaudeQueryFn,
  type ClaudeSdkExecutorOptions,
  classifyClaudeSdk,
  createClaudeSdkExecutor,
  type ExecutorOutcome,
  type NodeClock,
  summarizeToolInput,
  systemClock,
} from '../src/index.ts'
import { type Bench, bench } from './harness.ts'

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
  ask(tool: string, input: Record<string, unknown>): Promise<PermissionResult | null>
}
type Script = (io: MockIO) => AsyncGenerator<SDKMessage, void>

interface MockState {
  calls: Options[]
  prompts: string[]
  permissions: Array<PermissionResult | null>
  closed: number
  executed: string[]
}

function mockSdk(script: Script): { query: ClaudeQueryFn; state: MockState } {
  const state: MockState = { calls: [], prompts: [], permissions: [], closed: 0, executed: [] }
  let n = 0
  const query: ClaudeQueryFn = ({ prompt, options }) => {
    state.calls.push(options)
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
      async ask(tool, input) {
        const canUseTool = options.canUseTool
        if (!canUseTool) throw new Error('没有 canUseTool')
        n++
        const r = await canUseTool(tool, input, {
          signal: options.abortController?.signal ?? new AbortController().signal,
          toolUseID: `tu-${n}`,
          requestId: `rq-${n}`,
        })
        state.permissions.push(r)
        if (r?.behavior === 'allow') state.executed.push(String(r.updatedInput?.command ?? tool))
        return r
      },
    }
    const gen = script(io)
    return {
      [Symbol.asyncIterator]: () => gen,
      close() {
        state.closed++
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
      expect(rev?.permissionMode).toBe('auto')
      expect(rev?.allowedTools).toEqual([
        'Read',
        'Glob',
        'Grep',
        'Bash(gh pr comment:*)',
        'Bash(gh pr review:*)',
        'mcp__flow',
      ])
      expect(rev?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
      expect(String((rev?.systemPrompt as { append?: string } | undefined)?.append)).toContain(
        '只读检查 PR',
      )
      expect(rev?.mcpServers?.flow).toEqual({
        type: 'stdio',
        command: 'bun',
        args: ['/x/flow.ts', 'mcp', '--actor', 'reviewer'],
        env: { FLOW_HOME: home },
      })
      expect(plain?.model).toBe('claude-opus-5-5')
      expect(plain?.permissionMode).toBe('auto')
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
    expect(state.calls[0]?.allowedTools).toContain('mcp__flow')
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
    const pumped = (async () => {
      for await (const _ of run.activity) {
      }
    })()
    // 等 canUseTool 挂起。
    for (let i = 0; i < 50 && state.calls.length === 0; i++) await Bun.sleep(1)
    await Bun.sleep(5)
    const approve: DeliveredReply = { reply_id: 'r-a', kind: 'approve', by: 'user' }
    expect(await run.deliver?.(approve)).toBe('delivered')
    expect(await run.deliver?.(approve)).toBe('delivered')
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
