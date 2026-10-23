import { z } from 'zod'
import { ok } from '../result.ts'
import { appendCapture, appendJournal } from '../write/api.ts'
import { defineOperation } from './operation.ts'

export const kbJournalOp = defineOperation({
  name: 'kb_journal',
  cli: 'kb journal',
  summary: '追加一条工作日志（任何操作者都可直接写入，无需确认）',
  input: z.object({
    text: z.string().describe('日志正文'),
    workspace: z.string().optional().describe('关联的 workspace，例如 ws/product-res'),
  }),
  positional: ['text'],
  run: async (input: { text: string; workspace?: string | undefined }, ctx) => {
    const r = await appendJournal(
      ctx.home,
      input.workspace === undefined
        ? { text: input.text }
        : { text: input.text, workspace: input.workspace },
      { actor: ctx.actor },
    )
    if (!r.ok) return r
    return ok({ file: r.data.file, date: r.data.date, time: r.data.time, sha: r.data.sha })
  },
  human: (o) => `已记录到 ${o.file}（${o.date} ${o.time}）`,
})

export const captureOp = defineOperation({
  name: 'capture',
  cli: 'capture',
  summary: '随手记：写入 raw/inbox/，只追加，不进入 brain',
  input: z.object({ text: z.string().describe('要记录的内容') }),
  positional: ['text'],
  run: async (input: { text: string }, ctx) => {
    const source = ctx.via === 'mcp' ? `mcp:${ctx.actor}` : 'cli'
    const r = await appendCapture(ctx.home, { text: input.text, source }, { actor: ctx.actor })
    if (!r.ok) return r
    return ok({ file: r.data.file, sha: r.data.sha })
  },
  human: (o) => `已记下：${o.file}`,
})
