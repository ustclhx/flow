import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { type ExecOptions, execCommand, git } from '../src/git.ts'
import { initFlowHome } from '../src/init.ts'
import { initSecrets, loadSecrets, type SecretsOptions, setSecret } from '../src/secrets.ts'
import { GITLEAKS_TOML } from '../src/templates.ts'
import { scanForSecrets } from '../src/write/secrets.ts'
import { commitCount, snapshot, tempHome } from './helpers.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function setup() {
  const home = tempHome('flow-secret-provider-')
  roots.push(dirname(home))
  expect((await initFlowHome(home)).ok).toBe(true)
  return { home, config: join(home, 'config'), ageKeyFile: join(dirname(home), 'age/keys.txt') }
}
function fakeSops(ageKeyFile: string) {
  let data: unknown = {}
  const calls: { bin: string; args: string[]; opts: ExecOptions }[] = []
  const opts: SecretsOptions = {
    ageKeyFile,
    sopsBin: 'injected-sops',
    async exec(bin, args, options = {}) {
      if (bin !== 'injected-sops') return execCommand(bin, args, options)
      calls.push({ bin, args, opts: options })
      if (args.includes('--encrypt')) {
        data = JSON.parse(options.input as string)
        return {
          code: 0,
          stdout: `sops:\n  mac: ENC[AES256_GCM,data:fake-ciphertext-${calls.length},type:str]\n`,
          stderr: '',
        }
      }
      return { code: 0, stdout: JSON.stringify(data), stderr: '' }
    },
  }
  return {
    opts,
    calls,
    setData: (v: unknown) => {
      data = v
    },
  }
}

describe('密钥提供器（注入 sops）', () => {
  test('首次初始化：0600、精确规则、公开配置提交、备份提示；重跑不覆盖任何文件', async () => {
    const { home, config, ageKeyFile } = await setup()
    // 升级已存在的旧模板，不覆盖用户配置。
    await writeFile(join(config, '.gitleaks.toml'), `${GITLEAKS_TOML}\n# 用户配置\n`)
    const fake = fakeSops(ageKeyFile)
    const r = await initSecrets(home, fake.opts)
    expect(r).toMatchObject({ ok: true, data: { notice: expect.stringContaining('离线备份') } })
    expect((await stat(ageKeyFile)).mode & 0o777).toBe(0o600)
    const rules = parse(await readFile(join(config, '.sops.yaml'), 'utf8')).creation_rules
    expect(rules).toHaveLength(1)
    const pattern = new RegExp(rules[0].path_regex)
    expect(pattern.test('secrets.sops.yaml')).toBe(true)
    expect(pattern.test('other/secrets.sops.yaml')).toBe(false)
    expect(pattern.test('secretsXsopsXyaml')).toBe(false)
    expect(rules[0].age).toMatch(/^age1/)
    expect(await readFile(join(config, '.gitleaks.toml'), 'utf8')).toContain('# 用户配置')
    expect(await commitCount(config)).toBe(2)
    expect((await git(config, ['status', '--porcelain'])).stdout).toBe('')
    const before = snapshot(dirname(home))
    expect((await initSecrets(home, fake.opts)).ok).toBe(true)
    expect(snapshot(dirname(home))).toEqual(before)
    expect(fake.calls).toHaveLength(1)
    expect(await loadSecrets(home, fake.opts)).toEqual({ ok: true, data: new Map() })
  })

  test('解密→内存嵌套修改→stdin 加密；值和私钥不进 argv，所有 sops 显式指定密钥文件', async () => {
    const { home, config, ageKeyFile } = await setup()
    const fake = fakeSops(ageKeyFile)
    expect((await initSecrets(home, fake.opts)).ok).toBe(true)
    const value = 'test-value-not-a-secret-0001'
    expect((await setSecret(home, 'telegram/bot-token', value, fake.opts)).ok).toBe(true)
    expect((await setSecret(home, 'other/key', 'test-value-not-a-secret-0002', fake.opts)).ok).toBe(
      true,
    )
    const loaded = await loadSecrets(home, fake.opts)
    expect(loaded).toEqual({
      ok: true,
      data: new Map([
        ['telegram/bot-token', value],
        ['other/key', 'test-value-not-a-secret-0002'],
      ]),
    })
    const encrypted = fake.calls.filter((c) => c.args.includes('--encrypt'))
    expect(JSON.parse(encrypted[1]?.opts.input as string)).toEqual({
      telegram: { 'bot-token': value },
    })
    expect(fake.calls.slice(1, 3).map((c) => c.args[0])).toEqual(['-d', '--encrypt'])
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toContain(value)
      expect(call.opts.env?.SOPS_AGE_KEY_FILE).toBe(ageKeyFile)
      expect(call.opts.cwd).toBe(config)
    }
    expect(encrypted[1]?.args).toEqual([
      '--encrypt',
      '--config',
      '.sops.yaml',
      '--input-type',
      'json',
      '--output-type',
      'yaml',
      '--filename-override',
      'secrets.sops.yaml',
      '/dev/stdin',
    ])
    const allHistory = await git(config, ['log', '-p', '--all', '--format=fuller'])
    expect(allHistory.stdout).not.toContain(value)
    expect(allHistory.stdout).not.toContain(await readFile(ageKeyFile, 'utf8'))
  })

  test('非法路径、层级冲突、非法解密数据和工具失败均不泄漏或修改密文', async () => {
    const { home, config, ageKeyFile } = await setup()
    const fake = fakeSops(ageKeyFile)
    expect((await initSecrets(home, fake.opts)).ok).toBe(true)
    const before = await readFile(join(config, 'secrets.sops.yaml'), 'utf8')
    for (const path of ['a//b', '/a', 'a/../b', '__proto__/x', 'a/constructor']) {
      expect(await setSecret(home, path, 'test-value-not-a-secret-0001', fake.opts)).toMatchObject({
        ok: false,
        error: { code: 'invalid_secret_path' },
      })
    }
    fake.setData({ a: 'test-value-not-a-secret-0001' })
    expect(await setSecret(home, 'a/b', 'value', fake.opts)).toMatchObject({
      ok: false,
      error: { code: 'secret_path_conflict' },
    })
    fake.setData({ a: { b: 'test-value-not-a-secret-0001' } })
    expect(await setSecret(home, 'a', 'value', fake.opts)).toMatchObject({
      ok: false,
      error: { code: 'secret_path_conflict' },
    })
    fake.setData({ a: 1 })
    expect(await loadSecrets(home, fake.opts)).toMatchObject({
      ok: false,
      error: { code: 'invalid_secrets' },
    })
    const failed = await loadSecrets(home, {
      ...fake.opts,
      exec: async () => ({
        code: 1,
        stdout: 'test-value-not-a-secret-0001',
        stderr: 'test-value-not-a-secret-0001',
      }),
    })
    expect(failed).toMatchObject({ ok: false, error: { code: 'sops_failed' } })
    expect(JSON.stringify(failed)).not.toContain('test-value-not-a-secret-0001')
    expect(await readFile(join(config, 'secrets.sops.yaml'), 'utf8')).toBe(before)
  })

  test('提交钩子失败会恢复密文，不产生提交；失败的初始化保留私钥供重试', async () => {
    const { home, config, ageKeyFile } = await setup()
    const fake = fakeSops(ageKeyFile)
    const hook = join(config, '.git/hooks/pre-commit')
    const originalHook = await readFile(hook, 'utf8')
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect(await initSecrets(home, fake.opts)).toMatchObject({
      ok: false,
      error: { code: 'secrets_commit_failed' },
    })
    expect(existsSync(ageKeyFile)).toBe(true)
    expect(existsSync(join(config, '.sops.yaml'))).toBe(false)
    expect(existsSync(join(config, 'secrets.sops.yaml'))).toBe(false)
    expect(await commitCount(config)).toBe(1)
    const privateKey = await readFile(ageKeyFile, 'utf8')
    await writeFile(hook, originalHook)
    expect((await initSecrets(home, fake.opts)).ok).toBe(true)
    expect(await readFile(ageKeyFile, 'utf8')).toBe(privateKey)
    const before = await readFile(join(config, 'secrets.sops.yaml'), 'utf8')
    await writeFile(hook, '#!/bin/sh\nexit 1\n')
    expect(
      await setSecret(home, 'telegram/bot-token', 'test-value-not-a-secret-0001', fake.opts),
    ).toMatchObject({ ok: false, error: { code: 'secrets_commit_failed' } })
    expect(await readFile(join(config, 'secrets.sops.yaml'), 'utf8')).toBe(before)
    expect((await git(config, ['status', '--porcelain'])).stdout).toBe('')
    expect(await commitCount(config)).toBe(2)
  })
})

