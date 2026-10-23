import type { ManagedBlockInput } from './types.ts'

export const BEGIN_MARKER = '<!-- BEGIN:flow-managed -->'
export const END_MARKER = '<!-- END:flow-managed -->'

/** 按类型、标识排序，避免系统区域设置影响渲染结果。 */
function compareResources(
  a: ManagedBlockInput['resources'][number],
  b: ManagedBlockInput['resources'][number],
): number {
  for (const key of ['type', 'id', 'title', 'summary'] as const) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
  }
  return 0
}

export function renderManagedBlock(
  input: ManagedBlockInput,
  opts: { maxChars?: number } = {},
): string {
  const { workspace, projectCardId } = input
  const resources = input.resources.slice().sort(compareResources)
  const grouped = new Map<string, string[]>()
  for (const resource of resources) {
    const ids = grouped.get(resource.type) ?? []
    ids.push(resource.id)
    grouped.set(resource.type, ids)
  }

  const prefix = [
    BEGIN_MARKER,
    '## Flow 工作区上下文',
    '',
    '> 由 `flow agents sync` 生成，请勿手动修改本区块。',
    '',
    `- 所属 workspace：\`${workspace.id}\`（${workspace.name}，${workspace.kind === 'product' ? '产品' : '职能'}）`,
    projectCardId === null
      ? '- 项目卡片：尚未建立'
      : `- 项目卡片：brain 条目 \`${projectCardId}\`（\`flow kb get ${projectCardId}\`）`,
    '- 关键资源：',
  ]
  const suffix = [
    `- 访问知识库：MCP 工具 \`kb_search\`、\`kb_get\`、\`kb_query\`、\`ws_brief\`；或 CLI \`flow kb search <词>\`、\`flow ws brief ${workspace.id}\``,
    '- 写入规则：工作日志用 `kb_journal`；随手记用 `capture`；事实类修改用 `kb_propose` 提交提案，必须附出处；不得直接修改 decision 和 personal 条目。',
    END_MARKER,
  ]
  const levels = [
    resources.map((r) => `  - ${r.type} \`${r.id}\`：${r.title}，${r.summary}`),
    Array.from(grouped, ([type, ids]) => `  - ${type}：${ids.map((id) => `\`${id}\``).join('、')}`),
    [
      ...Array.from(grouped, ([type, ids]) => `  - ${type}：${ids.length} 个`),
      `  - 完整列表：flow ws resources ${workspace.id}`,
    ],
  ]

  let block = ''
  for (const lines of levels) {
    block = [...prefix, ...(lines.length === 0 ? ['  - 暂无资源'] : lines), ...suffix].join('\n')
    if (block.length <= (opts.maxChars ?? 2000)) return block
  }
  // 第三级保留全部类型计数与查询入口，即使预算小于固定指引所需长度。
  return block
}
