import { realpath } from 'node:fs/promises'
import { FLOW_MCP_TOOL_PREFIX } from '@flow/core'
import { scopedPath } from './claude-path-scope.ts'
import { PATH_FIELDS } from './claude-writable-paths.ts'

/**
 * claude-sdk 读边界 `read_scope: cwd`（add-m1-supervisor D6、executor-claude-sdk spec）。
 *
 * 设置后由全工具 PreToolUse 钩子（以及 canUseTool）调用：只允许读合同 cwd 与任务私有目录内的路径。
 * 这一层只会拒绝，从不放行：通过检查的调用仍走 SDK 权限、Flow 策略与审批。
 *
 * - Flow MCP 工具（`mcp__flow__*`）不受影响；
 * - `file_path`、`path`、`notebook_path` 按共用路径判定（`..`、隐藏段、越界与符号链接越界都拒绝）；
 * - Glob 的 `pattern`、Grep 的 `glob` 不得为绝对路径、不得含 `..`、不得有 `.` 开头的段；
 * - 执行命令、派生代理或改变工作目录的工具无法按路径约束，一律拒绝；
 * - 其他工具（含非 Flow 的 MCP 工具）输入中出现任何其他路径类字段即拒绝。
 */

export const READ_SCOPES = ['cwd'] as const
export type ReadScope = (typeof READ_SCOPES)[number]

/** 执行器为一次任务注入的读边界参数。 */
export interface ReadScopeContext {
  /** 合同工作目录。 */
  cwd: string
  /** 任务私有目录（例如审查任务的 diff 文件所在目录）；只接受绝对路径访问。 */
  privateDir?: string
  /** 允许 cwd 根下的 `.github/`（审查 worktree 用），默认关闭。 */
  allowDotGithub?: boolean
}

export type ReadScopeDenial = { behavior: 'deny'; message: string }

/**
 * 无法按路径约束的工具：任意命令（Bash、PowerShell、Monitor）、派生代理或工作流（其工具调用的
 * 边界无法确认）、远程触发、切换工作目录（相对路径会相对新目录解析）。
 */
export const READ_SCOPE_DENIED_TOOLS = new Set([
  'Bash',
  'PowerShell',
  'Monitor',
  'Agent',
  'Task',
  'Workflow',
  'RemoteTrigger',
  'EnterWorktree',
  'ExitWorktree',
])

/** 路径类字段名（不区分大小写的子串匹配）；出现在已处理字段以外的位置即拒绝。 */
const PATH_LIKE_KEY = /path|file|dir|folder|glob|cwd|root|uri|location/i

/** 各工具已按语义处理、不是路径的字段（Grep 的 `pattern` 是正则）。 */
const NON_PATH_FIELDS: Record<string, ReadonlySet<string>> = {
  Grep: new Set(['pattern']),
}

function deny(message: string): ReadScopeDenial {
  return { behavior: 'deny', message: `read_scope: cwd 拒绝：${message}` }
}

/** 递归收集对象中命中路径类模式的键（含嵌套对象与数组）。 */
function pathLikeKeys(value: unknown, top: boolean, skip: ReadonlySet<string>): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => pathLikeKeys(v, false, skip))
  if (value === null || typeof value !== 'object') return []
  const found: string[] = []
  for (const [key, v] of Object.entries(value)) {
    if (!(top && skip.has(key)) && PATH_LIKE_KEY.test(key)) found.push(key)
    found.push(...pathLikeKeys(v, false, skip))
  }
  return found
}

/**
 * Glob 模式只能相对搜索目录：不得为绝对路径或 `~` 开头，不得含 `..`、反斜杠或 NUL，
 * 任何段（含花括号、括号分支）不得以 `.` 或 `/` 开头；`allowDotGithub` 时首段可为 `.github`。
 */
