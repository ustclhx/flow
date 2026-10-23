import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDaemonPlists, type DaemonOptions, ok } from '@flow/core'
import { createDaemonCommands } from '../src/commands/daemon.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

let root: string
let options: DaemonOptions
let calls: string[][]
const health = { version: '0.1.0', uptime: 3, ledger_seq: 42 }
const printed = await readFile(
  new URL('../../core/test/fixtures/launchctl-finder.txt', import.meta.url),
  'utf8',
)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flow-cli-daemon-'))
  calls = []
  options = {
    home: join(root, 'flow-home'),
    launchAgentsDir: join(root, 'LaunchAgents'),
    uid: 123,
    launchctl: async (args) => {
      calls.push(args)
      return { code: 0, stdout: printed, stderr: '' }
    },
    health: async () => ok(health),
  }
})
afterEach(() => rm(root, { recursive: true, force: true }))

test('注册三个命令；安装解析当前 bun 和 CLI 入口，并以表格显示完整健康状态', async () => {
  for (const name of ['daemon install', 'daemon uninstall', 'daemon status'])
    expect(commands.some((c) => c.name === name)).toBe(true)
  const injected = createDaemonCommands(options)
  const installed = await runCli(['daemon', 'install'], injected)
  expect(installed.exitCode).toBe(0)
  expect(installed.stdout).toContain('已就绪')
  const check = checkDaemonPlists(options.launchAgentsDir as string)[0]
  expect(check?.bunPath).toBe(process.execPath)
  expect(check?.cliPath).toBe(join(import.meta.dir, '../src/main.ts'))
  const status = await runCli(['daemon', 'status'], injected)
  expect(status.exitCode).toBe(0)
  for (const field of [
    '项目',
    '状态',
    'dev.flow.hub',
    'dev.flow.node',
    'PID 749',
    '中枢版本',
    '0.1.0',
    '3.0 秒',
    '账本序号',
    '42',
    '最近一次备份',
    '（无）',
  ])
    expect(status.stdout).toContain(field)
  expect((await runCli(['daemon', 'uninstall'], injected)).exitCode).toBe(0)
  expect(calls.map((c) => c[0])).toEqual([
    'bootout',
    'bootstrap',
    'bootout',
    'bootstrap',
    'print',
    'print',
    'bootout',
    'bootout',
  ])
})

test('status 有问题时非零退出仍显示表格，JSON 的 details 保留完整报告', async () => {
  const injected = createDaemonCommands({
    ...options,
    launchctl: async () => ({ code: 3, stdout: '', stderr: 'No such process' }),
  })
  const status = await runCli(['daemon', 'status'], injected)
  expect(status.exitCode).toBe(1)
  expect(status.stdout).toContain('未加载')
  expect(status.stdout).toContain('未安装')
  expect(status.stdout).toContain('中枢版本')
  expect(status.stderr).toContain('daemon_unhealthy')
  const json = await runCli(['daemon', 'status', '--json'], injected)
  expect(json.exitCode).toBe(1)
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: false,
    error: {
      code: 'daemon_unhealthy',
      details: { health: ok(health), services: [{ loaded: false }, { loaded: false }] },
    },
  })
})

test('备份目录无法读取时保留诊断并非零退出', async () => {
  const injected = createDaemonCommands(options)
  await runCli(['daemon', 'install'], injected)
  // 用目录内同名非目录文件制造跨平台一致的 ENOTDIR。
  await mkdir(join(options.home, 'state'), { recursive: true })
  await writeFile(join(options.home, 'state/backups'), 'not a directory')
  const status = await runCli(['daemon', 'status'], injected)
  expect(status.exitCode).toBe(1)
  expect(status.stdout).toContain('ENOTDIR')
})

for (const service of ['hub', 'node']) {
  test(`${service} start 轮转后让 launchd 重开标准流，避免继续写归档`, async () => {
    const logs = join(options.home, 'state/logs')
    await mkdir(logs, { recursive: true })
    const path = join(logs, `${service}.log`)
    await writeFile(path, '')
    await truncate(path, 10 * 1024 * 1024 + 1)
    // 只模拟 launchd 预先打开日志的行为，不调用 launchctl。
    const fd = openSync(path, 'a')
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../src/main.ts'), service, 'start'],
      {
        env: { ...process.env, FLOW_HOME: options.home, XPC_SERVICE_NAME: `dev.flow.${service}` },
        stdout: fd,
        stderr: fd,
      },
    )
    try {
      expect(await child.exited).toBe(3)
      expect(existsSync(`${path}.1`)).toBe(true)
      expect(existsSync(path)).toBe(false)
      // 下一次 launchd 启动会重新创建当前日志，归档因此不会持续增长。
    } finally {
      closeSync(fd)
      if (child.exitCode === null) child.kill()
    }
  })
}
