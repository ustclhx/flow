import { expect, test } from 'bun:test'
import {
  allowedLogins,
  createGhApi,
  type ExecFileLike,
  githubPaths,
  isSafeApiPath,
  registeredGithubRepos,
} from '../src/pr/github.ts'

const repo = { host: 'github.com', owner: 'acme', repo: 'demo' }

test('gh 路径构造只接受登记信息：非法 owner、编号、sha、since 一律抛出', () => {
  expect(githubPaths.pull(repo, 40)).toBe('repos/acme/demo/pulls/40')
  expect(githubPaths.issueComments(repo, 40, 1, '2026-10-24T00:00:00.000Z')).toBe(
    'repos/acme/demo/issues/40/comments?per_page=100&page=1&since=2026-10-24T00:00:00.000Z',
  )
  expect(() => githubPaths.pull({ ...repo, owner: 'a/b' }, 1)).toThrow()
  expect(() => githubPaths.pull({ ...repo, owner: '..' }, 1)).toThrow()
  expect(() => githubPaths.pull({ ...repo, host: 'evil.example' }, 1)).toThrow()
  expect(() => githubPaths.pull(repo, 0)).toThrow()
  expect(() => githubPaths.checkRuns(repo, 'HEAD; rm -rf', 1)).toThrow()
  expect(() => githubPaths.issueComments(repo, 1, 1, '2026&per_page=1')).toThrow()
  for (const path of [
    githubPaths.pull(repo, 1),
    githubPaths.reviews(repo, 1, 2),
    githubPaths.reviewComments(repo, 1, 1),
    githubPaths.checkRuns(repo, 'a'.repeat(40), 1),
  ]) {
    expect(isSafeApiPath(path)).toBe(true)
  }
})

test('白名单拒绝任何越界路径', () => {
  for (const bad of [
    'repos/acme/demo/pulls/1/merge',
    'repos/acme/demo/issues/1/comments?per_page=100&page=1&body=x',
    'repos/acme/demo/pulls/1 --method POST',
    '-X POST repos/acme/demo/pulls/1',
    'graphql',
    'repos/acme/../demo/pulls/1',
    'repos/acme/demo/pulls/1?per_page=100&page=1&since=2026-10-24T00:00:00Z&x=1',
  ]) {
    expect(isSafeApiPath(bad)).toBe(false)
  }
})

test('gh 以 execFile 只读调用：argv 固定、去掉改写目标的环境变量；越界路径不启动进程', async () => {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
  const exec: ExecFileLike = (file, args, opts, done) => {
    calls.push({ file, args, env: opts.env })
    done(null, '{"state":"open"}')
  }
  process.env.GH_REPO = 'evil/repo'
  process.env.GH_HOST = 'evil.example'
  try {
    const gh = createGhApi(exec)
    expect(await gh('repos/acme/demo/pulls/40')).toEqual({ ok: true, data: { state: 'open' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe('gh')
    expect(calls[0]?.args).toEqual([
      'api',
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      'repos/acme/demo/pulls/40',
    ])
    expect(calls[0]?.env.GH_REPO).toBeUndefined()
    expect(calls[0]?.env.GH_HOST).toBeUndefined()
    expect(await gh('repos/acme/demo/pulls/40/merge')).toMatchObject({
      ok: false,
      error: { code: 'unsafe_gh_path' },
    })
    expect(calls).toHaveLength(1)
  } finally {
    delete process.env.GH_REPO
    delete process.env.GH_HOST
  }
})

test('gh 失败或返回无效 JSON 时为可重试错误', async () => {
  const failing = createGhApi((_f, _a, _o, done) => done(new Error('exit 1'), ''))
  expect(await failing('repos/acme/demo/pulls/1')).toMatchObject({
    ok: false,
    error: { kind: 'retryable', code: 'gh_query_failed' },
  })
  const garbage = createGhApi((_f, _a, _o, done) => done(null, 'not json'))
  expect(await garbage('repos/acme/demo/pulls/1')).toMatchObject({ ok: false })
})

test('登记仓库：读不出 origin 的计入 unresolved；名单按 PR 所属仓库的 owner 计算', async () => {
  const origins: Record<string, string | undefined> = {
    '/a': 'git@github.com:Acme/demo.git',
    '/b': 'https://gitlab.com/other/x.git',
    '/c': undefined,
    '/d': 'https://github.com/acme/demo',
  }
  const r = await registeredGithubRepos(['/a', '/b', '/c', '/d'], async (p) => origins[p])
  expect(r).toEqual({ repos: [{ host: 'github.com', owner: 'Acme', repo: 'demo' }], unresolved: 1 })
  expect(allowedLogins({}, 'Acme')).toEqual(['acme'])
  expect(allowedLogins({ allowed_users: ['Bob'] }, 'Acme')).toEqual(['bob'])
  expect(allowedLogins({ allowed_users: [] }, 'Acme')).toEqual([])
  expect(allowedLogins({}, undefined)).toEqual([])
})

test('身份查询路径也在白名单内，且只接受合法用户名', () => {
  expect(githubPaths.self()).toBe('user')
  expect(githubPaths.user('acme')).toBe('users/acme')
  expect(isSafeApiPath('user')).toBe(true)
  expect(isSafeApiPath('users/acme')).toBe(true)
  expect(isSafeApiPath('users/acme/repos')).toBe(false)
  expect(() => githubPaths.user('a/b')).toThrow()
  expect(() => githubPaths.user('x[bot]')).toThrow()
  expect(
    isSafeApiPath(
      'repos/acme/demo/pulls/1/comments?per_page=100&page=1&sort=updated&direction=asc&since=2026-10-24T00:00:00.000Z',
    ),
  ).toBe(true)
})
