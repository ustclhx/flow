import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { workspaceRef } from '../schema/common.ts'
import { formatZodIssues } from '../validation-issue.ts'
import { loadWorkspaces } from '../workspaces.ts'

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

/** 文件级错误返回失败；逐条校验，局部错误只排除对应规则。cron 和时区由中枢的 croner 校验。 */
export async function loadSchedulesConfig(home: string): Promise<Result<ScheduleConfig>> {
  let text: string
  try {
    text = await readFile(flowPaths(home).schedulesConfig, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({ rules: [], errors: [] })
    return fail('failure', 'read_failed', `无法读取 config/schedules.yaml：${String(err)}`)
  }
  let input: unknown
  try {
    input = parse(text) ?? []
  } catch (err) {
    return fail(
      'failure',
      'invalid_config',
      `config/schedules.yaml 不是合法的 YAML：${String(err)}`,
    )
  }
  const list = z.array(z.unknown()).safeParse(input)
  if (!list.success) {
    return fail('failure', 'invalid_config', 'config/schedules.yaml 必须是规则数组')
  }
  const workspaces = await loadWorkspaces(home)
  if (!workspaces.ok) return workspaces
  const refs = new Set(workspaces.data.workspaces.map((ws) => ws.ref))
  const rules: ScheduleRule[] = []
  const errors: ScheduleError[] = []
  const ids = new Set<string>()
  list.data.forEach((raw, rule_index) => {
    const id = z.object({ id: z.string() }).safeParse(raw)
    const context = { rule_index, ...(id.success ? { rule_id: id.data.id } : {}) }
    const parsed = scheduleRuleSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(
        ...formatZodIssues(parsed.error.issues, raw, { file: 'config/schedules.yaml' }).map(
          ({ file: _file, ...issue }) => ({ ...context, ...issue }),
        ),
      )
      return
    }
    const rule = parsed.data
    if (ids.has(rule.id)) {
      errors.push({ ...context, field: 'id', code: 'duplicate_rule', message: '规则 id 重复' })
      return
    }
    ids.add(rule.id)
    if (RESERVED_RULE_PREFIXES.some((prefix) => rule.id.startsWith(prefix))) {
      errors.push({
        ...context,
        field: 'id',
        code: 'reserved_rule_id',
        message: `规则 id 不能以 ${rule.id.split(':')[0]}: 开头（中枢内部规则保留）`,
      })
      return
    }
    if (!refs.has(rule.workspace)) {
      errors.push({
        ...context,
        field: 'workspace',
        code: 'unknown_workspace',
        message: `workspace ${rule.workspace} 未定义`,
      })
      return
    }
    rules.push(rule)
  })
  return ok({ rules, errors })
}
