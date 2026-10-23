import { kbGetInput, kbQueryInput, kbSearchInput, type SearchInput } from '../schema/search.ts'
import { getEntry, queryIndex, searchIndex } from '../search/index-db.ts'
import { defineOperation } from './operation.ts'

export const kbSearchOp = defineOperation({
  name: 'kb_search',
  cli: 'kb search',
  summary: '检索 brain 条目和工作日志',
  input: kbSearchInput,
  positional: ['query'],
  run: (input: SearchInput, ctx) => searchIndex(ctx.home, input),
  human: (output) =>
    output.results.map((r) => `${r.id} — ${r.title}：${r.summary}\n  ${r.snippet}`).join('\n'),
})

export const kbGetOp = defineOperation({
  name: 'kb_get',
  cli: 'kb get',
  summary: '按标识读取完整知识条目',
  input: kbGetInput,
  positional: ['id'],
  run: (input: { id: string }, ctx) => getEntry(ctx.home, input.id),
})

export const kbQueryOp = defineOperation({
  name: 'kb_query',
  cli: 'kb query',
  summary: '按 frontmatter 字段筛选知识条目',
  input: kbQueryInput,
  positional: ['filters'],
  run: (input: { filters: string[] }, ctx) => queryIndex(ctx.home, input.filters),
  human: (output) => output.results.map((r) => `${r.id} — ${r.title}：${r.summary}`).join('\n'),
})
