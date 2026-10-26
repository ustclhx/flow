import { realpath } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  effectiveRoleKind,
  fail,
  inferRoleKind,
  ok,
  PR_URL_RE,
  type Result,
  type Role,
  type RoleKind,
  type SupervisorConfig,
  type TaskContract,
  type TaskOrigin,
  type TaskView,
  USER_ACTOR,
} from '@flow/core'
import type { LedgerStore, WakeRecord } from './store.ts'

/**
 * 中枢建任务时与 supervisor 相关的校验（add-m1-supervisor D2、D4、D5、D9、D10；tasks 2.1–2.5）。
 * 全部是确定性代码，只依据账本、角色配置、策略与 workspace 配置，不取自调用方可填写的字段。
 * 任务提案（4.6）的校验复用这里的函数。
 */

/** 中枢内部身份（D1）。 */
export const HUB_ACTOR = 'hub'

/** `supervisor:` 幂等键前缀只保留给 hub（D3，不区分大小写）。 */
export const RESERVED_IDEMPOTENCY_PREFIX = 'supervisor:'
export const isReservedIdempotencyKey = (key: string) =>
  key.toLowerCase().startsWith(RESERVED_IDEMPOTENCY_PREFIX)

/**
 * 只有 hub 能在合同 `requires` 中声明的能力（不区分大小写）：唤醒任务的调度能力保留给中枢，
 * 其他身份声明它们可能把普通任务挤进 supervisor 的执行槽或冒充唤醒的调度路径。
 */
export const RESERVED_CAPABILITIES = ['wake'] as const
export const reservedCapabilitiesIn = (requires: readonly string[]) =>
  requires.filter((c) => (RESERVED_CAPABILITIES as readonly string[]).includes(c.toLowerCase()))

const KIND_RANK: Record<RoleKind, number> = { read: 0, write: 1, merge: 2, supervisor: 2 }
const stricter = (a: RoleKind, b: RoleKind): RoleKind => (KIND_RANK[b] > KIND_RANK[a] ? b : a)

/** 角色查找结果中参与类别判定的字段（测试注入的查找可以只给 name 与 creatable_by）。 */
export type RoleForKind = Pick<Role, 'name'> &
  Partial<Pick<Role, 'executor' | 'permissions' | 'kind'>>

/**
 * 新任务的有效类别（D9）。节点按**合同**的 `executor` 运行、按角色取权限，所以取两者中更严格者：
 * 角色自身的有效类别，与"用角色权限跑合同执行器"推断出的类别。角色未定义（只有 user 会走到这里）时
 * 只按合同执行器推断。比如 `role: triage`（read）配 `executor: codex-orca` 时为 write。
 *
 * 合同 `verify` 由节点在沙箱外直接执行，所以**非 user 身份**建的任务只要带 verify，至少按 write 计
 * （`opts.actor` 缺省时按非 user 处理）。
 */
export function taskKind(
  role: RoleForKind | null,
  contract: Pick<TaskContract, 'executor'> & Partial<Pick<TaskContract, 'verify'>>,
  opts: { actor?: string } = {},
): RoleKind {
  const viaContract = inferRoleKind({
    executor: contract.executor,
    ...(role?.permissions === undefined ? {} : { permissions: role.permissions }),
  })
  let kind: RoleKind
  if (!role || role.executor === undefined) {
    kind = role?.kind ? stricter(role.kind, viaContract) : viaContract
  } else {
    const own = effectiveRoleKind({
      executor: role.executor,
      ...(role.permissions === undefined ? {} : { permissions: role.permissions }),
      ...(role.kind === undefined ? {} : { kind: role.kind }),
    })
    kind = stricter(own, viaContract)
  }
  if (opts.actor !== USER_ACTOR && (contract.verify?.length ?? 0) > 0) {
    kind = stricter(kind, 'write')
  }
  return kind
}

const TERMINAL: ReadonlySet<TaskView['status']> = new Set(['done', 'failed', 'cancelled'])
export const isTerminal = (t: Pick<TaskView, 'status'>) => TERMINAL.has(t.status)

/**
 * 计算新任务的 origin（D2）：
 * - 中枢内部调用方显式给出时用它（例如接受提案 → instruction）；
 * - `parent` 是唤醒任务 → 该唤醒的 origin（reply 唤醒不传给任何任务）；能走到这里的只有 hub、user
 *   与绑定该唤醒的 supervisor（其他身份挂到唤醒下在前面就被拒绝）；
 * - `parent` 有 origin → 继承；但 user、hub、supervisor 之外的 AI 身份只在 parent 未结束时继承，
 *   防止借已结束的 instruction 任务洗出 origin；
 * - 其他 → 无。
 */
