import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeGithubConfig } from '../src/doctor.ts'
import { compareCursor, makeCursor } from '../src/ledger/pr-subscription.ts'
import { githubConfigSchema } from '../src/schema/github.ts'
import { loadWorkspaces } from '../src/workspaces.ts'
import { tempHome, writeText } from './helpers.ts'

test('github 段缺省为不轮询、未配置名单；global 同样不轮询', async () => {
  const home = tempHome('raindown-ws-github-')
  const base = 'kind: product\nname: 测试\ndescription: 测试\nrepos: []\n'
  writeText(join(home, 'config/workspaces/plain.yaml'), `id: plain\n${base}`)
  writeText(
    join(home, 'config/workspaces/watched.yaml'),
    `id: watched\n${base}github:\n  watch: true\n  allowed_users: [alice, Bob-2]\n`,
  )
  writeText(join(home, 'config/workspaces/typo.yaml'), `id: typo\n${base}github:\n  wach: true\n`)
  const r = await loadWorkspaces(home)
  if (!r.ok) throw new Error(r.error.message)
  const byId = new Map(r.data.workspaces.map((w) => [w.id, w]))
  expect(byId.get('plain')?.github).toEqual({ watch: false })
  expect(byId.get('global')?.github).toEqual({ watch: false })
  expect(byId.get('watched')?.github).toEqual({ watch: true, allowed_users: ['alice', 'Bob-2'] })
  // 拼错的键不被静默忽略：整个文件报错、不加载。
  expect(byId.has('typo')).toBe(false)
  expect(r.data.issues.some((i) => i.file === 'config/workspaces/typo.yaml')).toBe(true)
})

test('allowed_users 只接受合法的 GitHub 用户名', () => {
  for (const bad of ['', '-x', 'a b', 'evil;rm', 'x'.repeat(40), 'bot[bot]']) {
    expect(githubConfigSchema.safeParse({ allowed_users: [bad] }).success).toBe(false)
  }
  expect(githubConfigSchema.parse({})).toEqual({ watch: false })
})

test('doctor 显示：开关、名单与安全含义', () => {
  expect(describeGithubConfig({ watch: false })).toContain('不轮询 PR')
  const watched = describeGithubConfig({ watch: true })
  expect(watched).toContain('轮询有订阅的 PR')
  expect(watched).toContain('登记仓库 origin 的 owner')
  expect(watched).toContain('不可信上下文')
  expect(describeGithubConfig({ watch: true, allowed_users: [] })).toContain('没有人的评论算请求')
  expect(describeGithubConfig({ watch: true, allowed_users: ['alice'] })).toContain('alice')
})

test('游标按 (时间, id) 比较', () => {
  const a = makeCursor('2026-10-24T00:00:00Z', 5) as string
  expect(a).toBe('2026-10-24T00:00:00.000Z|5')
  expect(compareCursor(a, makeCursor('2026-10-24T00:00:00.000Z', 6) as string)).toBe(-1)
  expect(compareCursor(makeCursor('2026-10-24T00:00:01Z', 1) as string, a)).toBe(1)
  expect(compareCursor(a, a)).toBe(0)
  expect(makeCursor('bad', 1)).toBeUndefined()
  expect(makeCursor('2026-10-24T00:00:00Z', '1;x')).toBeUndefined()
})

test('worker_identity：用户名或 <app>[bot]，doctor 显示', () => {
  expect(githubConfigSchema.parse({ worker_identity: 'raindown-bot' }).worker_identity).toBe(
    'raindown-bot',
  )
  expect(githubConfigSchema.parse({ worker_identity: 'my-app[bot]' }).worker_identity).toBe(
    'my-app[bot]',
  )
  for (const bad of ['a b', 'x[bot]y', '-x']) {
    expect(githubConfigSchema.safeParse({ worker_identity: bad }).success).toBe(false)
  }
  expect(describeGithubConfig({ watch: true, worker_identity: 'raindown-bot' })).toContain(
    'worker 身份：raindown-bot',
  )
  expect(describeGithubConfig({ watch: true })).toContain('worker 身份：未配置')
})
