import { afterEach, describe, expect, test } from 'bun:test'
import { type Bench, bench, fake } from './harness.ts'

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
const open = async () => {
  current = await bench()
  return current
}

interface ReplyResponse {
  ok: boolean
  data?: { requeued: boolean; reply: { id: string; kind: string; by: string } }
  error?: { code: string }
}
const reply = (b: Bench, id: string, body: unknown, actor = 'user') =>
  b.api<ReplyResponse>('POST', `/v1/tasks/${id}/reply`, body, actor)

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
    const r = await reply(b, id, { kind: 'approve' }, 'agent:supervisor')
    expect(r).toMatchObject({
      ok: true,
      data: { reply: { kind: 'approve', by: 'agent:supervisor' } },
    })
    await b.until(id, (t) => t.status === 'done', 60_000)
    expect(b.events(id).find((e) => e.type === 'task.unblocked')?.payload).toMatchObject({
      note: 'agent:supervisor 批准',
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
})
