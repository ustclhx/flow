import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskContract } from '@flow/core'
import { classifyFake, noProgressMs, STUCK_TAIL_LINES } from '../src/index.ts'
import { type Bench, bench, fake } from './harness.ts'

/**
 * 卡住检测（add-m1-executors 1.2；stuck-detection spec 全部场景）。
 * 用 fake 执行器的脚本指令模拟 worker 的各种表现，中枢与节点在同一个虚拟时钟下运行。
 */

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})
const open = async (...args: Parameters<typeof bench>) => {
  current = await bench(...args)
  return current
}

const MIN = 60_000

describe('卡住的原因分类', () => {
  test('等待授权：终端末尾是命令执行请求 → blocked(awaiting_approval)，说明中包含该命令', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'output', text: '正在清理构建目录' },
          { do: 'output', text: 'Allow command `rm -rf build`? [y/n]' },
          { do: 'idle' },
          { do: 'hang' },
        ],
      }),
    )
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked).toMatchObject({ reason: 'awaiting_approval', lease_held: true })
    expect(t.blocked?.message).toContain('rm -rf build')
    expect(t.blocked?.tail).toEqual(['正在清理构建目录', 'Allow command `rm -rf build`? [y/n]'])
    // 交互式：worker 还活着，租约继续持有并照常续约。
    expect(t.lease).not.toBeNull()
    await b.clock.advance(5 * MIN)
    expect(b.sweep()).toBe(0)
    expect(b.task(id).lease).not.toBeNull()
    expect(b.events(id).at(-1)).toMatchObject({
      type: 'task.blocked',
      actor: 'node:n-bench',
      payload: { lease_held: true, node_id: 'n-bench' },
    })
  })

  test('提问：末尾以问号结尾 → blocked(question)', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [{ do: 'output', text: '要基于哪个分支？' }, { do: 'idle' }, { do: 'hang' }],
      }),
    )
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked).toMatchObject({ reason: 'question', message: '要基于哪个分支？' })
  })

  test('执行器无法识别 → other，仍附说明与末尾输出', async () => {
    const b = await open()
    const id = await b.create(
      fake({ script: [{ do: 'output', text: '一切正常' }, { do: 'idle' }, { do: 'hang' }] }),
    )
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked).toMatchObject({ reason: 'other', tail: ['一切正常'] })
    expect(t.blocked?.message.length).toBeGreaterThan(0)
  })

  test('末尾输出默认只附 40 行', async () => {
    const b = await open()
    const lines = Array.from({ length: 60 }, (_, i) => ({ do: 'output', text: `第 ${i} 行` }))
    const id = await b.create(fake({ script: [...lines, { do: 'idle' }, { do: 'hang' }] }))
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked?.tail).toHaveLength(STUCK_TAIL_LINES)
    expect(t.blocked?.tail?.at(-1)).toBe('第 59 行')
  })

  test('fake 的识别规则', () => {
    const contract = taskContract.parse({
      goal: 'x',
      workspace: 'ws/a',
      role: 'dev',
      executor: 'fake',
    })
    const snap = (tail: string[], hint?: Record<string, unknown>) =>
      classifyFake({ trigger: 'idle', tail, idle_ms: 0, contract, ...(hint ? { hint } : {}) })
    expect(snap(['允许执行 git push 吗？'])?.reason).toBe('awaiting_approval')
    expect(snap(['which branch should I use?', ''])?.reason).toBe('question')
    expect(snap(['完成'])).toBeNull()
    expect(snap([])).toBeNull()
    expect(snap([], { reason: 'awaiting_approval', message: '工具 Bash' })).toEqual({
      reason: 'awaiting_approval',
      message: '工具 Bash',
    })
  })
})

