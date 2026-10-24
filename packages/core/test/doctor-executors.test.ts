import { describe, expect, test } from 'bun:test'
import { chmodSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  type DoctorOptions,
  type DoctorReport,
  formatDoctorReport,
  runDoctor,
} from '../src/doctor.ts'
import { initFlowHome } from '../src/init.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome, writeText } from './helpers.ts'

async function setup(executors: string[] = ['codex-orca', 'claude-sdk', 'codex-exec']) {
  const home = tempHome('flow-doctor-executors-')
  const init = await initFlowHome(home)
  if (!init.ok) throw new Error(init.error.message)
  rmSync(join(home, 'config/roles'), { recursive: true })
  for (const executor of executors) {
    writeText(
      join(home, 'config/roles', `${executor}.yaml`),
      `name: ${executor}\nexecutor: ${executor}\nprompt: 测试\n`,
    )
  }
  return home
}

async function report(home: string, overrides: DoctorOptions = {}): Promise<DoctorReport> {
  const r = await runDoctor(home, 'FLOW_HOME', doctorOptions(home, overrides))
  return r.ok ? r.data : (r.error.details as DoctorReport)
}
const check = (r: DoctorReport, id: string) => {
  const c = r.checks.find((c) => c.id === id)
  if (!c) throw new Error(`缺少检查 ${id}`)
  return c
}

