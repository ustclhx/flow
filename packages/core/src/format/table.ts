/**
 * CLI 人类可读输出用的纯文本表格。中日韩字符与全角符号按两列宽计算，保证中文内容也能对齐。
 */

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

const charWidth = (cp: number): number =>
  WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1

export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** 截断到不超过 max 列宽，超出时以 `…` 结尾。 */
export function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

const pad = (text: string, width: number) => text + ' '.repeat(width - displayWidth(text))

export interface Column<T> {
  header: string
  value: (row: T) => string
  /** 最大列宽；超出时截断。省略表示不限。 */
  max?: number
}

/** 渲染表格：表头、分隔线和数据行，列之间用两个空格；没有数据时返回 `empty`。 */
export function renderTable<T>(rows: T[], columns: Column<T>[], empty = '（无）'): string {
  if (rows.length === 0) return empty
  const cells = rows.map((r) =>
    columns.map((c) => {
      const v = c.value(r).replace(/\s+/g, ' ')
      return c.max ? truncate(v, c.max) : v
    }),
  )
  const widths = columns.map((c, i) =>
    Math.max(displayWidth(c.header), ...cells.map((row) => displayWidth(row[i] as string))),
  )
  const line = (vals: string[]) =>
    vals
      .map((v, i) => (i === vals.length - 1 ? v : pad(v, widths[i] as number)))
      .join('  ')
      .trimEnd()
  return [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '-'.repeat(w))),
    ...cells.map(line),
  ].join('\n')
}
