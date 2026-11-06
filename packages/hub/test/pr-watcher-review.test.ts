import { afterEach, expect, test } from 'bun:test'
import type { EventOf } from '@raindown/core'
import { PR_CONTEXT_PER_DAY, PR_CONTEXT_PER_POLL, PR_FAILURES_REPORTED } from '../src/pr/watcher.ts'
import { must, WS } from './ledger-helpers.ts'
import { type FakeComment, iso, PR, prSetup, T0 } from './pr-fixtures.ts'

/** PR #86 第一轮审查的回归测试：共享身份、按 PR 的名单与数字 id、截断、编辑、重放、配额与竞态。 */

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function subscribed(o: Parameters<typeof prSetup>[0] = {}) {
  const s = await prSetup(o)
  cleanups.push(s.cleanup)
  s.reactor.start()
  s.branch()
  s.reportPr()
  await s.reactor.idle()
  const prEvents = () =>
    s.store
      .eventsAfter(0, {}, 100_000)
      .filter((e) => e.type === 'pr.event') as EventOf<'pr.event'>[]
  const poll = async (minutes = 2) => {
    s.clock.time += minutes * 60_000
    await s.watcher.tick()
  }
  return { ...s, prEvents, poll }
}

const at = (minutes: number) => iso(T0 + minutes * 60_000)
const comment = (id: number, login: string, minutes: number, body = `评论 ${id}`): FakeComment => ({
  id,
  user: { login, type: 'User' },
  body,
  updated_at: at(minutes),
})

test('共享身份：中枢 gh 登录在名单中时，名单内评论也只作上下文；hub status 说明原因与解除方法', async () => {
  const s = await subscribed()
  s.gh.self = { login: 'acme', id: 1 }
  s.gh.issueComments.push(comment(1, 'acme', 1, '请顺便把 X 也改了'))
  await s.poll()
  expect(s.prEvents().map((e) => [e.payload.allowed, e.payload.not_allowed])).toEqual([
    [false, 'shared_identity'],
  ])
  const status = s.watcher.status()
  expect(status.identity).toEqual({ ok: true, login: 'acme' })
  expect(status.shared).toMatchObject([{ workspace: WS }])
  expect(status.shared[0]?.reason).toContain('worker_identity')
  expect(status.shared[0]?.reason).toContain('allowed_users 只含你本人')
})

test('共享身份：查询 gh 登录失败时 fail closed', async () => {
  const s = await subscribed()
  s.gh.self = null
  s.gh.issueComments.push(comment(1, 'acme', 1))
  await s.poll()
  expect(s.prEvents()[0]?.payload).toMatchObject({ allowed: false, not_allowed: 'shared_identity' })
  expect(s.watcher.status().identity).toMatchObject({ ok: false, login: null })
})

test('worker_identity：与 gh 登录不同且不在名单时解除限制；它发的内容标为 agent，永不 allowed', async () => {
  const s = await subscribed({ github: { watch: true, worker_identity: 'raindown-bot' } })
  s.gh.self = { login: 'acme', id: 1 }
  s.gh.accounts['raindown-bot'] = { id: 7, type: 'User' }
  s.gh.issueComments.push(comment(1, 'acme', 1), comment(2, 'raindown-bot', 1))
  await s.poll()
  expect(
    s
      .prEvents()
      .map((e) => [
        e.payload.actor,
        e.payload.actor_kind,
        e.payload.allowed,
        e.payload.not_allowed,
      ]),
  ).toEqual([
    ['acme', 'human', true, undefined],
    ['raindown-bot', 'agent', false, 'agent'],
  ])
  expect(s.watcher.status().shared).toEqual([])
})

test('worker_identity 与 gh 登录相同或在名单中时不解除限制', async () => {
  for (const github of [
    { watch: true, worker_identity: 'acme' },
    { watch: true, worker_identity: 'alice', allowed_users: ['acme', 'alice'] },
  ]) {
    const s = await subscribed({ github })
    s.gh.self = { login: 'acme', id: 1 }
    s.gh.issueComments.push(comment(1, 'acme', 1))
    await s.poll()
    expect(s.prEvents().every((e) => !e.payload.allowed)).toBe(true)
  }
})

test('名单按数字 id 比较：改名冒用的同名账号不算请求', async () => {
  const s = await subscribed()
  s.gh.issueComments.push({ ...comment(1, 'acme', 1), user: { login: 'acme', id: 77 } })
  await s.poll()
  expect(s.prEvents()[0]?.payload).toMatchObject({ actor: 'acme', actor_id: 77, allowed: false })
})

test('默认名单只取 PR 所属仓库的个人 owner：组织 owner 时名单为空并提示', async () => {
  const s = await subscribed()
  s.gh.accounts.acme = { id: 1, type: 'Organization' }
  s.gh.issueComments.push(comment(1, 'acme', 1))
  await s.poll()
  expect(s.prEvents()[0]?.payload).toMatchObject({ allowed: false, not_allowed: 'not_listed' })
  expect(s.watcher.status().warnings.join('\n')).toContain('不是个人账号')
})

