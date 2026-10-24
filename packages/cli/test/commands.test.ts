import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findExecutable } from '@flow/core'
import { doctorOptions } from '../../core/test/doctor-helpers.ts'
import { createDoctorCommand } from '../src/commands/doctor.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/**
 * 命令通过 process.env 解析 FLOW_HOME；每个测试使用独立的临时目录，
 * 结束后恢复环境，绝不触碰真实的 ~/flow-home。
 */
let saved: { FLOW_HOME: string | undefined; PATH: string | undefined }
let home: string

beforeEach(() => {
  saved = { FLOW_HOME: process.env.FLOW_HOME, PATH: process.env.PATH }
  home = join(mkdtempSync(join(tmpdir(), 'flow-cli-')), 'home')
  process.env.FLOW_HOME = home
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const run = (...argv: string[]) =>
  runCli(
    argv,
    commands.map((command) =>
      command.name === 'doctor' ? createDoctorCommand(doctorOptions(home)) : command,
    ),
  )

function write(rel: string, content: string) {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

const entry = (fields: string[]) => `---\n${fields.join('\n')}\n---\n正文\n`

describe('flow init', () => {
  test('初始化两次：第二次报告无缺失项', async () => {
    const first = await run('init')
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('补齐了以下项')
    const second = await run('init')
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('无缺失项')
    const json = JSON.parse((await run('init', '--json')).stdout)
    expect(json).toMatchObject({ ok: true, data: { home, complete: true, created: [] } })
  })
})

describe('flow kb validate', () => {
  beforeEach(async () => {
    await run('init')
    write(
      'config/workspaces/xuanxue-saas.yaml',
      'id: xuanxue-saas\nkind: product\nname: Xuanxue\ndescription: d\nrepos: [~/workspace/xuanxue-saas]\n',
    )
  })

  test('只有警告与从未核实时退出码为 0', async () => {
    write(
      'brain/products/xuanxue.md',
      entry([
        'type: product',
        'title: Xuanxue',
        'summary: s',
        'scope: work',
        'workspace: ws/xuanxue-saas',
        'status: live',
      ]),
    )
    const out = await run('kb', 'validate')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('0 个错误，1 个警告')
    expect(out.stdout).toContain('从未核实')
    const json = JSON.parse((await run('kb', 'validate', '--json')).stdout)
    expect(json.ok).toBe(true)
    expect(json.data.warnings[0].code).toBe('missing_sources')
    expect(json.data.neverVerified[0].id).toBe('products/xuanxue')
  })

  test('缺少必填字段时退出码为 1，--json 中带完整报告', async () => {
    write(
      'brain/resources/domains/ganjiday.com.md',
      entry(['type: domain', 'title: g', 'scope: work', 'owner: ws/xuanxue-saas']),
    )
    const human = await run('kb', 'validate')
    expect(human.exitCode).toBe(1)
    expect(human.stderr).toContain('brain/resources/domains/ganjiday.com.md [summary]')
    const out = await run('kb', 'validate', '--json')
    expect(out.exitCode).toBe(1)
    const body = JSON.parse(out.stdout)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details.errors.map((e: { field: string }) => e.field)).toEqual([
      'summary',
      'registrar',
      'expires',
    ])
  })

  test('--stale-days 控制过期判断；非法值为用法错误', async () => {
    write(
      'brain/resources/domains/arcanumber.com.md',
      entry([
        'type: domain',
        'title: a',
        'summary: s',
        'scope: work',
        'owner: ws/xuanxue-saas',
        'registrar: null',
        'expires: null',
        'last_verified: 2000-01-01',
        'sources: [x]',
      ]),
    )
    const stale = JSON.parse((await run('kb', 'validate', '--json')).stdout)
    expect(stale.data.stale.map((s: { id: string }) => s.id)).toEqual([
      'resources/domains/arcanumber.com',
    ])
    expect(stale.data.staleDays).toBe(90)
    const wide = JSON.parse(
      (await run('kb', 'validate', '--json', '--stale-days', '1000000')).stdout,
    )
    expect(wide.data.stale).toEqual([])
    expect((await run('kb', 'validate', '--stale-days', 'abc')).exitCode).toBe(2)
  })

  test('未初始化时失败', async () => {
    process.env.FLOW_HOME = join(home, 'nowhere')
    const out = await run('kb', 'validate', '--json')
    expect(out.exitCode).toBe(1)
    expect(JSON.parse(out.stdout).error.code).toBe('not_initialized')
  })
})

describe('flow doctor', () => {
  test('缺少 gitleaks：非零退出并给出安装提示', async () => {
    await run('init')
    const bin = mkdtempSync(join(tmpdir(), 'flow-path-'))
    symlinkSync(findExecutable('git') as string, join(bin, 'git'))
    process.env.PATH = bin
    const out = await run('doctor')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('未找到 gitleaks')
    expect(out.stderr).toContain('brew install gitleaks')
    const json = JSON.parse((await run('doctor', '--json')).stdout)
    expect(json.error.code).toBe('doctor_failed')
    expect(json.error.details.homeSource).toBe('FLOW_HOME')
  })

  test.skipIf(!findExecutable('gitleaks'))('初始化后全部通过', async () => {
    await run('init')
    const out = await run('doctor')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('全部检查通过')
    expect(out.stdout).toContain(home)
  })
})
