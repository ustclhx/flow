import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, type DoctorReport, findExecutable, runDoctor } from '../src/doctor.ts'
import { initFlowHome } from '../src/init.ts'
import { tempHome } from './helpers.ts'

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

const failed = (r: DoctorReport) => r.checks.filter((c) => !c.ok).map((c) => c.id)

describe('flow doctor', () => {
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
