import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { FLOW_MCP_TOOL_PREFIX } from '@flow/core'
import { scopedPath } from './claude-path-scope.ts'

/**
 * claude-sdk 读边界 `read_scope: cwd`（add-m1-supervisor D6、executor-claude-sdk spec）。
 *
 * 设置后由全工具 PreToolUse 钩子（以及 canUseTool）调用：只允许读合同 cwd 与任务私有目录内的路径。
 * 这一层只会拒绝或改写输入，从不放行：通过检查的调用仍走 SDK 权限、Flow 策略与审批。
 *
 * - Flow MCP 工具不受影响：工具名为 `mcp__flow__*`，且 MCP 来源为本执行器注入的 `flow`（见 isFlowMcp）；
 * - 只认白名单中的内置工具，并按字段白名单校验输入；其他工具（含非 Flow 的 MCP 工具、WebFetch、WebSearch、
 *   Bash、Agent 等）一律拒绝；
 * - 路径字段按共用路径判定（`~`、首尾空白、`..`、隐藏段、越界与符号链接越界都拒绝），读取类目标必须已存在；
 *   通过后改写为校验过的真实绝对路径，保证 CLI 使用的就是检查过的路径；
 * - Glob / Grep 缺省搜索目录时显式补上 cwd；Grep 的 `glob` 末尾追加隐藏条目排除（CLI 的 Grep 固定带 `--hidden`）；
 * - Glob 的 `pattern`、Grep 的 `glob` 不得为绝对路径、不得含 `..`、反斜杠、字符类，任何段不得以 `.` 或 `?` 开头。
 */

export const READ_SCOPES = ['cwd'] as const
export type ReadScope = (typeof READ_SCOPES)[number]

/** 执行器为一次任务注入的读边界参数。 */
export interface ReadScopeContext {
  /** 合同工作目录。 */
  cwd: string
  /**
   * 任务私有目录（例如审查任务的 diff 文件所在目录）。只按绝对路径匹配：相对路径一律相对 cwd 解析，
   * 只在 cwd 的检查中判定。
   */
  privateDir?: string
  /** 允许 cwd 根下的 `.github/`（审查 worktree 用），默认关闭。 */
  allowDotGithub?: boolean
}

/** 钩子或 canUseTool 提供的调用上下文。 */
export interface ReadScopeCall {
  /** 钩子输入中的会话 cwd。 */
  sessionCwd?: string
  /** SDK 提供的 MCP 来源（`mcp__*` 工具）。 */
  mcpServer?: { name: string; source: string }
}

export type ReadScopeDecision =
  | { behavior: 'deny'; message: string }
  /** 通过：`updatedInput` 是改写后的输入（路径已换成真实绝对路径），调用方应以它继续。 */
  | { behavior: 'pass'; updatedInput: Record<string, unknown> }

/** Grep `glob` 末尾追加的隐藏条目排除（rg 的 override 以最后一条命中为准）。 */
export const GREP_HIDDEN_EXCLUDE = '!.*'
/** 允许 `.github` 时，在排除之后只把 cwd 根下的 `.github` 放回。 */
export const GREP_DOT_GITHUB_INCLUDE = '/.github'

/** 设置 read_scope 时注入 Claude Code 的环境变量：Glob 不加 `--hidden`、不加 `--no-ignore`（CLI 2.1.310 实测变量名）。 */
export const READ_SCOPE_ENV = {
  CLAUDE_CODE_GLOB_HIDDEN: 'false',
  CLAUDE_CODE_GLOB_NO_IGNORE: 'false',
} as const

type FieldKind =
  /** 读取的路径：必须已存在。 */
  | 'read_path'
  /** 写入的路径：可以尚不存在（是否可写由 writable_paths 或审批决定）。 */
  | 'write_path'
  /** Glob 模式。 */
  | 'glob'
  /** 不涉及路径的标量或内容。 */
  | 'value'

