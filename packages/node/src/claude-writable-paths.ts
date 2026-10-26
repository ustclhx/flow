import type { BUILTIN_TOOL_NAMES } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { scopedPath } from './claude-path-scope.ts'

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

export const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const
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

/** 原路径与真实路径都须匹配白名单；越界、隐藏段、代理指令文件与符号链接越界的判定见 claude-path-scope。 */
function writablePath(cwd: string, path: string, patterns: readonly string[]) {
  return scopedPath(cwd, cwd, path, {
    denyInstructionFiles: true,
    accept: (rel) => patterns.some((p) => matches(p, rel)),
    leaf: 'file',
  })
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
