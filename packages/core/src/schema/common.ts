import { z } from 'zod'

/**
 * 跨条目复用的基础字段类型。日期一律是 `YYYY-MM-DD` 字符串，
 * 不依赖 YAML 的时间戳解析（yaml 包默认的 core schema 不会把它转成 Date）。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 判断 `YYYY-MM-DD` 是否是真实存在的日历日期（排除 2026-02-30 之类）。 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export const dateString = z
  .string()
  .regex(DATE_RE, '日期格式应为 YYYY-MM-DD')
  .refine(isCalendarDate, '不是有效的日历日期')
  .meta({ description: '日期，格式 YYYY-MM-DD' })

export const WS_REF_RE = /^ws\/[a-z0-9][a-z0-9-]*$/
export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export const workspaceRef = z
  .string()
  .regex(WS_REF_RE, 'workspace 标识应形如 ws/<id>')
  .meta({ description: 'workspace 标识，形如 ws/<id>' })

export const SECRET_REF_RE = /^secret:\/\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/** 密钥引用：只允许 `secret://<路径>`，绝不允许明文（secret-hygiene）。 */
export const secretRef = z
  .string()
  .regex(SECRET_REF_RE, '凭据必须是 secret://<路径> 形式的引用，不能写明文')
  .meta({ description: '密钥引用，形如 secret://<路径>；不得写明文' })

/** 条目标识：相对 brain/ 的路径，不含 `.md`。 */
export const entryId = z
  .string()
  .regex(/^[^/.]/, '条目标识应为相对 brain/ 的路径，不含扩展名')
  .refine((v) => !v.endsWith('.md'), '条目标识不含 .md 扩展名')
  .meta({ description: '条目标识：相对 brain/ 的路径，不含 .md' })
