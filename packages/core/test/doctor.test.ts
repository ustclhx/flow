import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePlist } from '../src/daemon/plist.ts'
import {
  runDoctor as actualDoctor,
  compareVersions,
  type DoctorOptions,
  type DoctorReport,
  findExecutable,
  formatDoctorReport,
} from '../src/doctor.ts'
import { initFlowHome } from '../src/init.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome, writeText } from './helpers.ts'

/** 只包含 git 的 PATH，用来模拟未安装 gitleaks。 */
function pathWithoutGitleaks(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-path-'))
  const gitBin = findExecutable('git')
  if (!gitBin) throw new Error('测试需要 git')
  symlinkSync(gitBin, join(dir, 'git'))
  return dir
}

const reportOf = (r: Awaited<ReturnType<typeof runDoctor>>): DoctorReport =>
  r.ok ? r.data : (r.error.details as DoctorReport)

/** 未通过且不是 info 提示的检查。 */
const failed = (r: DoctorReport) =>
  r.checks.filter((c) => !c.ok && c.severity !== 'info').map((c) => c.id)
const runDoctor = (home: string, source: DoctorReport['homeSource'], options: DoctorOptions = {}) =>
  actualDoctor(home, source, doctorOptions(home, options))

describe('flow doctor', () => {
  test('执行器未知：报告角色文件和 executor，已知执行器全部通过；配置错误带字段', async () => {
    const home = tempHome('flow-doctor-roles-')
    await initFlowHome(home)
    writeText(join(home, 'config/roles/fake.yaml'), 'name: fake\nexecutor: fake\nprompt: 测试\n')
    writeText(
      join(home, 'config/roles/custom.yaml'),
      'name: custom\nexecutor: gpt-cli\nprompt: 测试\n',
    )
    writeText(join(home, 'config/roles/broken.yaml'), 'name: broken\nprompt: 测试\n')
    const result = await runDoctor(home, 'FLOW_HOME')
    expect(result.ok).toBe(false)
    const report = reportOf(result)
    const unknown = report.checks.find((c) => c.id === 'role.custom.executor')
    expect(unknown).toMatchObject({ ok: false })
    expect(unknown?.message).toContain('config/roles/custom.yaml：executor gpt-cli 不存在')
    expect(
      report.checks.filter((c) => /^role\.(dev|reviewer|triage|fake)\.executor$/.test(c.id)),
    ).toEqual(
      expect.arrayContaining(
        ['dev', 'reviewer', 'triage', 'fake'].map((name) =>
          expect.objectContaining({ id: `role.${name}.executor`, ok: true }),
        ),
      ),
    )
    expect(
      report.checks.find((c) => c.id === 'roles.config.config/roles/broken.yaml.executor'),
    ).toMatchObject({ ok: false, message: expect.stringContaining('executor') })
  })

  test('角色 creatable_by 缺省或为空：中性 info 提示；非空列表不提示', async () => {
    const home = tempHome('flow-doctor-roles-')
    await initFlowHome(home)
    writeText(
      join(home, 'config/roles/empty.yaml'),
      'name: empty\nexecutor: fake\nprompt: 测试\ncreatable_by: []\n',
    )
    const report = reportOf(await runDoctor(home, 'FLOW_HOME'))
    const hints = report.checks.filter((c) => c.id.endsWith('.creatable_by'))
    // 缺省与显式空数组的行为一致。
    expect(hints).toEqual([
      expect.objectContaining({
        id: 'role.dev.creatable_by',
        ok: false,
        severity: 'info',
        message: expect.stringContaining('仅 user 可创建'),
      }),
      expect.objectContaining({
        id: 'role.empty.creatable_by',
        severity: 'info',
        message: expect.stringContaining('仅 user 可创建'),
      }),
    ])
    expect(formatDoctorReport(report)).toContain(
      '[info] config/roles/dev.yaml：creatable_by 缺省或为空，仅 user 可创建',
    )
  })

  test('已安装 plist 的 bun 或入口失效时报错并提示重新安装；有效路径通过', async () => {
    const home = tempHome('flow-doctor-')
    await initFlowHome(home)
    const directory = join(home, 'LaunchAgents')
    mkdirSync(directory)
    const bunPath = join(home, 'bun & <test>')
    const cliPath = join(home, 'main.ts')
    const plist = generatePlist({
      label: 'dev.flow.hub',
      bunPath,
      cliPath,
      command: ['hub', 'start'],
      home,
      logPath: join(home, 'hub.log'),
      path: '/usr/bin',
    })
    writeFileSync(join(directory, 'dev.flow.hub.plist'), plist)
    const report = reportOf(await runDoctor(home, 'FLOW_HOME'))
    const check = report.checks.find((c) => c.id === 'daemon.dev.flow.hub')
    expect(check?.ok).toBe(false)
    expect(check?.message).toContain('bun 失效')
    expect(check?.message).toContain('入口 失效')
    expect(check?.hint).toContain('flow daemon install')
    writeFileSync(bunPath, '')
    writeFileSync(cliPath, '')
    expect(
      reportOf(await runDoctor(home, 'FLOW_HOME')).checks.find((c) => c.id === check?.id)?.ok,
    ).toBe(true)
  })

  test('损坏的 plist 不会静默跳过，未安装的服务不要求安装', async () => {
    const home = tempHome('flow-doctor-')
    mkdirSync(join(home, 'LaunchAgents'), { recursive: true })
    writeFileSync(join(home, 'LaunchAgents', 'dev.flow.node.plist'), 'broken plist')
    const checks = reportOf(await runDoctor(home, 'FLOW_HOME')).checks.filter((c) =>
      c.id.startsWith('daemon.'),
    )
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ id: 'daemon.dev.flow.node', ok: false })
    expect(checks[0]?.hint).toContain('flow daemon install')
  })

  test('缺少密钥扫描工具：指出缺失的工具与安装方式，非零退出', async () => {
    const home = tempHome('flow-doctor-')
    expect((await initFlowHome(home)).ok).toBe(true)
    const r = await runDoctor(home, 'FLOW_HOME', { env: { PATH: pathWithoutGitleaks() } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('doctor_failed')
    expect(!r.ok && r.error.kind).toBe('failure')
    const report = reportOf(r)
    expect(failed(report)).toEqual(['tool.gitleaks'])
    const check = report.checks.find((c) => c.id === 'tool.gitleaks')
    expect(check?.message).toContain('未找到 gitleaks')
    expect(check?.hint).toContain('brew install gitleaks')
    expect(!r.ok && r.error.message).toContain('brew install gitleaks')
  })

  test.skipIf(!findExecutable('gitleaks'))('初始化完整时全部通过', async () => {
    const home = tempHome('flow-doctor-')
    await initFlowHome(home)
    const r = await runDoctor(home, 'FLOW_HOME')
    expect(r.ok ? [] : failed(reportOf(r))).toEqual([])
    expect(r.ok && r.data.home).toBe(home)
  })

  test('缺少钩子或钩子不可执行时失败，并提示修复', async () => {
    const home = tempHome('flow-doctor-')
    await initFlowHome(home)
    rmSync(join(home, 'brain', '.git', 'hooks', 'pre-commit'))
    chmodSync(join(home, 'raw', '.git', 'hooks', 'pre-commit'), 0o644)
    const report = reportOf(await runDoctor(home, 'FLOW_HOME'))
    expect(failed(report).filter((id) => id.startsWith('hook.'))).toEqual([
      'hook.brain',
      'hook.raw',
    ])
    expect(report.checks.find((c) => c.id === 'hook.brain')?.hint).toContain('flow init')
  })

  test('未初始化时报告缺失的目录', async () => {
    const report = reportOf(await runDoctor(tempHome('flow-doctor-'), 'default'))
    expect(report.ok).toBe(false)
    expect(failed(report)).toEqual(
      expect.arrayContaining(['home', 'dir.config', 'dir.brain', 'dir.raw', 'dir.state']),
    )
  })

  test('缺少 brain 固定文件与 .gitleaks.toml 时失败', async () => {
    const home = tempHome('flow-doctor-')
    await initFlowHome(home)
    rmSync(join(home, 'brain', 'log.md'))
    rmSync(join(home, 'config', '.gitleaks.toml'))
    const ids = failed(reportOf(await runDoctor(home, 'FLOW_HOME')))
    expect(ids).toEqual(expect.arrayContaining(['brain.log.md', 'gitleaks-config.config']))
  })
})

test('compareVersions', () => {
  expect(compareVersions('8.30.1', '8.19.0')).toBeGreaterThan(0)
  expect(compareVersions('2.39.5', '2.40.0')).toBeLessThan(0)
  expect(compareVersions('2.28', '2.28.0')).toBe(0)
})
