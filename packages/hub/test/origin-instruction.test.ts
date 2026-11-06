import { afterEach, expect, test } from 'bun:test'
import { defaultSupervisorConfig, ok } from '@raindown/core'
import { createTaskService } from '../src/index.ts'
import { contractInput, must, tempLedger, WS } from './ledger-helpers.ts'

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
  const ledger = temporary.store
  let generation = 0
  const tasks = createTaskService({
    ledger,
    workspaceExists: () => true,
    roles: async (name) =>
      ok({
        name,
        kind: 'read',
        creatable_by: ['*'],
        permissions: {
          setting_sources: [],
          allowedTools: ['Read', 'Grep', 'Glob'],
          disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
        },
      }),
    workspaces: async () => ({
      ref: WS,
      repos: [temporary.dir],
      supervisor: defaultSupervisorConfig(),
    }),
  })
  const instruction = (text: string) =>
    must(
      ledger.append(
        { type: 'user.instruction', workspace: WS, payload: { text, via: 'cli' } },
        { actor: 'user' },
      ),
    ).seq
  const wake = async (events: number[], origin: 'instruction' | 'autonomous' = 'instruction') => {
    const g = ++generation
    return must(
      await tasks.createTask(contractInput({ role: 'supervisor' }), {
        actor: 'hub',
        withCreated: (id) => [
          {
            type: 'supervisor.wake_started',
            task_id: id,
            workspace: WS,
            payload: { task_id: id, workspace: WS, origin, events, generation: g },
          },
        ],
      }),
    ).task.id
  }
  const create = (wakeId: string, extra: Record<string, unknown> = {}) =>
    tasks.createTask(
      {
        ...contractInput({ parent: wakeId, cwd: temporary.dir, executor: 'claude-sdk' }),
        ...extra,
      },
      { actor: 'supervisor', wake: { task_id: wakeId } },
    )
  return { tasks, ledger, instruction, wake, create }
}

test('唯一指令从账本附加，原始指令和授权依据重建后保持一致', async () => {
  const s = await setup()
  const seq = s.instruction('用户要求保留这句话')
  const wake = await s.wake([seq])
  const task = must(await s.create(wake, { goal: 'supervisor 的补充要求' })).task
  expect(task.contract.origin_instruction).toEqual({ seq, text: '用户要求保留这句话' })
  expect(task.contract.goal).toBe('supervisor 的补充要求')
  expect(task.mandate?.instruction_seq).toBe(seq)
  expect('instruction_seq' in task.contract).toBe(false)
  must(s.ledger.rebuild())
  expect(s.ledger.getTask(task.id)?.contract.origin_instruction).toEqual(
    task.contract.origin_instruction,
  )
})

test('多条指令必须显式选择本次唤醒的指令，拒绝外来序号与伪造原文', async () => {
  const s = await setup()
  const first = s.instruction('第一条')
  const second = s.instruction('第二条')
  const outside = s.instruction('另一轮指令')
  const wake = await s.wake([first, second])
  for (const extra of [
    {},
    { instruction_seq: outside },
    { instruction_seq: first, origin_instruction: { seq: first, text: '伪造' } },
  ]) {
    const result = await s.create(wake, extra)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'usage', code: 'invalid_arguments' })
  }
  const task = must(await s.create(wake, { instruction_seq: second })).task
  expect(task.contract.origin_instruction).toEqual({ seq: second, text: '第二条' })
  expect(task.mandate?.instruction_seq).toBe(second)
})

test('长指令附原始长度和读取指针，中枢审查从开发任务继承相同指令', async () => {
  const s = await setup()
  const text = '原'.repeat(4001)
  const other = s.instruction('同次唤醒中的另一条指令')
  const seq = s.instruction(text)
  const wake = await s.wake([other, seq])
  const dev = must(await s.create(wake, { instruction_seq: seq })).task
  expect(dev.contract.origin_instruction).toEqual({
    seq,
    text: text.slice(0, 4000),
    chars: 4001,
    read: { op: 'event_get', args: { seq } },
  })
  const review = must(
    await s.tasks.createTask(
      contractInput({ inputs: { review: { pr: 'https://github.com/acme/repo/pull/1' } } }),
      { actor: 'hub', mandateSourceTask: dev.id },
    ),
  ).task
  expect(review.contract.origin_instruction).toEqual(dev.contract.origin_instruction)
  expect(review.mandate?.instruction_seq).toBe(seq)
})

test('自主唤醒没有用户原文，显式选择也不能借其他指令建立来源', async () => {
  const s = await setup()
  const seq = s.instruction('历史指令')
  const wake = await s.wake([seq], 'autonomous')
  const task = must(await s.create(wake)).task
  expect(task.contract.origin_instruction).toBeUndefined()
  expect(task.mandate?.instruction_seq).toBeUndefined()
  const result = await s.create(wake, { instruction_seq: seq })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('invalid_arguments')
})

