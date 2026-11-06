import { afterEach, expect, test } from 'bun:test'
import { defaultSupervisorConfig, ok } from '@raindown/core'
import { createTaskService } from '../src/index.ts'
import { wakeSourceFromEvents } from '../src/supervisor/observe.ts'
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
  const wake = async (
    events: number[],
    origin: 'instruction' | 'autonomous' = 'instruction',
    source?: 'pr',
  ) => {
    const g = ++generation
    // 与唤醒调度器相同：创建唤醒时由已固化的标记计算一次 source（不递归）。
    const derived =
      source ??
      wakeSourceFromEvents(
        ledger,
        events.flatMap((seq) => {
          const e = ledger.eventsAfter(seq - 1, {}, 1)[0]
          return e?.seq === seq ? [e] : []
        }),
      )
    return must(
      await tasks.createTask(contractInput({ role: 'supervisor' }), {
        actor: 'hub',
        withCreated: (id) => [
          {
            type: 'supervisor.wake_started',
            task_id: id,
            workspace: WS,
            payload: {
              task_id: id,
              workspace: WS,
              origin,
              events,
              generation: g,
              ...(derived ? { source: derived } : {}),
            },
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

test('PR 评论引起的唤醒（source: pr）建的任务不继承来源任务的原始指令，并记录 instruction_note', async () => {
  const s = await setup()
  const seq = s.instruction('实现缓存')
  const first = await s.wake([seq])
  const dev = must(await s.create(first)).task
  expect(dev.mandate?.instruction_seq).toBe(seq)
  const pr = 'https://github.com/acme/repo/pull/8'
  const devDone = await complete(s, dev.id, pr)
  const wakeEvent = (n: number) => {
    const comment = must(
      s.ledger.append(
        {
          type: 'pr.event',
          workspace: WS,
          payload: {
            pr,
            kind: 'issue_comment',
            actor: 'acme',
            actor_kind: 'human',
            allowed: true,
            text: '顺带把导出也做了',
            url: `${pr}#issuecomment-${n}`,
            cursor: `2026-10-24T00:00:00.000Z|${n}`,
          },
        },
        { actor: 'hub' },
      ),
    )
    return must(
      s.ledger.append(
        {
          type: 'pr.wake_requested',
          task_id: dev.id,
          workspace: WS,
          payload: { pr_event_seq: comment.seq, reason: 'resume_rejected' },
        },
        { actor: 'hub' },
      ),
    ).seq
  }
  // 对照：同一个开发任务，普通 instruction 唤醒（由完成事件引起）会继承原始指令。
  const plain = await s.wake([devDone])
  expect(s.ledger.wakeOf(plain)?.source).toBeUndefined()
  expect(must(await s.create(plain)).task.mandate?.instruction_seq).toBe(seq)
  const fromPr = await s.wake([wakeEvent(2)], 'instruction', 'pr')
  expect(s.ledger.wakeOf(fromPr)?.source).toBe('pr')
  const task = must(await s.create(fromPr)).task
  expect(task.contract.origin_instruction).toBeUndefined()
  expect(task.mandate?.instruction_seq).toBeUndefined()
  expect(task.mandate?.instruction_note).toContain('PR 评论')
})

test('PR 来源的污染沿唤醒链向下传递：两跳之后的任务仍带 pr_sourced，其唤醒也按 PR 来源推导', async () => {
  const { prSourcedWake } = await import('../src/supervisor/observe.ts')
  const s = await setup()
  const prWake = await s.wake([], 'instruction', 'pr')
  const d = must(await s.create(prWake)).task
  expect(d.mandate?.pr_sourced).toBe(true)
  // D 完成 → 普通 instruction 唤醒（payload 没有 source 标记），从事件涉及的任务推导为 PR 来源。
  const done = await complete(s, d.id)
  const w2 = await s.wake([done])
  // 普通唤醒的 source 在创建时由事件涉及的任务的已固化标记计算一次。
  expect(s.ledger.wakeOf(w2)?.source).toBe('pr')
  expect(prSourcedWake(s.ledger, w2)).toBe(true)
  const d2 = must(await s.create(w2)).task
  expect(d2.mandate?.pr_sourced).toBe(true)
  // 对照：与 PR 无关的唤醒链不带标记。
  const seq = s.instruction('普通指令')
  const plain = await s.wake([seq])
  expect(prSourcedWake(s.ledger, plain)).toBe(false)
  expect(must(await s.create(plain)).task.mandate?.pr_sourced).toBeUndefined()
})

test('PR 来源唤醒不能直接建或重试写类任务，与 autonomous 一样要求提案', async () => {
  const s = await setup()
  const seq = s.instruction('写代码')
  const plain = await s.wake([seq])
  const write = { executor: 'codex-orca' }
  const created = must(await s.create(plain, write)).task
  const prWake = await s.wake([], 'instruction', 'pr')
  expect(await s.create(prWake, write)).toMatchObject({
    ok: false,
    error: { code: 'proposal_required' },
  })
  // 重试：普通唤醒建的写类任务失败后，PR 来源唤醒也不能直接重试。
  const { startTask, drafts } = await import('./ledger-helpers.ts')
  startTask(s.ledger, created.id)
  must(s.ledger.append(drafts(created.id)['task.failed'], { actor: 'hub' }))
  expect(
    await s.tasks.retryTask(created.id, {
      actor: 'supervisor',
      wake: { task_id: prWake },
      reason: 'PR 评论要求重试',
    }),
  ).toMatchObject({ ok: false, error: { code: 'proposal_required' } })
})

test('用户接受 PR 来源唤醒的提案不清除污染：D → W2 → D2 仍为 PR 来源（不会自动合并）', async () => {
  const { prSourcedTask, prSourcedWake } = await import('../src/supervisor/observe.ts')
  const s = await setup()
  const seq = s.instruction('先修这个')
  const prWake = await s.wake([seq], 'instruction', 'pr')
  // 用户接受提案：以 user 身份建任务，来源指令属于 PR 来源唤醒。
  const d = must(
    await s.tasks.createTask(
      contractInput({ cwd: s.ledger.getTask(prWake)?.contract.cwd, executor: 'claude-sdk' }),
      { actor: 'user', instructionSource: { seq, wake: prWake } },
    ),
  ).task
  expect(d.mandate?.pr_sourced).toBe(true)
  const done = await complete(s, d.id)
  const w2 = await s.wake([done])
  expect(prSourcedWake(s.ledger, w2)).toBe(true)
  const d2 = must(await s.create(w2)).task
  expect(d2.mandate?.pr_sourced).toBe(true)
  expect(prSourcedTask(s.ledger, d2)).toBe(true)
})

test('PR 来源唤醒重试未污染的任务：重试记录 pr_sourced，之后的唤醒与任务都带污染', async () => {
  const { prSourcedTask, prSourcedWake } = await import('../src/supervisor/observe.ts')
  const s = await setup()
  const seq = s.instruction('读一下代码')
  const plain = await s.wake([seq])
  const r = must(await s.create(plain)).task
  expect(prSourcedTask(s.ledger, r)).toBe(false)
  const { startTask, drafts } = await import('./ledger-helpers.ts')
  startTask(s.ledger, r.id)
  must(s.ledger.append(drafts(r.id)['task.failed'], { actor: 'hub' }))
  const prWake = await s.wake([], 'instruction', 'pr')
  must(
    await s.tasks.retryTask(r.id, {
      actor: 'supervisor',
      wake: { task_id: prWake },
      reason: 'PR 评论要求再看一遍',
    }),
  )
  const requeued = s.ledger.taskEvents(r.id).findLast((e) => e.type === 'task.requeued')
  expect(requeued?.payload).toMatchObject({ reason: 'manual', pr_sourced: true })
  expect(prSourcedTask(s.ledger, s.ledger.getTask(r.id))).toBe(true)
  // R 第二次派工完成 → W2 为 PR 来源 → 下游任务带污染（不会自动合并）。
  const d = drafts(r.id, { attempt: 2 })
  must(s.ledger.appendMany([d['task.started'], d['lease.granted']], { actor: 'hub' }))
  const done = must(s.ledger.append(d['task.done'], { actor: 'hub' })).seq
  const w2 = await s.wake([done])
  expect(prSourcedWake(s.ledger, w2)).toBe(true)
  expect(must(await s.create(w2)).task.mandate?.pr_sourced).toBe(true)
})

test('40 代未污染的唤醒链保持未污染，且每次检查的开销与代数无关', async () => {
  const { prSourcedTask, prSourcedWake } = await import('../src/supervisor/observe.ts')
  const s = await setup()
  let events = [s.instruction('长期迭代')]
  let last: { id: string; wake: string } | undefined
  for (let g = 0; g < 40; g++) {
    const w = await s.wake(events)
    const t = must(await s.create(w)).task
    expect(t.mandate?.pr_sourced).toBeUndefined()
    events = [await complete(s, t.id)]
    last = { id: t.id, wake: w }
  }
  if (!last) throw new Error('没有任务')
  const started = performance.now()
  for (let i = 0; i < 100; i++) {
    expect(prSourcedWake(s.ledger, last.wake)).toBe(false)
    expect(prSourcedTask(s.ledger, s.ledger.getTask(last.id))).toBe(false)
  }
  // 只读已固化标记：100 次检查远小于 1 秒（递归重算时第 15 代左右单次就约 1 秒）。
  expect(performance.now() - started).toBeLessThan(1000)
  const w = await s.wake(events)
  expect(s.ledger.wakeOf(w)?.source).toBeUndefined()
  expect(must(await s.create(w)).task.mandate?.pr_sourced).toBeUndefined()
})

test('三跳：PR 来源的污染经固化标记逐层传递', async () => {
  const s = await setup()
  const prWake = await s.wake([], 'instruction', 'pr')
  let task = must(await s.create(prWake)).task
  for (let hop = 0; hop < 3; hop++) {
    const w = await s.wake([await complete(s, task.id)])
    expect(s.ledger.wakeOf(w)?.source).toBe('pr')
    task = must(await s.create(w)).task
    expect(task.mandate?.pr_sourced).toBe(true)
  }
})

test('父任务就是 PR 来源唤醒：直接建在其下的任务带污染', async () => {
  const s = await setup()
  const prWake = await s.wake([], 'instruction', 'pr')
  const t = must(
    await s.tasks.createTask(
      contractInput({
        parent: prWake,
        cwd: s.ledger.getTask(prWake)?.contract.cwd,
        executor: 'claude-sdk',
      }),
      { actor: 'user' },
    ),
  ).task
  expect(t.mandate?.pr_sourced).toBe(true)
})
