import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findExecutable } from '../src/doctor.ts'
import { flowAuthor, git, gitCommit } from '../src/git.ts'
import { resolveFlowHome } from '../src/home.ts'
import { formatInitReport, initFlowHome } from '../src/init.ts'
import { DEFAULT_REVIEWER_WRITABLE_PATHS } from '../src/role-templates.ts'
import { loadRoles } from '../src/roles.ts'
import { fakeStripeKey, snapshot, tempHome, writeText } from './helpers.ts'

const init = async (home: string) => {
  const r = await initFlowHome(home)
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

describe('flow init', () => {
  test('首次初始化：四个子目录、三个仓库各一次初始提交、brain 固定文件', async () => {
    const home = tempHome('flow-init-')
    const r = await init(home)
    expect(r.complete).toBe(false)
    expect(r.committed).toEqual(['config', 'brain', 'raw'])
    for (const sub of ['config', 'brain', 'raw', 'state']) {
      expect(statSync(join(home, sub)).isDirectory()).toBe(true)
    }
    for (const repo of ['config', 'brain', 'raw']) {
      const dir = join(home, repo)
      const log = await git(dir, ['log', '--format=%an <%ae>|%s'])
      expect(log.stdout.trim().split('\n')).toEqual([
        'Flow (init) <flow@localhost>|init: 初始化 flow-home 仓库',
      ])
      const files = (await git(dir, ['ls-files'])).stdout.trim().split('\n')
      expect(files).toContain('.gitleaks.toml')
      const hook = join(dir, '.git', 'hooks', 'pre-commit')
      expect(statSync(hook).mode & 0o111).not.toBe(0)
      expect(readFileSync(hook, 'utf8')).toContain('gitleaks git --pre-commit --staged --redact')
      const toml = readFileSync(join(dir, '.gitleaks.toml'), 'utf8')
      expect(toml).toContain('useDefault = true')
      expect(toml).toContain('secret://')
    }
    expect((await git(join(home, 'brain'), ['ls-files'])).stdout.trim().split('\n').sort()).toEqual(
      ['.gitleaks.toml', 'AGENTS.md', 'index.md', 'log.md'],
    )
    // state/ 与 flow-home 根都不进 git。
    expect(existsSync(join(home, '.git'))).toBe(false)
    expect(existsSync(join(home, 'state', '.git'))).toBe(false)
    const agents = readFileSync(join(home, 'brain', 'AGENTS.md'), 'utf8')
    expect(agents).toContain('只追加')
    expect(agents).toContain('### `decision`')
    expect(agents).toContain('`review_date`（必填，date）')
  })

  test('重复初始化：不改动任何已有文件，报告无缺失项', async () => {
    const home = tempHome('flow-init-')
    await init(home)
    const before = snapshot(home)
    await Bun.sleep(20)
    const r = await init(home)
    expect(r).toMatchObject({ complete: true, created: [], committed: [] })
    expect(formatInitReport(r)).toContain('无缺失项')
    const after = snapshot(home)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [file, v] of before) expect(after.get(file)).toEqual(v)
  })

  test('旧 home 补齐六个默认角色及提示词，在 config 提交；已有角色和提示词不覆盖', async () => {
    const home = tempHome('flow-init-roles-')
    await init(home)
    const config = join(home, 'config')
    await git(config, ['rm', '-r', 'roles'])
    await gitCommit(config, { message: '模拟旧 home', author: flowAuthor('test'), noVerify: true })
    const report = await init(home)
    expect(report.committed).toEqual(['config'])
    const expected = [
      'dev.md',
      'dev.yaml',
      'merger.md',
      'merger.yaml',
      'pr-reviewer.md',
      'pr-reviewer.yaml',
      'reviewer.md',
      'reviewer.yaml',
      'supervisor.md',
      'supervisor.yaml',
      'triage.md',
      'triage.yaml',
    ]
    expect(report.created.sort()).toEqual(expected.map((f) => `config/roles/${f}`))
    expect(
      (await git(config, ['show', '--name-only', '--format=', 'HEAD'])).stdout
        .trim()
        .split('\n')
        .sort(),
    ).toEqual(expected.map((f) => `roles/${f}`))
    const loaded = await loadRoles(home)
    if (!loaded.ok) throw new Error(loaded.error.message)
    expect(loaded.data.errors).toEqual([])
    expect(loaded.data.roles).toEqual([
      expect.objectContaining({
        name: 'dev',
        executor: 'codex-orca',
        model: 'gpt-6.1-sol',
        effort: 'high',
        permissions: { approval: 'never', sandbox: 'danger-full-access' },
        creatable_by: ['supervisor'],
      }),
      expect.objectContaining({ name: 'merger', kind: 'merge', executor: 'pr-merge' }),
      expect.objectContaining({
        name: 'pr-reviewer',
        kind: 'read',
        executor: 'claude-sdk',
        creatable_by: ['supervisor'],
        permissions: {
          permissionMode: 'default',
          setting_sources: [],
          read_scope: 'cwd',
          allowedTools: ['Read', 'Grep', 'Glob'],
          disallowedTools: [
            'Bash',
            'Edit',
            'Write',
            'MultiEdit',
            'NotebookEdit',
            'WebFetch',
            'WebSearch',
          ],
        },
      }),
      expect.objectContaining({
        name: 'reviewer',
        executor: 'claude-sdk',
        model: 'claude-opus-5-5',
        permissions: {
          permissionMode: 'default',
          setting_sources: [],
          allowedTools: ['Read', 'Glob', 'Grep', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)'],
          disallowedTools: ['NotebookEdit'],
          writable_paths: [...DEFAULT_REVIEWER_WRITABLE_PATHS],
        },
      }),
      expect.objectContaining({
        name: 'supervisor',
        kind: 'supervisor',
        executor: 'claude-sdk',
        model: 'claude-opus-5-5',
        permissions: {
          permissionMode: 'default',
          setting_sources: [],
          read_scope: 'cwd',
          allowedTools: ['Read', 'Grep', 'Glob'],
          disallowedTools: [
            'Bash',
            'Edit',
            'Write',
            'MultiEdit',
            'NotebookEdit',
            'WebFetch',
            'WebSearch',
          ],
        },
      }),
      expect.objectContaining({
        name: 'triage',
        executor: 'codex-exec',
        permissions: { sandbox: 'read-only' },
      }),
    ])
    for (const role of loaded.data.roles) {
      expect(role.prompt).toMatch(/[\u4e00-\u9fff]/)
      expect(role.prompt.trim().split('\n').length).toBeGreaterThanOrEqual(3)
    }
    writeFileSync(join(config, 'roles/dev.yaml'), '用户自定义配置\n')
    writeFileSync(join(config, 'roles/dev.md'), '用户自定义提示词\n')
    rmSync(join(config, 'roles/triage.yaml'))
    const repaired = await init(home)
    expect(repaired.created).toEqual(['config/roles/triage.yaml'])
    expect(readFileSync(join(config, 'roles/dev.yaml'), 'utf8')).toBe('用户自定义配置\n')
    expect(readFileSync(join(config, 'roles/dev.md'), 'utf8')).toBe('用户自定义提示词\n')
  })

  test('用户修改 AGENTS.md 后再次初始化：保持不变；缺失项被补齐并报告', async () => {
    const home = tempHome('flow-init-')
    await init(home)
    const agents = join(home, 'brain', 'AGENTS.md')
    writeFileSync(agents, '# 我自己的约定\n')
    // brain：log.md 从仓库中删除并提交；index.md 只在工作区误删。
    const brain = join(home, 'brain')
    await git(brain, ['rm', '-q', 'log.md'])
    await gitCommit(brain, { message: 'rm log', author: flowAuthor('user'), noVerify: true })
    rmSync(join(home, 'brain', 'index.md'))
    rmSync(join(home, 'raw', '.git', 'hooks', 'pre-commit'))
    const r = await init(home)
    expect(readFileSync(agents, 'utf8')).toBe('# 我自己的约定\n')
    expect(r.created).toEqual(['brain/index.md', 'brain/log.md', 'raw/.git/hooks/pre-commit'])
    expect(r.committed).toEqual(['brain'])
    expect(formatInitReport(r)).toContain('+ brain/index.md')
    // 补齐提交只包含有变化的 log.md（index.md 与已提交版本相同），AGENTS.md 的修改仍未提交。
    const last = await git(brain, ['show', '--name-only', '--format=%s', 'HEAD'])
    expect(last.stdout.trim().split('\n')).toEqual(['init: 补齐 log.md', '', 'log.md'])
    expect((await git(brain, ['status', '--porcelain'])).stdout.trim()).toBe('M AGENTS.md')
  })

  test('覆盖位置：FLOW_HOME 指向临时目录时 ~/flow-home 不受影响', async () => {
    const real = join(homedir(), 'flow-home')
    const existed = existsSync(real)
    const mtime = existed ? statSync(real).mtimeMs : null
    const home = tempHome('flow-init-')
    await init(resolveFlowHome({ FLOW_HOME: home }))
    expect(existsSync(join(home, 'brain', 'AGENTS.md'))).toBe(true)
    expect(existsSync(real)).toBe(existed)
    if (existed) expect(statSync(real).mtimeMs).toBe(mtime as number)
  })
})

