import type { TaskView } from '../ledger/task.ts'
import { fail, ok, type Result } from '../result.ts'
import { canCreateRole, type Role, SUPERVISOR_ACTOR } from '../roles.ts'

/** 恢复已结束工作前重新核对当前授权；旧任务沿用账本确认的创建者。 */
export function checkTaskMandateForResume(
  task: Pick<TaskView, 'created_by' | 'mandate'>,
  current: { supervisor_enabled: boolean; role: Pick<Role, 'creatable_by'> },
): Result<void> {
  if ((task.mandate?.created_by ?? task.created_by) !== SUPERVISOR_ACTOR) return ok(undefined)
  if (!current.supervisor_enabled) {
    return fail('failure', 'supervisor_disabled', '创建任务的 supervisor 已关闭，不能恢复任务')
  }
  if (!canCreateRole(current.role, SUPERVISOR_ACTOR)) {
    return fail('failure', 'role_not_allowed', '当前角色不再允许 supervisor 创建任务，不能恢复任务')
  }
  return ok(undefined)
}
