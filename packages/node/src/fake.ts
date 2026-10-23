import { fakeInputs, ok, type Result, type TaskContract, type TaskResult } from '@flow/core'
import { type NodeClock, systemClock } from './clock.ts'
import {
  ActivityQueue,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
} from './executor.ts'

/**
 * fake 执行器（design D11；node-protocol "执行器插件接口"）。
 *
 * 按合同的 `inputs.fake` 模拟：在 `delay_ms` 内均匀上报 `activity` 中的输出片段，
 * 然后以 `outcome`（done / failed / blocked）结束。只使用定时器，**不执行任何外部命令**，
 * 可以安全地在 CI 的端到端测试中运行。
 */

export interface FakeExecutorOptions {
  clock?: NodeClock
}

export function createFakeExecutor(options: FakeExecutorOptions = {}): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  return {
    type: 'fake',
    mode: 'headless',
    run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun {
      const queue = new ActivityQueue()
      const cancels: Array<() => void> = []
      let settle: (r: Result<ExecutorOutcome>) => void = () => {}
      const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
        settle = resolve
      })
      let finished = false
      const finish = (r: Result<ExecutorOutcome>) => {
        if (finished) return
        finished = true
        for (const c of cancels) c()
        ctx.signal.removeEventListener('abort', onAbort)
        queue.close()
        settle(r)
      }
      const onAbort = () => finish(ok({ outcome: 'cancelled', message: 'fake 执行器已取消' }))

      const parsed = fakeInputs.safeParse(contract.inputs?.fake ?? {})
      if (!parsed.success) {
        finish({
          ok: false,
          error: {
            kind: 'failure',
            code: 'invalid_fake_inputs',
            message: `inputs.fake 不合法：${parsed.error.message}`,
          },
        })
        return { activity: queue, done, cancel: async () => {} }
      }
      const spec = parsed.data
      const result = (summary: string): TaskResult => ({
        summary,
        artifacts: [],
        verify: [],
        executor: 'fake',
        node_id: ctx.nodeId,
      })
      const outcome = (): ExecutorOutcome => {
        switch (spec.outcome) {
          case 'done':
            return { outcome: 'done', result: result(spec.message ?? 'fake 执行完成') }
          case 'failed':
            return { outcome: 'failed', result: result(spec.message ?? 'fake 模拟失败') }
          case 'blocked':
            return {
              outcome: 'blocked',
              reason: spec.blocked_reason ?? 'other',
              message: spec.message ?? 'fake 模拟卡住',
              ...(spec.activity.length > 0 ? { tail: spec.activity.slice(-200) } : {}),
            }
        }
      }

      if (ctx.signal.aborted) onAbort()
      else {
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        const step = spec.delay_ms / (spec.activity.length + 1)
        spec.activity.forEach((text, i) => {
          cancels.push(
            clock.setTimeout(
              () => queue.push({ ts: new Date(clock.now()).toISOString(), kind: 'output', text }),
              step * (i + 1),
            ),
          )
        })
        cancels.push(clock.setTimeout(() => finish(ok(outcome())), spec.delay_ms))
      }

      return {
        activity: queue,
        done,
        cancel: async () => {
          onAbort()
        },
      }
    },
  }
}
