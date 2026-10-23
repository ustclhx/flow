import { fail, type Result, type SyncReport, type SyncTarget, syncAgentsFiles } from '@flow/core'
import { defineCommand } from '../command.ts'

function humanReport(report: SyncReport): string {
  const lines = report.repositories.map((r) => `${r.status}  ${r.repoPath}`)
  if (report.repositories.some((r) => r.status === 'updated' || r.status === 'created')) {
    lines.push('请审阅后在对应仓库提交 AGENTS.md')
  }
  return lines.join('\n')
}

export function createAgentsSyncCommand(loadTargets: () => Promise<Result<SyncTarget[]>>) {
  return defineCommand<SyncReport>({
    name: 'agents sync',
    summary: '同步项目 AGENTS.md 的 Flow 受管区块',
    usage: 'agents sync [--check]',
    options: { check: { type: 'boolean', description: '只检查区块是否过时，不写入文件' } },
    run: async ({ args, options }) => {
      if (args.length > 0) return fail('usage', 'invalid_arguments', 'agents sync 不接受位置参数')
      const targets = await loadTargets()
      if (!targets.ok) return targets
      return syncAgentsFiles(targets.data, { check: options.check === true })
    },
    human: humanReport,
    humanError: (error) =>
      ['agents_stale', 'managed_block_corrupt', 'agents_sync_failed'].includes(error.code)
        ? humanReport(error.details as SyncReport)
        : '',
  })
}

export default createAgentsSyncCommand(async () =>
  fail('failure', 'not_implemented', 'workspace 加载将在第 2 组合并后接入'),
)
