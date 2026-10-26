import { describe, expect, test } from 'bun:test'
import {
  type CommandOutput,
  type CommandRunner,
  createGitHubCli,
  parsePrUrl,
  parseRemoteUrl,
  sameRepo,
} from '../src/index.ts'
import { PR_URL, REPO } from './github-helpers.ts'

/** gh 封装与地址解析（add-m1-supervisor 5.2 / 5.4）。runner 注入假实现，绝不调用真实 gh。 */

function fakeRunner(reply: (args: readonly string[]) => CommandOutput) {
  const calls: Array<{ bin: string; args: readonly string[] }> = []
  const run: CommandRunner = async (bin, args) => {
    calls.push({ bin, args })
    return reply(args)
  }
  return { run, calls }
}
const out = (stdout: string, code = 0, stderr = ''): CommandOutput => ({ code, stdout, stderr })

describe('地址解析', () => {
  test('PR 链接', () => {
    expect(parsePrUrl(PR_URL)).toEqual({ url: PR_URL, ...REPO, number: 7 })
    for (const bad of [
      'https://github.com/acme/demo/pull/0',
      'https://github.com/acme/demo/pull/7/files',
      'http://github.com/acme/demo/pull/7',
      'https://github.com/acme/pull/7',
    ])
      expect(parsePrUrl(bad)).toBeUndefined()
  })

  test('remote 地址：https、ssh、scp 形式；本地路径、多级路径、带凭证与首尾空白拒绝', () => {
    for (const url of [
      'https://github.com/acme/demo.git',
      'https://github.com/acme/demo',
      'https://GitHub.com/acme/demo/',
      'git@github.com:acme/demo.git',
      'ssh://git@github.com/acme/demo.git',
      'ssh://git@github.com:22/acme/demo',
    ]) {
      const r = parseRemoteUrl(url)
      expect(r && sameRepo(r, REPO)).toBe(true)
    }
    expect(sameRepo({ host: 'github.com', owner: 'ACME', repo: 'Demo' }, REPO)).toBe(true)
    for (const url of [
      '/tmp/origin.git',
      'file:///tmp/origin.git',
      'https://github.com/acme/demo/extra',
      'https://user:secret@github.com/acme/demo.git',
      ' https://github.com/acme/demo.git',
      'https://github.com/acme/demo.git\n',
      'https://github.com/../demo',
      '',
    ])
      expect(parseRemoteUrl(url)).toBeUndefined()
    expect(sameRepo(parseRemoteUrl('https://example.com/acme/demo') ?? REPO, REPO)).toBe(false)
  })
})

