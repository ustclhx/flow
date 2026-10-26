import type { BrainEntry } from '../entries.ts'
import { ENTRY_TYPES } from '../schema/entries.ts'

/**
 * `brain/index.md` 与 `brain/log.md` 的确定性渲染（knowledge-base：索引维护、变更日志）。
 */

const INDEX_HEADER = '# 索引\n\n> 由 Flow 自动生成，请勿手动编辑。\n'
/** 类型未知或缺失的条目归入最后的这个分组。 */
export const INDEX_OTHER_GROUP = '其他'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const escapeLinkText = (s: string) => s.replace(/([\\[\]])/g, '\\$1')
/** 链接目标含空格或括号时用尖括号包起来，保证 Markdown 能正确解析。 */
const linkTarget = (id: string) => (/[\s()<>]/.test(id) ? `<${id}.md>` : `${id}.md`)

/** 索引中的一行：`- [title](id.md) — summary`。 */
export function indexLine(entry: Pick<BrainEntry, 'id' | 'frontmatter'>): string {
  const { title, summary } = entry.frontmatter
  const t = typeof title === 'string' && oneLine(title) ? oneLine(title) : entry.id
  const s = typeof summary === 'string' ? oneLine(summary) : ''
  return `- [${escapeLinkText(t)}](${linkTarget(entry.id)})${s ? ` — ${s}` : ''}`
}

/**
 * 按类型分组渲染索引。分组顺序固定为 ENTRY_TYPES 的顺序，未知类型放在最后的"其他"组；
 * 组内按条目标识排序；空组不输出。输出只取决于条目内容，不含时间戳。
 */
export function renderIndex(entries: readonly Pick<BrainEntry, 'id' | 'frontmatter'>[]): string {
  const groups = new Map<string, Pick<BrainEntry, 'id' | 'frontmatter'>[]>()
  for (const e of entries) {
    const type = e.frontmatter.type
    const key =
      typeof type === 'string' && (ENTRY_TYPES as readonly string[]).includes(type)
        ? type
        : INDEX_OTHER_GROUP
    const list = groups.get(key) ?? []
    list.push(e)
    groups.set(key, list)
  }
  const order = [...ENTRY_TYPES, INDEX_OTHER_GROUP]
  const sections: string[] = []
  for (const key of order) {
    const list = groups.get(key)
    if (!list) continue
    const lines = [...list]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => indexLine(e))
    sections.push(`## ${key}\n\n${lines.join('\n')}\n`)
  }
  if (sections.length === 0) return `${INDEX_HEADER}\n（暂无条目）\n`
  return `${INDEX_HEADER}\n${sections.join('\n')}`
}

export const LOG_OPS = [
  'journal',
  'capture',
  'propose',
  'apply',
  'reject',
  'owner-change',
  'sync',
  'brief',
] as const
export type LogOp = (typeof LOG_OPS)[number]

export const isLogOp = (v: unknown): v is LogOp =>
  typeof v === 'string' && (LOG_OPS as readonly string[]).includes(v)

/** log.md 的一行：`YYYY-MM-DD <op> <actor> <简述>`（简述压成单行）。 */
export function formatLogLine(date: string, op: LogOp, actor: string, summary: string): string {
  const s = oneLine(summary)
  return `${date} ${op} ${actor}${s ? ` ${s}` : ''}`
}
