import { HubClient } from '../daemon/client.ts'
import { eventGetQuery } from '../ledger/protocol.ts'
import { defineOperation } from './operation.ts'

export const eventGetOp = defineOperation({
  name: 'event_get',
  access: 'read',
  cli: 'event get',
  summary: '按序号读取可见范围内的完整账本事件',
  input: eventGetQuery,
  positional: ['seq'],
  run: (input: { seq: number }, ctx) => new HubClient(ctx).getEvent(input.seq),
  human: ({ event }) => JSON.stringify(event, null, 2),
})
