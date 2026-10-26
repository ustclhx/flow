import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * claude-sdk 文件边界共用的路径判定（`writable_paths` 写边界与 `read_scope` 读边界）。
 *
 * 判定只看路径本身与文件系统中的真实位置：拒绝 `..`、NUL、越界、隐藏路径段与符号链接越界，
 * 任何无法确认的情况一律拒绝。比较隐藏名称和指令文件名时做 NFKC 与 Unicode 大小写折叠，但不改写实际路径。
 */

/** 后续开发代理会加载的指令文件名（折叠后比较），写边界硬性禁写。 */
export const AGENT_INSTRUCTION_FILES = new Set([
  'claude.md',
  'claude.local.md',
  'agent.md',
  'agents.md',
  'agents.override.md',
  'conventions.md',
  'gemini.md',
  'copilot-instructions.md',
])

export interface PathScopeOptions {
  /** 允许路径就是根目录本身（读、搜索根目录）；写边界不允许。 */
  allowRoot?: boolean
  /** 禁止任意层级的代理指令文件（写边界）。 */
  denyInstructionFiles?: boolean
  /** 允许根下第一段恰为 `.github`（审查 worktree 用），其余隐藏段仍禁止。 */
  allowDotGithub?: boolean
  /** 额外的相对路径判定（例如 writable_paths 的 glob），原路径与真实路径都须满足。 */
  accept?: (rel: string) => boolean
  /** `file`：末段必须是已存在的普通文件或尚不存在；`any`：文件或目录皆可。 */
  leaf: 'file' | 'any'
  /** 目标必须已存在（读边界）；缺省允许尚不存在的新路径（写入）。 */
  mustExist?: boolean
}

function folded(segment: string): string {
  return segment.normalize('NFKC').toUpperCase().toLowerCase()
}

/** 路径相对根目录的 `/` 分隔形式；越界、隐藏段（及按选项禁止的指令文件）返回 undefined。 */
export function insidePath(
  root: string,
  path: string,
  opts: Omit<PathScopeOptions, 'accept' | 'leaf'> = {},
): string | undefined {
  const rel = relative(root, path)
  if (!rel) return opts.allowRoot ? '' : undefined
  if (isAbsolute(rel)) return undefined
  const parts = rel.split(sep)
  if (
    parts.some((p, i) => {
      if (opts.allowDotGithub && i === 0 && p === '.github') return false
      const f = folded(p)
      return (
        f.startsWith('.') || (opts.denyInstructionFiles === true && AGENT_INSTRUCTION_FILES.has(f))
      )
    })
  )
    return undefined
  return parts.join('/')
}

/**
 * 入口拒绝：NUL、`..` 段（`/` 与 `\` 都视为分隔符）、以 `~` 开头（CLI 会展开为 home，
 * 而 Node 的 resolve 不会）以及首尾空白（CLI 可能修剪后再使用）。
 */
export function rejectedPathForm(path: string): boolean {
  return (
    path.includes('\0') ||
    path.startsWith('~') ||
    path.trim() !== path ||
    path.split(/[\\/]/).includes('..')
  )
}

/**
 * 把 `path`（相对 `cwd` 或绝对）限定在 `root` 内，返回逐段解析符号链接后的真实路径。
 * 相对路径一律相对 `cwd` 解析；`root` 不是 `cwd` 时只有绝对路径或 `cwd` 位于其下才可能命中。
 *
 * 新路径解析到最近的已存在祖先；只把 ENOENT 当作新路径，悬空链接、循环链接、非目录祖先
 * 及其他 I/O 错误均拒绝。`root` 自身可能是链接（例如 macOS 的 /var），也接受其真实位置下的绝对路径。
 */
export async function scopedPath(
  root: string,
  cwd: string,
  path: string,
  opts: PathScopeOptions,
): Promise<string | undefined> {
  if (rejectedPathForm(path)) return undefined
  const accept = opts.accept ?? (() => true)
  try {
    const real = await realpath(root)
    const target = resolve(cwd, path)
    const lexical =
      insidePath(resolve(root), target, opts) ??
      (isAbsolute(path) ? insidePath(real, target, opts) : undefined)
    if (lexical === undefined || !accept(lexical)) return undefined
    const parts = lexical === '' ? [] : lexical.split('/')
    let current = real
    if (parts.length === 0) {
      const info = await lstat(current)
      return opts.leaf === 'any' && info.isDirectory() ? current : undefined
    }
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
        if (opts.mustExist) return undefined
        current = join(current, ...parts.slice(i + 1))
        break
      }
      current = await realpath(current)
      if (insidePath(real, current, opts) === undefined) return undefined
      const info = await lstat(current)
      const last = i === parts.length - 1
      if (!last && !info.isDirectory()) return undefined
      if (last && (opts.leaf === 'file' ? !info.isFile() : !info.isFile() && !info.isDirectory()))
        return undefined
    }
    const resolved = insidePath(real, current, opts)
    return resolved !== undefined && accept(resolved) ? current : undefined
  } catch {
    // 边界无法确认时直接拒绝，绝不转交审批或策略自动放行。
    return undefined
  }
}
