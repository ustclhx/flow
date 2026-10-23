import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { type ExecResult, execCommand } from '../git.ts'
import { flowPaths } from '../home.ts'
import type { HealthData } from '../ledger/protocol.ts'
import { fail, ok, type Result } from '../result.ts'
import { HubClient } from './client.ts'
import {
  checkDaemonPlists,
  DAEMON_LABELS,
  generatePlist,
  launchAgentsDirectory,
  type PlistCheck,
} from './plist.ts'

export interface DaemonOptions {
  home: string
  launchAgentsDir?: string
  uid?: number
  /** 注入后可在 Linux 测试；生产默认只允许 macOS。 */
  launchctl?: (args: string[]) => Promise<ExecResult>
  health?: (timeoutMs: number) => Promise<Result<HealthData>>
}

export interface InstallDaemonOptions extends DaemonOptions {
  bunPath: string
  cliPath: string
  path?: string
  /** 默认最多等 10 秒；测试可缩短等待时间。 */
  healthWaitMs?: number
}

function context(options: DaemonOptions) {
  if (process.platform !== 'darwin' && !options.launchctl) {
    return fail('failure', 'unsupported_platform', 'launchd 托管仅支持 macOS')
  }
  return ok({
    directory: options.launchAgentsDir ?? launchAgentsDirectory(),
    domain: `gui/${options.uid ?? process.getuid?.() ?? 0}`,
    launchctl: options.launchctl ?? ((args: string[]) => execCommand('launchctl', args)),
    health:
      options.health ??
      ((timeoutMs: number) =>
        new HubClient({
          home: options.home,
          actor: 'user',
          timeoutMs,
        }).health()),
  })
}

const missingService = (result: ExecResult) =>
  result.code === 3 ||
  /could not find service|no such process|service not found/i.test(result.stderr)

const launchctlFailure = (args: string[], result: ExecResult) =>
  fail('failure', 'launchctl_failed', `launchctl ${args.join(' ')} 失败：${result.stderr.trim()}`)

/** 总等待时间有上限，包括单次 health 请求与响应体读取。 */
async function waitForHealth(
  health: (timeoutMs: number) => Promise<Result<HealthData>>,
  waitMs: number,
): Promise<Result<HealthData>> {
  const timeout = () =>
    fail(
      'retryable',
      'hub_health_timeout',
      '安装已完成，但中枢未在期限内就绪，请运行 flow daemon status 检查',
    )
  const deadline = performance.now() + waitMs
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: Result<HealthData>
    try {
      result = await Promise.race([
        health(Math.min(1000, remaining)),
        new Promise<Result<HealthData>>((resolve) => {
          timer = setTimeout(() => resolve(timeout()), remaining)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (result.ok) return result
    const delay = Math.min(200, deadline - performance.now())
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return timeout()
}

export async function installDaemons(options: InstallDaemonOptions): Promise<Result<HealthData>> {
  const ctx = context(options)
  if (!ctx.ok) return ctx
  const { directory, domain, launchctl, health } = ctx.data
  const paths = flowPaths(resolve(options.home))
  try {
    await mkdir(directory, { recursive: true })
    await mkdir(paths.logs, { recursive: true })
    for (const label of DAEMON_LABELS) {
      const service = label === 'dev.flow.hub' ? 'hub' : 'node'
      await writeFile(
        join(directory, `${label}.plist`),
        generatePlist({
          label,
          bunPath: resolve(options.bunPath),
          cliPath: resolve(options.cliPath),
          command: [service, 'start'],
          home: paths.home,
          logPath: join(paths.logs, `${service}.log`),
          path: [
            dirname(resolve(options.bunPath)),
            options.path ?? process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          ].join(':'),
        }),
      )
    }
    for (const label of DAEMON_LABELS) {
      const args = ['bootout', `${domain}/${label}`]
      const stopped = await launchctl(args)
      if (stopped.code !== 0 && !missingService(stopped)) return launchctlFailure(args, stopped)
      const load = ['bootstrap', domain, join(directory, `${label}.plist`)]
      const started = await launchctl(load)
      if (started.code !== 0) return launchctlFailure(load, started)
    }
  } catch (err) {
    return fail('failure', 'daemon_install_failed', `无法安装守护进程：${(err as Error).message}`)
  }
  return waitForHealth(health, options.healthWaitMs ?? 10_000)
}

/** 只停止服务和删除两个 plist，绝不删除 state/ 中的文件。 */
export async function uninstallDaemons(
  options: DaemonOptions,
): Promise<Result<{ labels: readonly string[] }>> {
  const ctx = context(options)
  if (!ctx.ok) return ctx
  const { directory, domain, launchctl } = ctx.data
  const errors: string[] = []
  for (const label of DAEMON_LABELS) {
    try {
      const args = ['bootout', `${domain}/${label}`]
      const stopped = await launchctl(args)
      if (stopped.code !== 0 && !missingService(stopped)) {
        errors.push(`${label}：${stopped.stderr.trim()}`)
        continue
      }
      await rm(join(directory, `${label}.plist`), { force: true })
    } catch (err) {
      errors.push(`${label}：${(err as Error).message}`)
    }
  }
  return errors.length
    ? fail('failure', 'daemon_uninstall_failed', errors.join('；'))
    : ok({ labels: DAEMON_LABELS })
}

/** launchctl print 的顶层 pid 字段；没有 pid 的等待/退出状态视为未加载。 */
export function parseLaunchctlPid(output: string): number | null {
  const pid = /^\s+pid = ([1-9]\d*)\s*$/m.exec(output)?.[1]
  const value = Number(pid)
  return pid && Number.isSafeInteger(value) ? value : null
}

export interface DaemonStatus {
  services: (PlistCheck & { pid: number | null; loaded: boolean; launchctlError?: string })[]
  health: Result<HealthData>
  lastBackup: { path: string; at: string } | null
  backupError?: string
}

async function latestBackup(home: string): Promise<DaemonStatus['lastBackup']> {
  const directory = flowPaths(home).backups
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const backups = await Promise.all(
    names
      .filter((name) => /^flow-\d{8}-\d{6}\.db$/.test(name))
      .map(async (name) => {
        const path = join(directory, name)
        const info = await stat(path)
        return info.isFile() ? { path, at: info.mtime.toISOString() } : null
      }),
  )
  return backups.filter((b) => b !== null).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
}

export async function daemonStatus(options: DaemonOptions): Promise<Result<DaemonStatus>> {
  const ctx = context(options)
  if (!ctx.ok) return ctx
  const { directory, domain, launchctl, health } = ctx.data
  const services: DaemonStatus['services'] = []
  for (const check of checkDaemonPlists(directory)) {
    const printed = await launchctl(['print', `${domain}/${check.label}`])
    const pid = printed.code === 0 ? parseLaunchctlPid(printed.stdout) : null
    services.push({
      ...check,
      pid,
      loaded: pid !== null,
      ...(printed.code !== 0 ? { launchctlError: printed.stderr.trim() } : {}),
    })
  }
  const report: DaemonStatus = { services, health: await health(5000), lastBackup: null }
  try {
    report.lastBackup = await latestBackup(options.home)
  } catch (err) {
    report.backupError = (err as Error).message
  }
  return services.every((s) => s.loaded && s.installed && !s.error && s.bunExists && s.cliExists) &&
    report.health.ok &&
    !report.backupError
    ? ok(report)
    : fail(
        'failure',
        'daemon_unhealthy',
        '守护进程检查未通过，请查看状态表；路径失效时重新运行 flow daemon install',
        report,
      )
}
