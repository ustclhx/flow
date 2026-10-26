import type { Scheduler } from '../scheduler/index.ts'
import type { HubLogger } from '../server/maintenance.ts'
import type { SupervisorToolsDeps } from './common.ts'
import { DECISION_REVIEW_HOUR, scanDecisionReviews } from './decisions.ts'
import { expireQuestions } from './questions.ts'

export * from './common.ts'
export * from './decisions.ts'
export * from './questions.ts'
export * from './routes.ts'
export * from './task-proposals.ts'

/**
 * 中枢内的定时部分（tasks 4.4、4.7）：
 * - `questions:expire`：每小时关闭 7 天未答复的提问（`expired`）；
 * - `decisions:review`：每天 09:00（中枢时区）扫描到期决策。
 * 启动时各执行一次，补上停机期间错过的。命名空间不用 `supervisor:`，留给唤醒调度器。
 */
export async function startSupervisorTools(
  deps: SupervisorToolsDeps,
  o: { scheduler?: Pick<Scheduler, 'setInternalRules'>; logger?: Pick<HubLogger, 'warn'> },
): Promise<{ stop(): void }> {
  const expire = () => {
    try {
      expireQuestions(deps.ledger, deps.now())
    } catch (err) {
      o.logger?.warn('关闭过期提问失败', String(err))
    }
  }
  const scan = async () => {
    try {
      const r = await scanDecisionReviews(deps)
      if (!r.ok) o.logger?.warn('扫描到期决策失败', r.error)
    } catch (err) {
      o.logger?.warn('扫描到期决策失败', String(err))
    }
  }
  expire()
  await scan()
  const q = o.scheduler?.setInternalRules('questions:', [
    { id: 'questions:expire', cron: '0 * * * *', onFire: expire },
  ])
  if (q && !q.ok) o.logger?.warn('提问过期规则设置失败', q.error)
  const d = o.scheduler?.setInternalRules('decisions:', [
    {
      id: 'decisions:review',
      cron: `0 ${DECISION_REVIEW_HOUR} * * *`,
      onFire: () => scan(),
    },
  ])
  if (d && !d.ok) o.logger?.warn('决策回看规则设置失败', d.error)
  return {
    stop() {
      o.scheduler?.setInternalRules('questions:', [])
      o.scheduler?.setInternalRules('decisions:', [])
    },
  }
}
