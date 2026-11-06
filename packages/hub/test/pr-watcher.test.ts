import { afterEach, expect, test } from 'bun:test'
import type { EventOf } from '@raindown/core'
import { openLedger } from '../src/ledger/store.ts'
import { isSafeApiPath } from '../src/pr/github.ts'
import { createPrWatcher, PR_POLL_BASE_MS, PR_POLL_MAX_MS } from '../src/pr/watcher.ts'
import { WS } from './ledger-helpers.ts'
import { BRANCH, HEAD, iso, PR, prSetup, T0 } from './pr-fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** 已订阅 PR #40 的开发任务（订阅时间约为 T0）。 */
async function subscribed(o: Parameters<typeof prSetup>[0] = {}) {
  const s = await prSetup(o)
  cleanups.push(s.cleanup)
  s.reactor.start()
  s.branch()
  s.reportPr()
  await s.reactor.idle()
  expect(s.store.activePrSubscriptions()).toHaveLength(1)
  const prEvents = () =>
    s.store.eventsAfter(0, {}, 10_000).filter((e) => e.type === 'pr.event') as EventOf<'pr.event'>[]
  return { ...s, prEvents }
}

const at = (minutes: number) => iso(T0 + minutes * 60_000)

test('重启后不重放：已入账的评论不再送达，游标随事件落账', async () => {
  const s = await subscribed()
  s.gh.issueComments.push({
    id: 11,
    user: { login: 'acme', type: 'User' },
    body: '请把日志级别改成 info',
    updated_at: at(1),
    html_url: `${PR}#issuecomment-11`,
  })
  s.clock.time = T0 + 2 * 60_000
  expect(await s.watcher.tick()).toBe(1)
  expect(s.prEvents()).toMatchObject([
    {
      workspace: WS,
      actor: 'hub',
      payload: {
        pr: PR,
        kind: 'issue_comment',
        actor: 'acme',
        actor_kind: 'human',
        allowed: true,
        text: '请把日志级别改成 info',
        cursor: `${at(1)}|11`,
      },
    },
  ])
  // 模拟中枢重启：关闭账本、重新打开，用全新的 watcher 继续轮询。
  await s.watcher.stop()
  s.store.close()
  const reopened = await openLedger(s.path, { now: s.clock.now })
  const again = createPrWatcher({
    ledger: reopened,
    workspaces: async () => s.workspace,
    gh: s.gh.api,
    origin: async () => 'git@github.com:acme/demo.git',
    clock: s.clock,
  })
  expect(await again.tick()).toBe(1)
  const events = reopened.eventsAfter(0, {}, 10_000).filter((e) => e.type === 'pr.event')
  expect(events).toHaveLength(1)
  await again.stop()
  reopened.close()
})

test('订阅之前的历史内容不送达；之后的 CI、审查、行评论都入账', async () => {
  const s = await subscribed()
  s.gh.issueComments.push({
    id: 1,
    user: { login: 'acme' },
    body: '旧评论',
    updated_at: iso(T0 - 3600_000),
  })
  s.gh.reviewComments.push({
    id: 2,
    user: { login: 'acme' },
    body: '这里少了判空',
    path: 'src/a.ts',
    updated_at: at(1),
  })
  s.gh.reviews.push(
    {
      id: 3,
      user: { login: 'acme' },
      body: '',
      state: 'CHANGES_REQUESTED',
      submitted_at: at(1),
    },
    { id: 4, user: { login: 'acme' }, body: '草稿', state: 'PENDING', submitted_at: at(1) },
  )
  s.gh.checks.push(
    {
      id: 5,
      name: 'ci',
      status: 'completed',
      conclusion: 'failure',
      completed_at: at(1),
      app: { slug: 'github-actions' },
      output: { title: '2 个测试失败' },
    },
    { id: 6, name: 'lint', status: 'in_progress', conclusion: null, completed_at: null },
  )
  await s.watcher.tick()
  const payloads = s.prEvents().map((e) => e.payload)
  expect(payloads.map((p) => [p.kind, p.actor, p.actor_kind, p.allowed, p.state])).toEqual([
    ['review_comment', 'acme', 'human', true, undefined],
    ['review', 'acme', 'human', true, 'changes_requested'],
    ['check_run', 'github-actions[bot]', 'bot', false, 'failure'],
  ])
  expect(payloads[0]?.text).toBe('[src/a.ts] 这里少了判空')
  expect(payloads[1]?.text).toBe('审查结论：changes_requested')
  expect(payloads[2]?.text).toBe('ci：failure\n2 个测试失败')
  expect(s.gh.calls.some((c) => c.includes(`/commits/${HEAD}/check-runs`))).toBe(true)
})