/** 已知内置工具的字段白名单（SDK 0.3.310 的 sdk-tools.d.ts）。不在表中的工具、不在表中的字段一律拒绝。 */
const TOOL_FIELDS: Record<string, Record<string, FieldKind>> = {
  Read: {
    file_path: 'read_path',
    offset: 'value',
    limit: 'value',
    pages: 'value',
    allow_large: 'value',
  },
  NotebookRead: { notebook_path: 'read_path', cell_id: 'value' },
  Glob: { pattern: 'glob', path: 'read_path' },
  Grep: {
    pattern: 'value',
    path: 'read_path',
    glob: 'glob',
    output_mode: 'value',
    '-B': 'value',
    '-A': 'value',
    '-C': 'value',
    context: 'value',
    '-n': 'value',
    '-i': 'value',
    '-o': 'value',
    type: 'value',
    head_limit: 'value',
    offset: 'value',
    multiline: 'value',
  },
  Edit: { file_path: 'write_path', old_string: 'value', new_string: 'value', replace_all: 'value' },
  MultiEdit: { file_path: 'write_path', edits: 'value' },
  Write: { file_path: 'write_path', content: 'value' },
  NotebookEdit: {
    notebook_path: 'write_path',
    cell_id: 'value',
    new_source: 'value',
    cell_type: 'value',
    edit_mode: 'value',
  },
  TodoWrite: { todos: 'value' },
  ToolSearch: { query: 'value', max_results: 'value' },
}

/** 输入为调用方定义的 JSON Schema（审查结论等），只产生输出、不访问文件，不按字段白名单检查。 */
const OPAQUE_OUTPUT_TOOLS = new Set(['StructuredOutput'])

/** 注入的 Flow MCP 是 stdio 进程服务器，SDK 文档中其来源为 `dynamic`；`sdk` 只能由宿主注册。 */
const FLOW_MCP_SOURCES = new Set(['dynamic', 'sdk'])

function deny(message: string): ReadScopeDecision {
  return { behavior: 'deny', message: `read_scope: cwd 拒绝：${message}` }
}

/** 只有工具名前缀、来源名与来源类别都对得上时才视为 Flow MCP；缺少来源信息时不豁免。 */
export function isFlowMcp(toolName: string, mcpServer: ReadScopeCall['mcpServer']): boolean {
  return (
    toolName.startsWith(FLOW_MCP_TOOL_PREFIX) &&
    mcpServer !== undefined &&
    mcpServer.name === 'flow' &&
    FLOW_MCP_SOURCES.has(mcpServer.source)
  )
}

/** 单个 glob 片段：不得为绝对、`~`、盘符开头，任何段及花括号、括号分支不得以 `.`、`/`、`~`、`?` 开头。 */
function globTokenAllowed(token: string, allowDotGithub: boolean): boolean {
  if (/^!?(?:[/~]|[A-Za-z]:)/.test(token)) return false
  if (/[{,(|]\s*(?:[/~]|[A-Za-z]:)/.test(token)) return false
  return token.split('/').every((segment, i) => {
    if (allowDotGithub && i === 0 && segment === '.github') return true
    return segment.split(/[{},()|]/).every((piece) => {
      const f = piece.replace(/^!/, '').normalize('NFKC')
      return !f.startsWith('.') && !f.startsWith('?')
    })
  })
}

/**
 * Glob 模式只能相对搜索目录。整体不得含 NUL、`..`、反斜杠或字符类 `[`；
 * 按空白拆分后（CLI 的 Grep 以空白和逗号拆分 `glob`）逐个检查片段；`allowDotGithub` 时首段可为 `.github`。
 */
export function globPatternAllowed(pattern: string, allowDotGithub = false): boolean {
  if (!pattern.trim()) return false
  if (/[\0\\[\]]/.test(pattern) || pattern.includes('..')) return false
  return pattern
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => globTokenAllowed(token, allowDotGithub))
}

/**
 * 在 Grep 的 glob 末尾追加隐藏条目排除。CLI 2.1.310 按空白拆分 `glob`（不含成对花括号的片段再按逗号拆分），
 * 依次作为 `--glob` 传给 rg，之后只追加权限规则与缓存目录的排除；rg 的 override 以最后命中的一条为准，
 * 因此追加在末尾的 `!.*` 不会被用户片段覆盖。`includeDotGithub` 时再放回根下的 `.github`，
 * 用户没有正向片段时先补 `*`，避免这条正向规则把其他文件变成未命中而被忽略。
 */
export function grepGlobWithHiddenExclude(
  glob: string | undefined,
  includeDotGithub: boolean,
): string {
  const tokens = (glob ?? '').split(/\s+/).filter(Boolean)
  const positive = tokens.some((t) => !t.startsWith('!'))
  const suffix = includeDotGithub
    ? [...(positive ? [] : ['*']), GREP_HIDDEN_EXCLUDE, GREP_DOT_GITHUB_INCLUDE]
    : [GREP_HIDDEN_EXCLUDE]
  return [...tokens, ...suffix].join(' ')
}

/**
 * 去掉本模块追加过的后缀（钩子改写后的输入还会再经过 canUseTool），返回用户自己的片段；
 * 用户自己写了同样的结尾也一并去掉，随后按当前读边界重新追加，不会因此放宽。
 */
export function stripHiddenExclude(glob: string): string {
  const tokens = glob.split(/\s+/).filter(Boolean)
  for (const suffix of [
    ['*', GREP_HIDDEN_EXCLUDE, GREP_DOT_GITHUB_INCLUDE],
    [GREP_HIDDEN_EXCLUDE, GREP_DOT_GITHUB_INCLUDE],
    [GREP_HIDDEN_EXCLUDE],
  ]) {
    const tail = tokens.slice(-suffix.length)
    if (tail.length === suffix.length && tail.every((t, i) => t === suffix[i]))
      return tokens.slice(0, -suffix.length).join(' ')
  }
  return tokens.join(' ')
}

/** 路径须落在 cwd（优先）或任务私有目录（仅绝对路径）内；返回校验过的真实路径。 */
async function allowedPath(
  scope: ReadScopeContext,
  path: string,
  mustExist: boolean,
): Promise<string | undefined> {
  const inCwd = await scopedPath(scope.cwd, scope.cwd, path, {
    allowRoot: true,
    allowDotGithub: scope.allowDotGithub === true,
    leaf: 'any',
    mustExist,
  })
  if (inCwd !== undefined) return inCwd
  if (scope.privateDir === undefined || !isAbsolute(path)) return undefined
  return scopedPath(scope.privateDir, scope.cwd, path, { allowRoot: true, leaf: 'any', mustExist })
}

async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return false
  }
}

