import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'
import { flowPaths } from '../home.ts'
import { BLOCKED_REASONS } from '../ledger/task.ts'
import { fail, ok, type Result } from '../result.ts'
import { workspaceRef } from '../schema/common.ts'
import { formatZodIssues, type ValidationIssue } from '../validation-issue.ts'
import { INBOX_LEVELS, type InboxLevel, type InboxSource, inboxSource } from './schema.ts'

/**
 * `config/inbox.yaml`（inbox spec "默认分级"：用户可以覆盖默认级别）。
 *
 * ```yaml
 * levels:
 *   - reason: no_progress          # 所有 workspace 的无进展卡住只进每日摘要
 *     level: digest
 *   - source: task
 *     workspace: ws/product-res
 *     reason: question
 *     level: decide
 * ```
 *
 * 匹配：规则中写出的条件（source、workspace、reason）都要满足；多条命中时，条件更多的规则优先，
 * 条件数相同时文件中靠后的规则优先（后写的覆盖先写的）。都不命中时用默认级别（`defaultInboxLevel`）。
 * 单条规则写错只排除该条，并报告错误，其他规则照常生效。
 * 推送节奏（静默时段、Decide 时间点等）的字段由 3.3 加入。
 */

/** 级别写法不区分首字母大小写：spec 中写作 Interrupt / Decide / Digest。 */
const levelInput = z
  .enum([...INBOX_LEVELS, 'Interrupt', 'Decide', 'Digest'])
  .meta({ description: '级别：interrupt、decide 或 digest（首字母大小写均可）' })

export const inboxLevelRuleSchema = z
  .strictObject({
    source: inboxSource.optional().meta({ description: '只匹配该来源；缺省匹配所有来源' }),
    workspace: z
      .union([z.literal('*'), workspaceRef])
      .optional()
      .meta({ description: '只匹配该 workspace（ws/<id>）；缺省或 * 匹配所有' }),
    reason: z.enum(BLOCKED_REASONS).optional().meta({
      description: '只匹配该卡住原因（任务来源）；缺省匹配所有原因',
    }),
    level: levelInput,
  })
  .meta({ title: 'Inbox level rule', description: '一条分级覆盖规则' })

export const inboxConfigSchema = z
  .strictObject({
    levels: z
      .array(inboxLevelRuleSchema)
      .default([])
      .meta({ description: '分级覆盖规则，按条件多少与先后决定优先级' }),
  })
  .meta({ title: 'Flow inbox config', description: 'config/inbox.yaml：收件箱配置' })

export interface InboxLevelRule {
  /** `levels` 数组中的原始索引，从 0 开始。 */
  rule_index: number
  source?: InboxSource
  workspace?: string
  reason?: string
  level: InboxLevel
}

export interface InboxConfig {
  levels: InboxLevelRule[]
  errors: (ValidationIssue & { rule_index?: number })[]
}

export const EMPTY_INBOX_CONFIG: InboxConfig = { levels: [], errors: [] }

const FILE = 'config/inbox.yaml'

function issuesOf(error: z.ZodError, raw: unknown) {
  // strictObject 的未知键 issue 位于父对象，展开后才能精确报告拼错的字段。
  const issues = error.issues.flatMap<z.core.$ZodIssue>((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ ...issue, path: [...issue.path, key] }))
      : [issue],
  )
  return formatZodIssues(issues, raw, { file: FILE })
}

/** 解析已读出的配置对象（测试与热加载共用）。文件级错误返回失败，单条规则错误收集到 errors。 */
export function parseInboxConfig(input: unknown): Result<InboxConfig> {
  if (input === null || input === undefined) return ok({ levels: [], errors: [] })
  if (typeof input !== 'object' || Array.isArray(input)) {
    return fail('failure', 'invalid_config', `${FILE} 顶层必须是对象`)
  }
  const obj = input as Record<string, unknown>
  const errors: InboxConfig['errors'] = []
  for (const key of Object.keys(obj)) {
    if (key !== 'levels') {
      errors.push({ file: FILE, field: key, code: 'unknown_field', message: `未知字段 ${key}` })
    }
  }
  const rawLevels = obj.levels ?? []
  if (!Array.isArray(rawLevels)) {
    return fail('failure', 'invalid_config', `${FILE} 的 levels 必须是规则数组`)
  }
  const levels: InboxLevelRule[] = []
  rawLevels.forEach((raw, rule_index) => {
    const parsed = inboxLevelRuleSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(
        ...issuesOf(parsed.error, raw).map((issue) => ({
          ...issue,
          field: `levels.${rule_index}${issue.field ? `.${issue.field}` : ''}`,
          rule_index,
          message: `第 ${rule_index + 1} 条分级规则：${issue.message}`,
        })),
      )
      return
    }
    const r = parsed.data
    levels.push({
      rule_index,
      ...(r.source ? { source: r.source } : {}),
      ...(r.workspace && r.workspace !== '*' ? { workspace: r.workspace } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      level: r.level.toLowerCase() as InboxLevel,
    })
  })
  return ok({ levels, errors })
}

/** 读取 `config/inbox.yaml`；文件不存在等同空配置。 */
export async function loadInboxConfig(home: string): Promise<Result<InboxConfig>> {
  let text: string
  try {
    text = await readFile(flowPaths(home).inboxConfig, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({ levels: [], errors: [] })
    return fail('failure', 'read_failed', `无法读取 ${FILE}：${String(err)}`)
  }
  let input: unknown
  try {
    input = parse(text)
  } catch (err) {
    return fail('failure', 'invalid_config', `${FILE} 不是合法的 YAML：${String(err)}`)
  }
  return parseInboxConfig(input)
}

/** 分级的输入：条目来源、所属 workspace、来源内原因（任务的卡住原因）。 */
export interface LevelQuery {
  source: InboxSource
  workspace?: string | null
  reason?: string | null
}

/**
 * 默认级别（inbox spec "默认分级"）：
 * - awaiting_approval、question、crashed、node_lost：Interrupt；
 * - no_progress、other、待确认提案、supervisor 提问：Decide；
 * - auto-report 策略记录、每日完成情况：Digest。
 */
export function defaultInboxLevel(q: LevelQuery): InboxLevel {
  switch (q.source) {
    case 'task':
      return q.reason === 'no_progress' || q.reason === 'other' ? 'decide' : 'interrupt'
    case 'proposal':
    case 'supervisor':
      return 'decide'
    case 'policy':
    case 'digest':
      return 'digest'
  }
}

/** 按 `config/inbox.yaml` 的覆盖规则决定级别；不命中任何规则时取默认级别。 */
export function resolveInboxLevel(config: Pick<InboxConfig, 'levels'>, q: LevelQuery): InboxLevel {
  let best: { rule: InboxLevelRule; score: number } | undefined
  for (const rule of config.levels) {
    if (rule.source !== undefined && rule.source !== q.source) continue
    if (rule.workspace !== undefined && rule.workspace !== q.workspace) continue
    if (rule.reason !== undefined && rule.reason !== q.reason) continue
    const score =
      (rule.source === undefined ? 0 : 1) +
      (rule.workspace === undefined ? 0 : 1) +
      (rule.reason === undefined ? 0 : 1)
    // 同分时后面的规则覆盖前面的。
    if (best === undefined || score >= best.score) best = { rule, score }
  }
  return best?.rule.level ?? defaultInboxLevel(q)
}