const sopsVersion = await execCommand('sops', ['--version'])
const hasSops = sopsVersion.code === 0
if (!hasSops) console.info('跳过真实 sops 测试：PATH 中未找到 sops（注入命令测试照常运行）')
if (process.env.FLOW_REQUIRE_SOPS_TESTS === '1' && !hasSops)
  throw new Error('CI 必须安装 sops 并运行真实密钥测试')

describe('真实 sops + age', () => {
  test.skipIf(!hasSops)(
    '首次初始化及读写：真实加解密、幂等、gitleaks、所有提交均无明文',
    async () => {
      const { home, config, ageKeyFile } = await setup()
      const opts = { ageKeyFile }
      expect((await initSecrets(home, opts)).ok).toBe(true)
      expect((await stat(ageKeyFile)).mode & 0o777).toBe(0o600)
      expect(await loadSecrets(home, opts)).toEqual({ ok: true, data: new Map() })
      const values = ['test-value-not-a-secret-0001', 'test-value-not-a-secret-0002\n第二行']
      expect((await setSecret(home, 'telegram/bot-token', values[0] as string, opts)).ok).toBe(true)
      expect((await setSecret(home, 'telegram/bot-token', values[1] as string, opts)).ok).toBe(true)
      expect(await loadSecrets(home, opts)).toEqual({
        ok: true,
        data: new Map([['telegram/bot-token', values[1] as string]]),
      })
      const before = snapshot(dirname(home))
      expect((await initSecrets(home, opts)).ok).toBe(true)
      expect(snapshot(dirname(home))).toEqual(before)
      expect(
        await scanForSecrets(await readFile(join(config, 'secrets.sops.yaml'), 'utf8'), {
          configPath: join(config, '.gitleaks.toml'),
        }),
      ).toEqual({ ok: true, data: { findings: [] } })
      expect(
        (await execCommand('gitleaks', ['git', '--no-banner', '--redact', '.'], { cwd: config }))
          .code,
      ).toBe(0)
      const commits = (await git(config, ['rev-list', '--all'])).stdout.trim().split('\n')
      expect(commits).toHaveLength(4)
      for (const commit of commits) {
        const tree = await git(config, ['grep', '-F', '-e', 'test-value-not-a-secret-', commit])
        expect(tree.code).toBe(1)
      }
      expect((await git(config, ['log', '-p', '--all'])).stdout).not.toContain(
        'test-value-not-a-secret-',
      )
      console.info(
        `真实 sops 集成通过：${sopsVersion.stdout.split('\n')[0]}；init/set/load/gitleaks/git 全历史无明文`,
      )
    },
  )
})
