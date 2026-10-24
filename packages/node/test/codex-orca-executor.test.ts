import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Activity, ok, type Result, type TaskResume, taskContract } from '@flow/core'
import { createCodexOrcaExecutor } from '../src/codex-orca/executor.ts'
import {
  ActivityQueue,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
} from '../src/index.ts'
import {
  FakeGh,
  FakeOrca,
  type OrcaHome,
  orcaHome,
  sendFixture,
  staleHandle,
  tuiFixture,
} from './codex-orca-helpers.ts'
import { bench, ManualClock } from './harness.ts'

/**
 * codex-orca 执行器的监控循环、deliver 与 cancel（add-m1-executors 2.3；executor-codex-orca spec）。
 * Orca 与 gh 都是内存中的假实现，终端内容来自真实片段 fixture；时钟是手动拨动的虚拟时钟。
 */

const POLL = 30_000
let h: OrcaHome | undefined
afterEach(() => {
  if (h) rmSync(h.root, { recursive: true, force: true })
  h = undefined
})

const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await realWait(5)
  }
  throw new Error(`等待超时：${what}`)
}

interface Started {
  run: ExecutorRun
  orca: FakeOrca
  gh: FakeGh
  clock: ManualClock
  activity: Activity[]
  abort: AbortController
  outcome: () => Result<ExecutorOutcome> | undefined
  /** 拨动一次轮询间隔。 */
  poll(n?: number): Promise<void>
}

async function start(
  over: Record<string, unknown> = {},
  prepare?: (o: FakeOrca) => void,
  extra: { home?: OrcaHome; resume?: TaskResume } = {},
) {
  h = extra.home ?? orcaHome()
  const clock = new ManualClock()
  const orca = new FakeOrca(h.worktree)
  const gh = new FakeGh()
  prepare?.(orca)
  const plugin = createCodexOrcaExecutor({
    home: h.home,
    clock,
    orca,
    gh,
    baseBranch: async () => 'origin/main',
    waitForSetup: async () => ok(undefined),
  })
  const contract = taskContract.parse({
    goal: '修正 README',
    workspace: 'ws/product-res',
    role: 'dev',
    executor: 'codex-orca',
    context: ['projects/product-res'],
    inputs: { repo: h.repo },
    ...over,
  })
  const abort = new AbortController()
  const run = plugin.run(contract, {
    taskId: 't-orca-1',
    attempt: extra.home ? 2 : 1,
    cwd: h.home,
    nodeId: 'n-test',
    signal: abort.signal,
    ...(extra.resume ? { resume: extra.resume } : {}),
  })
  const activity: Activity[] = []
  void (async () => {
    for await (const a of run.activity) activity.push(a)
  })()
  let outcome: Result<ExecutorOutcome> | undefined
  void run.done.then((o) => {
    outcome = o
  })
  const s: Started = {
    run,
    orca,
    gh,
    clock,
    activity,
    abort,
    outcome: () => outcome,
    async poll(n = 1) {
      for (let i = 0; i < n; i++) {
        const before = orca.ops('terminalRead').length
        await clock.advance(POLL)
        await until(
          () => orca.ops('terminalRead').length > before || outcome !== undefined,
          '终端读取',
        )
        await realWait(5)
        await clock.advance(0)
      }
    },
  }
  return s
}

const ready = (s: Started) =>
  until(() => s.orca.ops('terminalCreate').length > 0 || s.outcome() !== undefined, '启动 Codex')
const idles = (s: Started) => s.activity.filter((a) => a.data?.idle === true)
const sends = (s: Started) => s.orca.ops('terminalSend').map((c) => c.input)

