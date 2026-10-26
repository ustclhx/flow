import { realpath } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import {
  effectiveRoleKind,
  fail,
  inferRoleKind,
  ok,
  type Result,
  type Role,
  type RoleKind,
  type SupervisorConfig,
  type TaskContract,
  type TaskOrigin,
  type TaskView,
} from '@flow/core'
import type { LedgerStore, WakeRecord } from './store.ts'

/**
 * 中枢建任务时与 supervisor 相关的校验（add-m1-supervisor D2、D4、D5、D9、D10；tasks 2.1–2.5）。
 * 全部是确定性代码，只依据账本、角色配置与 workspace 配置，不取自调用方可填写的字段。
 * 任务提案（4.6）的校验复用这里的函数。
 */

/** 中枢内部身份（D1）。 */
export const HUB_ACTOR = 'hub'

/** `supervisor:` 幂等键前缀只保留给 hub（D3，不区分大小写）。 */
export const RESERVED_IDEMPOTENCY_PREFIX = 'supervisor:'
export const isReservedIdempotencyKey = (key: string) =>
  key.toLowerCase().startsWith(RESERVED_IDEMPOTENCY_PREFIX)

const KIND_RANK: Record<RoleKind, number> = { read: 0, write: 1, merge: 2, supervisor: 2 }
const stricter = (a: RoleKind, b: RoleKind): RoleKind => (KIND_RANK[b] > KIND_RANK[a] ? b : a)

/** 角色查找结果中参与类别判定的字段（测试注入的查找可以只给 name 与 creatable_by）。 */
export type RoleForKind = Pick<Role, 'name'> &
  Partial<Pick<Role, 'executor' | 'permissions' | 'kind'>>

/**
 * 新任务的有效类别（D9）。节点按**合同**的 `executor` 运行、按角色取权限，所以取两者中更严格者：
 * 角色自身的有效类别，与"用角色权限跑合同执行器"推断出的类别。角色未定义（只有 user 会走到这里）时
 * 只按合同执行器推断。比如 `role: triage`（read）配 `executor: codex-orca` 时为 write。
 */
export function taskKind(
  role: RoleForKind | null,
  contract: Pick<TaskContract, 'executor'>,
): RoleKind {
  const viaContract = inferRoleKind({
    executor: contract.executor,
    ...(role?.permissions === undefined ? {} : { permissions: role.permissions }),
  })
  if (!role || role.executor === undefined) {
    return role?.kind ? stricter(role.kind, viaContract) : viaContract
  }
  const own = effectiveRoleKind({
    executor: role.executor,
    ...(role.permissions === undefined ? {} : { permissions: role.permissions }),
    ...(role.kind === undefined ? {} : { kind: role.kind }),
  })
  return stricter(own, viaContract)
}

const TERMINAL: ReadonlySet<TaskView['status']> = new Set(['done', 'failed', 'cancelled'])
export const isTerminal = (t: Pick<TaskView, 'status'>) => TERMINAL.has(t.status)

/**
 * 计算新任务的 origin（D2）：中枢内部调用方显式给出时用它（例如接受提案 → instruction）；
 * `parent` 是唤醒任务 → 该唤醒的 origin（reply 唤醒不传给任何任务）；`parent` 有 origin → 继承；其他 → 无。
 */
export function computeOrigin(
  explicit: TaskOrigin | undefined,
  parent: { task: TaskView; wake: WakeRecord | null } | null,
): TaskOrigin | undefined {
  if (explicit !== undefined) return explicit
  if (!parent) return undefined
  if (parent.wake) return parent.wake.origin === 'reply' ? undefined : parent.wake.origin
  return parent.task.origin ?? undefined
}

/** `parent` 链深度（新任务的深度：直接挂在根任务下为 1）。遇到环或缺失的祖先时停止。 */
export function chainDepth(
  ledger: Pick<LedgerStore, 'getTask'>,
  parent: TaskView,
  max: number,
): number {
  let depth = 1
  const seen = new Set<string>([parent.id])
  let cur: TaskView | null = parent
  while (cur?.contract.parent !== undefined && depth <= max) {
    if (seen.has(cur.contract.parent)) break
    seen.add(cur.contract.parent)
    cur = ledger.getTask(cur.contract.parent)
    if (!cur) break
    depth++
  }
  return depth
}

