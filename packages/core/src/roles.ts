import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { flowPaths } from './home.ts'
import { executorType } from './ledger/common.ts'
import { fail, ok, type Result } from './result.ts'
import { formatZodIssues, type ValidationIssue } from './validation-issue.ts'

/** 当前内置的执行器类型；角色 schema 不限定此列表，由 doctor 检查可用性。 */
export const KNOWN_EXECUTORS = ['fake', 'codex-orca', 'claude-sdk', 'codex-exec'] as const

export const roleSchema = z
  .strictObject({
    name: z.string().min(1).meta({ description: '角色名，与 YAML 文件名（不含扩展名）一致' }),
    executor: executorType,
    prompt: z.string().min(1).meta({
      description: '内联提示词；同目录的 .md 文件名视为文件引用，文件必须存在',
    }),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    permissions: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: '执行器专用权限设置；内核只校验它是对象' }),
    no_progress_minutes: z.number().int().positive().optional(),
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
