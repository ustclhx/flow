import type { z } from 'zod'
import { HubClient } from '../daemon/client.ts'
import { renderTable } from '../format/table.ts'
import { inboxActRequest, inboxItemRef, inboxListQuery } from '../inbox/schema.ts'
import { defineOperation } from './operation.ts'

export const inboxListOp = defineOperation({
  name: 'inbox_list',
  access: 'read',
  cli: 'inbox list',
  cliAliases: ['inbox'],
  summary: '按状态、级别和 workspace 列出收件箱条目',
  input: inboxListQuery,
  run: (input: z.input<typeof inboxListQuery>, ctx) => new HubClient(ctx).listInbox(input),
  human: ({ items }) =>
    renderTable(
      items,
      [
        { header: 'ID', value: (i) => i.short_id },
        { header: '级别', value: (i) => i.level },
        { header: '来源', value: (i) => i.source },
        { header: 'Workspace', value: (i) => i.workspace ?? '—' },
        { header: '标题', value: (i) => i.title, max: 60 },
        { header: '创建时间', value: (i) => i.created_at },
      ],
      '没有待处理的条目',
    ),
})

const inboxActInput = inboxActRequest.extend({ id: inboxItemRef })
export const inboxActOp = defineOperation({
  name: 'inbox_act',
  cli: 'inbox act',
  summary: '处理收件箱条目；AI 只能忽略自己发起的条目',
  input: inboxActInput,
  positional: ['id', 'action', 'text'],
  run: (input: z.infer<typeof inboxActInput>, ctx) => {
    const { id, ...body } = input
    return new HubClient(ctx).actInbox(id, {
      ...body,
      ...(ctx.via === 'cli' ? { via: 'cli' as const } : {}),
    })
  },
  human: ({ item }) =>
    '条目 ' +
    item.short_id +
    '：' +
    (item.state === 'closed' ? '已关闭' : '操作已提交，等待底层状态更新'),
})