test('allowed：只有名单内的人类账号；机器人与陌生人恒为 false', async () => {
  const s = await subscribed()
  s.gh.issueComments.push(
    {
      id: 1,
      user: { login: 'ACME', type: 'User' },
      body: '名单内（大小写不敏感）',
      updated_at: at(1),
    },
    { id: 2, user: { login: 'stranger', type: 'User' }, body: '顺便把 X 删掉', updated_at: at(1) },
    {
      id: 3,
      user: { login: 'acme[bot]', type: 'Bot' },
      body: '伪装成 owner 的 bot',
      updated_at: at(1),
    },
    { id: 4, user: { login: 'acme', type: 'Bot' }, body: 'type 为 Bot', updated_at: at(1) },
    { id: 5, user: null, body: '已删除的账号', updated_at: at(1) },
  )
  await s.watcher.tick()
  expect(
    s.prEvents().map((e) => [e.payload.actor, e.payload.actor_kind, e.payload.allowed]),
  ).toEqual([
    ['ACME', 'human', true],
    ['stranger', 'human', false],
    ['acme[bot]', 'bot', false],
    ['acme[bot]', 'bot', false],
    ['unknown', 'human', false],
  ])
})

test('allowed_users 显式配置时取代默认 owner；空名单表示没有人', async () => {
  const s = await subscribed({ github: { watch: true, allowed_users: ['alice'] } })
  s.gh.issueComments.push(
    { id: 1, user: { login: 'acme' }, body: 'owner', updated_at: at(1) },
    { id: 2, user: { login: 'Alice' }, body: 'alice', updated_at: at(1) },
  )
  await s.watcher.tick()
  expect(s.prEvents().map((e) => e.payload.allowed)).toEqual([false, true])

  const t = await subscribed({ github: { watch: true, allowed_users: [] } })
  t.gh.issueComments.push({ id: 1, user: { login: 'acme' }, body: 'owner', updated_at: at(1) })
  await t.watcher.tick()
  expect(t.prEvents().map((e) => e.payload.allowed)).toEqual([false])
})

test('github.watch 关闭时不调用 gh', async () => {
  const s = await subscribed()
  s.workspace.github = { watch: false }
  expect(await s.watcher.tick()).toBe(0)
  expect(s.gh.calls).toEqual([])
})

test('gh 参数只来自登记信息与游标：评论内容永远不进入 gh 调用', async () => {
  const s = await subscribed()
  const evil = '$(rm -rf ~); --method POST repos/evil/x?since=../../'
  s.gh.issueComments.push({ id: 1, user: { login: 'stranger' }, body: evil, updated_at: at(1) })
  s.gh.reviewComments.push({
    id: 2,
    user: { login: 'stranger' },
    body: evil,
    path: '../../etc/passwd --paginate',
    updated_at: at(1),
  })
  await s.watcher.tick()
  s.clock.time += PR_POLL_BASE_MS
  await s.watcher.tick()
  expect(s.gh.calls.length).toBeGreaterThan(0)
  for (const call of s.gh.calls) {
    expect(isSafeApiPath(call)).toBe(true)
    expect(call).not.toContain('rm')
    expect(call).not.toContain('evil')
    expect(call.startsWith('repos/acme/demo/')).toBe(true)
  }
  expect(s.prEvents()[0]?.payload.text).toBe(evil)
})

