import { fileURLToPath } from 'node:url'
import {
  type DaemonOptions,
  type DaemonStatus,
  daemonStatus,
  fail,
  findExecutable,
  installDaemons,
  renderTable,
  resolveFlowHome,
  uninstallDaemons,
} from '@flow/core'
import { defineCommand } from '../command.ts'

export function formatDaemonStatus(status: DaemonStatus): string {
  const rows: string[][] = []
  for (const service of status.services) {
    rows.push(
      [service.label, service.loaded ? `已加载（PID ${service.pid}）` : '未加载'],
      [
        `${service.label} plist`,
        service.installed ? (service.error ?? service.plistPath) : '未安装',
      ],
      [
        `${service.label} bun`,
        `${service.bunExists ? '有效' : '失效'}：${service.bunPath ?? '未知'}`,
      ],
      [
        `${service.label} 入口`,
        `${service.cliExists ? '有效' : '失效'}：${service.cliPath ?? '未知'}`,
      ],
    )
    if (service.launchctlError) rows.push([`${service.label} launchctl`, service.launchctlError])
  }
  if (status.health.ok) {
    rows.push(
      ['中枢版本', status.health.data.version],
      ['运行时长', `${status.health.data.uptime.toFixed(1)} 秒`],
      ['账本序号', String(status.health.data.ledger_seq)],
    )
  } else {
    rows.push(['中枢 health', `${status.health.error.code}：${status.health.error.message}`])
  }
  rows.push([
    '最近一次备份',
    status.backupError ??
      (status.lastBackup ? `${status.lastBackup.at} ${status.lastBackup.path}` : '（无）'),
  ])
  return renderTable(rows, [
    { header: '项目', value: (row) => row[0] ?? '' },
    { header: '状态', value: (row) => row[1] ?? '' },
  ])
}

/** 命令工厂让测试注入所有系统边界，默认注册表使用真实适配器。 */
export function createDaemonCommands(overrides: Partial<DaemonOptions> = {}) {
  const options = (): DaemonOptions => ({ home: resolveFlowHome(process.env), ...overrides })
  return [
    defineCommand({
      name: 'daemon install',
      summary: '安装或更新 launchd 中枢与节点，并等待中枢就绪',
      run: async () => {
        const bunPath = process.versions.bun ? process.execPath : findExecutable('bun')
        if (!bunPath) return fail('failure', 'bun_not_found', '未找到 bun，请先安装 bun')
        return installDaemons({
          ...options(),
          bunPath,
          cliPath: fileURLToPath(new URL('../main.ts', import.meta.url)),
        })
      },
      human: (health) =>
        `已安装 dev.flow.hub 和 dev.flow.node；中枢 ${health.version} 已就绪（账本序号 ${health.ledger_seq}）`,
    }),
    defineCommand({
      name: 'daemon uninstall',
      summary: '停止并移除 launchd 中枢与节点，保留全部账本数据',
      run: () => uninstallDaemons(options()),
      human: () => '已停止并移除 dev.flow.hub 和 dev.flow.node',
    }),
    defineCommand({
      name: 'daemon status',
      summary: '检查 launchd 进程、安装路径、中枢健康与最近备份',
      run: () => daemonStatus(options()),
      human: formatDaemonStatus,
      humanError: (error) =>
        error.code === 'daemon_unhealthy' ? formatDaemonStatus(error.details as DaemonStatus) : '',
    }),
  ]
}

export const daemonCommands = createDaemonCommands()