describe('启动', () => {
  test('按任务 id 建 worktree（基于 origin/main），任务说明写入 state/tasks/<id>/spec.md，在终端启动 Codex', async () => {
    const s = await start()
    await ready(s)
    expect(s.orca.ops('worktreeCreate')[0]?.input).toEqual({
      repo: h?.repo,
      name: 't-orca-1',
      baseBranch: 'origin/main',
      setup: 'run',
      comment: 'flow 任务 t-orca-1',
    })
    const specPath = join(h?.home ?? '', 'state/tasks/t-orca-1/spec.md')
    const spec = readFileSync(specPath, 'utf8')
    expect(spec).toContain('`flow kb get projects/product-res`')
    expect(spec).toContain('example-user/t-orca-1')
    const created = s.orca.ops('terminalCreate')[0]?.input as {
      command: string
      worktreePath: string
    }
    expect(created.worktreePath).toBe(h?.worktree ?? '')
    expect(created.command).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(created.command).toContain(`"$(cat ${specPath})"`)
    const statePath = join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json')
    // 状态文件是异步写入的：等 handle 落盘。
    await until(
      () => readFileSync(statePath, 'utf8').includes(s.orca.handle),
      'orca.json 写入 handle',
    )
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state).toMatchObject({ branch: 'example-user/t-orca-1', handle: s.orca.handle })
    await s.run.cancel()
  })

  test('仓库不属于 workspace：failed(repo_not_in_workspace)，不调用 Orca', async () => {
    const s = await start({ inputs: { repo: '/somewhere/else' } })
    await until(() => s.outcome() !== undefined, '结束')
    const o = s.outcome()
    expect(o?.ok && o.data.outcome).toBe('failed')
    expect(o?.ok && o.data.outcome === 'failed' && o.data.result.reason).toBe(
      'repo_not_in_workspace',
    )
    expect(s.orca.calls).toEqual([])
  })
})