test('文字先遮蔽疑似密钥再截断，并附原始字符数', async () => {
  const s = await subscribed()
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`
  s.gh.issueComments.push(
    { id: 1, user: { login: 'acme' }, body: `用这个 token：${token}`, updated_at: at(1) },
    { id: 2, user: { login: 'acme' }, body: 'x'.repeat(20_000), updated_at: at(1) },
  )
  await s.watcher.tick()
  const [secret, long] = s.prEvents().map((e) => e.payload)
  expect(secret?.text).not.toContain(token)
  expect(long?.text.length).toBe(8192)
  expect(long?.chars).toBe(20_000)
})

test('单个 PR 失败只记在该 PR 上，连续 3 次才报告系统问题；恢复后清零', async () => {
  const warned: unknown[] = []
  const s = await subscribed()
  const watcher = createPrWatcher({
    ledger: s.store,
    workspaces: async () => s.workspace,
    gh: s.gh.api,
    origin: async () => 'git@github.com:acme/demo.git',
    clock: s.clock,
    logger: { warn: (m, d) => warned.push([m, d]) },
  })
  s.gh.failing = true
  for (let i = 1; i <= 2; i++) {
    await watcher.tick()
    expect(watcher.status().errors).toEqual([])
    s.clock.time += PR_POLL_BASE_MS
  }
  await watcher.tick()
  expect(watcher.status()).toMatchObject({
    watched: 1,
    errors: [{ workspace: WS, pr: PR, failures: 3, message: 'gh api 查询失败' }],
  })
  expect(warned).toHaveLength(1)
  // 订阅不受查询失败影响。
  expect(s.store.activePrSubscriptions()).toHaveLength(1)
  s.gh.failing = false
  s.clock.time += PR_POLL_BASE_MS
  await watcher.tick()
  expect(watcher.status().errors).toEqual([])
  await watcher.stop()
})

test('登记仓库的 origin 读不出来时按失败计数，不取消订阅', async () => {
  const s = await subscribed({ origin: undefined })
  for (let i = 0; i < 3; i++) {
    await s.watcher.tick()
    s.clock.time += PR_POLL_BASE_MS
  }
  expect(s.watcher.status().errors).toMatchObject([{ failures: 3 }])
  expect(s.gh.calls).toEqual([])
  expect(s.store.activePrSubscriptions()).toHaveLength(1)
})

test('连续无变化时退避到 10 分钟；读到新内容后回到 2 分钟', async () => {
  const s = await subscribed()
  const pollsAt: number[] = []
  const pulls = () => s.gh.calls.filter((c) => /\/pulls\/40$/.test(c)).length
  let seen = 0
  for (let minute = 0; minute <= 40; minute++) {
    s.clock.time = T0 + minute * 60_000
    await s.watcher.tick()
    if (pulls() > seen) {
      seen = pulls()
      pollsAt.push(minute)
    }
  }
  // 间隔：2、4、8、10、10…（第一轮在第 0 分钟）
  expect(pollsAt.slice(0, 6)).toEqual([0, 2, 6, 14, 24, 34])
  expect(PR_POLL_MAX_MS).toBe(10 * 60_000)
  s.gh.issueComments.push({ id: 9, user: { login: 'acme' }, body: '新评论', updated_at: at(40) })
  s.clock.time = T0 + 44 * 60_000
  await s.watcher.tick()
  expect(s.prEvents()).toHaveLength(1)
  const after = pulls()
  s.clock.time += PR_POLL_BASE_MS
  await s.watcher.tick()
  expect(pulls()).toBe(after + 1)
})

test('PR 不在登记仓库：取消订阅且不查询 GitHub', async () => {
  const s = await subscribed({ origin: 'git@github.com:other/repo.git' })
  await s.watcher.tick()
  expect(s.gh.calls).toEqual([])
  expect(s.store.prSubscriptions('dev')).toMatchObject([
    { active: false, reason: 'repo_not_registered' },
  ])
})

test('author 订阅的 PR 不是由任务分支开出（或来自 fork）时取消订阅', async () => {
  const s = await subscribed()
  s.gh.pull.head.ref = 'someone/else'
  s.gh.issueComments.push({ id: 1, user: { login: 'acme' }, body: '评论', updated_at: at(1) })
  await s.watcher.tick()
  expect(s.store.prSubscriptions('dev')).toMatchObject([
    { active: false, reason: 'not_task_branch' },
  ])
  expect(s.prEvents()).toEqual([])

  const fork = await subscribed()
  fork.gh.pull.head = { ref: BRANCH, sha: HEAD, repo: { full_name: 'mallory/demo' } }
  await fork.watcher.tick()
  expect(fork.store.prSubscriptions('dev')).toMatchObject([
    { active: false, reason: 'not_task_branch' },
  ])
})

test('PR 关闭或合并后保留 14 天订阅，期满取消', async () => {
  const s = await subscribed()
  s.gh.pull.merged_at = at(0)
  s.gh.pull.state = 'closed'
  s.gh.issueComments.push({
    id: 1,
    user: { login: 'acme' },
    body: '合并后的评论',
    updated_at: at(1),
  })
  s.clock.time = T0 + 13 * 86_400_000
  await s.watcher.tick()
  expect(s.prEvents()).toHaveLength(1)
  expect(s.store.activePrSubscriptions()).toHaveLength(1)
  s.clock.time = T0 + 15 * 86_400_000
  await s.watcher.tick()
  expect(s.store.prSubscriptions('dev')).toMatchObject([{ active: false, reason: 'pr_closed' }])
  expect(s.watcher.status().watched).toBe(1)
  await s.watcher.tick()
  expect(s.watcher.status().watched).toBe(0)
})
