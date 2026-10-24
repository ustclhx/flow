import { z } from 'zod'
import { inboxVia } from '../inbox/schema.ts'
import { actor } from '../ledger/common.ts'

export const proposalIdSchema = z.string().regex(/^\d{13}-[0-9a-f]{12}$/)
const timestamp = z.iso.datetime({ offset: true })

/** 待确认提案与归档的磁盘格式；归档保留原提议理由和处理时间。 */
export const proposalSchema = z.object({
  id: proposalIdSchema,
  created_at: timestamp,
  actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/),
  target: z.string().min(1),
  base_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  content: z.string(),
  reason: z.string(),
  sources: z.array(z.string().min(1)),
  decided_by: actor.optional().describe('接受或拒绝提案的操作者'),
  via: inboxVia.optional(),
  accepted_at: timestamp.optional(),
  rejected_at: timestamp.optional(),
  proposal_reason: z.string().optional().describe('拒绝归档时保留的原提议理由'),
})

export type Proposal = z.infer<typeof proposalSchema>
