import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIFF_STAT_MAX } from '@flow/core'
import {
  checkGhEnv,
  checkPushEnv,
  computeDiffStat,
  credentialAllowed,
  FORBIDDEN_GIT_CONFIG,
  FORBIDDEN_GIT_ENV,
  forbiddenGitConfig,
  nodeEnvReport,
  parseRemoteUrl,
  parseScopedConfig,
  type RepoEnvOptions,
  snapshotRepo,
  snapshotRepoResult,
} from '../src/push-env.ts'
import { neutralizeDrivers } from '../src/safe-git.ts'
import { type GitFixture, gitFixture, ORIGIN_URL, TASK_BRANCH } from './git-fixture.ts'

/**
 * 节点侧推送与 gh 环境检查（add-m1-supervisor D15、tasks 5.6）：本地临时仓库 + 假 gh，
 * 不联网、不读写用户真实的 git 配置。任何不确定都应判为不通过。
 */

let f: GitFixture | undefined
afterEach(() => {
  f?.cleanup()
  f = undefined
})
const fixture = () => {
  f = gitFixture()
  return f
}
const SNAPSHOT = { remote_url: ORIGIN_URL, default_branch: 'main' }
const opts = (g: GitFixture, over: Partial<RepoEnvOptions> = {}): RepoEnvOptions => ({
  registeredRepos: [g.repo],
  snapshot: SNAPSHOT,
  taskBranch: TASK_BRANCH,
  run: g.run,
  env: g.env,
  ...over,
})
const push = (g: GitFixture, over: Partial<Parameters<typeof checkPushEnv>[0]> = {}) => ({
  cwd: g.worktree,
  remote: 'origin',
  src: TASK_BRANCH,
  dst: TASK_BRANCH,
  ...over,
})

describe('推送环境检查清单（常量）', () => {
  test.each([
    'core.sshcommand',
    'core.gitproxy',
    'core.askpass',
    'core.fsmonitor',
    'core.hookspath',
    'core.alternaterefscommand',
    'remote.origin.receivepack',
    'remote.origin.uploadpack',
    'remote.origin.push',
    'remote.origin.vcs',
    'remote.origin.proxy',
    'remote.origin.mirror',
    'push.recursesubmodules',
    'push.gpgsign',
    'push.pushoption',
    'submodule.recurse',
    'include.path',
    'includeif.gitdir:~/x/.path',
    'hook.pre-push.command',
    'Hook.Pre-Push.Command',
  ])('任何作用域都禁用：%s', (key) => {
    for (const scope of ['system', 'global', 'local', 'worktree']) {
      expect(forbiddenGitConfig([{ scope, key }])?.key).toBe(key)
    }
  })

  test.each([
    'core.pager',
    'pager.log',
    'url.https://evil.example/.insteadof',
    'url.git@evil:.pushinsteadof',
    'http.proxy',
    'http.https://github.com/.extraheader',
    'gpg.program',
    'gpg.ssh.program',
    'protocol.ext.allow',
    'filter.lfs.clean',
    'filter.Evil.clean',
    'diff.external',
    'diff.md.textconv',
  ])('只在 local / worktree 禁用：%s', (key) => {
    expect(forbiddenGitConfig([{ scope: 'local', key }])?.key).toBe(key)
    expect(forbiddenGitConfig([{ scope: 'worktree', key }])?.key).toBe(key)
    expect(forbiddenGitConfig([{ scope: 'global', key }])).toBeUndefined()
    expect(forbiddenGitConfig([{ scope: 'system', key }])).toBeUndefined()
  })

  test.each(['user.name', 'remote.origin.url', 'remote.origin.fetch', 'core.editor'])(
    '允许：%s',
    (key) => {
      expect(forbiddenGitConfig([{ scope: 'local', key }])).toBeUndefined()
    },
  )

  test('credential：local / worktree 中任何一项都拒绝；system / global 只允许 helper', () => {
    expect(credentialAllowed('global', 'credential.helper')).toBe(true)
    expect(credentialAllowed('system', 'credential.https://github.com.helper')).toBe(true)
    expect(credentialAllowed('unknown', 'credential.helper')).toBe(true)
    expect(credentialAllowed('local', 'credential.helper')).toBe(false)
    expect(credentialAllowed('worktree', 'credential.helper')).toBe(false)
    expect(credentialAllowed('global', 'credential.username')).toBe(false)
    expect(forbiddenGitConfig([{ scope: 'local', key: 'credential.helper' }])).toBeDefined()
    // 节点自己的 -c（command 作用域）不计。
    expect(forbiddenGitConfig([{ scope: 'command', key: 'core.fsmonitor' }])).toBeUndefined()
  })

  test('清单内容固定（变更须同步文档与测试）', () => {
    expect(FORBIDDEN_GIT_CONFIG.map((c) => c.pattern.source)).toMatchSnapshot()
    expect(FORBIDDEN_GIT_ENV).toMatchSnapshot()
  })

  test('parseScopedConfig：按 scope\\0key\\nvalue\\0 解析；格式不对视为无法解析', () => {
    expect(
      parseScopedConfig('global\0core.sshCommand\nssh -v\0local\0user.name\nA B\0local\0flag\0'),
    ).toEqual([
      { scope: 'global', key: 'core.sshCommand', value: 'ssh -v' },
      { scope: 'local', key: 'user.name', value: 'A B' },
      { scope: 'local', key: 'flag', value: '' },
    ])
    expect(parseScopedConfig('local\0bad key\nx\0')).toBeUndefined()
    expect(parseScopedConfig('local\0')).toBeUndefined()
  })

  test.each([
    ['https://github.com/acme/demo.git', 'github.com', 'acme', 'demo'],
    ['git@github.com:acme/demo.git', 'github.com', 'acme', 'demo'],
    ['ssh://git@github.com/acme/demo.git', 'github.com', 'acme', 'demo'],
  ])('可识别的远端地址：%s', (url, host, owner, repo) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, repo })
  })

  test.each([
    '/srv/git/demo.git',
    'file:///srv/git/demo.git',
    'ext::sh -c touch% /tmp/pwned',
    'https://github.com/acme/demo.git extra',
    'http://github.com/acme/demo.git',
  ])('不接受的远端地址：%s', (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined()
  })
})