describe('doctor 执行器依赖', () => {
  test('解析实测版本、验证 Orca 信封；只执行版本和 terminal list，不执行 claude', async () => {
    const home = await setup()
    const calls: string[] = []
    const defaultRun = doctorOptions(home).runCommand
    const r = await report(home, {
      runCommand: async (bin, args, opts) => {
        if (['codex', 'orca', 'claude'].includes(basename(bin)))
          calls.push([basename(bin), ...args].join(' '))
        return defaultRun(bin, args, opts)
      },
    })
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['codex --version', 'orca --version', 'orca terminal list --json'])
    expect(check(r, 'tool.codex').message).toContain('0.164.0')
    expect(check(r, 'tool.orca').message).toContain('1.4.218')
    expect(check(r, 'orca.app').ok).toBe(true)
    expect(check(r, 'tool.claude-sdk').message).toContain('0.3.310')
    expect(check(r, 'tool.claude').ok).toBe(true)
  })

  test('缺少依赖只使引用它的角色失败；fake 或未引用的工具仅 info', async () => {
    for (const executors of [['codex-orca'], ['codex-exec'], ['claude-sdk'], ['fake']]) {
      const home = await setup(executors)
      const find = doctorOptions(home).findExecutable
      const r = await report(home, {
        findExecutable: (name, env) =>
          ['codex', 'orca', 'claude'].includes(name) ? null : find(name, env),
        inspectClaudeSdk: async () => null,
        env: { CLAUDE_CODE_OAUTH_TOKEN: undefined },
      })
      const codes = r.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.id)
      const executor = executors[0]
      expect(codes).toEqual(
        executor === 'codex-orca'
          ? ['tool.codex', 'tool.orca']
          : executor === 'codex-exec'
            ? ['tool.codex']
            : executor === 'claude-sdk'
              ? ['tool.claude-sdk', 'tool.claude', 'claude.credentials']
              : [],
      )
      expect(r.ok).toBe(executor === 'fake')
      if (executor === 'claude-sdk')
        expect(check(r, 'tool.claude-sdk').message).toContain('SDK 未安装')
      expect(check(r, 'tool.codex').message).toContain(
        executor?.startsWith('codex') ? `角色：${executor}` : '没有角色引用',
      )
      for (const c of r.checks.filter((c) => !c.ok && !codes.includes(c.id)))
        expect(c.severity).toBe('info')
    }
  })

  test('旧版只警告且退出成功；未引用的旧版仅 info', async () => {
    const home = await setup(['codex-orca'])
    const defaultRun = doctorOptions(home).runCommand
    const runCommand: DoctorOptions['runCommand'] = (bin, args, opts) => {
      if (args[0] === '--version' && ['codex', 'orca'].includes(basename(bin))) {
        return Promise.resolve({ code: 0, stdout: '0.1.0', stderr: '' })
      }
      return defaultRun(bin, args, opts)
    }
    const r = await report(home, { runCommand })
    expect(r.ok).toBe(true)
    for (const id of ['tool.codex', 'tool.orca'])
      expect(check(r, id)).toMatchObject({ ok: false, severity: 'warning' })
    expect(formatDoctorReport(r)).toContain('全部检查通过（2 项警告）')
    expect(formatDoctorReport(r)).toContain('[warn]')
    rmSync(join(home, 'config/roles/codex-orca.yaml'))
    const unused = await report(home, { runCommand })
    expect(check(unused, 'tool.codex').severity).toBe('info')
    expect(formatDoctorReport(unused)).toContain('[info]')
  })

  test('版本无法解析或命令失败（即使含版本号）都为 error', async () => {
    const home = await setup(['codex-orca'])
    const defaultRun = doctorOptions(home).runCommand
    for (const output of [
      { code: 0, stdout: 'unknown', stderr: '' },
      { code: 1, stdout: '', stderr: '0.164.0' },
    ]) {
      const r = await report(home, {
        runCommand: (bin, args, opts) =>
          args[0] === '--version' && ['codex', 'orca'].includes(basename(bin))
            ? Promise.resolve(output)
            : defaultRun(bin, args, opts),
      })
      expect(r.ok).toBe(false)
      for (const id of ['tool.codex', 'tool.orca'])
        expect(check(r, id)).toMatchObject({ ok: false, severity: 'error' })
    }
  })

  test('Orca 未启动、错误信封或无效 JSON：提示启动应用；不暴露原始输出', async () => {
    const home = await setup(['codex-orca'])
    const defaultRun = doctorOptions(home).runCommand
    for (const output of [
      { code: 1, stdout: '', stderr: '连接失败' },
      { code: 0, stdout: '{"ok":false,"error":{"code":"app_not_running"}}', stderr: '' },
      { code: 0, stdout: '{"ok":true,"result":{}}', stderr: '' },
      { code: 0, stdout: '不是 JSON', stderr: '' },
    ]) {
      const r = await report(home, {
        runCommand: (bin, args, opts) =>
          basename(bin) === 'orca' && args[0] === 'terminal'
            ? Promise.resolve(output)
            : defaultRun(bin, args, opts),
      })
      expect(check(r, 'orca.app')).toMatchObject({
        ok: false,
        severity: 'error',
        hint: expect.stringContaining('启动 Orca 应用'),
      })
    }
  })

  test('SDK 可 import 但原生 CLI 缺失：PATH 上另装的 claude 不会掩盖故障', async () => {
    const home = await setup(['claude-sdk'])
    const r = await report(home, {
      inspectClaudeSdk: async () => ({
        version: '0.3.310',
        expectedVersion: '0.3.310',
        cliPath: null,
      }),
    })
    expect(check(r, 'tool.claude-sdk').ok).toBe(true)
    expect(check(r, 'tool.claude')).toMatchObject({
      ok: false,
      severity: 'error',
      message: expect.stringContaining('SDK 不自动使用它'),
    })
  })

  test('凭证只检查环境变量或指定目录的文件存在性，不读取内容；Keychain 仅提示未确认', async () => {
    const home = await setup(['claude-sdk'])
    const env = { CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CONFIG_DIR: join(home, 'credentials') }
    expect(check(await report(home, { env }), 'claude.credentials')).toMatchObject({
      ok: false,
      severity: 'error',
    })
    const path = join(env.CLAUDE_CONFIG_DIR, '.credentials.json')
    writeText(path, '不可解析的凭证内容不应被读取')
    chmodSync(path, 0o000)
    try {
      expect(check(await report(home, { env }), 'claude.credentials').ok).toBe(true)
    } finally {
      chmodSync(path, 0o600)
    }
    rmSync(path)
    const find = doctorOptions(home).findExecutable
    const r = await report(home, {
      env,
      platform: 'darwin',
      findExecutable: (name, env) => (name === 'security' ? '/fake/security' : find(name, env)),
    })
    expect(r.ok).toBe(true)
    expect(check(r, 'claude.credentials')).toMatchObject({
      ok: false,
      severity: 'warning',
      message: expect.stringContaining('Keychain 登录状态未检查'),
    })
  })
})
