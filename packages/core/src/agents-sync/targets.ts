import { homedir } from 'node:os'
import { join } from 'node:path'
import { readBrainEntries } from '../entries.ts'
import { fail, ok, type Result } from '../result.ts'
import { isResourceType } from '../schema/index.ts'
import { validateBrain } from '../validate.ts'
import { loadWorkspaces } from '../workspaces.ts'
import type { SyncTarget } from './types.ts'

const expandHome = (p: string) =>
  p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p

/**
 * 由 flow-home 构造受管区块的同步目标：每个产品 workspace 的每个关联仓库一个目标。
 */
export async function loadSyncTargets(home: string): Promise<Result<SyncTarget[]>> {
  // 先整体校验：workspace 定义或条目有错误时拒绝同步，避免把半残的数据写进项目 AGENTS.md。
  const report = await validateBrain(home)
  if (!report.ok) return report
  if (report.data.errors.length > 0) {
    return fail(
      'failure',
      'invalid_flow_home',
      '存在格式错误的 workspace 定义或条目，请先运行 flow kb validate 修复',
      report.data.errors,
    )
  }
  const ws = await loadWorkspaces(home)
  if (!ws.ok) return ws
  const brain = await readBrainEntries(home)
  if (!brain.ok) return brain

  const targets: SyncTarget[] = []
  for (const w of ws.data.workspaces) {
    if (w.kind !== 'product') continue
    const card = brain.data.entries.find(
      (e) => e.frontmatter.type === 'project-card' && e.frontmatter.workspace === w.ref,
    )
    const resources = brain.data.entries
      .filter((e) => isResourceType(String(e.frontmatter.type)) && e.frontmatter.owner === w.ref)
      .map((e) => ({
        id: e.id,
        type: String(e.frontmatter.type),
        title: String(e.frontmatter.title ?? ''),
        summary: String(e.frontmatter.summary ?? ''),
      }))
    for (const repo of w.repos) {
      targets.push({
        workspaceId: w.ref,
        repoPath: expandHome(repo),
        input: {
          workspace: { id: w.ref, name: w.name, kind: 'product' },
          projectCardId: card?.id ?? null,
          resources,
        },
      })
    }
  }
  return ok(targets)
}
