import { z } from 'zod'
import { workspaceRef } from '../schema/common.ts'
import { taskId } from './common.ts'

export const taskReadSection = z.enum([
  'summary',
  'events',
  'tail',
  'attempts',
  'replies',
  'instruction',
])
export type TaskReadSection = z.infer<typeof taskReadSection>
/** 不依赖任务视图及协议模块，便于在任务输入 schema 中复用。 */
export const readOperation = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('task_list'),
    args: z.strictObject({
      workspace: workspaceRef,
      pr: z.string().url(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
  }),
  z.strictObject({
    op: z.literal('event_get'),
    args: z.strictObject({ seq: z.number().int().positive() }),
  }),
  z.strictObject({
    op: z.literal('task_show'),
    args: z.strictObject({
      id: taskId,
      section: taskReadSection.optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
  }),
])

/** 注入上下文省略内容时，附上可直接调用的只读操作。 */
export function eventReadPointer(seq: number) {
  return { read: { op: 'event_get' as const, args: { seq } } }
}

export function taskReadPointer(id: string, section?: TaskReadSection, offset?: number) {
  return {
    read: {
      op: 'task_show' as const,
      args: {
        id,
        ...(section === undefined ? {} : { section }),
        ...(offset === undefined ? {} : { offset }),
      },
    },
  }
}

export function prTasksReadPointer(workspace: string, pr: string, offset = 0, limit = 20) {
  return { read: { op: 'task_list' as const, args: { workspace, pr, offset, limit } } }
}
