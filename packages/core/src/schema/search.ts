import { z } from 'zod'

export const kbSearchInput = z.object({
  query: z.string().trim().min(1).describe('检索短语'),
  limit: z.number().int().positive().default(20).describe('最多返回的条目数'),
  type: z.string().optional().describe('仅检索指定类型'),
  includeJournal: z.boolean().default(true).describe('是否包含工作日志'),
})

export const kbGetInput = z.object({ id: z.string().min(1).describe('条目标识') })
export const kbQueryInput = z.object({
  filters: z.array(z.string()).describe('AND 条件，例如 type=data-source owner=ws/xuanxue-saas'),
})

const entrySummary = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  summary: z.string(),
})
export const kbSearchOutput = z.object({
  results: z.array(entrySummary.extend({ snippet: z.string(), score: z.number() })),
})
export const kbGetOutput = z.object({
  id: z.string(),
  type: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  file: z.string(),
})
export const kbQueryOutput = z.object({ results: z.array(entrySummary) })

export type SearchInput = z.input<typeof kbSearchInput>
export type SearchOutput = z.infer<typeof kbSearchOutput>
export type GetOutput = z.infer<typeof kbGetOutput>
export type QueryOutput = z.infer<typeof kbQueryOutput>

/** 输入及 data 部分的输出契约，供 CLI 与 MCP 共用。 */
export const searchSchemas = {
  'kb-search.input': kbSearchInput,
  'kb-search.output': kbSearchOutput,
  'kb-get.input': kbGetInput,
  'kb-get.output': kbGetOutput,
  'kb-query.input': kbQueryInput,
  'kb-query.output': kbQueryOutput,
}
