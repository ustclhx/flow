import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { type Bench, bench, fake, type Intercept } from './harness.ts'

/**
 * 回复与送达（add-m1-executors 1.3；task-interaction spec、node-protocol 增量）：
 * 真实的中枢路由 + 节点循环 + fake 执行器，回复经 `POST /v1/tasks/:id/reply` 提交。
 * fake 执行器的 idle + await_reply 脚本代表交互式执行器（例如 codex-orca），
 * 以 blocked 结束并附会话 id 的 fake 代表无头执行器（例如 codex-exec）。
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

interface ReplyResponse {
  ok: boolean
  data?: { requeued: boolean; reply: { id: string; kind: string; by: string } }
  error?: { code: string }
}
const reply = (b: Bench, id: string, body: unknown, actor = 'user') =>
  b.api<ReplyResponse>('POST', `/v1/tasks/${id}/reply`, body, actor)

/** 运行时拼出的 PEM 形状文本（随机 base64 正文，每行 64 字符），不是真的私钥。 */
function fakePem(bodyLines: number): string[] {
  const body =
    randomBytes(bodyLines * 48)
      .toString('base64')
      .match(/.{1,64}/g) ?? []
  const label = ['PRIVATE', 'KEY'].join(' ')
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`]
}

const deliverCalls = (b: Bench, id: string) =>
  b.ledger.taskActivity(id).filter((a) => a.text?.startsWith('fake：deliver 调用')).length

const interactive = (extra: Record<string, unknown>[] = []) =>
  fake({
    script: [
      { do: 'output', text: '要基于哪个分支？' },
      { do: 'idle' },
      { do: 'await_reply' },
      { do: 'output', text: '好的，继续' },
      ...extra,
    ],
  })

describe('送达与恢复', () => {
  test('交互式任务的回复：下一次续约送进 worker，账本依次记录 task.replied 与 task.unblocked', async () => {
    const b = await open()
    const id = await b.create(interactive())
    await b.until(id, (t) => t.status === 'blocked')
    expect(b.task(id).blocked).toMatchObject({ reason: 'question', lease_held: true })

    const r = await reply(b, id, { kind: 'text', text: '用 main' })
    expect(r).toMatchObject({ ok: true, data: { requeued: false, reply: { by: 'user' } } })
    const t = await b.until(id, (t) => t.status === 'done', 60_000)
    expect(t.attempt).toBe(1)
    expect(b.types(id)).toEqual([
      'task.created',
      'task.started',
      'lease.granted',
      'task.blocked',
      'task.replied',
      'task.unblocked',
      'task.done',
    ])
    // 同一条回复只送达一次。
    const got = b.ledger.taskActivity(id).filter((a) => a.text?.startsWith('收到回复'))
    expect(got.map((a) => a.text)).toEqual(['收到回复（text，user）：用 main'])
    expect(b.ledger.taskReplies(id)).toMatchObject([{ state: 'delivered', text: '用 main' }])
  })

  test('无头任务的回复：任务重新排队，下一次执行以该会话 id 和回复恢复', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        outcome: 'blocked',
        blocked_reason: 'question',
        message: '要基于哪个分支？',
        session: 'sess-7',
      }),
    )
    const blocked = await b.until(id, (t) => t.status === 'blocked')
    expect(blocked.blocked).toMatchObject({ session: 'sess-7', lease_held: false })
    expect(blocked.lease).toBeNull()

    const r = await reply(b, id, { kind: 'text', text: '用 main' })
    expect(r).toMatchObject({ ok: true, data: { requeued: true } })
    const t = await b.until(id, (t) => t.status === 'done', 60_000)
    expect(t.attempt).toBe(2)
    expect(t.result?.summary).toBe('已恢复（会话 sess-7）：text 用 main')
    expect(b.types(id).slice(3)).toEqual([
      'task.blocked',
      'task.replied',
      'task.requeued_with_reply',
      'task.started',
      'lease.granted',
      'task.done',
    ])
  })

  test('审批：awaiting_approval 的任务 --approve 后继续', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'output', text: 'Allow command `git push`? [y/n]' },
          { do: 'idle' },
          { do: 'await_reply' },
        ],
      }),
    )
    await b.until(id, (t) => t.blocked?.reason === 'awaiting_approval')
    const r = await reply(b, id, { kind: 'approve' })
    expect(r).toMatchObject({ ok: true, data: { reply: { kind: 'approve', by: 'user' } } })
    await b.until(id, (t) => t.status === 'done', 60_000)
    expect(b.events(id).find((e) => e.type === 'task.unblocked')?.payload).toMatchObject({
      note: 'user 批准',
    })
  })

  test('对提问点了批准：reply_kind_mismatch；对运行中的任务回复：not_blocked', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'wait', ms: 10_000 },
          { do: 'output', text: '要基于哪个分支？' },
          { do: 'idle' },
          { do: 'hang' },
        ],
      }),
    )
    await b.until(id, (t) => t.status === 'running')
    const before = b.ledger.seq()
    expect(await reply(b, id, { kind: 'text', text: '好的' })).toMatchObject({
      ok: false,
      error: { code: 'not_blocked' },
    })
    expect(b.ledger.seq()).toBe(before)
    await b.until(id, (t) => t.status === 'blocked')
    expect(await reply(b, id, { kind: 'approve' })).toMatchObject({
      ok: false,
      error: { code: 'reply_kind_mismatch' },
    })
  })

  test('worker 自行恢复（用户直接在终端里答复）：上报 task.unblocked，之后正常完成', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'output', text: '继续吗？' },
          { do: 'idle' },
          { do: 'wait', ms: 30_000 },
          { do: 'resumed' },
          { do: 'output', text: '继续了' },
        ],
      }),
    )
    await b.until(id, (t) => t.status === 'blocked')
    await b.until(id, (t) => t.status === 'done', 2 * 60_000)
    expect(b.types(id).slice(3)).toEqual(['task.blocked', 'task.unblocked', 'task.done'])
  })

  test('卡住期间 worker 直接结束：先恢复为 running 再提交 done', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [{ do: 'output', text: '继续吗？' }, { do: 'idle' }, { do: 'wait', ms: 5_000 }],
      }),
    )
    await b.until(id, (t) => t.status === 'done', 2 * 60_000)
    expect(b.types(id).slice(3)).toEqual(['task.blocked', 'task.unblocked', 'task.done'])
  })

  test('取消持有租约的 blocked 任务：节点得知取消、停止执行器、提交 cancelled', async () => {
    const b = await open()
    const id = await b.create(interactive())
    await b.until(id, (t) => t.status === 'blocked')
    const r = await b.api<{ ok: boolean }>('POST', `/v1/tasks/${id}/cancel`, {})
    expect(r.ok).toBe(true)
    const t = await b.until(id, (t) => t.status === 'cancelled', 2 * 60_000)
    expect(t.finished_at).not.toBeNull()
    expect(b.events(id).at(-1)).toMatchObject({ type: 'task.cancelled', actor: 'node:n-bench' })
  })

  test('卡住期间 worker 崩溃：不上报恢复，已提交的回复随重新排队带到下一次执行（审查第 5 条）', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        deliver_failures: 1_000_000,
        script: [
          { do: 'output', text: '要基于哪个分支？' },
          { do: 'idle' },
          { do: 'wait', ms: 120_000 },
          { do: 'exit', code: 137 },
        ],
      }),
    )
    await b.until(id, (t) => t.status === 'blocked')
    expect(await reply(b, id, { kind: 'text', text: '用 main' })).toMatchObject({ ok: true })
    const t = await b.until(id, (t) => t.status === 'done', 10 * 60_000)
    expect(t.result?.summary).toBe('已恢复（会话 无）：text 用 main')
    const types = b.types(id)
    expect(types).not.toContain('task.unblocked')
    expect(types.slice(3, 7)).toEqual([
      'task.blocked',
      'task.replied',
      'task.blocked',
      'task.requeued_with_reply',
    ])
    expect(b.events(id)[5]?.payload).toMatchObject({ reason: 'crashed', lease_held: false })
  })

  test('deliver 临时失败：不取消 worker，下一次续约重试直到送达（审查第 6 条）', async () => {
    const b = await open()
    const id = await b.create({
      ...interactive(),
      inputs: { fake: { ...interactive().inputs.fake, deliver_failures: 2 } },
    })
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'text', text: '用 main' })
    const t = await b.until(id, (t) => t.status === 'done', 5 * 60_000)
    expect(t.attempt).toBe(1)
    expect(b.types(id).slice(3)).toEqual([
      'task.blocked',
      'task.replied',
      'task.unblocked',
      'task.done',
    ])
    const got = b.ledger.taskActivity(id).filter((a) => a.text?.startsWith('收到回复'))
    expect(got).toHaveLength(1)
  })

  test('deliver 很慢（超过 TTL）：续约不被阻塞，租约不过期（审查第 9 条）', async () => {
    const b = await open({}, 30)
    const id = await b.create({
      ...interactive(),
      inputs: { fake: { ...interactive().inputs.fake, deliver_delay_ms: 50_000 } },
    })
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'text', text: '用 main' })
    for (let i = 0; i < 20; i++) {
      await b.clock.advance(10_000)
      b.sweep()
    }
    expect(b.types(id)).not.toContain('task.lease_expired')
    await b.until(id, (t) => t.status === 'done', 5 * 60_000)
  })

  test('ack 被非重试错误拒绝：允许中枢再次返回时重新送达，不会永久卡住（审查第 8 条）', async () => {
    let rejected = 0
    const intercept: Intercept = (url) => {
      if (url.endsWith('/ack-reply') && rejected === 0) {
        rejected++
        return Response.json(
          {
            ok: false,
            error: {
              kind: 'failure',
              code: 'invalid_transition',
              message: '注入的拒绝',
              retryable: false,
            },
          },
          { status: 409 },
        )
      }
      return undefined
    }
    const b = await open({}, 60, intercept)
    const id = await b.create(interactive())
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'text', text: '用 main' })
    const t = await b.until(id, (t) => t.status === 'done', 5 * 60_000)
    expect(rejected).toBe(1)
    expect(t.status).toBe('done')
    // 节点重新送达了一次，执行器按 reply_id 幂等，worker 只收到一次。
    expect(deliverCalls(b, id)).toBe(2)
    expect(b.ledger.taskActivity(id).filter((a) => a.text?.startsWith('收到回复'))).toHaveLength(1)
    expect(b.ledger.taskReplies(id)).toMatchObject([{ state: 'delivered' }])
  })

  test('交互式卡住时执行器给出的会话 id 写入 task.blocked（审查第 3 条）', async () => {
    const b = await open()
    const id = await b.create(
      fake({
        script: [
          { do: 'output', text: '要基于哪个分支？' },
          { do: 'idle', hint: { session: 'orca-term-3' } },
          { do: 'hang' },
        ],
      }),
    )
    const t = await b.until(id, (t) => t.status === 'blocked')
    expect(t.blocked).toMatchObject({
      reason: 'question',
      session: 'orca-term-3',
      lease_held: true,
    })
  })

  test('deliver 比超时慢（70 秒 / 60 秒）：不重送，worker 只收到 1 次回复（第三轮复核第 2 条）', async () => {
    const b = await open({ deliverTimeoutMs: 60_000 })
    const id = await b.create({
      ...interactive(),
      inputs: { fake: { ...interactive().inputs.fake, deliver_delay_ms: 70_000 } },
    })
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'text', text: '用 main' })
    const t = await b.until(id, (t) => t.status === 'done', 5 * 60_000)
    expect(t.attempt).toBe(1)
    expect(deliverCalls(b, id)).toBe(1)
    const got = b.ledger.taskActivity(id).filter((a) => a.text?.startsWith('收到回复'))
    expect(got).toHaveLength(1)
    expect(b.ledger.taskReplies(id)).toMatchObject([{ state: 'delivered' }])
  })

  test('deliver 迟迟没有结果：按 not_running 处理，带着回复重新排队并取消当前 worker（第三轮复核第 2 条）', async () => {
    const b = await open({ deliverTimeoutMs: 60_000, deliverGiveUpMs: 5 * 60_000 })
    const id = await b.create({
      ...interactive(),
      inputs: { fake: { ...interactive().inputs.fake, deliver_hangs: 1 } },
    })
    await b.until(id, (t) => t.status === 'blocked')
    await reply(b, id, { kind: 'text', text: '用 main' })
    await b.clock.advance(4 * 60_000)
    // 放弃之前不重送。
    expect(b.task(id).status).toBe('blocked')
    expect(deliverCalls(b, id)).toBe(1)
    const t = await b.until(id, (t) => t.status === 'done', 10 * 60_000)
    expect(t.attempt).toBe(2)
    expect(t.result?.summary).toBe('已恢复（会话 无）：text 用 main')
    expect(b.types(id)).toContain('task.requeued_with_reply')
    expect(b.ledger.taskReplies(id)).toMatchObject([{ state: 'requeued' }])
  })

  test('卡住时末尾 40 行切掉了私钥的 BEGIN 行：私钥正文也不入账（第三轮复核第 1 条）', async () => {
    for (const bodyLines of [50, 98]) {
      const b = await open()
      const pem = fakePem(bodyLines)
      const id = await b.create(
        fake({
          script: [
            ...pem.map((text) => ({ do: 'output', text })),
            { do: 'output', text: '要继续吗？' },
            { do: 'idle' },
            { do: 'hang' },
          ],
        }),
      )
      const t = await b.until(id, (t) => t.status === 'blocked')
      // 合同（task.created）里本来就有这些脚本行，只检查卡住上报入账的部分。
      const stored = JSON.stringify(b.events(id).filter((e) => e.type === 'task.blocked'))
      expect(pem.slice(1, -1).filter((line) => stored.includes(line))).toEqual([])
      expect(t.blocked?.tail?.some((l) => l.includes('[REDACTED:private-key]'))).toBe(true)
      await b.close()
      current = undefined
    }
  })
})
