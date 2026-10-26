import { readBrainEntries } from './entries.ts'
import { fail, ok, type Result } from './result.ts'
import { isCalendarDate, WS_REF_RE } from './schema/common.ts'
import { entrySchemas, isEntryType, isFactType, isResourceType } from './schema/entries.ts'
import { formatZodIssues, type ValidationIssue } from './validation-issue.ts'
import { loadWorkspaces, type Workspace } from './workspaces.ts'

export const DEFAULT_STALE_DAYS = 90

export interface ValidateOptions {
  /** 超过多少天未核实视为可能过时，默认 90。 */
  staleDays?: number
  /** 计算过期用的"今天"（YYYY-MM-DD），默认本地日期；测试中注入。 */
  today?: string
}

export interface VerificationItem {
  id: string
  file: string
  type: string
  last_verified: string | null
  /** 距今天数；从未核实时为 null。 */
  age_days: number | null
}

export interface ValidationReport {
  /** 检查过的条目数。 */
  checked: number
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  /** 可能过时：`last_verified` 早于 staleDays 天前的事实条目。 */
  stale: VerificationItem[]
  /** 从未核实：`last_verified` 为空的事实条目。 */
  neverVerified: VerificationItem[]
  staleDays: number
  today: string
}

const DAY_MS = 86_400_000

export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/** 条目中引用 workspace 的非 owner 字段。 */
const WORKSPACE_FIELDS = ['workspace'] as const

/**
 * 单个条目 frontmatter 的错误级检查：type、schema 必填字段、owner 与 workspace 引用。
 * `flow kb validate` 与统一写入路径共用这一套规则，保证两边判断一致。
 */
export function checkEntryFrontmatter(
  fm: Record<string, unknown>,
  ctx: { file: string; id: string; workspaces: ReadonlyMap<string, Workspace> },
): ValidationIssue[] {
  const { file, id, workspaces } = ctx
  const errors: ValidationIssue[] = []
  const at = (field: string, code: string, message: string): ValidationIssue => ({
    file,
    id,
    field,
    code,
    message,
  })
  const type = fm.type
  if (type === undefined || type === null) return [at('type', 'missing_field', '缺少必填字段 type')]
  if (!isEntryType(type)) return [at('type', 'unknown_type', `未知条目类型：${String(type)}`)]

  const parsed = entrySchemas[type].safeParse(fm)
  if (!parsed.success) errors.push(...formatZodIssues(parsed.error.issues, fm, { file, id }))

  // 资源单一归属：owner 必须是已定义的非职能 workspace（ws/global 合法）。
  if (isResourceType(type) && typeof fm.owner === 'string' && WS_REF_RE.test(fm.owner)) {
    const ws = workspaces.get(fm.owner)
    if (!ws) {
      errors.push(at('owner', 'unknown_owner', `owner 指向未定义的 workspace：${fm.owner}`))
    } else if (ws.kind === 'function') {
      errors.push(
        at('owner', 'function_owner', `职能 workspace 不能拥有资源：${fm.owner} 是 function 类型`),
      )
    }
  }
  for (const field of WORKSPACE_FIELDS) {
    const v = fm[field]
    if (typeof v === 'string' && WS_REF_RE.test(v) && !workspaces.has(v)) {
      errors.push(at(field, 'unknown_workspace', `${field} 指向未定义的 workspace：${v}`))
    }
  }
  return errors
}

/**
 * 校验 brain 下的全部条目与 workspace 定义（knowledge-base、resource-registry）。
 * 只有 brain 不存在时返回失败；条目问题都记入报告，由调用方根据 errors 决定退出码。
 */
export async function validateBrain(
  home: string,
  opts: ValidateOptions = {},
): Promise<Result<ValidationReport>> {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS
  if (!Number.isInteger(staleDays) || staleDays < 0) {
    return fail('usage', 'invalid_stale_days', 'stale-days 必须是非负整数')
  }
  const today = opts.today ?? localDate()
  const read = await readBrainEntries(home)
  if (!read.ok) return read
  const wsResult = await loadWorkspaces(home)
  if (!wsResult.ok) return wsResult

  const workspaces = new Map<string, Workspace>(wsResult.data.workspaces.map((w) => [w.ref, w]))
  const knownIds = new Set(read.data.entries.map((e) => e.id))
  const errors: ValidationIssue[] = [...wsResult.data.issues, ...read.data.issues]
  // workspace 的 supervisor 段问题已降级为"supervisor 未启用"，按警告报告。
  const warnings: ValidationIssue[] = [...wsResult.data.warnings]
  const stale: VerificationItem[] = []
  const neverVerified: VerificationItem[] = []

  for (const entry of read.data.entries) {
    const { id, file, frontmatter: fm } = entry
    const at = (field: string, code: string, message: string): ValidationIssue => ({
      file,
      id,
      field,
      code,
      message,
    })
    const entryErrors = checkEntryFrontmatter(fm, { file, id, workspaces })
    errors.push(...entryErrors)
    const type = fm.type
    if (!isEntryType(type)) continue
    if (Array.isArray(fm.applies_to)) {
      for (const ref of fm.applies_to) {
        if (typeof ref === 'string' && !knownIds.has(ref)) {
          warnings.push(
            at('applies_to', 'unknown_reference', `applies_to 引用了不存在的条目：${ref}`),
          )
        }
      }
    }

    if (!isFactType(type)) continue
    // 出处：validate 无法区分作者，缺失只警告；AI 写入的强制拒绝在写入路径实现。
    const sources = fm.sources
    if (fm.scope !== 'personal' && (!Array.isArray(sources) || sources.length === 0)) {
      warnings.push(at('sources', 'missing_sources', '事实类条目需要出处（sources 为空）'))
    }
    const lv = fm.last_verified
    if (lv === undefined || lv === null) {
      neverVerified.push({ id, file, type, last_verified: null, age_days: null })
    } else if (typeof lv === 'string' && isCalendarDate(lv)) {
      const age = daysBetween(lv, today)
      if (age > staleDays) stale.push({ id, file, type, last_verified: lv, age_days: age })
    }
  }

  return ok({
    checked: read.data.entries.length + read.data.issues.length,
    errors,
    warnings,
    stale,
    neverVerified,
    staleDays,
    today,
  })
}

/** 人类可读的校验报告。 */
export function formatValidationReport(r: ValidationReport): string {
  const issueLine = (i: ValidationIssue) =>
    `  ${i.file}${i.field ? ` [${i.field}]` : ''}: ${i.message} (${i.code})`
  const itemLine = (i: VerificationItem) =>
    `  ${i.id} (${i.type})${i.last_verified ? `，最近核实 ${i.last_verified}，${i.age_days} 天前` : ''}`
  const parts = [
    `检查了 ${r.checked} 个条目：${r.errors.length} 个错误，${r.warnings.length} 个警告`,
  ]
  if (r.errors.length) parts.push('错误：', ...r.errors.map(issueLine))
  if (r.warnings.length) parts.push('警告：', ...r.warnings.map(issueLine))
  if (r.stale.length) parts.push(`可能过时（超过 ${r.staleDays} 天）：`, ...r.stale.map(itemLine))
  if (r.neverVerified.length) parts.push('从未核实：', ...r.neverVerified.map(itemLine))
  return parts.join('\n')
}
