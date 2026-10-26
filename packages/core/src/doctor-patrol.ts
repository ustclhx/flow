import type { DoctorCheck } from './doctor.ts'
import { effectiveRoleKind, type Role } from './roles.ts'
import { loadWorkspaces } from './workspaces.ts'

/** 巡检规则的 payload.kind（add-m1-supervisor D13；与唤醒调度器识别的值一致）。 */
export const SUPERVISOR_PATROL_KIND = 'supervisor_patrol'

/**
 * 启用了 supervisor 却没有巡检规则的 workspace 给 info（add-m1-supervisor D13）。
 *
 * 只看真正可能被唤醒的 workspace：非 global、`supervisor.enabled`、有登记仓库，且存在
 * `kind: supervisor` 角色（没有仓库、没有角色的情况已由其他检查报告）。
 * `config/schedules.yaml` 读不出来（YAML 错误）时不给这条 info：规则错误由 `flow hub status` 报告。
 */
export async function checkPatrolRules(home: string, roles?: Role[]): Promise<DoctorCheck[]> {
  if (roles && !roles.some((r) => effectiveRoleKind(r) === 'supervisor')) return []
  const workspaces = await loadWorkspaces(home)
  if (!workspaces.ok) return []
  // 动态导入：daemon/schedules.ts 与 ledger/protocol.ts 互相引用，静态导入会让直接加载 doctor.ts 的入口
  // 在 protocol 初始化前访问 scheduleErrorSchema（经 index.ts 加载时没有这个问题）。
  const { loadSchedulesConfig } = await import('./daemon/schedules.ts')
  const schedules = await loadSchedulesConfig(home)
  if (!schedules.ok) return []
  const patrolled = new Set(
    schedules.data.rules
      .filter((r) => r.payload.kind === SUPERVISOR_PATROL_KIND)
      .map((r) => r.workspace),
  )
  const checks: DoctorCheck[] = []
  for (const ws of workspaces.data.workspaces) {
    if (ws.file === null || !ws.supervisor.enabled || ws.repos.length === 0) continue
    if (patrolled.has(ws.ref)) continue
    checks.push({
      id: `workspace.${ws.id}.supervisor_patrol`,
      ok: false,
      severity: 'info',
      message: `${ws.ref} 启用了 supervisor 但没有巡检规则：supervisor 只在指令与事件到来时唤醒，不会每日巡检`,
      hint: `需要每日巡检时，在 config/schedules.yaml 取消注释巡检示例（payload.kind: ${SUPERVISOR_PATROL_KIND}，workspace: ${ws.ref}），见 docs/supervisor.md`,
    })
  }
  return checks
}
