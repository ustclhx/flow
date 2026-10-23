import { z } from 'zod'
import { dateString, entryId, secretRef, workspaceRef } from './common.ts'

/**
 * 11 种知识条目的 frontmatter 定义（design D3）。这是唯一的定义来源：
 * 校验、brain/AGENTS.md 字段说明、schemas/ 下的 JSON Schema 都由这里生成。
 * 允许出现未声明的额外字段（looseObject），以便用户按需补充信息。
 */

export const ENTRY_TYPES = [
  'product',
  'domain',
  'service',
  'repo',
  'data-source',
  'account',
  'runbook',
  'decision',
  'concept',
  'note',
  'project-card',
] as const
export type EntryType = (typeof ENTRY_TYPES)[number]

/** 资源类型：必须有唯一 owner（resource-registry）。 */
export const RESOURCE_TYPES = ['domain', 'service', 'repo', 'data-source', 'account'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/** 事实类：资源类型 + product + runbook，需要出处并跟踪核实时间（knowledge-base）。 */
export const FACT_TYPES = [...RESOURCE_TYPES, 'product', 'runbook'] as const
export type FactType = (typeof FACT_TYPES)[number]

export const isEntryType = (v: unknown): v is EntryType =>
  typeof v === 'string' && (ENTRY_TYPES as readonly string[]).includes(v)
export const isResourceType = (v: unknown): v is ResourceType =>
  typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v)
export const isFactType = (v: unknown): v is FactType =>
  typeof v === 'string' && (FACT_TYPES as readonly string[]).includes(v)

const nullableString = (description: string) => z.string().nullable().meta({ description })

export const baseShape = {
  title: z.string().min(1).meta({ description: '标题' }),
  summary: z.string().min(1).meta({ description: '一句话摘要，会出现在 index.md 中' }),
  scope: z.enum(['work', 'personal']).meta({ description: '范围：work 或 personal' }),
  tags: z.array(z.string()).optional().meta({ description: '标签' }),
  sources: z
    .array(z.string().min(1))
    .optional()
    .meta({ description: '出处：raw 中的路径、项目仓库内的路径或 URL；事实类条目需要至少一个' }),
  last_verified: dateString
    .nullable()
    .optional()
    .meta({ description: '最近一次核实日期（YYYY-MM-DD），未核实时为空' }),
}

const owner = workspaceRef.meta({
  description: '唯一归属的 workspace（ws/<id>），不能是职能 workspace',
})

function entry<T extends EntryType, S extends z.core.$ZodLooseShape>(
  type: T,
  description: string,
  shape: S,
) {
  return z
    .looseObject({
      type: z.literal(type).meta({ description: '条目类型' }),
      ...baseShape,
      ...shape,
    })
    .meta({ title: type, description })
}

export const productEntry = entry('product', '一个对外产品', {
  workspace: workspaceRef.meta({ description: '产品所属的 workspace（ws/<id>）' }),
  status: z.string().min(1).meta({ description: '产品状态，例如 beta、live' }),
  url: z.string().optional().meta({ description: '产品主页 URL' }),
})

export const domainEntry = entry('domain', '一个域名（资源）', {
  owner,
  registrar: nullableString('注册商；未知时为空'),
  expires: dateString.nullable().meta({ description: '注册到期日（YYYY-MM-DD）；未知时为空' }),
  dns_provider: nullableString('DNS 服务商').optional(),
  monitors: z.array(z.string()).optional().meta({ description: '监控该域名的数据源条目标识' }),
})

export const serviceEntry = entry('service', '一个部署的服务（资源）', {
  owner,
  provider: z.string().min(1).meta({ description: '运行平台，例如 cloudflare-workers' }),
  environment: z.string().optional().meta({ description: '环境，例如 production' }),
  url: z.string().optional().meta({ description: '服务地址' }),
})

export const repoEntry = entry('repo', '一个代码仓库（资源）', {
  owner,
  path: z.string().min(1).meta({ description: '本地路径' }),
  remote: nullableString('远端地址').optional(),
})

export const dataSourceEntry = entry('data-source', '一个可读取的数据源（资源）', {
  owner,
  provider: z.string().min(1).meta({
    description: '数据源提供方，例如 sentry、stripe、cloudflare-web-analytics、http-health',
  }),
  endpoint: nullableString('访问地址').optional(),
  credential: secretRef
    .nullable()
    .optional()
    .meta({ description: '访问凭据的 secret:// 引用；不得写明文' }),
})

export const accountEntry = entry('account', '一个平台账号（资源）', {
  owner,
  platform: z.string().min(1).meta({ description: '平台名称' }),
  handle: z.string().min(1).meta({ description: '账号名' }),
  goal: nullableString('运营目标').optional(),
  credential: secretRef
    .nullable()
    .optional()
    .meta({ description: '访问凭据的 secret:// 引用；不得写明文' }),
})

export const runbookEntry = entry('runbook', '一份操作手册', {
  workspace: workspaceRef.optional().meta({ description: '适用的 workspace（ws/<id>）' }),
  applies_to: z.array(entryId).optional().meta({ description: '适用的条目标识列表' }),
})

export const decisionEntry = entry('decision', '一项决策，需要定期回看', {
  status: z
    .enum(['proposed', 'approved', 'rejected', 'reviewed'])
    .meta({ description: '决策状态：proposed、approved、rejected、reviewed' }),
  expected_outcome: z.string().min(1).meta({ description: '预期结果' }),
  metric: z.string().min(1).meta({ description: '衡量指标' }),
  review_date: dateString.meta({ description: '回看日期（YYYY-MM-DD）' }),
  workspace: workspaceRef.optional().meta({ description: '相关的 workspace（ws/<id>）' }),
})

export const conceptEntry = entry('concept', '一个概念或术语', {})

export const noteEntry = entry('note', '一条笔记，不要求出处', {})

export const projectCardEntry = entry('project-card', '项目卡片：一个产品 workspace 的入口说明', {
  workspace: workspaceRef.meta({ description: '项目所属的 workspace（ws/<id>）' }),
  repo_paths: z.array(z.string().min(1)).meta({ description: '项目仓库的本地路径' }),
  docs: z.array(z.string()).optional().meta({ description: '重要文档的路径' }),
})

export const entrySchemas = {
  product: productEntry,
  domain: domainEntry,
  service: serviceEntry,
  repo: repoEntry,
  'data-source': dataSourceEntry,
  account: accountEntry,
  runbook: runbookEntry,
  decision: decisionEntry,
  concept: conceptEntry,
  note: noteEntry,
  'project-card': projectCardEntry,
} as const satisfies Record<EntryType, z.ZodType>

/** 任意条目的 frontmatter（按 `type` 区分）。 */
export const entrySchema = z
  .discriminatedUnion('type', [
    productEntry,
    domainEntry,
    serviceEntry,
    repoEntry,
    dataSourceEntry,
    accountEntry,
    runbookEntry,
    decisionEntry,
    conceptEntry,
    noteEntry,
    projectCardEntry,
  ])
  .meta({ title: 'Flow brain entry', description: 'brain/ 下知识条目的 YAML frontmatter' })

export type EntryFrontmatter = z.infer<typeof entrySchema>
