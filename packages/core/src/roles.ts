import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { flowPaths } from './home.ts'
import { executorType } from './ledger/common.ts'
import { isDeclarableActor } from './ledger/protocol.ts'
import { fail, ok, type Result } from './result.ts'
import { formatZodIssues, type ValidationIssue } from './validation-issue.ts'
import { isValidActor, USER_ACTOR } from './write/policy.ts'

/** 当前内置的执行器类型；角色 schema 不限定此列表，由 doctor 检查可用性。 */
export const KNOWN_EXECUTORS = ['fake', 'codex-orca', 'claude-sdk', 'codex-exec'] as const

/**
 * `creatable_by` 中的一项：`*`；`<前缀>:*` 形式的前缀通配（例如 `node:*`、`remote:*`）；
 * 或精确的操作者标识（与 ACTOR_RE 相同的格式）。写成单个正则，导出的 JSON Schema 也带上同样的约束。
 */
const ACTOR_PATTERN_RE =
  /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:@-]{0,62}:\*|[A-Za-z0-9][A-Za-z0-9._:@-]{0,63})$/

export const actorPattern = z
  .string()
  .regex(
    ACTOR_PATTERN_RE,
    '应为操作者标识（如 user、node:n-abc）、前缀通配（如 node:*、remote:*）或 *',
  )
  .meta({ description: '操作者模式：精确值，或 `*`、`<前缀>:*` 形式的前缀通配' })

/** 操作者是否匹配模式：`*` 匹配全部；`<前缀>:*` 匹配以 `<前缀>:` 开头的身份；其余精确比较（区分大小写）。 */
export function actorMatches(pattern: string, actor: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1)
    return actor.length > prefix.length && actor.startsWith(prefix)
  }
  return pattern === actor
}

/**
 * 某身份能否创建该角色的任务：`user` 永远可以；其他身份必须匹配 `creatable_by` 中的某一项。
 * 字段缺省时只有 `user` 可以创建（默认拒绝 AI 与节点）。
 */
export function canCreateRole(role: Pick<Role, 'creatable_by'>, actor: string): boolean {
  if (actor === USER_ACTOR) return true
  return (role.creatable_by ?? []).some((p) => actorMatches(p, actor))
}

export const writablePaths = z.array(z.string().min(1)).meta({
  description:
    '仅 claude-sdk 可配置，其他执行器报配置错误；cwd 相对路径 glob（*、**、?，不支持花括号）；原路径与真实路径都须匹配，硬性禁止 ..、越界、隐藏路径、代理指令文件及 NotebookEdit，禁写名称按 NFKC 和 Unicode 大小写折叠比较；[] 禁止全部，缺省沿用原有审批',
})

export const readScope = z.enum(['cwd']).meta({
  description:
    '仅 claude-sdk 可配置，其他执行器报配置错误；cwd：所有工具的路径类参数只能落在合同 cwd 与任务私有目录内，拒绝 ~、..、隐藏路径段、绝对 glob 与符号链接越界，只允许白名单内置工具与字段（Bash、WebFetch、非 Flow 的 MCP 等一律拒绝）；Flow MCP 不受影响',
})

export const roleSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .refine((name) => name !== USER_ACTOR && isValidActor(name) && isDeclarableActor(name), {
        message: '角色名必须是合法且可声明的 AI 身份，不能使用 user、保留身份或 node: 前缀',
      })
      .meta({ description: '可声明的 AI 角色名，与 YAML 文件名（不含扩展名）一致' }),
    executor: executorType,
    prompt: z.string().min(1).meta({
      description: '内联提示词；同目录的 .md 文件名视为文件引用，文件必须存在',
    }),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    permissions: z
      .looseObject({ writable_paths: writablePaths.optional(), read_scope: readScope.optional() })
      .optional()
      .meta({ description: '执行器专用权限设置；其余字段由执行器校验' }),
    no_progress_minutes: z.number().int().positive().optional(),
    creatable_by: z.array(actorPattern).optional().meta({
      description:
        '除 user 之外，允许哪些身份创建该角色的任务（精确值或 node:*、remote:*、* 等前缀通配）；缺省时只有 user 可以创建',
    }),
  })
  .superRefine((role, ctx) => {
    if (role.permissions?.writable_paths !== undefined && role.executor !== 'claude-sdk') {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'writable_paths'],
        message: 'writable_paths 仅适用于 claude-sdk 执行器',
      })
    }
    if (role.permissions?.read_scope !== undefined && role.executor !== 'claude-sdk') {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'read_scope'],
        message: 'read_scope 仅适用于 claude-sdk 执行器',
      })
    }
  })
  .meta({ title: 'Flow role config', description: 'config/roles/<name>.yaml' })
export type Role = z.infer<typeof roleSchema>

export interface RoleSet {
  roles: Role[]
  /** 出错文件不会加载；路径相对 flow-home，字段路径以点连接。 */
  errors: ValidationIssue[]
}

/** 目录不存在时返回空集；逐文件加载，单个文件错误不影响其他角色。 */
export async function loadRoles(home: string): Promise<Result<RoleSet>> {
  const dir = flowPaths(home).roles
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.yaml') && !n.startsWith('.')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({ roles: [], errors: [] })
    return fail('failure', 'read_failed', `无法读取 ${dir}：${String(err)}`)
  }
  const roles: Role[] = []
  const errors: ValidationIssue[] = []
  for (const name of names) {
    const path = join(dir, name)
    const file = relative(home, path)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      errors.push({ file, code: 'read_failed', message: `无法读取角色文件：${String(err)}` })
      continue
    }
    let input: unknown
    try {
      input = parse(text)
    } catch (err) {
      errors.push({ file, code: 'invalid_yaml', message: `不是合法的 YAML：${String(err)}` })
      continue
    }
    const parsed = roleSchema.safeParse(input)
    if (!parsed.success) {
      errors.push(...formatZodIssues(parsed.error.issues, input, { file }))
      continue
    }
    const role = parsed.data
    if (role.name !== name.slice(0, -5)) {
      errors.push({
        file,
        field: 'name',
        code: 'role_name_mismatch',
        message: `角色名 ${role.name} 与文件名 ${name} 不一致`,
      })
      continue
    }
    // 只解释同目录的文件名；含路径的文本保持内联，不读取目录外的文件。
    if (role.prompt.endsWith('.md') && basename(role.prompt) === role.prompt) {
      try {
        role.prompt = await readFile(join(dir, role.prompt), 'utf8')
      } catch (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        errors.push({
          file,
          field: 'prompt',
          code: missing ? 'prompt_file_missing' : 'read_failed',
          message: missing ? `提示词文件 ${role.prompt} 不存在` : String(err),
        })
        continue
      }
    }
    roles.push(role)
  }
  return ok({ roles, errors })
}
