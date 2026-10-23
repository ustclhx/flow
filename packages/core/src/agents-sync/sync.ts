import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, ok, type Result } from '../result.ts'
import { renderManagedBlock } from './render.ts'
import { spliceManagedBlock } from './splice.ts'
import type { SyncReport, SyncTarget } from './types.ts'

export async function syncAgentsFiles(
  targets: SyncTarget[],
  opts: { check: boolean },
): Promise<Result<SyncReport>> {
  const report: SyncReport = { repositories: [] }
  for (const target of targets) {
    const path = join(target.repoPath, 'AGENTS.md')
    let existing: string | null
    try {
      existing = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fail(
          'failure',
          'agents_sync_failed',
          `无法读取 ${path}：${(error as Error).message}`,
          report,
        )
      }
      existing = null
    }

    const result = spliceManagedBlock(existing, renderManagedBlock(target.input))
    const repository = { workspaceId: target.workspaceId, repoPath: target.repoPath }
    if (!result.ok) {
      report.repositories.push({ ...repository, status: 'corrupt', reason: result.error.message })
      continue
    }

    const { content, changed } = result.data
    if (changed && !opts.check) {
      try {
        await writeFile(path, content, 'utf8')
      } catch (error) {
        return fail(
          'failure',
          'agents_sync_failed',
          `无法写入 ${path}：${(error as Error).message}`,
          report,
        )
      }
    }
    report.repositories.push({
      ...repository,
      status: !changed
        ? 'unchanged'
        : existing === null
          ? 'created'
          : opts.check
            ? 'stale'
            : 'updated',
    })
  }

  const corrupt = report.repositories.filter((r) => r.status === 'corrupt')
  const corruptReasons = corrupt.map((r) => `${r.repoPath}：${r.reason}`).join('\n')
  if (opts.check && report.repositories.some((r) => r.status !== 'unchanged')) {
    return fail(
      'failure',
      'agents_stale',
      `AGENTS.md 受管区块已过时、缺失或标记损坏${corruptReasons ? `\n${corruptReasons}` : ''}`,
      report,
    )
  }
  if (corrupt.length > 0) {
    return fail('failure', 'managed_block_corrupt', corruptReasons, report)
  }
  return ok(report)
}