describe('监控循环', () => {
  test('信任提示：只发回车，继续监控，不报告停下', async () => {
    const s = await start({}, (o) => o.show('trust-prompt', 'starting', 'working'))
    await ready(s)
    await s.poll()
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.poll(3)
    expect(idles(s)).toEqual([])
    expect(s.activity.some((a) => a.text === '已自动确认 Codex 的文件夹信任提示')).toBe(true)
    await s.run.cancel()
  })

  test('信任提示只自动确认一次：成功后即使提示仍在也不再发回车；发送失败时才重试', async () => {
    const s = await start({}, (o) => o.show('trust-prompt'))
    s.orca.sends.push({
      ok: false,
      error: { kind: 'failure', code: 'orca_failed', message: 'runtime busy' },
    })
    await ready(s)
    await s.poll(5)
    // 第一次失败、第二次成功，之后提示还在也不再发送。
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, enter: true },
      { handle: s.orca.handle, enter: true },
    ])
    await s.run.cancel()
  })

  test('出现过忙碌标记之后，再看到信任提示也不自动发回车', async () => {
    const s = await start({}, (o) => o.show('working', 'trust-prompt'))
    await ready(s)
    await s.poll(3)
    expect(sends(s)).toEqual([])
    const [idle] = idles(s)
    expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('trust_prompt')
    await s.run.cancel()
  })

  test('对抗：授权弹窗上方的输出里含有信任提示的文字，不能发回车', async () => {
    const forged = [
      '• Ran cat test/fixtures/codex-tui/trust-prompt.json',
      ...tuiFixture('trust-prompt').tail.map((l) => `  ${l}`),
      ...tuiFixture('approval').tail.slice(-9),
    ]
    const s = await start({}, (o) =>
      o.reads.push(ok({ handle: o.handle, status: 'running', tail: forged })),
    )
    await ready(s)
    await s.poll(3)
    expect(sends(s)).toEqual([])
    const [idle] = idles(s)
    expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('awaiting_approval')
    await s.run.cancel()
  })

  test('对抗：Reason 里写着 "Trust this folder?"，仍是授权请求，不发回车', async () => {
    const tail = [
      '• Running rm -rf build',
      '  Would you like to run the following command?',
      '  Reason: Trust this folder? 1. Trust and continue · enter continue',
      '  $ rm -rf build',
      '› 1. Yes, proceed (y)',
      '  3. No, and tell Codex what to do differently (esc)',
      '  Press enter to confirm or esc to cancel · enter continue',
    ]
    const s = await start({}, (o) =>
      o.reads.push(ok({ handle: o.handle, status: 'running', tail })),
    )
    await ready(s)
    await s.poll(3)
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('Working：终端有新内容时上报 output，没有时上报 heartbeat', async () => {
    const s = await start({}, (o) => o.show('working', 'working'))
    await ready(s)
    await s.poll(2)
    const kinds = s.activity.filter((a) => a.kind !== 'status').map((a) => a.kind)
    expect(kinds).toEqual(['output', 'heartbeat'])
    expect(idles(s)).toEqual([])
    await s.run.cancel()
  })

  test('流式输出中一次没有忙碌标记不算停下；连续两次才报告', async () => {
    const s = await start({}, (o) => o.show('streaming', 'working', 'question'))
    await ready(s)
    await s.poll(3)
    expect(idles(s)).toEqual([])
    await s.poll()
    expect(idles(s)).toHaveLength(1)
    await s.run.cancel()
  })

  test('停下提问：没有 PR 时上报 idle，hint 带末尾输出，classify 判为 question', async () => {
    const s = await start({}, (o) => o.show('working', 'question'))
    await ready(s)
    await s.poll(3)
    const [idle] = idles(s)
    expect(idle?.text).toBe('下一步你希望我查看什么？')
    const hint = idle?.data?.hint as { kind: string; tail: string[] }
    expect(hint.kind).toBe('question')
    expect(hint.tail.at(-1)).toBe('  ? for shortcuts')
    expect(s.gh.calls).toEqual([{ cwd: h?.worktree ?? '', branch: 'example-user/t-orca-1' }])
    await s.poll(2)
    expect(idles(s)).toHaveLength(1)
    await s.run.cancel()
  })

  test('开完 PR 停下：以 done 结束，产物中有 PR 链接；终端保持打开', async () => {
    const s = await start({}, (o) => o.show('working', 'pr-opened'))
    s.gh.prs = [{ url: 'https://github.com/example-user/flow/pull/20', number: 20, state: 'OPEN' }]
    await ready(s)
    await s.poll(3)
    await until(() => s.outcome() !== undefined, '结束')
    const o = s.outcome()
    expect(o?.ok && o.data.outcome).toBe('done')
    if (o?.ok && o.data.outcome === 'done') {
      expect(o.data.result.artifacts[0]).toEqual({
        kind: 'pr',
        ref: 'https://github.com/example-user/flow/pull/20',
      })
      expect(o.data.result.executor).toBe('codex-orca')
    }
    expect(s.orca.ops('terminalClose')).toEqual([])
  })

  test('done 带上 workdir：验收在 worktree 中运行', async () => {
    const s = await start({}, (o) => o.show('pr-opened'))
    s.gh.prs = [{ url: 'https://github.com/example-user/flow/pull/20', number: 20, state: 'OPEN' }]
    await ready(s)
    await s.poll(2)
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({
      ok: true,
      data: { outcome: 'done', workdir: h?.worktree },
    })
  })

  test('gh 不可用：终端里有 PR 链接也不判 done，上报停下并说明 gh 不可用', async () => {
    const s = await start({}, (o) => o.show('pr-opened'))
    s.gh.error = 'gh: not logged in'
    await ready(s)
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    const [idle] = idles(s)
    expect(idle?.text).toContain('gh 不可用')
    const hint = idle?.data?.hint as Record<string, unknown>
    expect(hint.gh_error).toBe('gh: not logged in')
    const v = createCodexOrcaExecutor({ home: '/nonexistent' }).classify?.({
      trigger: 'idle',
      tail: [],
      idle_ms: 0,
      hint,
      contract: taskContract.parse({
        goal: 'g',
        workspace: 'ws/product-res',
        role: 'dev',
        executor: 'codex-orca',
      }),
    })
    expect(v?.reason).toBe('other')
    expect(v?.message).toContain('gh 不可用')
    await s.run.cancel()
  })

  test('gh 不可用且终端已退出：exited，不判 done', async () => {
    const s = await start({}, (o) =>
      o.reads.push(ok({ ...tuiFixture('pr-opened'), status: 'exited' })),
    )
    s.gh.error = 'gh: not logged in'
    await ready(s)
    await s.poll()
    await until(() => s.outcome() !== undefined, '结束')
    const o = s.outcome()
    expect(o?.ok && o.data.outcome).toBe('exited')
    expect(o?.ok && o.data.outcome === 'exited' && o.data.message).toContain('gh 不可用')
  })

  test('无输出：终端已退出且没有 PR，以 exited 结束（节点上报 crashed）', async () => {
    const s = await start({}, (o) => o.show('no-output'))
    await ready(s)
    await s.poll()
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({ ok: true, data: { outcome: 'exited', exit_code: null } })
  })

  test('handle 失效（stale）不等于终端已死：在本 worktree 找到唯一的 Codex 终端就接上', async () => {
    const replacement = 'term_00000000-0000-4000-8000-0000000000bb'
    const s = await start({}, (o) => {
      o.reads.push(staleHandle())
      o.show('question')
    })
    await ready(s)
    s.orca.terminals = ok([
      { handle: replacement, worktreePath: h?.worktree ?? '', agentIdentity: 'codex' },
      { handle: 'term_shell', worktreePath: h?.worktree ?? '' },
    ])
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    const reads = s.orca.ops('terminalRead') as Array<{ input: { handle: string } }>
    expect(reads.at(-1)?.input.handle).toBe(replacement)
    expect(idles(s)).toHaveLength(1)
    const state = JSON.parse(
      readFileSync(join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.handle).toBe(replacement)
    await s.run.cancel()
  })

  test('stale 后接管：过滤孤儿和已断开的终端，只接管进程身份一致的那个', async () => {
    const wt = () => h?.worktree ?? ''
    const s = await start({}, (o) => {
      o.identity = { ptyId: 'pty-A', incarnationId: 'inc-A' }
      o.reads.push(staleHandle())
      o.show('question')
    })
    await ready(s)
    const statePath = join(h?.home ?? '', 'state/tasks/t-orca-1/orca.json')
    await until(() => readFileSync(statePath, 'utf8').includes('inc-A'), '进程身份落盘')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      pty_id: 'pty-A',
      incarnation_id: 'inc-A',
    })
    const codex = (handle: string, extra: Record<string, unknown>) => ({
      handle,
      worktreePath: wt(),
      agentIdentity: 'codex',
      ...extra,
    })
    // 第一轮：孤儿、已断开的被过滤；剩下唯一的那个身份不一致 → 不接管。
    s.orca.terminals = ok([
      codex('term_orphan', { orphaned: true, ptyId: 'pty-A', incarnationId: 'inc-A' }),
      codex('term_gone', { connected: false, ptyId: 'pty-A', incarnationId: 'inc-A' }),
      codex('term_other', { connected: true, ptyId: 'pty-B', incarnationId: 'inc-B' }),
    ])
    await s.poll()
    const handles = () =>
      (s.orca.ops('terminalRead') as Array<{ input: { handle: string } }>).map(
        (c) => c.input.handle,
      )
    expect(handles().every((x) => x === s.orca.handle)).toBe(true)
    // 第二轮：身份一致的终端出现 → 接管。
    s.orca.reads.unshift(staleHandle())
    s.orca.terminals = ok([
      codex('term_orphan', { orphaned: true, ptyId: 'pty-A', incarnationId: 'inc-A' }),
      codex('term_same', { connected: true, ptyId: 'pty-A', incarnationId: 'inc-A' }),
    ])
    await s.poll(2)
    expect(handles().at(-1)).toBe('term_same')
    expect(JSON.parse(readFileSync(statePath, 'utf8')).handle).toBe('term_same')
    await s.run.cancel()
  })

  test('handle 失效且找不到替代：按临时错误继续重试，不判退出；deliver 抛出而不是 not_running', async () => {
    const s = await start({}, (o) => {
      o.reads.push(staleHandle())
    })
    s.orca.terminals = ok([])
    await ready(s)
    await s.poll(3)
    expect(s.outcome()).toBeUndefined()
    await expect(
      s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: 'x', by: 'user' }) ??
        Promise.resolve('none'),
    ).rejects.toThrow()
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('报告停下后 Codex 自行恢复（用户直接在终端里答复）：上报 resumed', async () => {
    const s = await start({}, (o) => o.show('question', 'question', 'working'))
    await ready(s)
    await s.poll(3)
    expect(idles(s)).toHaveLength(1)
    expect(s.activity.some((a) => a.data?.resumed === true)).toBe(true)
    await s.run.cancel()
  })
})

