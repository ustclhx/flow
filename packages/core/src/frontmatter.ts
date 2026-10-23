import { parse } from 'yaml'
import { fail, ok, type Result } from './result.ts'

export interface ParsedDocument {
  /** frontmatter 解析结果（未经 schema 校验）。 */
  data: Record<string, unknown>
  body: string
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * 解析 Markdown 文件开头的 YAML frontmatter。使用 yaml 包默认的 core schema，
 * 日期保持为字符串，不会被转成 Date。
 */
export function parseFrontmatter(text: string): Result<ParsedDocument> {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const m = FM_RE.exec(src)
  if (!m)
    return fail('failure', 'missing_frontmatter', '缺少 YAML frontmatter（文件应以 --- 开头）')
  let data: unknown
  try {
    data = parse(m[1] ?? '')
  } catch (err) {
    return fail('failure', 'invalid_yaml', `frontmatter 不是合法的 YAML：${(err as Error).message}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail('failure', 'invalid_frontmatter', 'frontmatter 必须是键值映射')
  }
  return ok({ data: data as Record<string, unknown>, body: src.slice(m[0].length) })
}
