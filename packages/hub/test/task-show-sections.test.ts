import { afterEach, expect, test } from 'bun:test'
import { taskShowResponse } from '@raindown/core'
import { createTaskService } from '../src/index.ts'
import {
  anyRole,
  contractInput,
  drafts,
  must,
  startTask,
  sys,
  tempLedger,
} from './ledger-helpers.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup() {
  const temporary = await tempLedger()
  const previousHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = temporary.dir
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.RAINDOWN_HOME
    else process.env.RAINDOWN_HOME = previousHome
    temporary.cleanup()
  })
  const tasks = createTaskService({
    ledger: temporary.store,
    workspaceExists: () => true,
    roles: anyRole,
  })
  const task = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
  startTask(temporary.store, task.id)
  const blocked = drafts(task.id)['task.blocked']
  must(
    temporary.store.append(
      { ...blocked, payload: { ...blocked.payload, tail: ['第一行', '第二行'] } },
      sys,
    ),
  )
  must(tasks.replyTask(task.id, { kind: 'text', text: '继续' }, { actor: 'user' }))
  return { tasks, task, ledger: temporary.store }
}

test('无section保持完整详情，事件分页连续且不会在task副本重复终端输出', async () => {
  const { tasks, task, ledger } = await setup()
  const full = must(tasks.getTask(task.id))
  expect(full.events).toEqual(ledger.taskEvents(task.id))
  const first = must(tasks.getTask(task.id, { section: 'events', limit: 2 }))
  expect(taskShowResponse.safeParse(first).success).toBe(true)
  if (!('section' in first) || first.section !== 'events') throw new Error('不是事件分页')
  expect(first).toMatchObject({ total: full.events.length, has_more: true, next_offset: 2 })
  expect(first.events).toEqual(full.events.slice(0, 2))
  expect(first.task.blocked?.tail).toBeUndefined()
  const last = must(tasks.getTask(task.id, { section: 'events', offset: 2, limit: 100 }))
  if (!('section' in last) || last.section !== 'events') throw new Error('不是事件分页')
  expect(last.events).toEqual(full.events.slice(2))
  expect(last.has_more).toBe(false)
  expect(last.next_offset).toBeUndefined()
})

test('tail按字符读取已恢复任务最近卡住片段，summary、attempts和replies分别读取', async () => {
  const { tasks, task } = await setup()
  const tail = must(tasks.getTask(task.id, { section: 'tail', offset: 2, limit: 3 }))
  expect(tail).toMatchObject({ section: 'tail', tail: '行\n第', total: 7, next_offset: 5 })
  const full = must(tasks.getTask(task.id))
  for (const section of ['attempts', 'replies'] as const) {
    const page = must(tasks.getTask(task.id, { section, limit: 1 }))
    expect(taskShowResponse.safeParse(page).success).toBe(true)
    expect(page).toMatchObject({ section, total: full[section].length, has_more: false })
    expect(page).toHaveProperty(section, full[section].slice(0, 1))
  }
  const summary = must(tasks.getTask(task.id, { section: 'summary' }))
  expect(Object.keys(summary).sort()).toEqual(['section', 'task'])
})

test('分页参数验证与越界空页', async () => {
  const { tasks, task } = await setup()
  for (const query of [{ offset: -1 }, { limit: 0 }, { limit: 1001 }]) {
    const result = tasks.getTask(task.id, query)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_arguments')
  }
  expect(must(tasks.getTask(task.id, { section: 'tail', offset: 100 }))).toMatchObject({
    tail: '',
    has_more: false,
    total: 7,
  })
})