describe('deliver 与 cancel', () => {
  test('回复提问：文字加回车送进终端，按 reply_id 幂等', async () => {
    const s = await start({}, (o) => o.show('question'))
    await ready(s)
    await s.poll(2)
    const reply = { reply_id: 'r-1', kind: 'text' as const, text: '用方案 A\n谢谢', by: 'user' }
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '用方案 A 谢谢', enter: true, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('没有观察到这一轮开始：用同一个 request id 复核，不重发', async () => {
    const s = await start({}, (o) => {
      o.show('question')
      o.sends.push(ok(sendFixture('terminal-send-no-turn')), ok(sendFixture('terminal-send-retry')))
    })
    await ready(s)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: '继续', by: 'user' })).toBe(
      'delivered',
    )
    const id = '00000000-0000-4000-8000-000000000003'
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '继续', enter: true, waitSubmitS: 10 },
      { handle: s.orca.handle, text: '继续', enter: true, retryRequest: id, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('复核两次仍未开始：补发一次回车', async () => {
    const noTurn = ok(sendFixture('terminal-send-no-turn'))
    const s = await start({}, (o) => {
      o.show('question')
      o.sends.push(noTurn, noTurn, noTurn)
    })
    await ready(s)
    await s.poll(2)
    await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: '继续', by: 'user' })
    const all = sends(s) as Array<{ text?: string; retryRequest?: string }>
    expect(all).toHaveLength(4)
    expect(all.filter((x) => x.text !== undefined && !x.retryRequest)).toHaveLength(1)
    expect(all.at(-1) as unknown).toEqual({ handle: s.orca.handle, enter: true })
    await s.run.cancel()
  })

  test('送达失败抛出后重送：已拿到的 request id 用于复核，Codex 不会收到第二次', async () => {
    const s = await start({}, (o) => {
      o.show('question')
      o.sends.push(
        ok(sendFixture('terminal-send-no-turn')),
        { ok: false, error: { kind: 'failure', code: 'orca_failed', message: 'runtime down' } },
        { ok: false, error: { kind: 'failure', code: 'orca_failed', message: 'runtime down' } },
        { ok: false, error: { kind: 'failure', code: 'orca_failed', message: 'runtime down' } },
      )
    })
    await ready(s)
    await s.poll(2)
    const reply = { reply_id: 'r-1', kind: 'text' as const, text: '继续', by: 'user' }
    // 两次复核失败后补发回车也失败：仍视为已送达（输入已被接受）。
    expect(await s.run.deliver?.(reply)).toBe('delivered')
    const fresh = (sends(s) as Array<{ text?: string; retryRequest?: string }>).filter(
      (x) => x.text !== undefined && !x.retryRequest,
    )
    expect(fresh).toHaveLength(1)
    await s.run.cancel()
  })

  test('批准授权请求：只发回车', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await ready(s)
    await s.poll(2)
    const [idle] = idles(s)
    expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('awaiting_approval')
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.run.cancel()
  })

  test('拒绝授权请求：先发 Esc，再把理由作为新一轮发出', async () => {
    const s = await start({}, (o) => o.show('approval'))
    await ready(s)
    await s.poll(2)
    const p = s.run.deliver?.({ reply_id: 'r-1', kind: 'deny', text: '不要写 /tmp', by: 'user' })
    await until(() => sends(s).length > 0, 'Esc')
    await s.clock.advance(1_000)
    expect(await p).toBe('delivered')
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '\u001b' },
      { handle: s.orca.handle, text: '不同意：不要写 /tmp', enter: true, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('送达后 Codex 回答完又停下：再次报告停下', async () => {
    const s = await start({}, (o) =>
      o.show('question', 'question', 'question', 'working', 'question'),
    )
    await ready(s)
    await s.poll(2)
    expect(idles(s)).toHaveLength(1)
    await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: '看 README', by: 'user' })
    await s.poll(4)
    expect(idles(s)).toHaveLength(2)
    await s.run.cancel()
  })

  test('deliver 按实时的末尾判断：轮询时是提问、送达时已是授权弹窗，批准只发回车', async () => {
    const s = await start({}, (o) => o.show('question', 'question', 'approval'))
    await ready(s)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    expect(sends(s)).toEqual([{ handle: s.orca.handle, enter: true }])
    await s.run.cancel()
  })

  test('deliver 按实时的末尾判断：轮询时是授权弹窗、送达时弹窗已不在，批准作为文字发出，不按回车', async () => {
    const s = await start({}, (o) => o.show('approval', 'approval', 'question'))
    await ready(s)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'approve', by: 'user' })).toBe(
      'delivered',
    )
    expect(sends(s)).toEqual([
      { handle: s.orca.handle, text: '同意，请继续。', enter: true, waitSubmitS: 10 },
    ])
    await s.run.cancel()
  })

  test('deliver 时终端已退出：not_running', async () => {
    const s = await start({}, (o) => o.show('question', 'question', 'no-output'))
    await ready(s)
    await s.poll(2)
    expect(await s.run.deliver?.({ reply_id: 'r-1', kind: 'text', text: 'x', by: 'user' })).toBe(
      'not_running',
    )
    expect(sends(s)).toEqual([])
    await s.run.cancel()
  })

  test('送达记录持久化：节点重启后同一个 reply_id 不再送进终端', async () => {
    const reply = { reply_id: 'r-1', kind: 'text' as const, text: '用方案 A', by: 'user' }
    const first = await start({}, (o) => o.show('question'))
    await ready(first)
    await first.poll(2)
    expect(await first.run.deliver?.(reply)).toBe('delivered')
    const home = h
    if (!home) throw new Error('no home')
    // 模拟节点重启：终端不关闭，第一次执行直接被丢弃，新的执行从 orca.json 恢复。
    const state = JSON.parse(
      readFileSync(join(home.home, 'state/tasks/t-orca-1/orca.json'), 'utf8'),
    )
    expect(state.replies['r-1']).toMatchObject({ done: true })

    const second = await start({}, (o) => o.show('question'), { home, resume: { reply } })
    await until(
      () => second.activity.some((a) => a.text?.includes('接着使用已有的终端')),
      '复用终端',
    )
    await realWait(20)
    expect(await second.run.deliver?.(reply)).toBe('delivered')
    expect(sends(second)).toEqual([])
    expect(second.orca.ops('terminalCreate')).toEqual([])
    await second.run.cancel()
  })

  test('复用记录中的 handle 前确认它属于这个 worktree；不属于时新建终端', async () => {
    const first = await start({}, (o) => o.show('working'))
    await ready(first)
    const home = h
    if (!home) throw new Error('no home')
    const statePath = join(home.home, 'state/tasks/t-orca-1/orca.json')
    await until(() => readFileSync(statePath, 'utf8').includes(first.orca.handle), 'handle 落盘')
    const second = await start(
      {},
      (o) => {
        o.show('working')
        o.terminals = ok([{ handle: o.handle, worktreePath: '/elsewhere', agentIdentity: 'codex' }])
      },
      { home },
    )
    await ready(second)
    // 记录中的 handle 经 terminal list 校验后被拒绝，才新建终端。
    expect(second.orca.ops('terminalList')).toHaveLength(1)
    expect(second.orca.ops('terminalCreate')).toHaveLength(1)
    await first.run.cancel()
    await second.run.cancel()
  })

  test('取消：关闭终端，worktree 保留；之后 deliver 返回 not_running', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    await s.poll()
    await s.run.cancel()
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({ ok: true, data: { outcome: 'cancelled' } })
    expect(s.orca.ops('terminalClose')).toEqual([
      { op: 'terminalClose', input: { handle: s.orca.handle } },
    ])
    expect(s.orca.ops('worktreeRm')).toEqual([])
    expect(existsSync(h?.worktree ?? '')).toBe(true)
    expect(await s.run.deliver?.({ reply_id: 'r-9', kind: 'text', text: 'x', by: 'user' })).toBe(
      'not_running',
    )
  })

  test('节点的取消信号同样关闭终端', async () => {
    const s = await start({}, (o) => o.show('working'))
    await ready(s)
    s.abort.abort()
    await until(() => s.outcome() !== undefined, '结束')
    expect(s.outcome()).toMatchObject({ ok: true, data: { outcome: 'cancelled' } })
    expect(s.orca.ops('terminalClose')).toHaveLength(1)
  })
})

