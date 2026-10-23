import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  daemonStatus,
  type InstallDaemonOptions,
  installDaemons,
  parseLaunchctlPid,
  uninstallDaemons,
} from '../src/daemon/launchd.ts'
import { rotateLog } from '../src/daemon/logs.ts'
import {
  checkDaemonPlists,
  DAEMON_LABELS,
  generatePlist,
  parsePlistPaths,
} from '../src/daemon/plist.ts'
import type { ExecResult } from '../src/git.ts'
import { flowPaths } from '../src/home.ts'
import { fail, ok } from '../src/result.ts'

let root: string
let options: InstallDaemonOptions
let calls: string[][]
const healthy = { version: '0.1.0', uptime: 12, ledger_seq: 7 }
const success: ExecResult = { code: 0, stdout: '', stderr: '' }
const missing: ExecResult = { code: 3, stdout: '', stderr: 'No such process' }
// 2026-10-24 在 macOS 上以 launchctl print gui/$(id -u)/com.apple.Finder 采集。
const printed = await readFile(new URL('./fixtures/launchctl-finder.txt', import.meta.url), 'utf8')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flow-daemon-'))
  calls = []
  const bunPath = join(root, 'bun & <"\'>')
  const cliPath = join(root, 'main & <"\'>.ts')
  await writeFile(bunPath, '')
  await writeFile(cliPath, '')
  options = {
    home: join(root, 'home'),
    launchAgentsDir: join(root, 'LaunchAgents'),
    uid: 123,
    bunPath,
    cliPath,
    path: '/tools/git:/tools/gitleaks:/tools/gh:/tools/codex:/tools/orca',
    launchctl: async (args) => {
      calls.push(args)
      return args[0] === 'bootout' ? missing : { ...success, stdout: printed }
    },
    health: async () => ok(healthy),
  }
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('plist', () => {
  test('两个服务的 plist 快照包含启动、重启、环境和日志设置', () => {
    for (const service of ['hub', 'node']) {
      expect(
        generatePlist({
          label: `dev.flow.${service}`,
          bunPath: '/opt/bun',
          cliPath: '/src/main.ts',
          command: [service, 'start'],
          home: '/flow',
          logPath: `/flow/state/logs/${service}.log`,
          path: '/opt:/usr/bin',
        }),
      ).toMatchSnapshot(service)
    }
  })

  test('XML 特殊字符在所有字符串中转义，路径解析仅解码一次', () => {
    const special = '/a&<>"\'/&lt;'
    const xml = generatePlist({
      label: special,
      bunPath: special,
      cliPath: special,
      command: [special],
      home: special,
      logPath: special,
      path: special,
    })
    expect(xml).toMatchSnapshot('xml-escaping')
    expect(parsePlistPaths(xml)).toEqual({ bunPath: special, cliPath: special })
    expect(
      parsePlistPaths('<key>ProgramArguments</key><array><string>relative</string></array>'),
    ).toBeNull()
    expect(
      parsePlistPaths('<key>ProgramArguments</key><array><integer>1</integer></array>'),
    ).toBeNull()
  })
})