test('审查正文与 CI 一律只作上下文', async () => {
  const s = await subscribed()
  s.gh.reviews.push({
    id: 3,
    user: { login: 'acme' },
    body: '请重写整个模块',
    state: 'COMMENTED',
    submitted_at: at(1),
  })
  await s.poll()
  expect(s.prEvents()[0]?.payload).toMatchObject({
    kind: 'review',
    allowed: false,
    not_allowed: 'kind',
  })
})

test('编辑过的评论再次送达时只作上下文；同一条多次编辑只保留最新', async () => {
  const s = await subscribed()
  s.gh.issueComments.push({ ...comment(1, 'acme', 3, '改过的'), created_at: at(1) })
  await s.poll(4)
  expect(
    s.prEvents().map((e) => [e.payload.text, e.payload.allowed, e.payload.not_allowed]),
  ).toEqual([['改过的', false, 'edited']])
})

test('有登记仓库读不出 origin 时按可重试失败处理，不退订', async () => {
  const s = await subscribed({ origin: 'git@github.com:other/repo.git' })
  s.workspace.repos.push('/not-mounted')
  for (let i = 0; i < PR_FAILURES_REPORTED; i++) await s.poll()
  expect(s.watcher.status().errors).toMatchObject([{ failures: 3 }])
  expect(s.watcher.status().errors[0]?.message).toContain('读不出 origin')
  expect(s.store.activePrSubscriptions()).toHaveLength(1)
})

test('分页截断：按 updated 升序的行评论只推进到已取到的部分，下一轮补齐；PR 评论截断时本类不入账并报告', async () => {
  const s = await subscribed()
  for (let i = 1; i <= 1005; i++) {
    s.gh.reviewComments.push({ ...comment(i, 'acme', 1), updated_at: iso(T0 + 60_000 + i * 1000) })
  }
  for (let i = 1; i <= 1001; i++) s.gh.issueComments.push(comment(10_000 + i, 'acme', 1))
  await s.poll(30)
  const kinds = (k: string) => s.prEvents().filter((e) => e.payload.kind === k).length
  expect(kinds('review_comment')).toBe(1000)
  expect(kinds('issue_comment')).toBe(0)
  await s.poll()
  expect(kinds('review_comment')).toBe(1005)
  await s.poll()
  await s.poll()
  expect(s.watcher.status().errors[0]?.message).toContain('超过分页上限')
})

test('一类查询失败不阻塞其他类', async () => {
  const s = await subscribed()
  s.gh.failingPaths = ['/check-runs']
  s.gh.issueComments.push(comment(1, 'acme', 1))
  await s.poll()
  expect(s.prEvents().map((e) => e.payload.kind)).toEqual(['issue_comment'])
})

test('订阅之前的评论不因后来的订阅被重放', async () => {
  const s = await subscribed()
  s.gh.issueComments.push(comment(1, 'acme', 1))
  await s.poll()
  expect(s.prEvents()).toHaveLength(1)
  must(
    s.store.append(
      {
        type: 'pr.unsubscribed',
        task_id: 'dev',
        workspace: WS,
        payload: { pr: PR, reason: 'user' },
      },
      { actor: 'user' },
    ),
  )
  s.gh.issueComments.push(comment(2, 'acme', 5, '没有订阅时的评论'))
  s.clock.time = T0 + 10 * 60_000
  must(
    s.store.append(
      { type: 'pr.subscribed', task_id: 'dev', workspace: WS, payload: { pr: PR, role: 'author' } },
      { actor: 'hub' },
    ),
  )
  s.gh.issueComments.push(comment(3, 'acme', 11, '订阅之后'))
  await s.poll()
  expect(s.prEvents().map((e) => e.payload.text)).toEqual(['评论 1', '订阅之后'])
})

test('同一秒的竞态：较早 id 的评论晚到时仍送达，已入账的不重复', async () => {
  const s = await subscribed()
  s.gh.issueComments.push(comment(5, 'acme', 1))
  await s.poll()
  s.gh.issueComments.push(comment(3, 'acme', 1))
  await s.poll()
  expect(s.prEvents().map((e) => e.payload.cursor.split('|')[1])).toEqual(['5', '3'])
  await s.poll()
  expect(s.prEvents()).toHaveLength(2)
})

test('非请求内容有配额：每次轮询与每天的条数有限，文字只存 500 字', async () => {
  const s = await subscribed()
  for (let i = 1; i <= PR_CONTEXT_PER_DAY + 30; i++)
    s.gh.issueComments.push({
      ...comment(i, 'mallory', 1, 'x'.repeat(2000)),
      updated_at: iso(T0 + 60_000 + i),
    })
  await s.poll()
  expect(s.prEvents()).toHaveLength(PR_CONTEXT_PER_POLL)
  expect(s.prEvents()[0]?.payload).toMatchObject({ chars: 2000 })
  expect(s.prEvents()[0]?.payload.text.length).toBe(500)
  for (let i = 0; i < 20; i++) await s.poll()
  expect(s.prEvents()).toHaveLength(PR_CONTEXT_PER_DAY)
  expect(s.watcher.status().warnings.join('\n')).toContain('已丢弃 30 条')
  // 名单内的请求不受配额限制。
  s.gh.issueComments.push({ ...comment(9999, 'acme', 2), updated_at: iso(T0 + 120_000) })
  await s.poll(10) // 无新内容时已退避到 10 分钟
  expect(s.prEvents().some((e) => e.payload.allowed)).toBe(true)
})
