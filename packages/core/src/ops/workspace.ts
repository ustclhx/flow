import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { type BrainEntry, readBrainEntries } from '../entries.ts'
import { renderTable } from '../format/table.ts'
import { parseFrontmatter } from '../frontmatter.ts'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { isResourceType, RESOURCE_TYPES } from '../schema/entries.ts'
import { validateBrain } from '../validate.ts'
import { loadWorkspaces, type Workspace } from '../workspaces.ts'
import { entryPath, writeEntry } from '../write/api.ts'
import { withWriteLock } from '../write/lock.ts'
import { isAiActor } from '../write/policy.ts'
import { defineOperation } from './operation.ts'

/** 两种公开参数写法统一为完整引用，并通过已定义集合判断合法性。 */
async function workspaceOf(home: string, value: string): Promise<Result<Workspace>> {
  const loaded = await loadWorkspaces(home)
  if (!loaded.ok) return loaded
  const ref = value.startsWith('ws/') ? value : `ws/${value}`
  const ws = loaded.data.workspaces.find((w) => w.ref === ref)
  return ws ? ok(ws) : fail('failure', 'unknown_workspace', `未定义的 workspace：${ref}`)
}

function resourcesFor(entries: BrainEntry[], ref: string) {
  return entries
    .filter((e) => isResourceType(e.frontmatter.type) && e.frontmatter.owner === ref)
    .map((e) => ({
      id: e.id,
      type: e.frontmatter.type as string,
      title: e.frontmatter.title as string,
      summary: e.frontmatter.summary as string,
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id))
}

export const wsListOp = defineOperation({
  name: 'ws_list',
  cli: 'ws list',
  summary: '列出全局与已定义的 workspace',
  input: z.object({}),
  run: async (_input: Record<string, never>, ctx) => {
    const loaded = await loadWorkspaces(ctx.home)
    if (!loaded.ok) return loaded
    return ok({
      workspaces: loaded.data.workspaces.map(({ ref, kind, name }) => ({ ref, kind, name })),
    })
  },
  human: (o) =>
    renderTable(o.workspaces, [
      { header: 'WORKSPACE', value: (w) => w.ref },
      { header: 'KIND', value: (w) => w.kind },
      { header: 'NAME', value: (w) => w.name },
    ]),
})

export const wsResourcesOp = defineOperation({
  name: 'ws_resources',
  cli: 'ws resources',
  summary: '按归属和类型列出资源',
  input: z.object({ workspace: z.string(), type: z.enum(RESOURCE_TYPES).optional() }),
  positional: ['workspace'],
  run: async (input: { workspace: string; type?: string | undefined }, ctx) => {
    const ws = await workspaceOf(ctx.home, input.workspace)
    if (!ws.ok) return ws
    const read = await readBrainEntries(ctx.home)
    if (!read.ok) return read
    const resources = resourcesFor(read.data.entries, ws.data.ref).filter(
      (e) => !input.type || e.type === input.type,
    )
    return ok({ workspace: ws.data.ref, resources })
  },
  human: (o) =>
    renderTable(
      o.resources,
      [
        { header: 'TYPE', value: (r) => r.type },
        { header: 'ID', value: (r) => r.id },
        { header: 'SUMMARY', value: (r) => r.summary, max: 50 },
      ],
      `${o.workspace} 没有资源`,
    ),
})

export const resourceTransferOp = defineOperation({
  name: 'resource_transfer',
  cli: 'resource transfer',
  summary: '用户转移资源归属并记录原 owner 与新 owner',
  input: z.object({ resource: z.string(), workspace: z.string() }),
  positional: ['resource', 'workspace'],
  run: async (input: { resource: string; workspace: string }, ctx) => {
    if (isAiActor(ctx.actor))
      return fail('failure', 'user_only', '只有用户能转移资源，AI 请提交修改提案')
    const path = entryPath(input.resource)
    if (!path.ok) return path
    return withWriteLock(ctx.home, async (lock) => {
      const ws = await workspaceOf(ctx.home, input.workspace)
      if (!ws.ok) return ws
      if (ws.data.kind === 'function')
        return fail('failure', 'function_owner', '职能 workspace 不能拥有资源')
      let content: string
      try {
        content = await readFile(join(flowPaths(ctx.home).brain, path.data), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          return fail('failure', 'not_found', `资源不存在：${input.resource}`)
        return fail('failure', 'read_failed', '无法读取资源条目')
      }
      const parsed = parseFrontmatter(content)
      if (!parsed.ok) return parsed
      if (!isResourceType(parsed.data.data.type))
        return fail('failure', 'not_resource', '该条目不是资源类型')
      const before = parsed.data.data.owner
      const r = await writeEntry(
        ctx.home,
        {
          id: input.resource,
          frontmatter: { ...parsed.data.data, owner: ws.data.ref },
          body: parsed.data.body,
        },
        {
          actor: 'user',
          lock,
          op: 'owner-change',
          summary: `${input.resource} ${String(before)} → ${ws.data.ref}`,
        },
      )
      if (!r.ok) return r
      return ok({
        resource: input.resource,
        previous_owner: before as string,
        owner: ws.data.ref,
        sha: r.data.sha,
      })
    })
  },
})

/** 只识别 journal 的完整记录标题，正文中的 ws 字样不会被当作归属标记。 */
async function recentJournal(home: string, workspace: string, limit: number): Promise<string[]> {
  const dir = flowPaths(home).journal
  let files: string[]
  try {
    files = (await readdir(dir))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: { stamp: string; order: number; text: string }[] = []
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    const headings = [...text.matchAll(/^## (\d{2}:\d{2}:\d{2}) · ([^\r\n]+)$/gm)]
    headings.forEach((h, i) => {
      const fields = (h[2] ?? '').split(' · ')
      if (fields.length !== 2 || fields[1] !== workspace) return
      const end = headings[i + 1]?.index ?? text.length
      records.push({
        stamp: `${file.slice(0, -3)}T${h[1]}`,
        order: i,
        text: `### ${file.slice(0, -3)} ${h[1]} · ${fields[0]}\n${text.slice(h.index + h[0].length, end).trim()}`,
      })
    })
  }
  return records
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || b.order - a.order)
    .slice(0, limit)
    .map((r) => r.text)
}

interface BriefSection {
  label: string
  text: string
}

/** 保留高优先级前缀，先截最低优先级部分；预算包含末尾的省略说明。 */
function fitBrief(sections: BriefSection[], budget: number): { text: string; omitted: string[] } {
  const full = sections.map((s) => s.text).join('\n\n')
  if (full.length <= budget) return { text: full, omitted: [] }
  for (let i = sections.length - 1; i >= 0; i--) {
    const omitted = sections.slice(i).map((s) => s.label)
    const footer = `\n\n> 已省略：${omitted.join('、')}`
    const prefix = sections
      .slice(0, i)
      .map((s) => s.text)
      .join('\n\n')
    const before = prefix ? `${prefix}\n\n` : ''
    const remaining = budget - before.length - footer.length
    if (remaining >= 0) {
      // 避免在 UTF-16 代理对中间切断字符。
      let partial = (sections[i]?.text ?? '').slice(0, remaining)
      const last = partial.charCodeAt(partial.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) partial = partial.slice(0, -1)
      return { text: `${before}${partial.trimEnd()}${footer}`, omitted }
    }
  }
  return {
    text: `> 已省略：${sections.map((s) => s.label).join('、')}`,
    omitted: sections.map((s) => s.label),
  }
}

export const wsBriefOp = defineOperation({
  name: 'ws_brief',
  cli: 'ws brief',
  summary: '在字符预算内生成 workspace 简报',
  input: z.object({
    workspace: z.string(),
    budget: z.number().int().min(64).default(4000).describe('字符预算（至少 64，包含省略说明）'),
    limit: z.number().int().nonnegative().default(10).describe('最近相关 journal 的条数'),
  }),
  positional: ['workspace'],
  run: async (
    input: { workspace: string; budget?: number | undefined; limit?: number | undefined },
    ctx,
  ) => {
    const budget = input.budget ?? 4000
    const limit = input.limit ?? 10
    if (!Number.isInteger(budget) || budget < 64 || !Number.isInteger(limit) || limit < 0) {
      return fail('usage', 'invalid_arguments', 'budget 必须是至少 64 的整数，limit 必须是非负整数')
    }
    return withWriteLock(ctx.home, async () => {
      const ws = await workspaceOf(ctx.home, input.workspace)
      if (!ws.ok) return ws
      const read = await readBrainEntries(ctx.home)
      if (!read.ok) return read
      const validation = await validateBrain(ctx.home)
      if (!validation.ok) return validation
      const ref = ws.data.ref
      const entries = read.data.entries.filter(
        (e) => e.frontmatter.owner === ref || e.frontmatter.workspace === ref,
      )
      const cards = entries
        .filter((e) => e.frontmatter.type === 'project-card')
        .map(
          (e) =>
            `### ${e.frontmatter.title}\n${e.frontmatter.summary}\n\n${e.body.trim().split('\n').slice(0, 5).join('\n')}`,
        )
      const resources = resourcesFor(entries, ref).map(
        (e) => `- ${e.type} [${e.title}](${e.id}.md)：${e.summary}`,
      )
      const journals = await recentJournal(ctx.home, ref, limit)
      const ids = new Set(entries.map((e) => e.id))
      const facts = [
        ...validation.data.stale
          .filter((e) => ids.has(e.id))
          .map((e) => `- 可能过时：${e.id}（${e.last_verified}）`),
        ...validation.data.neverVerified
          .filter((e) => ids.has(e.id))
          .map((e) => `- 从未核实：${e.id}`),
      ]
      const sections: BriefSection[] = [
        { label: 'workspace 描述', text: `# ${ws.data.name}（${ref}）\n\n${ws.data.description}` },
      ]
      if (cards.length)
        sections.push({ label: '项目卡片', text: `## 项目卡片\n\n${cards.join('\n\n')}` })
      if (resources.length)
        sections.push({ label: '资源列表', text: `## 资源列表\n\n${resources.join('\n')}` })
      if (journals.length)
        sections.push({
          label: '最近 journal',
          text: `## 最近 journal\n\n${journals.join('\n\n')}`,
        })
      if (facts.length)
        sections.push({ label: '待核实事实', text: `## 待核实事实\n\n${facts.join('\n')}` })
      return ok({ workspace: ref, ...fitBrief(sections, budget) })
    })
  },
  human: (o) => o.text,
})
