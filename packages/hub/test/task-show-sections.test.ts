import { afterEach, expect, spyOn, test } from 'bun:test'
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

test('分段事件与tail遮蔽完整密钥后分页，默认详情保持兼容', async () => {
  const { tasks, task, ledger } = await setup()
  const token = 'x'.repeat(36)
  startTask(ledger, task.id, 2)
  const blocked = drafts(task.id)['task.blocked']
  must(
    ledger.append(
      { ...blocked, payload: { ...blocked.payload, tail: [`前缀 Bearer ${token} 后缀`] } },
      sys,
    ),
  )
  // 模拟正则遮蔽上线前已经入账的历史片段，当前写入层会主动遮蔽。
  const historicalEvents = ledger
    .taskEvents(task.id)
    .map((event) =>
      event.type === 'task.blocked'
        ? { ...event, payload: { ...event.payload, tail: [`前缀 Bearer ${token} 后缀`] } }
        : event,
    )
  const stored = ledger.getTask(task.id)
  if (!stored?.blocked) throw new Error('缺少卡住任务')
  const eventSpy = spyOn(ledger, 'taskEvents').mockReturnValue(historicalEvents)
  const taskSpy = spyOn(ledger, 'getTask').mockReturnValue({
    ...stored,
    blocked: { ...stored.blocked, tail: [`前缀 Bearer ${token} 后缀`] },
  })
  cleanups.push(() => {
    eventSpy.mockRestore()
    taskSpy.mockRestore()
  })
  const full = must(tasks.getTask(task.id))
  expect(JSON.stringify(full.events)).toContain(token)
  const events = must(tasks.getTask(task.id, { section: 'events', limit: 1000 }))
  expect(JSON.stringify(events)).not.toContain(token)
  expect(JSON.stringify(events)).toContain('[REDACTED:bearer]')
  const expected = '前缀 Bearer [REDACTED:bearer] 后缀'
  let text = ''
  for (let offset = 0; offset < expected.length; offset += 5) {
    const page = must(tasks.getTask(task.id, { section: 'tail', offset, limit: 5 }))
    if (!('section' in page) || page.section !== 'tail') throw new Error('不是tail分页')
    expect(page.total).toBe(expected.length)
    text += page.tail
  }
  expect(text).toBe(expected)
})