/**
 * 读边界判定：返回拒绝，或带改写后输入的通过（不代表放行）；Flow MCP 返回 undefined（不处理）。
 *
 * `sessionCwd` 与合同 cwd 不同时，相对路径与缺省搜索目录无法确认，全部拒绝。
 */
export async function checkReadScope(
  toolName: string,
  input: unknown,
  scope: ReadScopeContext,
  call: ReadScopeCall = {},
): Promise<ReadScopeDecision | undefined> {
  if (isFlowMcp(toolName, call.mcpServer)) return undefined
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return deny('工具输入不是对象')
  const record = input as Record<string, unknown>
  if (OPAQUE_OUTPUT_TOOLS.has(toolName)) return { behavior: 'pass', updatedInput: record }
  const fields = Object.hasOwn(TOOL_FIELDS, toolName) ? TOOL_FIELDS[toolName] : undefined
  if (fields === undefined) return deny(`${toolName} 不在读边界允许的工具中`)
  if (call.sessionCwd !== undefined && !(await sameDir(call.sessionCwd, scope.cwd)))
    return deny('会话工作目录偏离合同 cwd')
  const updated: Record<string, unknown> = { ...record }
  for (const [key, value] of Object.entries(record)) {
    const kind = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (kind === undefined) return deny(`${toolName} 带有无法识别的参数 ${key}`)
    if (kind === 'value') continue
    if (typeof value !== 'string' || value === '') return deny(`${key} 不是非空字符串`)
    if (kind === 'glob') {
      const own = toolName === 'Grep' ? stripHiddenExclude(value) : value
      if (toolName === 'Grep' && own === '') {
        delete updated[key]
        continue
      }
      if (!globPatternAllowed(own, scope.allowDotGithub === true))
        return deny(
          `${toolName} 的 ${key} 不得为绝对路径，不得含 ..、反斜杠、字符类或以 . / ? 开头的段`,
        )
      continue
    }
    const real = await allowedPath(scope, value, kind === 'read_path')
    if (real === undefined)
      return deny(
        `${key} 不在合同 cwd 或任务私有目录内、不存在，或含 ~、首尾空白、隐藏段、..、越界链接`,
      )
    updated[key] = real
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    // 缺省搜索目录取会话 cwd：显式写成合同 cwd 的真实路径。
    if (updated.path === undefined) {
      try {
        updated.path = await realpath(scope.cwd)
      } catch {
        return deny('无法确认合同 cwd 的真实位置')
      }
    }
    if (toolName === 'Grep') {
      let rootReal: string
      try {
        rootReal = await realpath(scope.cwd)
      } catch {
        return deny('无法确认合同 cwd 的真实位置')
      }
      updated.glob = grepGlobWithHiddenExclude(
        typeof updated.glob === 'string' ? stripHiddenExclude(updated.glob) : undefined,
        scope.allowDotGithub === true && updated.path === rootReal,
      )
    }
  }
  return { behavior: 'pass', updatedInput: updated }
}
