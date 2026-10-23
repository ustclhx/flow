import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parse } from 'yaml'
import { flowPaths } from './home.ts'
import { fail, ok, type Result } from './result.ts'
import { workspaceSchema } from './schema/workspace.ts'
import { formatZodIssues, type ValidationIssue } from './validation-issue.ts'

export type WorkspaceKind = 'product' | 'function' | 'global'

export interface Workspace {
  /** 不含 `ws/` 前缀的 id。 */
  id: string
  /** 完整标识 `ws/<id>`。 */
  ref: string
  kind: WorkspaceKind
  name: string
  description: string
  repos: string[]
  /** 定义文件（相对 flow-home）；`ws/global` 为 null。 */
  file: string | null
}

export interface WorkspaceSet {
  /** 第一个总是隐式的 `ws/global`，其余按 id 排序。 */
  workspaces: Workspace[]
  /** 定义文件中的问题；有问题的文件不会出现在 workspaces 中。 */
  issues: ValidationIssue[]
}

export const GLOBAL_WORKSPACE: Workspace = {
  id: 'global',
  ref: 'ws/global',
  kind: 'global',
  name: 'Global',
  description: '隐式存在的全局 workspace，不需要定义文件',
  repos: [],
  file: null,
}

/**
 * 读取 `config/workspaces/*.yaml`（resource-registry）。目录不存在时只返回 `ws/global`；
 * 单个文件的格式问题记入 issues，不会让整体失败。
 */
export async function loadWorkspaces(home: string): Promise<Result<WorkspaceSet>> {
  const dir = flowPaths(home).workspaces
  const workspaces: Workspace[] = []
  const issues: ValidationIssue[] = []
  if (!existsSync(dir)) return ok({ workspaces: [GLOBAL_WORKSPACE], issues })
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n) && !n.startsWith('.')).sort()
  } catch (err) {
    return fail('failure', 'read_failed', `无法读取 ${dir}：${(err as Error).message}`)
  }
  for (const name of names) {
    const file = relative(home, join(dir, name))
    const base = name.replace(/\.ya?ml$/, '')
    const issue = (code: string, message: string, field?: string): ValidationIssue =>
      field === undefined ? { file, code, message } : { file, field, code, message }
    let data: unknown
    try {
      data = parse(await readFile(join(dir, name), 'utf8'))
    } catch (err) {
      issues.push(issue('invalid_yaml', `不是合法的 YAML：${(err as Error).message}`))
      continue
    }
    const parsed = workspaceSchema.safeParse(data)
    if (!parsed.success) {
      issues.push(...formatZodIssues(parsed.error.issues, data, { file }))
      continue
    }
    const ws = parsed.data
    if (ws.id !== base) {
      issues.push(issue('workspace_id_mismatch', `id "${ws.id}" 与文件名 "${base}" 不一致`, 'id'))
      continue
    }
    if (ws.id === 'global') {
      issues.push(issue('workspace_reserved', 'ws/global 是隐式 workspace，不能定义', 'id'))
      continue
    }
    workspaces.push({
      id: ws.id,
      ref: `ws/${ws.id}`,
      kind: ws.kind,
      name: ws.name,
      description: ws.description,
      repos: ws.repos ?? [],
      file,
    })
  }
  return ok({ workspaces: [GLOBAL_WORKSPACE, ...workspaces], issues })
}