describe('snapshotRepo', () => {
  test('登记仓库：origin 地址与默认分支', async () => {
    const g = fixture()
    expect(await snapshotRepo(g.repo, opts(g))).toEqual(SNAPSHOT)
  })

  test('没有 origin/HEAD：省略默认分支', async () => {
    const g = fixture()
    g.git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'])
    expect(await snapshotRepo(g.repo, opts(g))).toEqual({ remote_url: ORIGIN_URL })
  })

  test('多个 origin 地址、非 github.com、worktree 而非登记仓库本身、未登记：没有快照', async () => {
    const g = fixture()
    expect(await snapshotRepo(g.worktree, opts(g))).toBeUndefined()
    expect(await snapshotRepo(g.repo, opts(g, { registeredRepos: [] }))).toBeUndefined()
    g.git(['config', '--add', 'remote.origin.url', 'https://github.com/evil/demo.git'])
    expect(await snapshotRepo(g.repo, opts(g))).toBeUndefined()
    g.git(['config', '--unset-all', 'remote.origin.url'])
    g.git(['config', 'remote.origin.url', 'https://gitlab.example.com/acme/demo.git'])
    expect(await snapshotRepo(g.repo, opts(g))).toBeUndefined()
  })
})

describe('checkPushEnv（本地临时仓库）', () => {
  test('干净的 worktree：通过（global 的 credential.helper 允许）', async () => {
    const g = fixture()
    expect(await checkPushEnv(push(g), opts(g))).toEqual({ ok: true })
    expect(await checkPushEnv(push(g, { cwd: g.repo }), opts(g))).toEqual({ ok: true })
  })

  test.each([
    ['core.sshCommand', 'sh -c "curl evil"'],
    ['core.hooksPath', '/tmp/hooks'],
    ['core.fsmonitor', 'true'],
    ['core.pager', 'less'],
    ['url.https://evil.example/.insteadOf', 'https://github.com/'],
    ['url.https://evil.example/.pushInsteadOf', 'https://github.com/'],
    ['remote.origin.receivepack', 'sh -c x'],
    ['remote.origin.push', 'refs/heads/*:refs/heads/main'],
    ['remote.origin.proxy', 'http://proxy.example'],
    ['remote.origin.mirror', 'true'],
    ['push.recurseSubmodules', 'on-demand'],
    ['http.proxy', 'http://proxy.example'],
    ['http.https://github.com/.extraHeader', 'X: y'],
    ['gpg.program', '/tmp/x'],
    ['protocol.ext.allow', 'always'],
    ['filter.lfs.clean', 'git-lfs clean -- %f'],
    ['diff.md.textconv', 'cat'],
    ['hook.pre-push.command', 'sh -c x'],
    ['credential.helper', 'store'],
  ])('仓库配置 %s：不通过', async (key, value) => {
    const g = fixture()
    g.git(['config', key, value])
    expect((await checkPushEnv(push(g), opts(g))).ok).toBe(false)
  })

  test('include 进来的配置（include.path 本身即禁用）', async () => {
    const g = fixture()
    const inc = join(g.root, 'inc.gitconfig')
    writeFileSync(inc, '[user]\n\tname = x\n')
    g.git(['config', 'include.path', inc])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({
      ok: false,
      reason: 'config:include.path',
    })
  })

  test('全局配置中的禁用项同样不通过（global 取自节点的 HOME）', async () => {
    const g = fixture()
    g.git(['config', '--global', 'core.sshCommand', 'ssh -o ProxyCommand=x'])
    expect((await checkPushEnv(push(g), opts(g))).ok).toBe(false)
  })

  test('多值地址：url 有两个、pushurl 有两个或指向别处时不通过；pushurl 与 url 相同则通过', async () => {
    const g = fixture()
    g.git(['config', 'remote.origin.pushurl', ORIGIN_URL])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({ ok: true })
    g.git(['config', '--add', 'remote.origin.pushurl', ORIGIN_URL])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({ ok: false, reason: 'pushurl_mismatch' })
    g.git(['config', '--unset-all', 'remote.origin.pushurl'])
    g.git(['config', 'remote.origin.pushurl', 'https://github.com/evil/demo.git'])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({ ok: false, reason: 'pushurl_mismatch' })
    g.git(['config', '--unset-all', 'remote.origin.pushurl'])
    g.git(['config', '--add', 'remote.origin.url', ORIGIN_URL])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({
      ok: false,
      reason: 'remote_url_mismatch',
    })
  })

  test('与快照比对：地址被改、快照缺失或不是 github.com、未知 remote：不通过', async () => {
    const g = fixture()
    expect((await checkPushEnv(push(g), opts(g, { snapshot: undefined }))).ok).toBe(false)
    expect(
      (
        await checkPushEnv(
          push(g),
          opts(g, { snapshot: { remote_url: 'https://gitlab.example.com/acme/demo.git' } }),
        )
      ).ok,
    ).toBe(false)
    expect((await checkPushEnv(push(g, { remote: 'upstream' }), opts(g))).ok).toBe(false)
    g.git(['remote', 'set-url', 'origin', 'https://github.com/evil/demo.git'])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({
      ok: false,
      reason: 'remote_url_mismatch',
    })
  })

  test('来源必须解析为任务分支', async () => {
    const g = fixture()
    expect(await checkPushEnv(push(g), opts(g, { taskBranch: 'ustclhx/other' }))).toEqual({
      ok: false,
      reason: 'source_not_task_branch',
    })
    expect((await checkPushEnv(push(g), opts(g, { taskBranch: undefined }))).ok).toBe(false)
  })

  test('hook：只有 .sample 通过；pre-push（即使不可执行）、目录或符号链接不通过', async () => {
    const g = fixture()
    const hooks = join(g.repo, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-push.sample'), '#!/bin/sh\n')
    expect((await checkPushEnv(push(g), opts(g))).ok).toBe(true)
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(hooks, 'pre-push'), 0o644)
    expect(await checkPushEnv(push(g), opts(g))).toEqual({
      ok: false,
      reason: 'hook_enabled:pre-push',
    })
    rmSync(join(hooks, 'pre-push'))
    symlinkSync('/bin/sh', join(hooks, 'x.sample'))
    expect((await checkPushEnv(push(g), opts(g))).ok).toBe(false)
  })

  test('本地有与任务分支同名的 tag：不通过', async () => {
    const g = fixture()
    g.git(['tag', TASK_BRANCH])
    expect(await checkPushEnv(push(g), opts(g))).toEqual({
      ok: false,
      reason: `tag_conflict:${TASK_BRANCH}`,
    })
  })

  test('gitdir 不指向登记仓库：不通过', async () => {
    const g = fixture()
    expect((await checkPushEnv(push(g), opts(g, { registeredRepos: [] }))).ok).toBe(false)
    mkdirSync(join(g.worktree, 'sub'))
    expect((await checkPushEnv(push(g, { cwd: join(g.worktree, 'sub') }), opts(g))).ok).toBe(false)
    writeFileSync(join(g.worktree, '.git'), 'gitdir: ./.evil\n')
    expect((await checkPushEnv(push(g), opts(g))).ok).toBe(false)
  })

  test.each([...FORBIDDEN_GIT_ENV, 'GIT_CONFIG_KEY_0'])('worker 环境有 %s：不通过', async (key) => {
    const g = fixture()
    expect(await checkPushEnv(push(g), opts(g, { env: { ...g.env, [key]: 'x' } }))).toMatchObject({
      ok: false,
    })
  })

  test('git 命令失败（找不到程序）：不通过，不抛出', async () => {
    const g = fixture()
    const broken = opts(g, {
      run: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    expect((await checkPushEnv(push(g), broken)).ok).toBe(false)
  })
})

describe('checkGhEnv', () => {
  test('gh 解析出的仓库与快照一致：通过；不一致、失败、大小写不同：不通过', async () => {
    const g = fixture()
    expect(await checkGhEnv({ cwd: g.worktree }, opts(g))).toEqual({ ok: true })
    g.gh.repo = 'evil/demo'
    expect(await checkGhEnv({ cwd: g.worktree }, opts(g))).toEqual({
      ok: false,
      reason: 'gh_repo_mismatch',
    })
    g.gh.repo = 'ACME/demo'
    expect((await checkGhEnv({ cwd: g.worktree }, opts(g))).ok).toBe(false)
    g.gh.repo = undefined
    expect(await checkGhEnv({ cwd: g.worktree }, opts(g))).toEqual({
      ok: false,
      reason: 'gh_failed',
    })
  })

  test('GH_REPO / GH_HOST、没有快照、gitdir 不指向登记仓库：不通过，且不调用 gh', async () => {
    const g = fixture()
    for (const key of ['GH_REPO', 'GH_HOST']) {
      expect(
        (await checkGhEnv({ cwd: g.worktree }, opts(g, { env: { ...g.env, [key]: 'x' } }))).ok,
      ).toBe(false)
    }
    expect((await checkGhEnv({ cwd: g.worktree }, opts(g, { snapshot: undefined }))).ok).toBe(false)
    expect((await checkGhEnv({ cwd: g.worktree }, opts(g, { registeredRepos: [] }))).ok).toBe(false)
    expect(g.gh.calls).toBe(0)
  })
})

describe('改动摘要与上报字段', () => {
  test('computeDiffStat：已提交部分的 stat 加未提交的文件列表；超长截断', async () => {
    const g = fixture()
    expect(await computeDiffStat(g.worktree, opts(g))).toBe('（相对任务基点没有改动）')
    writeFileSync(join(g.worktree, 'README.md'), '# demo\n改了\n加一行\n')
    g.git(['commit', '-qam', 'wip'], g.worktree)
    writeFileSync(join(g.worktree, 'new.txt'), 'x\n')
    writeFileSync(join(g.worktree, 'README.md'), '# demo\n又改了\n')
    const stat = await computeDiffStat(g.worktree, opts(g))
    expect(stat).toContain('已提交：')
    expect(stat).toContain('README.md | 2 ++')
    expect(stat).toContain('未提交：')
    expect(stat).toContain(' M README.md')
    expect(stat).toContain('?? new.txt')
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(g.worktree, `file-${i}-${'x'.repeat(40)}.txt`), 'x\n')
    }
    const long = await computeDiffStat(g.worktree, opts(g))
    expect(long?.length).toBeLessThanOrEqual(DIFF_STAT_MAX)
    expect(long?.endsWith('…')).toBe(true)
  })

  test('computeDiffStat：不是 git 目录或不属于登记仓库时省略', async () => {
    const g = fixture()
    const plain = mkdtempSync(join(tmpdir(), 'flow-not-git-'))
    try {
      expect(await computeDiffStat(plain, opts(g))).toBeUndefined()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
    expect(await computeDiffStat(g.worktree, opts(g, { registeredRepos: [] }))).toBeUndefined()
  })

  test('nodeEnvReport：推送命令带 push_env_ok；gh 命令带 gh_env_ok；其他只有 command_cwd', async () => {
    const g = fixture()
    const link = join(g.root, 'wt-link')
    symlinkSync(g.worktree, link)
    expect(await nodeEnvReport(`git push -u origin ${TASK_BRANCH}`, link, opts(g))).toEqual({
      command_cwd: g.worktree,
      push_env_ok: true,
    })
    expect(await nodeEnvReport('gh pr create --fill', g.worktree, opts(g))).toEqual({
      command_cwd: g.worktree,
      gh_env_ok: true,
    })
    expect(await nodeEnvReport('pnpm check', g.worktree, opts(g))).toEqual({
      command_cwd: g.worktree,
    })
    g.git(['config', 'core.sshCommand', 'evil'])
    expect(await nodeEnvReport(`git push origin ${TASK_BRANCH}`, g.worktree, opts(g))).toEqual({
      command_cwd: g.worktree,
      push_env_ok: false,
    })
    // gitdir 不指向登记仓库：不上报执行目录，推送环境判为不通过。
    expect(
      await nodeEnvReport(
        `git push origin ${TASK_BRANCH}`,
        g.worktree,
        opts(g, { registeredRepos: [] }),
      ),
    ).toEqual({ push_env_ok: false })
    expect(await nodeEnvReport('git push origin x', join(g.root, 'missing'), opts(g))).toEqual({
      push_env_ok: false,
    })
  })
})

describe('不执行 worker 控制的程序（审查第 1 条）', () => {
  /** 写标记文件的脚本：被执行时会创建 marker。 */
  const marker = (g: GitFixture, name: string) => {
    const path = join(g.root, `${name}.marker`)
    const script = join(g.root, `${name}.sh`)
    writeFileSync(script, `#!/bin/sh\ntouch '${path}'\ncat\n`)
    chmodSync(script, 0o755)
    return { path, script }
  }

  test('gitfile 改指 worktree 里的 .evil（配置了 fsmonitor）：不计算，脚本不被执行', async () => {
    const g = fixture()
    const m = marker(g, 'fsmonitor')
    const evil = join(g.worktree, '.evil')
    // worker 在自己的 worktree 里造一个 gitdir，配置 core.fsmonitor，再改写 .git 指向它。
    g.git(['init', '-q', '--bare', evil])
    g.git(['--git-dir', evil, 'config', 'core.fsmonitor', m.script])
    g.git(['--git-dir', evil, 'config', 'core.bare', 'false'])
    writeFileSync(join(g.worktree, '.git'), 'gitdir: ./.evil\n')
    expect(await computeDiffStat(g.worktree, opts(g))).toBeUndefined()
    expect(await nodeEnvReport(`git push origin ${TASK_BRANCH}`, g.worktree, opts(g))).toEqual({
      push_env_ok: false,
    })
    expect(existsSync(m.path)).toBe(false)
  })

  test('反向指针不一致（gitdir 文件不指回本 worktree）：不计算', async () => {
    const g = fixture()
    const name = TASK_BRANCH.split('/').at(-1) ?? ''
    const admin = join(g.repo, '.git', 'worktrees')
    const entry = join(admin, require('node:fs').readdirSync(admin)[0] as string)
    expect(name).toBeTruthy()
    writeFileSync(join(entry, 'gitdir'), `${join(g.root, 'elsewhere', '.git')}\n`)
    expect(await computeDiffStat(g.worktree, opts(g))).toBeUndefined()
  })

  test('.git 是符号链接：不计算', async () => {
    const g = fixture()
    rmSync(join(g.worktree, '.git'))
    symlinkSync(join(g.repo, '.git'), join(g.worktree, '.git'))
    expect(await computeDiffStat(g.worktree, opts(g))).toBeUndefined()
  })

  test('配置里的 fsmonitor、hook、clean/smudge/process 过滤器、外部 diff、textconv 都被中和', async () => {
    const g = fixture()
    const fs = marker(g, 'fsmonitor')
    const clean = marker(g, 'clean')
    const proc = marker(g, 'process')
    const ext = marker(g, 'external')
    const conv = marker(g, 'textconv')
    const hook = marker(g, 'hook')
    // 放在 global 作用域（local 作用域里出现这些会直接不计算，见后面的测试），驱动名大小写混合。
    g.git(['config', '--global', 'core.fsmonitor', fs.script])
    g.git(['config', '--global', 'filter.Evil.clean', clean.script])
    g.git(['config', '--global', 'filter.Evil.smudge', clean.script])
    g.git(['config', '--global', 'filter.EVIL2.process', proc.script])
    g.git(['config', '--global', 'filter.Evil.required', 'true'])
    g.git(['config', '--global', 'diff.external', ext.script])
    g.git(['config', '--global', 'diff.Md.textconv', conv.script])
    g.git(['config', '--global', 'diff.Md.command', ext.script])
    mkdirSync(join(g.repo, '.git', 'hooks'), { recursive: true })
    for (const h of ['post-index-change', 'reference-transaction']) {
      writeFileSync(join(g.repo, '.git', 'hooks', h), `#!/bin/sh\ntouch '${hook.path}'\n`)
      chmodSync(join(g.repo, '.git', 'hooks', h), 0o755)
    }
    writeFileSync(
      join(g.worktree, '.gitattributes'),
      '*.txt filter=Evil\n*.dat filter=EVIL2\n*.md diff=Md\n',
    )
    writeFileSync(join(g.worktree, 'README.md'), '# demo\n改了\n')
    g.git(
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'wip'],
      g.worktree,
    )
    writeFileSync(join(g.worktree, 'a.txt'), 'x\n')
    writeFileSync(join(g.worktree, 'b.dat'), 'x\n')
    writeFileSync(join(g.worktree, 'README.md'), '# demo\n又改了\n')
    const stat = await computeDiffStat(g.worktree, opts(g))
    expect(stat).toContain('README.md')
    for (const m of [fs, clean, proc, ext, conv, hook]) expect(existsSync(m.path)).toBe(false)
  })

  test('混合大小写的 driver 名逐个中和（子节名区分大小写）', () => {
    expect(neutralizeDrivers('filter.Evil.clean\nx\0diff.Md.textconv\ny\0')).toEqual([
      '-c',
      'filter.Evil.clean=',
      '-c',
      'filter.Evil.smudge=',
      '-c',
      'filter.Evil.process=',
      '-c',
      'filter.Evil.required=false',
      '-c',
      'diff.Md.command=',
      '-c',
      'diff.Md.textconv=',
    ])
    expect(neutralizeDrivers('filter.a=b.clean\nx\0')).toBeUndefined()
  })

  test.each([
    ['filter.Evil.clean', 'clean'],
    ['diff.Md.textconv', 'textconv'],
    ['include.path', 'include'],
    ['core.fsmonitor', 'fsmonitor'],
    ['core.hooksPath', 'hooks'],
  ])('local 作用域里有 %s：不计算改动摘要，脚本不被执行', async (key, name) => {
    const g = fixture()
    const m = marker(g, name)
    g.git(['config', key, key === 'core.hooksPath' || key === 'include.path' ? g.root : m.script])
    writeFileSync(join(g.worktree, '.gitattributes'), '* filter=Evil diff=Md\n')
    writeFileSync(join(g.worktree, 'README.md'), '# demo\n改了\n')
    expect(await computeDiffStat(g.worktree, opts(g))).toBeUndefined()
    expect(existsSync(m.path)).toBe(false)
  })

  test('snapshotRepoResult 给出没有快照的原因', async () => {
    const g = fixture()
    const why = async (dir: string, o = opts(g)) => {
      const r = await snapshotRepoResult(dir, o)
      return r.ok ? 'ok' : r.reason
    }
    expect(await why(g.repo)).toBe('ok')
    expect(await why(g.worktree)).toBe('not_repo_root')
    expect(await why(g.repo, opts(g, { registeredRepos: [] }))).not.toBe('ok')
    g.git(['config', '--add', 'remote.origin.url', 'https://github.com/evil/demo.git'])
    expect(await why(g.repo)).toBe('origin_url_not_single')
    g.git(['config', '--unset-all', 'remote.origin.url'])
    g.git(['config', 'remote.origin.url', 'https://gitlab.example.com/acme/demo.git'])
    expect(await why(g.repo)).toBe('origin_not_github')
  })
})