export function globPatternAllowed(pattern: string, allowDotGithub = false): boolean {
  if (!pattern || pattern.includes('\0') || pattern.includes('\\') || pattern.includes('..'))
    return false
  if (pattern.startsWith('/') || pattern.startsWith('~') || /^[A-Za-z]:/.test(pattern)) return false
  // 花括号或括号分支里的绝对路径：`{/etc,src}`、`@(~/x)`。
  if (/[{,(|][\s]*[/~]|[{,(|][A-Za-z]:/.test(pattern)) return false
  return pattern.split('/').every((segment, i) => {
    if (allowDotGithub && i === 0 && segment === '.github') return true
    return segment.split(/[{},()|]/).every((piece) => {
      const f = piece.normalize('NFKC')
      return !f.startsWith('.') && !f.startsWith('/') && !f.startsWith('~')
    })
  })
}

/** 路径须落在 cwd（优先）或任务私有目录内；返回是否允许。 */
async function pathAllowed(scope: ReadScopeContext, path: string): Promise<boolean> {
  if (
    await scopedPath(scope.cwd, scope.cwd, path, {
      allowRoot: true,
      allowDotGithub: scope.allowDotGithub === true,
      leaf: 'any',
    })
  )
    return true
  if (scope.privateDir === undefined) return false
  return (
    (await scopedPath(scope.privateDir, scope.cwd, path, { allowRoot: true, leaf: 'any' })) !==
    undefined
  )
}

async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return false
  }
}

/**
 * 读边界判定：返回拒绝结果，或 undefined 表示这一层不拦截（不代表放行）。
 *
 * `sessionCwd` 是钩子输入中的会话 cwd；它与合同 cwd 不同时相对路径与缺省搜索目录无法确认，全部拒绝。
 * `mcpServer` 是钩子输入中的 MCP 来源；名称不是 flow 的工具不按 Flow MCP 豁免。
 */
export async function checkReadScope(
  toolName: string,
  input: unknown,
  scope: ReadScopeContext,
  hook: { sessionCwd?: string; mcpServer?: { name: string } } = {},
): Promise<ReadScopeDenial | undefined> {
  if (
    toolName.startsWith(FLOW_MCP_TOOL_PREFIX) &&
    (hook.mcpServer === undefined || hook.mcpServer.name === 'flow')
  )
    return undefined
  if (READ_SCOPE_DENIED_TOOLS.has(toolName)) return deny(`${toolName} 无法按路径限定读取范围`)
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return deny('工具输入不是对象')
  if (hook.sessionCwd !== undefined && !(await sameDir(hook.sessionCwd, scope.cwd)))
    return deny('会话工作目录偏离合同 cwd')
  const record = input as Record<string, unknown>
  const isMcp = toolName.startsWith('mcp__')
  const handled = new Set<string>(NON_PATH_FIELDS[toolName] ?? [])
  // 非 MCP 工具的标准路径字段按路径判定；MCP 工具的 path 语义未知，交给下面的未知字段兜底拒绝。
  if (!isMcp) {
    for (const field of PATH_FIELDS) {
      if (!Object.hasOwn(record, field)) continue
      handled.add(field)
      const value = record[field]
      if (typeof value !== 'string' || value === '' || !(await pathAllowed(scope, value)))
        return deny(`${field} 不在合同 cwd 或任务私有目录内，或含隐藏段、..、越界链接`)
    }
  }
  const globField = toolName === 'Glob' ? 'pattern' : toolName === 'Grep' ? 'glob' : undefined
  if (globField !== undefined && Object.hasOwn(record, globField)) {
    handled.add(globField)
    const value = record[globField]
    if (typeof value !== 'string' || !globPatternAllowed(value, scope.allowDotGithub === true))
      return deny(`${toolName} 的 ${globField} 不得为绝对路径，不得含 ..、反斜杠或隐藏段`)
  }
  const unknown = pathLikeKeys(record, true, handled)
  if (unknown.length > 0) return deny(`无法识别的路径类参数 ${unknown.slice(0, 5).join('、')}`)
  return undefined
}