describe('gh 封装', () => {
  test('每条命令都显式指定 PR 链接或 HOST/OWNER/REPO', async () => {
    const { run, calls } = fakeRunner(() => out('[]'))
    const gh = createGitHubCli({ run })
    await gh.runList(REPO, 'c'.repeat(40), 'main')
    await gh.prMerge(PR_URL, 'squash', 'a'.repeat(40))
    await gh.repoView(REPO)
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      `run list -R github.com/acme/demo --commit ${'c'.repeat(40)} --branch main --limit 100 --json databaseId,name,status,conclusion,url,headSha,event`,
      `pr merge ${PR_URL} --squash --match-head-commit ${'a'.repeat(40)}`,
      'repo view github.com/acme/demo --json nameWithOwner,defaultBranchRef',
    ])
    expect(calls.every((c) => c.bin === 'gh')).toBe(true)
  })

  test('pr checks：有失败或进行中时非零退出码仍以 JSON 为准；"no checks reported" 为空；其他错误返回失败', async () => {
    const checks = JSON.stringify([{ name: 'ci', state: 'PENDING', bucket: 'pending' }])
    expect(
      await createGitHubCli({ run: fakeRunner(() => out(checks, 8)).run }).prChecks(PR_URL),
    ).toMatchObject({
      ok: true,
      data: [{ bucket: 'pending' }],
    })
    expect(
      await createGitHubCli({
        run: fakeRunner(() => out('', 1, "no checks reported on the 'feature' branch")).run,
      }).prChecks(PR_URL),
    ).toEqual({ ok: true, data: [] })
    for (const o of [out('', 1, 'HTTP 502'), out('not json', 1), out('', 0)]) {
      const r = await createGitHubCli({ run: fakeRunner(() => o).run }).prChecks(PR_URL)
      expect(r.ok).toBe(false)
    }
  })

  test('输出不合 schema、非零退出码与找不到 gh 都返回失败', async () => {
    const bad = createGitHubCli({ run: fakeRunner(() => out('{"number":"7"}')).run })
    expect(await bad.prView(PR_URL)).toMatchObject({ ok: false, error: { code: 'gh_bad_output' } })
    const failing = createGitHubCli({ run: fakeRunner(() => out('', 1, 'boom')).run })
    expect(await failing.prDiff(PR_URL)).toMatchObject({ ok: false, error: { code: 'gh_failed' } })
    expect(await failing.prMerge(PR_URL, 'merge', 'a'.repeat(40))).toMatchObject({ ok: false })
    const missing = createGitHubCli({
      run: async () => {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(await missing.prView(PR_URL)).toMatchObject({
      ok: false,
      error: { code: 'gh_not_found' },
    })
  })
})

describe('prSnapshot（GraphQL）', () => {
  const pr = parsePrUrl(PR_URL)
  if (!pr) throw new Error('PR 链接')
  const HEAD = 'a'.repeat(40)
  const run = (over: Record<string, unknown> = {}) => ({
    __typename: 'CheckRun',
    name: 'ci',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://ci/1',
    startedAt: '2026-10-26T08:00:00Z',
    checkSuite: {
      app: { slug: 'github-actions' },
      workflowRun: { event: 'pull_request', workflow: { name: 'CI' } },
    },
    ...over,
  })
  const response = (rollup: unknown, prOver: Record<string, unknown> = {}) =>
    JSON.stringify({
      data: {
        repository: {
          nameWithOwner: 'acme/demo',
          defaultBranchRef: { name: 'main' },
          pullRequest: {
            number: 7,
            url: PR_URL,
            state: 'OPEN',
            isDraft: false,
            baseRefName: 'main',
            headRefOid: HEAD,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            isMergeQueueEnabled: false,
            isInMergeQueue: false,
            autoMergeRequest: null,
            commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: rollup } }] },
            ...prOver,
          },
        },
      },
    })
  const contexts = (nodes: unknown[], over: Record<string, unknown> = {}) => ({
    contexts: { totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes, ...over },
  })
  const snap = async (stdout: string) => {
    const { run: runner, calls } = fakeRunner(() => out(stdout))
    return { r: await createGitHubCli({ run: runner }).prSnapshot(pr), calls }
  }

  test('参数：gh api graphql、--hostname、owner / name 为字符串、number 用 -F（整数）', async () => {
    const { r, calls } = await snap(response(contexts([run()])))
    expect(r.ok).toBe(true)
    const args = calls[0]?.args ?? []
    expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com'])
    expect(args).toContain('owner=acme')
    expect(args).toContain('name=demo')
    expect(args[args.indexOf('number=7') - 1]).toBe('-F')
    expect(args[args.indexOf('owner=acme') - 1]).toBe('-f')
    const query = args.find((a) => a.startsWith('query=')) ?? ''
    expect(query).toContain('statusCheckRollup')
    expect(query).toContain('isMergeQueueEnabled')
  })

  test('bucket 映射：CheckRun 与 StatusContext', async () => {
    const { r } = await snap(
      response(
        contexts([
          run({ name: 'a' }),
          run({ name: 'b', conclusion: 'SKIPPED' }),
          run({ name: 'c', conclusion: 'NEUTRAL' }),
          run({ name: 'd', conclusion: 'CANCELLED' }),
          run({ name: 'e', conclusion: 'TIMED_OUT' }),
          run({ name: 'f', status: 'IN_PROGRESS', conclusion: null }),
          { __typename: 'StatusContext', context: 's1', state: 'SUCCESS', targetUrl: null },
          { __typename: 'StatusContext', context: 's2', state: 'PENDING' },
          { __typename: 'StatusContext', context: 's3', state: 'EXPECTED' },
          { __typename: 'StatusContext', context: 's4', state: 'ERROR' },
        ]),
      ),
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(Object.fromEntries(r.data.checks.map((c) => [c.name, c.bucket]))).toEqual({
      a: 'pass',
      b: 'skipping',
      c: 'skipping',
      d: 'cancel',
      e: 'fail',
      f: 'pending',
      s1: 'pass',
      s2: 'pending',
      s3: 'pending',
      s4: 'fail',
    })
    expect(r.data).toMatchObject({
      checksOid: HEAD,
      checksTruncated: false,
      mergeQueue: false,
      autoMerge: false,
    })
  })

  test('null rollup：没有检查、不截断；没有提交时 checksOid 为空', async () => {
    const a = await snap(response(null))
    expect(a.r).toMatchObject({
      ok: true,
      data: { checks: [], checksTruncated: false, checksOid: HEAD },
    })
    const b = await snap(response(null, { commits: { nodes: [] } }))
    expect(b.r).toMatchObject({ ok: true, data: { checks: [] } })
    if (b.r.ok) expect(b.r.data.checksOid).toBeUndefined()
  })

  test('截断：还有下一页或总数多于返回的条目', async () => {
    for (const over of [{ pageInfo: { hasNextPage: true } }, { totalCount: 101 }]) {
      const { r } = await snap(response(contexts([run()], over)))
      expect(r).toMatchObject({ ok: true, data: { checksTruncated: true } })
    }
  })

  test('未知 __typename 或缺字段：gh_bad_output（判失败）', async () => {
    for (const bad of [
      response(contexts([{ __typename: 'FutureCheck', name: 'x' }])),
      response(contexts([run({ status: undefined })])),
      response(null, { isMergeQueueEnabled: undefined }),
      '{"errors":[{"message":"x"}]}',
    ]) {
      const { r } = await snap(bad)
      expect(r).toMatchObject({ ok: false, error: { code: 'gh_bad_output' } })
    }
  })

  test('同一检查的多次运行只保留最新的一条；排队中的重跑（没有 startedAt）视为最新', async () => {
    const { r } = await snap(
      response(
        contexts([
          run({ conclusion: 'FAILURE', startedAt: '2026-10-26T08:00:00Z' }),
          run({ conclusion: 'SUCCESS', startedAt: '2026-10-26T09:00:00Z' }),
          run({ name: 'lint', conclusion: 'SUCCESS', startedAt: '2026-10-26T08:00:00Z' }),
          run({ name: 'lint', status: 'QUEUED', conclusion: null, startedAt: null }),
          // 不同 workflow 的同名检查分别保留。
          run({
            conclusion: 'FAILURE',
            checkSuite: {
              app: { slug: 'github-actions' },
              workflowRun: { event: 'push', workflow: { name: 'Deploy' } },
            },
          }),
        ]),
      ),
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.checks.map((c) => `${c.name}:${c.bucket}`).sort()).toEqual([
      'ci:fail',
      'ci:pass',
      'lint:pending',
    ])
  })
})
