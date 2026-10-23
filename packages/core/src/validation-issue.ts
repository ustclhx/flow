import type { z } from 'zod'

/** 校验发现的一个问题。错误码稳定，供脚本与 agent 判断。 */
export interface ValidationIssue {
  /** 相对 flow-home 的文件路径，例如 `brain/resources/domains/x.md`。 */
  file: string
  /** 条目标识（仅 brain 条目）。 */
  id?: string
  /** 出问题的字段，嵌套字段用 `.` 连接。 */
  field?: string
  code: string
  message: string
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = data
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return cur
}

/** 把 zod 的 issue 转成带文件与字段名的中文问题描述。 */
export function formatZodIssues(
  issues: readonly z.core.$ZodIssue[],
  data: unknown,
  ctx: { file: string; id?: string },
): ValidationIssue[] {
  return issues.map((issue) => {
    const field = issue.path.map(String).join('.')
    const base = ctx.id === undefined ? { file: ctx.file } : { file: ctx.file, id: ctx.id }
    const withField = field === '' ? base : { ...base, field }
    if (issue.code === 'invalid_type' && valueAt(data, issue.path) === undefined) {
      return { ...withField, code: 'missing_field', message: `缺少必填字段 ${field}` }
    }
    const detail =
      issue.code === 'invalid_type'
        ? `类型错误，应为 ${issue.expected}`
        : issue.code === 'invalid_value'
          ? `取值无效，应为 ${issue.values.map((v) => JSON.stringify(v)).join(' | ')}`
          : issue.message
    return {
      ...withField,
      code: 'invalid_field',
      message: field === '' ? detail : `字段 ${field}：${detail}`,
    }
  })
}
