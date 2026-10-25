import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fail, loadWorkspaces, ok, type Result, type TaskContract } from '@flow/core'
import { z } from 'zod'

const workdirInputs = z.looseObject({ repo: z.string().min(1).optional() })
const normalizeRepo = (path: string) => {
  const expanded =
    path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  return resolve(expanded)
}

/**
 * 合同 cwd 优先，其次 inputs.repo，最后取 workspace 唯一仓库；绝不回退到 flow-home。
 * requireWorkspaceRepo 用于 codex-orca 的基础仓库：显式 cwd 也必须校验归属并规范化。
 */
export async function resolveContractCwd(
  home: string,
  contract: TaskContract,
  requireWorkspaceRepo = false,
): Promise<Result<string>> {
  if (contract.cwd !== undefined && !requireWorkspaceRepo) return ok(normalizeRepo(contract.cwd))
  const inputs = workdirInputs.safeParse(contract.inputs ?? {})
  if (!inputs.success) {
    return fail('usage', 'invalid_inputs', `inputs 不合法：${inputs.error.message}`)
  }
  const loaded = await loadWorkspaces(home)
  if (!loaded.ok) return loaded
  const ws = loaded.data.workspaces.find((w) => w.ref === contract.workspace)
  const repo =
    contract.cwd ?? inputs.data.repo ?? (ws?.repos.length === 1 ? ws.repos[0] : undefined)
  if (!repo) {
    return fail(
      'failure',
      'repo_not_in_workspace',
      `请在合同中指定 cwd 或 inputs.repo；${contract.workspace} 没有唯一的仓库`,
    )
  }
  const normalized = normalizeRepo(repo)
  if (!ws?.repos.map(normalizeRepo).includes(normalized)) {
    return fail(
      'failure',
      'repo_not_in_workspace',
      `仓库 ${normalized} 不属于 ${contract.workspace}（config/workspaces/ 中该 workspace 的 repos）`,
    )
  }
  return ok(normalized)
}
