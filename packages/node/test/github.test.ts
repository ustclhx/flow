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