test('原文沿合同送给worker时沿用event_get的疑似密钥遮蔽', async () => {
  const s = await setup()
  const seq = s.instruction(`排查 Bearer ${'a'.repeat(30)} 的请求`)
  const wake = await s.wake([seq])
  const task = must(await s.create(wake)).task
  expect(task.contract.origin_instruction).toEqual({
    seq,
    text: '排查 Bearer [REDACTED:bearer] 的请求',
  })
})

async function complete(s: Awaited<ReturnType<typeof setup>>, id: string, pr?: string) {
  const { startTask, sys, drafts } = await import('./ledger-helpers.ts')
  startTask(s.ledger, id)
  const done = drafts(id)['task.done']
  return must(
    s.ledger.append(
      {
        ...done,
        payload: {
          result: {
            ...done.payload.result,
            ...(pr ? { artifacts: [{ kind: 'pr' as const, ref: pr }] } : {}),
          },
        },
      },
      sys,
    ),
  ).seq
}

test('真实第二次唤醒从开发完成事件为审查和普通后续任务继承同一指令', async () => {
  const s = await setup()
  const seq = s.instruction('实现缓存并审查')
  const first = await s.wake([seq])
  const dev = must(await s.create(first)).task
  const pr = 'https://github.com/acme/repo/pull/8'
  const done = await complete(s, dev.id, pr)
  const second = await s.wake([done])
  for (const extra of [{ role: 'pr-reviewer', inputs: { review: { pr } } }, {}]) {
    const task = must(await s.create(second, extra)).task
    expect(task.contract.origin_instruction).toEqual({ seq, text: '实现缓存并审查' })
    expect(task.mandate?.instruction_seq).toBe(seq)
  }
})

test('多个任务对应不同指令时不继承并记录原因，相同指令去重', async () => {
  const s = await setup()
  const seq = s.instruction('第一条工作')
  const first = await s.wake([seq])
  const one = must(await s.create(first)).task
  const two = must(await s.create(first)).task
  const oneDone = await complete(s, one.id)
  const twoDone = await complete(s, two.id)
  const sameWake = await s.wake([oneDone, twoDone])
  expect(must(await s.create(sameWake)).task.mandate?.instruction_seq).toBe(seq)
  const other = s.instruction('另一条工作')
  const otherWake = await s.wake([other])
  const three = must(await s.create(otherWake)).task
  const threeDone = await complete(s, three.id)
  const ambiguous = await s.wake([oneDone, threeDone])
  const task = must(await s.create(ambiguous)).task
  expect(task.contract.origin_instruction).toBeUndefined()
  expect(task.mandate?.instruction_seq).toBeUndefined()
  expect(task.mandate?.instruction_note).toContain('多条不同用户指令')
})

test('原始指令回溯拒绝跨workspace任务与不匹配的PR产物', async () => {
  const s = await setup()
  const seq = s.instruction('本workspace的指令')
  const first = await s.wake([seq])
  const dev = must(await s.create(first)).task
  const done = await complete(s, dev.id, 'https://github.com/acme/repo/pull/1')
  const second = await s.wake([done])
  const unrelated = must(
    await s.create(second, { inputs: { review: { pr: 'https://github.com/acme/repo/pull/2' } } }),
  ).task
  expect(unrelated.contract.origin_instruction).toBeUndefined()
  const other = must(
    await s.tasks.createTask(contractInput({ workspace: 'ws/other' }), { actor: 'user' }),
  ).task
  const { drafts, sys } = await import('./ledger-helpers.ts')
  const foreign = drafts(other.id, { ws: 'ws/other' })
  must(s.ledger.appendMany([foreign['task.started'], foreign['lease.granted']], sys))
  const event = must(s.ledger.append(drafts(other.id, { ws: 'ws/other' })['task.done'], sys))
  const foreignWake = await s.wake([event.seq])
  expect(must(await s.create(foreignWake)).task.contract.origin_instruction).toBeUndefined()
})

test('开发任务重试清空当前结果后，审查仍沿历史PR产物继承指令', async () => {
  const s = await setup()
  const seq = s.instruction('保留已有PR并继续审查')
  const first = await s.wake([seq])
  const dev = must(await s.create(first)).task
  const { startTask, sys, result } = await import('./ledger-helpers.ts')
  startTask(s.ledger, dev.id)
  const pr = 'https://github.com/acme/repo/pull/11'
  const failed = must(
    s.ledger.append(
      {
        type: 'task.failed',
        task_id: dev.id,
        workspace: WS,
        payload: { result: { ...result(), artifacts: [{ kind: 'pr', ref: pr }] } },
      },
      sys,
    ),
  )
  must(
    s.ledger.append(
      { type: 'task.requeued', task_id: dev.id, workspace: WS, payload: { reason: 'manual' } },
      sys,
    ),
  )
  expect(s.ledger.getTask(dev.id)?.result).toBeNull()
  const second = await s.wake([failed.seq])
  const review = must(
    await s.create(second, { role: 'pr-reviewer', inputs: { review: { pr } } }),
  ).task
  expect(review.contract.origin_instruction).toEqual({ seq, text: '保留已有PR并继续审查' })
  expect(review.mandate?.instruction_seq).toBe(seq)
})
