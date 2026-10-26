import {
  effectiveRoleKind,
  fail,
  type InboxConfig,
  loadRoles,
  loadWorkspaces,
  type Result,
  SUPERVISOR_ACTOR,
} from '@flow/core'
import type { Context } from 'hono'
import type { LedgerStore } from '../ledger/store.ts'
import type { RepoCheckOptions } from '../ledger/supervisor-checks.ts'
import type {
  RoleLookup,
  TaskService,
  VerifyPolicyCheck,
  WorkspaceLookup,
} from '../ledger/tasks.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'

/**
 * supervisor 的提问、任务提案与决策回看（add-m1-supervisor design D7、D11；tasks 4.4–4.7）共用的依赖与身份核对。
 *
 * 调用方身份一律取自鉴权中间件按唤醒绑定 token（D6）认定的结果，不信任请求体、`--task`、
 * `FLOW_TASK_ID` 或 `X-Flow-Actor`。
 */

export interface SupervisorToolsDeps {
  ledger: LedgerStore
  tasks: TaskService
  home: string
  workspaces: WorkspaceLookup
  roles: RoleLookup
  verifyPolicy: VerifyPolicyCheck
  /** 收件箱分级配置（热加载时返回新值）。 */
  levels: () => Pick<InboxConfig, 'levels'>
  /** workspace 是否启用了 supervisor（配置开启且存在 kind: supervisor 角色，D3）。 */
  supervisorActive: (workspace: string) => Promise<boolean>
  repoCheck?: RepoCheckOptions
  now: () => number
}

/** 鉴权中间件认定的唤醒调用方；其他认证方式返回 null。 */
export function wakeCallerOf(c: Context): WakeCaller | null {
  const auth = c.get('auth')
  return auth?.kind === 'wake' ? auth.wake : null
}

/**
 * 只限 supervisor 唤醒 token 的写操作的调用方核对（D6、D15）：
 * - 非 supervisor 身份 → `role_not_allowed`；
 * - supervisor 但不是经唤醒 token 认证 → `scope_denied`（失败即拒绝）；
 * - reply 唤醒 → `reply_only_wake`；
 * - 给出 workspace 且与绑定不一致 → `workspace_mismatch`。
 */
export function checkWakeCaller(
  op: string,
  actor: string,
  wake: WakeCaller | null,
  workspace?: string,
): Result<WakeCaller> {
  if (actor !== SUPERVISOR_ACTOR) {
    return fail('failure', 'role_not_allowed', `只有 supervisor 能调用 ${op}，当前为 ${actor}`)
  }
  if (!wake) {
    return fail(
      'failure',
      'scope_denied',
      `supervisor 只能通过唤醒绑定 token 调用 ${op}（无法确认本次唤醒与 workspace）`,
    )
  }
  if (wake.origin === 'reply') {
    return fail('failure', 'reply_only_wake', 'reply 唤醒只能调用 task_respond 与只读操作')
  }
  if (workspace !== undefined && workspace !== wake.workspace) {
    return fail(
      'failure',
      'workspace_mismatch',
      `本次唤醒绑定 ${wake.workspace}，不能作用于 ${workspace}`,
    )
  }
  return { ok: true, data: wake }
}

/** 基于 flow-home：workspace 启用 supervisor 且存在有效类别为 supervisor 的角色（每次调用重新读取）。 */
export function supervisorActiveFromHome(home: string): (workspace: string) => Promise<boolean> {
  return async (ref) => {
    const ws = await loadWorkspaces(home)
    if (!ws.ok) return false
    const found = ws.data.workspaces.find((w) => w.ref === ref)
    if (!found?.supervisor.enabled) return false
    const roles = await loadRoles(home)
    return roles.ok && roles.data.roles.some((r) => effectiveRoleKind(r) === 'supervisor')
  }
}

/** 一行化并截断（标题用）。 */
export const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
