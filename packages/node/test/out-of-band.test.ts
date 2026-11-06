import { afterEach, expect, test } from 'bun:test'
import { NO_ADAPTER_CAPABILITIES, ok, type Result } from '@raindown/core'
import {
  ActivityQueue,
  type ExecutorOutcome,
  type ExecutorPlugin,
  idleSignal,
  resumedSignal,
} from '../src/executor.ts'
import { type Bench, bench } from './harness.ts'

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

test('带外信号经节点续约上报，临时失败重试且中枢只记一次', async () => {
  const activity = new ActivityQueue()
  let finish: (result: Result<ExecutorOutcome>) => void = () => {}
  const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
    finish = resolve
  })
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => ({ reason: 'awaiting_approval', message: '等待授权：gh pr create' }),
    run: () => ({
      activity,
      done,
      async cancel() {
        activity.close()
        finish(ok({ outcome: 'cancelled' }))
      },
    }),
  }
  let failures = 0
  const b = await bench({ executors: [executor] }, 60, (url, init) => {
    if (
      url.endsWith('/renew') &&
      String(init?.body).includes('"out_of_band"') &&
      failures++ === 0
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
        }),
        { status: 503 },
      )
    }
    return undefined
  })
  current = b
  const id = await b.create({ executor: 'probe' })
  activity.push(idleSignal(new Date(b.clock.now()).toISOString(), '等待授权'))
  await b.until(id, (task) => task.status === 'blocked')
  activity.push({
    ts: new Date(b.clock.now()).toISOString(),
    kind: 'status',
    data: {
      out_of_band: { id: 'outside-1', kind: 'approval_outside_raindown', command: 'gh pr create' },
    },
  })
  activity.push(resumedSignal(new Date(b.clock.now()).toISOString(), '外部批准后继续'))
  await b.until(id, (task) => task.status === 'running')
  await b.clock.advance(60_000)
  expect(failures).toBeGreaterThanOrEqual(2)
  expect(b.events(id).filter((event) => event.type === 'task.out_of_band')).toMatchObject([
    { payload: { id: 'outside-1', kind: 'approval_outside_raindown', command: 'gh pr create' } },
  ])
  expect(b.types(id).filter((type) => type === 'task.unblocked')).toHaveLength(1)
})