describe('launchd 托管', () => {
  test('安装顺序为每个服务 bootout → bootstrap，重装会更新 plist', async () => {
    expect(await installDaemons(options)).toEqual(ok(healthy))
    const expected = DAEMON_LABELS.flatMap((label) => [
      ['bootout', `gui/123/${label}`],
      ['bootstrap', 'gui/123', join(options.launchAgentsDir as string, `${label}.plist`)],
    ])
    expect(calls).toEqual(expected)
    const checks = checkDaemonPlists(options.launchAgentsDir as string)
    expect(checks.every((c) => c.bunExists && c.cliExists)).toBe(true)
    const plist = await readFile(checks[0]?.plistPath as string, 'utf8')
    expect(plist).toContain(options.path as string)
    expect(plist).toContain(join(flowPaths(options.home).logs, 'hub.log'))
    const newCli = join(root, 'updated.ts')
    await writeFile(newCli, '')
    expect((await installDaemons({ ...options, cliPath: newCli })).ok).toBe(true)
    expect(calls).toEqual([...expected, ...expected])
    expect(checkDaemonPlists(options.launchAgentsDir as string)[0]?.cliPath).toBe(newCli)
  })

  for (const command of ['bootout', 'bootstrap']) {
    test(`${command} 的非缺失错误必须报告，不能继续安装或检查 health`, async () => {
      let healthCalled = false
      const result = await installDaemons({
        ...options,
        launchctl: async (args) => {
          calls.push(args)
          return args[0] === command
            ? { code: 5, stdout: '', stderr: 'Input/output error' }
            : success
        },
        health: async () => {
          healthCalled = true
          return ok(healthy)
        },
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'launchctl_failed' } })
      expect(calls).toHaveLength(command === 'bootout' ? 1 : 2)
      expect(healthCalled).toBe(false)
    })
  }

  test('安装后轮询 health，启动稍慢也能成功', async () => {
    let probes = 0
    const result = await installDaemons({
      ...options,
      health: async (timeout) => {
        expect(timeout).toBeLessThanOrEqual(1000)
        return ++probes === 1 ? fail('retryable', 'hub_unavailable', '尚未启动') : ok(healthy)
      },
    })
    expect(result).toEqual(ok(healthy))
    expect(probes).toBe(2)
  })

  test('health 永久挂起也受总等待期限约束', async () => {
    const started = performance.now()
    expect(
      await installDaemons({ ...options, healthWaitMs: 25, health: () => new Promise(() => {}) }),
    ).toMatchObject({ ok: false, error: { code: 'hub_health_timeout', kind: 'retryable' } })
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('卸载两个服务并移除 plist，可重复执行，state 文件内容不变', async () => {
    await installDaemons(options)
    const paths = flowPaths(options.home)
    await writeFile(paths.ledgerDb, 'ledger remains')
    await writeFile(paths.hubToken, 'token remains')
    calls = []
    expect((await uninstallDaemons(options)).ok).toBe(true)
    expect(calls).toEqual(DAEMON_LABELS.map((label) => ['bootout', `gui/123/${label}`]))
    expect(checkDaemonPlists(options.launchAgentsDir as string).every((c) => !c.installed)).toBe(
      true,
    )
    expect(await readFile(paths.ledgerDb, 'utf8')).toBe('ledger remains')
    expect(await readFile(paths.hubToken, 'utf8')).toBe('token remains')
    expect((await uninstallDaemons(options)).ok).toBe(true)
  })

  test('卸载失败保留对应 plist，仍尝试停止另一服务', async () => {
    await installDaemons(options)
    calls = []
    const result = await uninstallDaemons({
      ...options,
      launchctl: async (args) => {
        calls.push(args)
        return args[1]?.endsWith('hub')
          ? { code: 5, stdout: '', stderr: 'Input/output error' }
          : success
      },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'daemon_uninstall_failed' } })
    expect(calls).toHaveLength(2)
    expect(checkDaemonPlists(options.launchAgentsDir as string).map((c) => c.installed)).toEqual([
      true,
      false,
    ])
  })

  test('真实 launchctl print fixture 提取 pid，等待或缺少 pid 显示未加载', () => {
    expect(parseLaunchctlPid(printed)).toBe(749)
    expect(parseLaunchctlPid(printed.replace('\tpid = 749\n', ''))).toBeNull()
    expect(
      parseLaunchctlPid('gui/123/dev.flow.node = {\n\tstate = waiting\n\tlast exit code = 1\n}'),
    ).toBeNull()
    expect(parseLaunchctlPid('')).toBeNull()
  })

  test('status 合并进程、有效路径、health 与最近一次实际备份', async () => {
    await installDaemons(options)
    const paths = flowPaths(options.home)
    await mkdir(paths.backups)
    for (const [name, date] of [
      ['flow-20260101-033000.db', '2026-01-01'],
      ['flow-20260201-033000.db', '2026-02-01'],
      ['unrelated.txt', '2026-03-01'],
    ]) {
      const path = join(paths.backups, name as string)
      await writeFile(path, '')
      await utimes(path, new Date(date as string), new Date(date as string))
    }
    calls = []
    const result = await daemonStatus(options)
    expect(result).toMatchObject({
      ok: true,
      data: {
        health: ok(healthy),
        lastBackup: { at: '2026-02-01T00:00:00.000Z' },
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(
      result.data.services.every((s) => s.loaded && s.pid === 749 && s.bunExists && s.cliExists),
    ).toBe(true)
    expect(calls).toEqual(DAEMON_LABELS.map((label) => ['print', `gui/123/${label}`]))
  })

  test('status 失败保留完整诊断：未加载、缺失路径、中枢不可用、无备份', async () => {
    await installDaemons(options)
    await rm(options.bunPath)
    await rm(options.cliPath)
    const result = await daemonStatus({
      ...options,
      launchctl: async () => missing,
      health: async () => fail('retryable', 'hub_unavailable', '离线'),
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'daemon_unhealthy', details: { lastBackup: null, health: { ok: false } } },
    })
    if (result.ok) throw new Error('应该失败')
    expect(result.error.details).toMatchObject({
      services: [
        { loaded: false, bunExists: false, cliExists: false },
        { loaded: false, bunExists: false, cliExists: false },
      ],
    })
  })
})

describe('日志轮转', () => {
  test('超过阈值后后移三份归档并删除最旧一份', async () => {
    const path = join(root, 'hub.log')
    await writeFile(path, 'current')
    for (const n of [1, 2, 3]) await writeFile(`${path}.${n}`, `old-${n}`)
    expect(await rotateLog(path, { maxBytes: 3, keep: 3 })).toEqual(ok(true))
    expect(existsSync(path)).toBe(false)
    expect(await readFile(`${path}.1`, 'utf8')).toBe('current')
    expect(await readFile(`${path}.2`, 'utf8')).toBe('old-1')
    expect(await readFile(`${path}.3`, 'utf8')).toBe('old-2')
    expect(existsSync(`${path}.4`)).toBe(false)
  })

  test('缺少日志、等于阈值时不动文件，首次轮转允许归档缺失', async () => {
    const path = join(root, 'node.log')
    expect(await rotateLog(path)).toEqual(ok(false))
    await writeFile(path, '123')
    expect(await rotateLog(path, { maxBytes: 3, keep: 3 })).toEqual(ok(false))
    expect(await readFile(path, 'utf8')).toBe('123')
    expect(await rotateLog(path, { maxBytes: 2, keep: 3 })).toEqual(ok(true))
    expect(await readFile(`${path}.1`, 'utf8')).toBe('123')
  })
})