const PR_URL_GLOBAL =
  /https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*/gi

/**
 * 合同中出现的 PR 链接（去重、小写），用于"同一 PR 的修改轮数"（D4）。
 * 修改任务没有专门的 PR 字段，按合同全文（目标、inputs、context 等）中出现的链接认定；
 * 不提链接就无法关联到 PR，这是已知的残余风险（轮数上限只能约束可识别的 PR）。
 */
export function prUrlsIn(contract: TaskContract): string[] {
  const found = JSON.stringify(contract).match(PR_URL_GLOBAL) ?? []
  return [...new Set(found.map((u) => u.toLowerCase()))]
}

export interface RepoCheckOptions {
  /** `~` 展开用的家目录，默认 `os.homedir()`（测试注入）。 */
  homedir?: () => string
}

const repoDenied = (message: string, details?: unknown) =>
  fail('failure', 'repo_not_in_workspace', message, details)

const expandHome = (p: string, home: () => string) =>
  p === '~' ? home() : p.startsWith('~/') ? join(home(), p.slice(2)) : p

async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/**
 * D5 第 4 步：合同 `cwd` 与 `inputs.repo` 必须位于本 workspace 登记仓库内（realpath 比较，允许仓库子目录）。
 * - 路径必须是绝对路径或 `~/` 开头（相对路径由节点按自身工作目录解析，不确定，拒绝）；不存在的路径拒绝；
 * - 两者都没写时，只有 workspace 恰好登记一个仓库才允许（节点会回退到它）；
 * - 验收步骤的 `cwd` 相对任务目录解析，不能是绝对路径或含 `..`。
 */
export async function checkRepoInWorkspace(
  contract: TaskContract,
  workspace: { ref: string; repos: readonly string[] },
  opts: RepoCheckOptions = {},
): Promise<Result<null>> {
  const home = opts.homedir ?? osHomedir
  const repo = contract.inputs?.repo
  if (repo !== undefined && (typeof repo !== 'string' || repo === '')) {
    return repoDenied('inputs.repo 应为仓库路径', { field: 'inputs.repo' })
  }
  const roots = (await Promise.all(workspace.repos.map((r) => real(expandHome(r, home))))).filter(
    (r): r is string => r !== null,
  )
  const candidates: [string, string][] = []
  if (contract.cwd !== undefined) candidates.push(['cwd', contract.cwd])
  if (typeof repo === 'string') candidates.push(['inputs.repo', repo])
  if (candidates.length === 0 && workspace.repos.length !== 1) {
    return repoDenied(`请在合同中指定 cwd 或 inputs.repo；${workspace.ref} 没有唯一的仓库`, {
      field: 'cwd',
    })
  }
  for (const [field, raw] of candidates) {
    const expanded = expandHome(raw, home)
    if (!isAbsolute(expanded)) {
      return repoDenied(`${field} 必须是绝对路径：${raw}`, { field })
    }
    const resolved = await real(expanded)
    const inside =
      resolved !== null && roots.some((r) => resolved === r || resolved.startsWith(r + sep))
    if (!inside) {
      return repoDenied(
        `${field} ${raw} 不在 ${workspace.ref} 登记的仓库内（config/workspaces/ 中该 workspace 的 repos）`,
        { field, workspace: workspace.ref },
      )
    }
  }
  for (const [i, step] of (contract.verify ?? []).entries()) {
    if (step.cwd === undefined) continue
    if (
      isAbsolute(step.cwd) ||
      step.cwd.startsWith('~') ||
      step.cwd.split(/[\\/]/).includes('..')
    ) {
      return repoDenied(`验收步骤的 cwd 只能是任务目录内的相对路径：${step.cwd}`, {
        field: `verify.${i}.cwd`,
      })
    }
  }
  return ok(null)
}

/** 审查任务的目标是否由中枢模板重写（D10 第 2 步）：角色在 reviewer_roles 中且带 inputs.review。 */
export const isReviewTask = (
  contract: Pick<TaskContract, 'role' | 'inputs'>,
  supervisor: Pick<SupervisorConfig, 'reviewer_roles'>,
) => contract.inputs?.review !== undefined && supervisor.reviewer_roles.includes(contract.role)