describe('无进展超时', () => {
  test('长时间没有输出：默认 15 分钟后 blocked(no_progress)', async () => {
    const b = await open()
    const id = await b.create(fake({ script: [{ do: 'output', text: '开始' }, { do: 'hang' }] }))
    await b.until(id, (t) => t.status === 'running')
    await b.clock.advance(14 * MIN + 50_000)
    expect(b.task(id).status).toBe('running')
    const t = await b.until(id, (t) => t.status === 'blocked', 2 * MIN)
    expect(t.blocked).toMatchObject({ reason: 'no_progress', lease_held: true, tail: ['开始'] })
    expect(t.blocked?.message).toContain('15')
  })

  test('有活动就重新计时', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'wait', ms: 10 * MIN },
          { do: 'output', text: '还在干' },
          { do: 'wait', ms: 10 * MIN },
          { do: 'output', text: '还在干' },
          { do: 'hang' },
        ],
      }),
    )
    await b.clock.advance(21 * MIN)
    expect(b.task(id).status).toBe('running')
    await b.until(id, (t) => t.status === 'blocked', 20 * MIN)
  })

  test('阈值：合同的 no_progress_minutes 优先，其次角色设定，最后默认 15 分钟', async () => {
    const parse = (over: Record<string, unknown> = {}) =>
      taskContract.parse({ goal: 'x', workspace: 'ws/a', role: 'dev', executor: 'fake', ...over })
    expect(noProgressMs(parse())).toBe(15 * MIN)
    expect(noProgressMs(parse(), (c) => (c.role === 'dev' ? 30 : undefined))).toBe(30 * MIN)
    expect(noProgressMs(parse({ no_progress_minutes: 2 }), () => 30)).toBe(2 * MIN)

    const b = await open({ noProgressMinutes: () => 5 })
    const id = await b.create(fake({ script: [{ do: 'hang' }] }))
    await b.clock.advance(4 * MIN)
    expect(b.task(id).status).toBe('running')
    await b.until(id, (t) => t.blocked?.reason === 'no_progress', 2 * MIN)
  })
})

describe('角色设定的无进展阈值', () => {
  test('按合同的角色读取 config/roles/<role>.yaml 的 no_progress_minutes', async () => {
    const b = await open({ readRoles: true })
    const dir = join(b.home, 'config', 'roles')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'dev.yaml'),
      'name: dev\nexecutor: fake\nprompt: 测试角色\nno_progress_minutes: 3\n',
    )
    const id = await b.create(fake({ script: [{ do: 'hang' }] }))
    // 领到租约后节点要先读角色文件（真实 I/O），等执行器真正启动后再拨动虚拟时钟。
    for (let i = 0; i < 400 && b.node.active() === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(b.node.active()).toBe(1)
    await b.clock.advance(2 * MIN + 30_000)
    expect(b.task(id).status).toBe('running')
    const t = await b.until(id, (t) => t.status === 'blocked', 2 * MIN)
    expect(t.blocked?.message).toContain('3 分钟')
  })
})

describe('崩溃与超时', () => {
  test('进程意外退出 → blocked(crashed)，附退出码与末尾输出', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'output', text: '编译中' },
          { do: 'output', text: 'Segmentation fault' },
          { do: 'exit', code: 139 },
        ],
      }),
    )
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked).toMatchObject({
      reason: 'crashed',
      lease_held: false,
      tail: ['编译中', 'Segmentation fault'],
    })
    expect(t.blocked?.message).toContain('139')
    expect(t.lease).toBeNull()
  })

  test('超时：timeout_s=600 的任务到第 601 秒仍未结束 → 停止执行器，failed(timeout)', async () => {
    const b = await open()
    const id = await b.create({
      timeout_s: 600,
      no_progress_minutes: 60,
      ...fake({ script: [{ do: 'hang' }] }),
    })
    await b.until(id, (t) => t.status === 'running')
    await b.clock.advance(599_000)
    expect(b.task(id).status).toBe('running')
    const t = await b.until(id, (t) => t.status === 'failed', 5_000)
    expect(t.result).toMatchObject({ reason: 'timeout', executor: 'fake', node_id: 'n-bench' })
    expect(t.result?.summary).toContain('600')
  })

  test('超时后执行器不响应取消：宽限期过后照样提交 failed(timeout)', async () => {
    const b = await open({ timeoutGraceMs: 5_000 })
    const id = await b.create({
      timeout_s: 60,
      ...fake({ script: [{ do: 'hang', ignore_cancel: true }] }),
    })
    await b.clock.advance(62_000)
    expect(b.task(id).status).toBe('running')
    const t = await b.until(id, (t) => t.status === 'failed', 10_000)
    expect(t.result?.reason).toBe('timeout')
  })

  test('blocked 等待回复的时间不计入超时', async () => {
    const b = await open()
    const id = await b.create({
      timeout_s: 120,
      ...fake({
        script: [
          { do: 'output', text: '继续吗？' },
          { do: 'idle' },
          { do: 'await_reply' },
          { do: 'wait', ms: 30_000 },
        ],
      }),
    })
    await b.until(id, (t) => t.status === 'blocked')
    await b.clock.advance(30 * MIN)
    expect(b.task(id).status).toBe('blocked')
    const r = b.tasks.replyTask(id, { kind: 'text', text: '继续' }, { actor: 'user' })
    expect(r.ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'done', 2 * MIN)
    expect(t.result?.reason).toBeUndefined()
  })
})
