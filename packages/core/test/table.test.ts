import { describe, expect, test } from 'bun:test'
import { displayWidth, renderTable, truncate } from '../src/format/table.ts'

describe('renderTable', () => {
  test('中文按两列宽对齐', () => {
    const out = renderTable(
      [
        { a: 'ws/global', b: 'Global' },
        { a: 'ws/x', b: '干支日' },
      ],
      [
        { header: 'REF', value: (r) => r.a },
        { header: 'NAME', value: (r) => r.b },
      ],
    )
    expect(out).toBe(
      ['REF        NAME', '---------  ------', 'ws/global  Global', 'ws/x       干支日'].join('\n'),
    )
  })

  test('空表返回占位文字；超长内容按列宽截断', () => {
    expect(renderTable([], [{ header: 'X', value: () => '' }], '没有')).toBe('没有')
    expect(displayWidth('干支日a')).toBe(7)
    expect(truncate('东方站品牌干支日', 7)).toBe('东方站…')
  })
})
