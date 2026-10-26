import { z } from 'zod'

/**
 * workspace 配置中的 `supervisor` 一节（add-m1-supervisor D3、D4、D10、D15；tasks 1.2）。
 *
 * 所有字段可选、有默认值；未知字段视为错误（拼错的键不会被静默忽略）。
 * `enabled` 缺省为 true，但只有存在 `kind: supervisor` 角色时才生效（D3）。
 */

export const SUPERVISOR_LIMIT_DEFAULTS = {
  tasks_per_wake: 5,
  wakes_per_day: 24,
  autonomous_wakes_per_day: 4,
  reply_wakes_per_day: 48,
  chain_depth: 8,
  review_rounds: 2,
  open_questions: 3,
} as const

const count = (max: number, def: number, description: string) =>
  z.number().int().min(0).max(max).default(def).meta({ description })

export const supervisorLimitsSchema = z
  .strictObject({
    tasks_per_wake: count(
      100,
      SUPERVISOR_LIMIT_DEFAULTS.tasks_per_wake,
      '每次唤醒最多创建的任务数，超出返回 limit_exceeded；默认 5',
    ),
    wakes_per_day: count(
      1000,
      SUPERVISOR_LIMIT_DEFAULTS.wakes_per_day,
      '每天普通唤醒（instruction + autonomous，不含 reply）的次数上限；默认 24',
    ),
    autonomous_wakes_per_day: count(
      1000,
      SUPERVISOR_LIMIT_DEFAULTS.autonomous_wakes_per_day,
      '其中 autonomous 唤醒的次数上限；默认 4',
    ),
    reply_wakes_per_day: count(
      1000,
      SUPERVISOR_LIMIT_DEFAULTS.reply_wakes_per_day,
      '每天代回复（reply）唤醒的次数上限，超出时委托立即转交用户；默认 48',
    ),
    chain_depth: count(64, SUPERVISOR_LIMIT_DEFAULTS.chain_depth, 'parent 链深度上限；默认 8'),
    review_rounds: count(
      20,
      SUPERVISOR_LIMIT_DEFAULTS.review_rounds,
      '同一 PR 的 changes_requested 轮数上限，超出返回 review_rounds_exceeded；默认 2',
    ),
    open_questions: count(
      20,
      SUPERVISOR_LIMIT_DEFAULTS.open_questions,
      '同一 workspace 未回答的提问上限，超出返回 too_many_questions；默认 3',
    ),
  })
  .refine((l) => l.autonomous_wakes_per_day <= l.wakes_per_day, {
    message: 'autonomous_wakes_per_day 不能超过 wakes_per_day',
    path: ['autonomous_wakes_per_day'],
  })
  .meta({ title: 'Supervisor limits', description: '中枢强制的硬性上限（D4）' })

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

/** 角色名（与 config/roles/<name>.yaml 一致）；这里只校验格式，角色是否存在由 doctor 与中枢检查。 */
const roleName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '角色名格式不合法')
  .meta({ description: '角色名' })

export const DEFAULT_REVIEWER_ROLES = ['pr-reviewer'] as const
export const DEFAULT_REPLY_TIMEOUT_S = 600

export const supervisorConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true).meta({
      description:
        '是否唤醒本 workspace 的 supervisor；缺省 true，仅在存在 kind: supervisor 角色时生效',
    }),
    auto_merge: z.boolean().default(false).meta({
      description: 'true：审查通过后中枢直接建 merger 任务；默认 false，需要用户在收件箱批准合并',
    }),
    merge_method: z
      .enum(MERGE_METHODS)
      .default('squash')
      .meta({ description: 'pr-merge 的合并方式：squash（默认）、merge 或 rebase' }),
    allow_no_checks: z.boolean().default(false).meta({
      description: 'true：PR 没有任何检查时也允许合并；默认 false（至少要有一项检查且全部成功）',
    }),
    reviewer_roles: z
      .array(roleName)
      .min(1)
      .max(16)
      .default([...DEFAULT_REVIEWER_ROLES])
      .meta({
        description: '审查结论被采信的角色（只接受 claude-sdk 执行器）；默认 [pr-reviewer]',
      }),
    delegate_replies: z.boolean().default(true).meta({
      description: '卡住时先交给 supervisor 代回复（D15）；启用 supervisor 时默认 true',
    }),
    reply_timeout_s: z
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(DEFAULT_REPLY_TIMEOUT_S)
      .meta({ description: '代回复的等待秒数，超时转交用户；默认 600' }),
    limits: supervisorLimitsSchema.default({ ...SUPERVISOR_LIMIT_DEFAULTS }),
  })
  .meta({ title: 'Workspace supervisor', description: 'workspace 配置的 supervisor 一节' })

export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>
export type SupervisorLimits = z.infer<typeof supervisorLimitsSchema>

/** 全部取默认值的 supervisor 配置（workspace 文件没有写 `supervisor` 时使用）。 */
export const defaultSupervisorConfig = (): SupervisorConfig => supervisorConfigSchema.parse({})
