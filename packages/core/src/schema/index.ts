import { z } from 'zod'
import { proposalSchema } from '../proposals/schema.ts'
import { baseShape, ENTRY_TYPES, entrySchema, entrySchemas } from './entries.ts'
import { workspaceSchema } from './workspace.ts'

export * from '../proposals/schema.ts'
export * from './common.ts'
export * from './entries.ts'
export * from './workspace.ts'

type JsonSchema = Record<string, unknown>

const SCHEMA_BASE = 'https://flow.local/schemas/'

function toJson(schema: z.ZodType, file: string): JsonSchema {
  const json = z.toJSONSchema(schema) as JsonSchema
  return { $id: `${SCHEMA_BASE}${file}`, ...json }
}

/**
 * 导出到仓库根 `schemas/` 的全部 JSON Schema（design D12：跨语言的磁盘格式契约）。
 * 键是相对 `schemas/` 的文件路径，值是 JSON Schema 对象。
 */
export function jsonSchemas(): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {
    'entry.schema.json': toJson(entrySchema, 'entry.schema.json'),
    'workspace.schema.json': toJson(workspaceSchema, 'workspace.schema.json'),
    'proposal.schema.json': toJson(proposalSchema, 'proposal.schema.json'),
  }
  for (const type of ENTRY_TYPES) {
    const file = `entries/${type}.schema.json`
    out[file] = toJson(entrySchemas[type], file)
  }
  return out
}

/** 把 JSON Schema 的类型描述成简短的人类可读文本。 */
function describeType(prop: JsonSchema): string {
  if (typeof prop.const === 'string') return `\`${prop.const}\``
  if (Array.isArray(prop.enum)) return prop.enum.map((v) => `\`${String(v)}\``).join(' | ')
  if (Array.isArray(prop.anyOf)) {
    return (prop.anyOf as JsonSchema[]).map(describeType).join(' | ')
  }
  const t = prop.type
  if (Array.isArray(t)) return t.join(' | ')
  if (t === 'array') {
    const items = (prop.items ?? {}) as JsonSchema
    return `${describeType(items)}[]`
  }
  if (t === 'string' && typeof prop.pattern === 'string' && prop.pattern.includes('\\d{4}')) {
    return 'date'
  }
  return typeof t === 'string' ? t : 'any'
}

/**
 * 由 zod 定义生成各条目类型的字段说明（Markdown），写入 brain/AGENTS.md，
 * 保证文档与校验使用同一份定义（design D3）。
 */
export function renderEntryFieldDocs(): string {
  const fieldLines = (schema: z.ZodType, include: (name: string) => boolean) => {
    const json = z.toJSONSchema(schema) as JsonSchema
    const props = (json.properties ?? {}) as Record<string, JsonSchema>
    const required = new Set((json.required ?? []) as string[])
    return Object.entries(props)
      .filter(([name]) => include(name))
      .map(([name, prop]) => {
        const req = required.has(name) ? '必填' : '可选'
        const desc = typeof prop.description === 'string' ? `：${prop.description}` : ''
        return `- \`${name}\`（${req}，${describeType(prop)}）${desc}`
      })
  }
  const common = new Set(Object.keys(baseShape))
  const sections = [
    [
      '### 公共字段（所有类型）',
      '',
      '- `type`（必填）：条目类型，取值为下列各小节标题之一',
      ...fieldLines(entrySchemas.note, (n) => common.has(n)),
    ].join('\n'),
  ]
  for (const type of ENTRY_TYPES) {
    const lines = fieldLines(entrySchemas[type], (n) => n !== 'type' && !common.has(n))
    const description = entrySchemas[type].meta()?.description ?? ''
    sections.push(
      [`### \`${type}\` — ${description}`, '', ...(lines.length ? lines : ['- 无额外字段'])].join(
        '\n',
      ),
    )
  }
  return sections.join('\n\n')
}