describe('验收目录（PR #24 审查第 3 条）', () => {
  test('执行器在 done 中给出 workdir 时，验收命令在 workdir 中运行，而不是合同的 cwd', async () => {
    h = orcaHome()
    const workdir = h.worktree
    mkdirSync(workdir, { recursive: true })
    const plugin: ExecutorPlugin = {
      type: 'codex-orca',
      mode: 'interactive',
      run: (_c, ctx) => {
        const queue = new ActivityQueue()
        queue.close()
        return {
          activity: queue,
          done: Promise.resolve(
            ok({
              outcome: 'done' as const,
              workdir,
              result: {
                summary: 'ok',
                artifacts: [],
                verify: [],
                executor: 'codex-orca',
                node_id: ctx.nodeId,
              },
            }),
          ),
          cancel: async () => {},
        }
      },
    }
    const b = await bench({ executors: [plugin] })
    try {
      const id = await b.create({
        executor: 'codex-orca',
        cwd: h.repo,
        verify: [{ cmd: [process.execPath, '-e', 'console.log(process.cwd())'] }],
      })
      const deadline = Date.now() + 10_000
      while (!['done', 'failed'].includes(b.task(id).status)) {
        if (Date.now() > deadline) throw new Error(`等待验收超时：${b.task(id).status}`)
        await b.clock.advance(1000)
        await realWait(5)
      }
      const t = b.task(id)
      expect(t.status).toBe('done')
      expect(t.result?.verify[0]?.output_tail).toContain(realpathSync(workdir))
      expect(t.result?.verify[0]?.output_tail).not.toContain(realpathSync(h.repo))
    } finally {
      await b.close()
    }
  })
})