export function computeOrigin(
  explicit: TaskOrigin | undefined,
  parent: { task: TaskView; wake: WakeRecord | null } | null,
  actor: string,
): TaskOrigin | undefined {
  if (explicit !== undefined) return explicit
  if (!parent) return undefined
  if (parent.wake) return parent.wake.origin === 'reply' ? undefined : parent.wake.origin
  const trusted = actor === USER_ACTOR || actor === HUB_ACTOR || actor === 'supervisor'
  if (!trusted && isTerminal(parent.task)) return undefined
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

const normalizePr = (url: string) => url.toLowerCase()

/**
 * 这次唤醒涉及的 PR（D4 审查轮数）：从 `supervisor.wake_started.events` 引用的任务推出——
 * 审查任务的 `inputs.review.pr`、写类任务的 `inputs.pr`、结果中 `kind: pr` 的产物。全部取自账本。
 */
export function wakePrs(
  ledger: Pick<LedgerStore, 'eventTaskIds' | 'getTask'>,
  wake: Pick<WakeRecord, 'events'>,
): string[] {
  const out = new Set<string>()
  for (const id of ledger.eventTaskIds(wake.events)) {
    const t = ledger.getTask(id)
    if (!t) continue
    const review = t.contract.inputs?.review?.pr
    if (review) out.add(normalizePr(review))
    const pr = t.contract.inputs?.pr
    if (typeof pr === 'string' && PR_URL_RE.test(pr)) out.add(normalizePr(pr))
    for (const a of t.result?.artifacts ?? []) {
      if (a.kind === 'pr' && PR_URL_RE.test(a.ref)) out.add(normalizePr(a.ref))
    }
  }
  return [...out]
}

/**
 * 新写类任务计入的 PR：本次唤醒涉及的全部 PR，加上合同结构化的 `inputs.pr`。
 * 不再按合同全文的链接匹配（调用方不写链接就能绕过，不能作为依据）。
 */
export function prsForNewTask(contract: TaskContract, fromWake: readonly string[]): string[] {
  const out = new Set(fromWake.map(normalizePr))
  const pr = contract.inputs?.pr
  if (typeof pr === 'string') out.add(normalizePr(pr))
  return [...out]
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

/** 仓库检查通过后规范化的路径：写回合同，节点按它执行。 */
export interface CheckedRepoPaths {
  cwd?: string
  repo?: string
}

/**
 * D5 第 4 步：合同 `cwd` 与 `inputs.repo` 必须位于本 workspace 登记仓库内（允许仓库子目录）。
 * - 路径必须是绝对路径或 `~/` 开头（相对路径由节点按自身工作目录解析，不确定，拒绝）；
 * - 先按节点的方式词法 `resolve`（`a/l/../..` 按字面消去，不经符号链接），再 `realpath` 比较，
 *   避免中枢与节点对 `..` 加符号链接的解释不同；不存在的路径拒绝；
 * - 通过后返回规范化的路径：登记仓库的写法（展开 `~`、词法规范化）加上 realpath 中仓库以下的部分。
 *   这个路径不含 `..` 与仓库内的符号链接，且与节点对登记仓库的比较方式一致；调用方写回合同；
 * - executor 为 codex-orca 时必须恰好是登记仓库（与节点 `resolveContractCwd(…, true)` 一致），其他执行器允许子目录；
 * - 两者都没写时，只有 workspace 恰好登记一个仓库才允许（节点会回退到它）；
 * - 验收步骤的 `cwd` 相对任务目录解析，不能是绝对路径或含 `..`。
 * 节点在执行前仍须再核对一次 realpath（tasks 5.6），这里只能保证创建时刻的状态。
 */
export async function checkRepoInWorkspace(
  contract: TaskContract,
  workspace: { ref: string; repos: readonly string[] },
  opts: RepoCheckOptions = {},
): Promise<Result<CheckedRepoPaths>> {
  const home = opts.homedir ?? osHomedir
  const repo = contract.inputs?.repo
  if (repo !== undefined && (typeof repo !== 'string' || repo === '')) {
    return repoDenied('inputs.repo 应为仓库路径', { field: 'inputs.repo' })
  }
  const roots: { lexical: string; real: string }[] = []
  for (const r of workspace.repos) {
    const lexical = resolve(expandHome(r, home))
    const realRoot = await real(lexical)
    if (realRoot !== null) roots.push({ lexical, real: realRoot })
  }
  const candidates: ['cwd' | 'inputs.repo', string][] = []
  if (contract.cwd !== undefined) candidates.push(['cwd', contract.cwd])
  if (typeof repo === 'string') candidates.push(['inputs.repo', repo])
  if (candidates.length === 0 && workspace.repos.length !== 1) {
    return repoDenied(`请在合同中指定 cwd 或 inputs.repo；${workspace.ref} 没有唯一的仓库`, {
      field: 'cwd',
    })
  }
  const out: CheckedRepoPaths = {}
  for (const [field, raw] of candidates) {
    const expanded = expandHome(raw, home)
    if (!isAbsolute(expanded)) {
      return repoDenied(`${field} 必须是绝对路径：${raw}`, { field })
    }
    const resolved = await real(resolve(expanded))
    const root =
      resolved === null
        ? undefined
        : roots.find((r) => resolved === r.real || resolved.startsWith(r.real + sep))
    if (resolved === null || !root) {
      return repoDenied(
        `${field} ${raw} 不在 ${workspace.ref} 登记的仓库内（config/workspaces/ 中该 workspace 的 repos）`,
        { field, workspace: workspace.ref },
      )
    }
    // codex-orca 以登记仓库为基础仓库创建 worktree，节点要求 cwd / inputs.repo 恰好是登记仓库（不允许子目录）。
    if (contract.executor === 'codex-orca' && resolved !== root.real) {
      return repoDenied(
        `executor 为 codex-orca 时 ${field} 必须恰好是 ${workspace.ref} 登记的仓库，不能是其中的子目录：${raw}`,
        { field, workspace: workspace.ref },
      )
    }
    const rest = relative(root.real, resolved)
    const normalized = rest === '' ? root.lexical : join(root.lexical, rest)
    if (field === 'cwd') out.cwd = normalized
    else out.repo = normalized
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
  return ok(out)
}

/** 审查任务的目标是否由中枢模板重写（D10 第 2 步）：角色在 reviewer_roles 中且带 inputs.review。 */
export const isReviewTask = (
  contract: Pick<TaskContract, 'role' | 'inputs'>,
  supervisor: Pick<SupervisorConfig, 'reviewer_roles'>,
) => contract.inputs?.review !== undefined && supervisor.reviewer_roles.includes(contract.role)
