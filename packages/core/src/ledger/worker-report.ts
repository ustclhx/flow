import { z } from 'zod'
import { taskId } from './common.ts'
import { PROTOCOL_MESSAGE_MAX } from './redact.ts'

const text = z.string().trim().min(1).max(PROTOCOL_MESSAGE_MAX)
export const reportOption = z.strictObject({
  label: z.string().trim().min(1).max(100),
  description: text,
})
export const reportQuestion = z
  .strictObject({
    text,
    options: z.array(reportOption).min(2).max(8),
    recommended: z.string().trim().min(1).max(100),
  })
  .superRefine((q, ctx) => {
    if (new Set(q.options.map((o) => o.label)).size !== q.options.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: '选项标签不能重复' })
    if (!q.options.some((o) => o.label === q.recommended))
      ctx.addIssue({ code: 'custom', path: ['recommended'], message: '推荐项必须是选项标签' })
  })
export type ReportQuestion = z.infer<typeof reportQuestion>

const reportShape = {
  status: z.enum(['progress', 'question', 'ready', 'blocked', 'failed', 'dropped']),
  summary: text,
  question: text.optional(),
  options: z.array(reportOption).min(2).max(8).optional(),
  recommended: z.string().trim().min(1).max(100).optional(),
  deliverables: z.array(z.string().url().max(2048)).min(1).max(20).optional(),
  missing: text.optional(),
  tried: text.optional(),
  reason: text.optional(),
  handback: z.strictObject({ pr_event_seq: z.number().int().positive(), reason: text }).optional(),
}

function validateReport(r: z.infer<z.ZodObject<typeof reportShape>>, ctx: z.RefinementCtx) {
  const fields = {
    progress: [],
    question: ['question', 'options', 'recommended'],
    ready: ['deliverables'],
    blocked: ['missing', 'tried'],
    failed: ['reason'],
    dropped: ['reason'],
  } as const
  // 按状态收敛输入，避免借非 ready 状态保存未核实的交付物。
  for (const key of [
    'question',
    'options',
    'recommended',
    'deliverables',
    'missing',
    'tried',
    'reason',
  ] as const) {
    if (r[key] !== undefined && !(fields[r.status] as readonly string[]).includes(key))
      ctx.addIssue({ code: 'custom', path: [key], message: `${r.status} 不接受 ${key}` })
  }
  const required = (
    key: 'question' | 'options' | 'recommended' | 'deliverables' | 'missing' | 'tried' | 'reason',
  ) => {
    if (r[key] === undefined)
      ctx.addIssue({ code: 'custom', path: [key], message: `${r.status} 必须提供 ${key}` })
  }
  if (r.status === 'question') {
    required('question')
    required('options')
    required('recommended')
  }
  if (r.options && new Set(r.options.map((o) => o.label)).size !== r.options.length)
    ctx.addIssue({ code: 'custom', path: ['options'], message: '选项标签不能重复' })
  if (r.recommended !== undefined && !r.options?.some((o) => o.label === r.recommended))
    ctx.addIssue({ code: 'custom', path: ['recommended'], message: '推荐项必须是选项标签' })
  if (r.status === 'ready') required('deliverables')
  if (r.status === 'blocked') {
    required('missing')
    required('tried')
  }
  if (r.status === 'failed' || r.status === 'dropped') required('reason')
}

/** worker 调用输入：id 只用于核对，调用者身份始终取自派工令牌。 */
export const workerReportInput = z
  .strictObject({ id: taskId.optional(), ...reportShape })
  .superRefine(validateReport)
/** HTTP 请求由路径指明任务，拒绝在请求体另传身份或任务 id。 */
export const workerReportRequest = z.strictObject(reportShape).superRefine(validateReport)
export type WorkerReportInput = z.infer<typeof workerReportInput>
export type WorkerReport = z.infer<typeof workerReportRequest>
export const workerReportData = z.object({
  seq: z.number().int().positive(),
  attempt: z.number().int().positive(),
})
export const pendingWorkerReport = z.object({
  seq: z.number().int().positive(),
  attempt: z.number().int().positive(),
  ...reportShape,
})
