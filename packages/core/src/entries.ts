import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseFrontmatter } from './frontmatter.ts'
import { flowPaths } from './home.ts'
import { fail, ok, type Result } from './result.ts'
import type { ValidationIssue } from './validation-issue.ts'

/**
 * brain 条目的发现与读取。条目 = `brain/` 下的 `.md` 文件；标识 = 相对 brain 的路径去掉 `.md`。
 * 排除：顶层的 `AGENTS.md`、`index.md`、`log.md`，`journal/` 整个目录（按天的日志，不是条目），
 * `briefs/` 整个目录（supervisor 的简报笔记，design D8：不是条目，不进校验、索引与搜索），
 * 以及所有隐藏文件和目录。
 */

export const BRAIN_RESERVED_FILES = ['AGENTS.md', 'index.md', 'log.md'] as const
export const BRAIN_JOURNAL_DIR = 'journal'
/** supervisor 简报笔记目录：`briefs/<workspace id>.md`，只能经中枢的 `brief_update` 写入。 */
export const BRAIN_BRIEFS_DIR = 'briefs'
/** brain 顶层的保留目录：其中的文件不是条目。 */
export const BRAIN_RESERVED_DIRS = [BRAIN_JOURNAL_DIR, BRAIN_BRIEFS_DIR] as const

/**
 * 比较保留名时使用的折叠：兼容性规范化（NFKC，例如 `ſ` → `s`）后转小写。macOS 的 APFS 默认不区分
 * 大小写，`Briefs/x.md` 与 `briefs/x.md` 是同一个文件，因此保留名的任何变体都必须按保留名处理。
 */
export const foldName = (name: string): string => name.normalize('NFKC').toLowerCase()
const foldedDirs = new Set(BRAIN_RESERVED_DIRS.map(foldName))
const foldedFiles = new Set(BRAIN_RESERVED_FILES.map(foldName))
/** 顶层目录名是否是保留目录（含大小写与兼容字符变体）。 */
export const isReservedBrainDir = (name: string): boolean => foldedDirs.has(foldName(name))
/** 顶层文件名是否是保留文件（含大小写与兼容字符变体）。 */
export const isReservedBrainFile = (name: string): boolean => foldedFiles.has(foldName(name))

export interface BrainEntry {
  /** 条目标识，例如 `resources/domains/arcanumber.com`。 */
  id: string
  /** 相对 flow-home 的路径，例如 `brain/resources/domains/arcanumber.com.md`。 */
  file: string
  absPath: string
  /** 未经 schema 校验的 frontmatter。 */
  frontmatter: Record<string, unknown>
  body: string
}

const toPosix = (p: string) => p.split(sep).join('/')

/** 列出 brain 下所有条目文件的绝对路径（按标识排序）。 */
export async function listEntryFiles(brainDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, relDir: string) {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const rel = relDir === '' ? item.name : `${relDir}/${item.name}`
      if (item.isDirectory()) {
        if (relDir === '' && isReservedBrainDir(item.name)) continue
        await walk(join(dir, item.name), rel)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        if (relDir === '' && isReservedBrainFile(item.name)) continue
        out.push(join(dir, item.name))
      }
    }
  }
  await walk(brainDir, '')
  return out.sort()
}

export const entryIdOf = (brainDir: string, absPath: string): string =>
  toPosix(relative(brainDir, absPath)).replace(/\.md$/, '')

/**
 * 读取全部条目。无法解析 frontmatter 的文件记入 issues（作为错误），不会出现在 entries 中。
 */
export async function readBrainEntries(
  home: string,
): Promise<Result<{ entries: BrainEntry[]; issues: ValidationIssue[] }>> {
  const { brain } = flowPaths(home)
  if (!existsSync(brain)) {
    return fail('failure', 'not_initialized', `未找到 ${brain}，请先运行 flow init`)
  }
  const entries: BrainEntry[] = []
  const issues: ValidationIssue[] = []
  for (const absPath of await listEntryFiles(brain)) {
    const id = entryIdOf(brain, absPath)
    const file = toPosix(relative(home, absPath))
    const parsed = parseFrontmatter(await readFile(absPath, 'utf8'))
    if (!parsed.ok) {
      issues.push({ file, id, code: parsed.error.code, message: parsed.error.message })
      continue
    }
    entries.push({ id, file, absPath, frontmatter: parsed.data.data, body: parsed.data.body })
  }
  return ok({ entries, issues })
}