describe('经节点与中枢的完整流程', () => {
  test('Codex 停下提问 → blocked(question) 附末尾输出 → 用户回复"用方案 A" → 终端收到 → 开 PR → done', async () => {
    let real: ExecutorPlugin | undefined
    const proxy: ExecutorPlugin = {
      type: 'codex-orca',
      mode: 'interactive',
      classify: (snap) => real?.classify?.(snap) ?? null,
      run: (c, ctx) => {
        if (!real) throw new Error('执行器尚未就绪')
        return real.run(c, ctx)
      },
    }
    const b = await bench({ executors: [proxy] })
    h = orcaHome()
    const orca = new FakeOrca(h.worktree)
    orca.show('working', 'question')
    const gh = new FakeGh()
    real = createCodexOrcaExecutor({
      home: h.home,
      clock: b.clock,
      orca,
      gh,
      baseBranch: async () => 'origin/main',
      waitForSetup: async () => ok(undefined),
    })
    try {
      const id = await b.create({
        executor: 'codex-orca',
        workspace: 'ws/product-res',
        inputs: { repo: h.repo },
      })
      await until(() => orca.ops('terminalCreate').length > 0, '启动 Codex')
      const blocked = await b.until(id, (t) => t.status === 'blocked', 600_000)
      expect(blocked.blocked).toMatchObject({
        reason: 'question',
        message: '下一步你希望我查看什么？',
        lease_held: true,
      })
      expect(blocked.blocked?.tail?.join('\n')).toContain('下一步你希望我查看什么？')

      orca.reads = []
      orca.show('working', 'pr-opened')
      gh.prs = [{ url: 'https://github.com/example-user/flow/pull/20', number: 20, state: 'OPEN' }]
      await b.api('POST', `/v1/tasks/${id}/reply`, { kind: 'text', text: '用方案 A' })
      const done = await b.until(id, (t) => t.status === 'done', 600_000)
      expect(done.result?.artifacts[0]).toEqual({
        kind: 'pr',
        ref: 'https://github.com/example-user/flow/pull/20',
      })
      const texts = (orca.ops('terminalSend') as Array<{ input: { text?: string } }>).map(
        (c) => c.input.text,
      )
      expect(texts).toEqual(['用方案 A'])
      expect(b.types(id)).toContain('task.unblocked')
    } finally {
      await b.close()
    }
  })
})

describe('脱敏', () => {
  test('终端输出作为活动上报前脱敏', async () => {
    const token = ['ghp', 'B'.repeat(36)].join('_')
    const s = await start({}, (o) => {
      o.reads.push(
        ok({
          handle: o.handle,
          status: 'running',
          tail: [`• Ran echo ${token}`, '• Working (1s • esc to interrupt)'],
        }),
      )
    })
    await ready(s)
    await s.poll()
    const out = s.activity
      .filter((a) => a.kind === 'output')
      .map((a) => a.text ?? '')
      .join('\n')
    expect(out).toContain('[REDACTED:github-token]')
    expect(out).not.toContain(token)
    await s.run.cancel()
  })
})
