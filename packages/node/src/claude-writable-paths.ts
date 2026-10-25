import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BUILTIN_TOOL_NAMES } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const CLAUDE_FILE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
export const CLAUDE_FILE_WRITE_MATCHER = '^(Edit|Write|MultiEdit|NotebookEdit)$'
/** SDK 0.3.310 的只读文件工具；LS 不在当前内置工具名中。 */
export const CLAUDE_READ_ONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LSP',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
] as const satisfies readonly (typeof BUILTIN_TOOL_NAMES)[number][]

const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const
const AGENT_INSTRUCTION_FILES = new Set([
  'claude.md',
  'claude.local.md',
  'agent.md',
  'agents.md',
  'agents.override.md',
  'conventions.md',
  'gemini.md',
  'copilot-instructions.md',
])

const fileInput = z.looseObject({ file_path: z.string().min(1) })

/** 与 Flow 策略路径相同的简化 glob：* 不跨目录，** 跨目录，? 匹配单字符。 */
function matches(pattern: string, path: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          source += '(?:.*/)?'
          i++
        } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).exec(path)?.[0] === path
}

/** 禁止越界、隐藏路径段及代理指令文件；比较兼容字符与 Unicode 大小写折叠，但不改写实际路径。 */
function insidePath(root: string, path: string): string | undefined {
  const rel = relative(root, path)
  if (
    !rel ||
    isAbsolute(rel) ||
    rel.split(sep).some((p) => {
      const folded = p.normalize('NFKC').toUpperCase().toLowerCase()
      return folded.startsWith('.') || AGENT_INSTRUCTION_FILES.has(folded)
    })
  )
    return undefined
  return rel.split(sep).join('/')
}

/**
 * 逐段解析符号链接；新文件解析到最近的已存在祖先。只把 ENOENT 当作新路径，
 * 悬空链接、循环链接、非目录祖先及其他 I/O 错误均拒绝，不借用策略预检的宽松回退。
 */
async function writablePath(cwd: string, path: string, patterns: readonly string[]) {
  if (path.includes('\0') || path.split(/[\\/]/).includes('..')) return undefined
  try {
    const root = await realpath(cwd)
    // cwd 自身可能是链接（例如 macOS 的 /var）；也接受 cwd 真实位置下的绝对路径。
    const lexical =
      insidePath(resolve(cwd), resolve(cwd, path)) ??
      (isAbsolute(path) ? insidePath(root, resolve(path)) : undefined)
    if (!lexical || !patterns.some((p) => matches(p, lexical))) return undefined
    const parts = lexical.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i] as string)
      let exists = true
      try {
        await lstat(current)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
        exists = false
      }
      if (!exists) {
        current = join(current, ...parts.slice(i + 1))
        break
      }
      current = await realpath(current)
      if (!insidePath(root, current)) return undefined
      const info = await lstat(current)
      if (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) return undefined
    }
    const resolved = insidePath(root, current)
    return resolved && patterns.some((p) => matches(p, resolved)) ? current : undefined
  } catch {
    // 权限边界无法确认时直接拒绝，绝不转交审批或策略自动放行。
    return undefined
  }
}

/** 缺省不改变既有角色审批；配置后，文件工具只允许白名单路径且永不进入审批。 */
export async function checkWritableTool(
  toolName: string,
  input: unknown,
  cwd: string,
  patterns: readonly string[] | undefined,
): Promise<
  { behavior: 'allow'; path: string } | { behavior: 'deny'; message: string } | undefined
> {
  if (patterns === undefined) return undefined
  if (!CLAUDE_FILE_WRITE_TOOLS.some((t) => t === toolName)) {
    // MCP 的 path 可能是资源标识而非文件写入；仍交给既有策略与审批，不自动放行。
    if (toolName.startsWith('mcp__') || CLAUDE_READ_ONLY_TOOLS.some((t) => t === toolName))
      return undefined
    return input !== null &&
      typeof input === 'object' &&
      PATH_FIELDS.some((p) => Object.hasOwn(input, p))
      ? { behavior: 'deny', message: '未识别的非只读文件工具，拒绝带路径的调用' }
      : undefined
  }
  const parsed = fileInput.safeParse(input)
  const path =
    toolName !== 'NotebookEdit' && parsed.success
      ? await writablePath(cwd, parsed.data.file_path, patterns)
      : undefined
  return path
    ? { behavior: 'allow', path }
    : {
        behavior: 'deny',
        message: '角色 writable_paths 不允许此次文件写入（NotebookEdit 始终禁用）',
      }
}
