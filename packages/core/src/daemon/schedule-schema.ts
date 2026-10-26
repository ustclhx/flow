import { z } from 'zod'
import { workspaceRef } from '../schema/common.ts'

/**
 * `config/schedules.yaml` 的 schema（叶子模块，只依赖 zod 与通用 schema）：
 * `ledger/protocol.ts` 引用 `scheduleErrorSchema`，放在这里避免与 `schedules.ts`（依赖 workspaces）形成循环。
 */

/** 中枢内部定时规则保留的 id 前缀（add-m1-inbox D8：例如 `inbox:digest`），schedules.yaml 不能用。 */
export const RESERVED_RULE_PREFIXES: readonly string[] = ['inbox:']

export const scheduleRuleSchema = z.strictObject({
  id: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1).optional().meta({ description: '缺省使用本机时区' }),
  workspace: workspaceRef,
  payload: z.record(z.string(), z.unknown()).default({}),
})

export const schedulesConfigSchema = z
  .array(scheduleRuleSchema)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>()
    rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '规则 id 重复' })
      }
      seen.add(rule.id)
    })
  })
  .meta({ title: 'Flow schedules config', description: 'config/schedules.yaml：定时规则数组' })

export const scheduleErrorSchema = z.object({
  rule_id: z.string().optional(),
  rule_index: z.number().int().min(0).optional(),
  field: z.string().optional(),
  code: z.string().optional(),
  message: z.string(),
})
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>
export type ScheduleError = z.infer<typeof scheduleErrorSchema>
export interface ScheduleConfig {
  rules: ScheduleRule[]
  errors: ScheduleError[]
}