describe.skipIf(!findExecutable('gitleaks'))('提交前钩子（需要 gitleaks）', () => {
  test('用户手动提交 Stripe 密钥：提交被阻止，指出文件与行号，不回显原文', async () => {
    const home = tempHome('flow-hook-')
    await init(home)
    const brain = join(home, 'brain')
    const key = fakeStripeKey()
    writeText(
      join(brain, 'notes', 'leak.md'),
      `---\ntitle: x\n---\n第一行\nstripe_key = "${key}"\n`,
    )
    const r = await gitCommit(brain, {
      message: 'test',
      author: flowAuthor('test'),
      paths: ['notes/leak.md'],
    })
    expect(r.ok).toBe(false)
    const msg = r.ok ? '' : r.error.message
    expect(msg).toContain('notes/leak.md')
    expect(msg).toMatch(/Line:\s*5/)
    expect(msg).not.toContain(key)
    expect((await git(brain, ['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1')
  })

  test('secret:// 引用不被当作密钥，提交通过', async () => {
    const home = tempHome('flow-hook-')
    await init(home)
    const brain = join(home, 'brain')
    writeText(
      join(brain, 'resources', 'data-sources', 'stripe.md'),
      '---\ntype: data-source\ncredential: secret://stripe/readonly\napi_token: secret://cloudflare/zone-ezarouter\n---\n',
    )
    const r = await gitCommit(brain, {
      message: 'test',
      author: flowAuthor('test'),
      paths: ['resources/data-sources/stripe.md'],
    })
    expect(r.ok ? 'ok' : r.error.message).toBe('ok')
  })
})
