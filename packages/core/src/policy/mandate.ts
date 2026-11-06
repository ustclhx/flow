import type { TaskView } from '../ledger/task.ts'
import { fail, ok, type Result } from '../result.ts'
import { canCreateRole, type Role, SUPERVISOR_ACTOR } from '../roles.ts'

/** 恢复已结束工作前重新核对当前授权；旧任务沿用账本确认的创建者。 */
export function checkTaskMandateForResume(
  task: Pick<TaskView, 'created_by' | 'mandate'>,
  current: { supervisor_enabled: boolean; role: Pick<Role, 'creatable_by'> | null },
): Result<void> {
  if (!current.role) return fail('failure', 'role_missing', '任务角色已不存在，不能恢复任务')
  const creator = task.mandate?.created_by ?? task.created_by
  // hub 管线保存源任务的 supervisor 唤醒；恢复这类派生任务同样要求 supervisor 仍启用。
  // 合并角色按设计仅由 hub/user 创建，不能对 hub 管线套用 supervisor 的 creatable_by。
  const directSupervisor = creator === SUPERVISOR_ACTOR
  const supervisorPipeline = creator === 'hub' && task.mandate?.wake_task !== undefined
  if (!directSupervisor && !supervisorPipeline) return ok(undefined)
  if (!current.supervisor_enabled) {
    return fail('failure', 'supervisor_disabled', '创建任务的 supervisor 已关闭，不能恢复任务')
  }
  if (directSupervisor && !canCreateRole(current.role, SUPERVISOR_ACTOR)) {
    return fail('failure', 'role_not_allowed', '当前角色不再允许 supervisor 创建任务，不能恢复任务')
  }
  return ok(undefined)
}
