import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { workspaceRef } from '../schema/common.ts'
import { formatZodIssues, type ValidationIssue } from '../validation-issue.ts'

/** `supervisor`：委托给本 workspace 的 supervisor 判断（D15）；节点对它不放行，按卡住上报。 */
export const policyLevelSchema = z.enum([
  'notify',
  'draft-approve',
  'supervisor',
  'auto-report',
  'auto',
])
export type PolicyLevel = z.infer<typeof policyLevelSchema>

export const policyRuleSchema = z
  .strictObject({
    scope: z.union([
      z.literal('*'),
      workspaceRef,
      z.string().regex(/^[^\s/*]+$/, '应为角色名、ws/<id> 或 *'),
    ]),
    action: z.string().regex(/^[^\s]+$/, '应为动作 id 或含 * 的动作模式'),
    level: policyLevelSchema,
    when: z
      .strictObject({
        command_prefix: z.string().trim().min(1).optional().meta({
          description: '按命令词匹配前缀；串联请求的每段命令都必须满足',
        }),
        paths: z.array(z.string().min(1)).min(1).optional().meta({
          description: '每个请求路径都须匹配至少一个模式；支持 *、**、?，路径使用 /',
        }),
        push_to: z.literal('task_branch').optional().meta({
          description:
            '只用于 git.push：单段 git push 推到执行器上报的任务分支（非默认分支），且节点上报 push_env_ok；任何不确定都不满足',
        }),
        gh_scope: z.literal('workspace_repo').optional().meta({
          description:
            '用于 gh pr create|view|diff：不带 -R/--repo、无环境变量前缀、节点上报 gh_env_ok，--body-file 只能在 cwd 内',
        }),
      })
      .optional(),
  })
  .refine((rule) => rule.when?.push_to === undefined || rule.action === 'git.push', {
    path: ['when', 'push_to'],
    message: 'push_to 只能用于 action: git.push',
  })

export const policiesConfigSchema = z
  .array(policyRuleSchema)
  .meta({ title: 'Flow policies config', description: 'config/policies.yaml：策略规则数组' })

export type PolicyRule = z.infer<typeof policyRuleSchema>
export interface IndexedPolicyRule {
  /** YAML 数组中的原始索引，从 0 开始；跳过坏规则后也不重新编号。 */
  rule_index: number
  rule: PolicyRule
}
export interface PolicyConfig {
  rules: IndexedPolicyRule[]
  errors: (ValidationIssue & { rule_index: number })[]
}

/** 文件级错误返回失败；单条规则错误只排除该条，供调用方集中报告。 */
export async function loadPoliciesConfig(home: string): Promise<Result<PolicyConfig>> {
  const file = 'config/policies.yaml'
  let text: string
  try {
    text = await readFile(flowPaths(home).policiesConfig, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({ rules: [], errors: [] })
    return fail('failure', 'read_failed', `无法读取 ${file}：${String(err)}`)
  }
  let input: unknown
  try {
    input = parse(text) ?? []
  } catch (err) {
    return fail('failure', 'invalid_config', `${file} 不是合法的 YAML：${String(err)}`)
  }
  const list = z.array(z.unknown()).safeParse(input)
  if (!list.success) return fail('failure', 'invalid_config', `${file} 必须是规则数组`)
  const rules: IndexedPolicyRule[] = []
  const errors: PolicyConfig['errors'] = []
  list.data.forEach((raw, rule_index) => {
    const parsed = policyRuleSchema.safeParse(raw)
    if (parsed.success) rules.push({ rule_index, rule: parsed.data })
    else {
      // strictObject 的未知键 issue 位于父对象，展开后才能精确报告拼错的字段。
      const issues = parsed.error.issues.flatMap<z.core.$ZodIssue>((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => ({ ...issue, path: [...issue.path, key] }))
          : [issue],
      )
      errors.push(
        ...formatZodIssues(issues, raw, { file }).map((issue) => ({
          ...issue,
          field: issue.field ?? '$',
          rule_index,
          message: `第 ${rule_index + 1} 条规则：${issue.message}`,
        })),
      )
    }
  })
  return ok({ rules, errors })
}
