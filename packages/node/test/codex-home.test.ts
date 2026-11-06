import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCodexHome, readCodexHome, workCodexHome } from '../src/codex-home.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flow-codex-home-'))
  dirs.push(root)
  const home = join(root, 'flow-home')
  const source = join(root, 'auth-source')
  mkdirSync(source)
  writeFileSync(join(source, 'auth.json'), '{"placeholder":true}')
  const isolated = workCodexHome(home)
  mkdirSync(isolated, { recursive: true })
  return { root, home, source, isolated }
}

describe('Flow 管理的 Codex 目录', () => {
  test('读写目录固定且不同，重建配置与扩展不影响会话和用户源目录', async () => {
    const s = setup()
    const sourceConfig = join(s.source, 'config.toml')
    writeFileSync(sourceConfig, 'notify = ["source-notify"]\n')
    symlinkSync(sourceConfig, join(s.isolated, 'config.toml'))
    for (const name of ['rules', 'skills', 'plugins']) {
      mkdirSync(join(s.isolated, name))
      writeFileSync(join(s.isolated, name, 'old'), '污染扩展')
    }
    for (const name of ['hooks.json', 'AGENTS.md', 'AGENTS.override.md'])
      writeFileSync(join(s.isolated, name), '污染扩展')
    mkdirSync(join(s.isolated, 'sessions'))
    const session = join(s.isolated, 'sessions', 'session.jsonl')
    writeFileSync(session, '会话状态')

    expect(await prepareCodexHome(s.isolated, s.source)).toEqual({ ok: true, data: s.isolated })
    expect(readCodexHome(s.home)).toBe(join(s.home, 'state', 'codex-read-home'))
    expect(workCodexHome(s.home)).toBe(join(s.home, 'state', 'codex-work-home'))
    expect(lstatSync(join(s.isolated, 'config.toml')).isSymbolicLink()).toBe(false)
    const config = readFileSync(join(s.isolated, 'config.toml'), 'utf8')
    expect(config.split('\n').every((line) => !line.trim() || line.startsWith('#'))).toBe(true)
    expect(readFileSync(sourceConfig, 'utf8')).toBe('notify = ["source-notify"]\n')
    for (const name of [
      'rules',
      'skills',
      'plugins',
      'hooks.json',
      'AGENTS.md',
      'AGENTS.override.md',
    ])
      expect(existsSync(join(s.isolated, name))).toBe(false)
    expect(readlinkSync(join(s.isolated, 'auth.json'))).toBe(join(s.source, 'auth.json'))
    expect(await prepareCodexHome(s.isolated, s.source)).toEqual({ ok: true, data: s.isolated })
    expect(readFileSync(session, 'utf8')).toBe('会话状态')
  })

  test('清理期间其他 worker 刷新成普通 auth 文件时保留并拒绝启动', async () => {
    const s = setup()
    mkdirSync(join(s.isolated, 'rules'))
    // 模拟有积累规则的共享目录，留出真实文件监听事件送达的时间窗。
    for (let i = 0; i < 2000; i++) writeFileSync(join(s.isolated, 'rules', `${i}.rules`), '')
    const auth = join(s.isolated, 'auth.json')
    let refreshed = false
    const watcher = watch(s.isolated, (_, name) => {
      if (refreshed || name !== 'config.toml') return
      refreshed = true
      writeFileSync(auth, '刷新后的凭证占位')
    })
    try {
      const result = await prepareCodexHome(s.isolated, s.source)
      expect(refreshed).toBe(true)
      expect(result).toMatchObject({ ok: false, error: { code: 'codex_home_failed' } })
      expect(lstatSync(auth).isFile()).toBe(true)
      expect(readFileSync(auth, 'utf8')).toBe('刷新后的凭证占位')
    } finally {
      watcher.close()
    }
  })

  test('清除 rules 符号链接只删除链接，不触碰源目录', async () => {
    const s = setup()
    mkdirSync(join(s.source, 'rules'))
    const rule = join(s.source, 'rules', 'user.rules')
    writeFileSync(rule, '用户审批规则')
    symlinkSync(join(s.source, 'rules'), join(s.isolated, 'rules'))
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(existsSync(join(s.isolated, 'rules'))).toBe(false)
    expect(readFileSync(rule, 'utf8')).toBe('用户审批规则')
  })

  test('隔离目录自身是符号链接时拒绝，不能改写用户配置和规则', async () => {
    const s = setup()
    const config = join(s.source, 'config.toml')
    writeFileSync(config, '用户配置')
    rmSync(s.isolated, { recursive: true })
    symlinkSync(s.source, s.isolated)
    expect(await prepareCodexHome(s.isolated, s.source)).toMatchObject({
      ok: false,
      error: { code: 'codex_home_failed' },
    })
    expect(readFileSync(config, 'utf8')).toBe('用户配置')
    expect(readFileSync(join(s.source, 'auth.json'), 'utf8')).toBe('{"placeholder":true}')
  })

  test('拒绝相同目录和 realpath 别名，在失败前保留原配置', async () => {
    const s = setup()
    writeFileSync(join(s.isolated, 'config.toml'), '原配置')
    const alias = join(s.root, 'alias')
    symlinkSync(s.isolated, alias)
    for (const source of [s.isolated, alias])
      expect(await prepareCodexHome(s.isolated, source)).toMatchObject({
        ok: false,
        error: { code: 'codex_home_failed' },
      })
    expect(readFileSync(join(s.isolated, 'config.toml'), 'utf8')).toBe('原配置')
  })

  test('保留普通 auth 文件并拒绝启动；旧链接可替换，无来源凭证时移除旧链接', async () => {
    const s = setup()
    const auth = join(s.isolated, 'auth.json')
    writeFileSync(auth, '刷新后的凭证占位')
    expect(await prepareCodexHome(s.isolated, s.source)).toMatchObject({
      ok: false,
      error: { code: 'codex_home_failed' },
    })
    expect(readFileSync(auth, 'utf8')).toBe('刷新后的凭证占位')
    rmSync(auth)
    symlinkSync(join(s.root, 'old-auth'), auth)
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(readlinkSync(auth)).toBe(join(s.source, 'auth.json'))
    rmSync(join(s.source, 'auth.json'))
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(existsSync(auth)).toBe(false)
    expect((await prepareCodexHome(s.isolated, s.source)).ok).toBe(true)
    expect(existsSync(auth)).toBe(false)
  })
})
