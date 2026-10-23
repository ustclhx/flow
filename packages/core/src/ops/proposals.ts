import { z } from 'zod'
import { renderTable } from '../format/table.ts'
import {
  acceptProposals,
  createProposal,
  diffProposal,
  listProposals,
  type ProposalSelection,
  type ProposeInput,
  rejectProposals,
} from '../proposals/index.ts'
import { defineOperation } from './operation.ts'

export const kbProposeOp = defineOperation({
  name: 'kb_propose',
  cli: 'kb propose',
  summary: '提交完整条目的修改提案，等待用户确认',
  input: z
    .object({
      target: z.string(),
      content: z.string().optional().describe('完整文件内容，与 file 二选一'),
      file: z.string().optional().describe('读取本地文件，与 content 二选一'),
      reason: z.string().trim().min(1).describe('修改理由'),
    })
    .refine(
      (v) => (v.content === undefined) !== (v.file === undefined),
      'content 和 file 必须且只能提供一个',
    ),
  positional: ['target'],
  run: (input: ProposeInput, ctx) => createProposal(ctx.home, input, { actor: ctx.actor }),
  human: (o) => `已提交提案 ${o.id}：${o.target}`,
})

/** ISO 时间转为本地时区的 `YYYY-MM-DD HH:MM`，便于人读。 */
const localMinute = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const kbProposalsListOp = defineOperation({
  name: 'kb_proposals_list',
  cli: 'kb proposals list',
  summary: '列出待确认提案',
  input: z.object({}),
  run: (_input: Record<string, never>, ctx) => listProposals(ctx.home),
  human: (o) =>
    renderTable(
      o.proposals,
      [
        { header: 'ID', value: (p) => p.id },
        { header: 'TARGET', value: (p) => p.target },
        { header: 'NEW', value: (p) => (p.is_new ? '新建' : '修改') },
        { header: 'ACTOR', value: (p) => p.actor },
        { header: 'CREATED', value: (p) => localMinute(p.created_at) },
        { header: 'REASON', value: (p) => p.reason, max: 40 },
      ],
      '没有待确认的提案',
    ),
})

export const kbProposalsDiffOp = defineOperation({
  name: 'kb_proposals_diff',
  cli: 'kb proposals diff',
  summary: '查看提案与当前内容的统一差异',
  input: z.object({ id: z.string() }),
  positional: ['id'],
  run: (input: { id: string }, ctx) => diffProposal(ctx.home, input.id),
  human: (o) => o.diff || '无差异',
})

const selectionShape = {
  ids: z.array(z.string()).optional().describe('待处理的提案 id'),
  all: z.boolean().optional().describe('处理全部待确认提案，不能同时指定 id'),
}

export const kbProposalsAcceptOp = defineOperation({
  name: 'kb_proposals_accept',
  cli: 'kb proposals accept',
  summary: '用户接受提案，逐个检测冲突并合入',
  input: z.object(selectionShape),
  positional: ['ids'],
  run: (input: ProposalSelection, ctx) => acceptProposals(ctx.home, input, { actor: ctx.actor }),
})

export const kbProposalsRejectOp = defineOperation({
  name: 'kb_proposals_reject',
  cli: 'kb proposals reject',
  summary: '用户拒绝提案并归档理由',
  input: z.object({ ...selectionShape, reason: z.string().optional().describe('拒绝理由') }),
  positional: ['ids'],
  run: (input: ProposalSelection & { reason?: string | undefined }, ctx) =>
    rejectProposals(ctx.home, input, { actor: ctx.actor }),
})
