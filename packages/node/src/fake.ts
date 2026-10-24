import {
  BLOCKED_REASONS,
  type BlockedReason,
  type DeliveredReply,
  type FakeResumeInputs,
  type FakeStep,
  fakeInputs,
  fakeResumeInputs,
  ok,
  type Result,
  type TaskContract,
  type TaskResult,
} from '@flow/core'
import { type NodeClock, systemClock } from './clock.ts'
import {
  ActivityQueue,
  type DeliverResult,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
  idleSignal,
  resumedSignal,
  type StuckSnapshot,
  type StuckVerdict,
} from './executor.ts'

/**
 * fake 执行器（add-m1-ledger-daemon D11；add-m1-executors 1.2 / 1.3 的扩展指令）。
 *
 * 按合同的 `inputs.fake` 模拟：先依次执行 `script`（输出、等待、停下、等回复、自行恢复、意外退出、挂起），
 * 再在 `delay_ms` 内均匀上报 `activity` 中的输出片段，最后以 `outcome`（done / failed / blocked）结束。
 * 带着回复重新排队后的那一次执行（`ctx.resume`）改按 `inputs.fake.resume`，缺省为 done，摘要带上会话 id 与回复。
 *
 * 只使用定时器，**不执行任何外部命令**，可以安全地在 CI 的端到端测试中运行。
 */

export interface FakeExecutorOptions {
  clock?: NodeClock
}

/** 授权请求的特征（模拟执行器自带的识别规则）。 */
const APPROVAL_RE = /(allow|approve|permission|允许|批准|授权).*(\?|？|\[y\/n\])\s*$/i
const QUESTION_RE = /[?？]\s*$/

/**
 * fake 执行器的卡住识别规则：
 * 1. idle 信号的 hint 里给了合法的 `reason`：照用（`message` 作为说明）；
 * 2. 末尾一行像授权请求：awaiting_approval，说明中带上这一行（含命令）；
 * 3. 末尾一行以问号结尾：question；
 * 4. 其他：无法识别（返回 null）。
 */
export function classifyFake(snapshot: StuckSnapshot): StuckVerdict | null {
  const hinted = snapshot.hint?.reason
  if (typeof hinted === 'string' && (BLOCKED_REASONS as readonly string[]).includes(hinted)) {
    const message = snapshot.hint?.message
    return {
      reason: hinted as BlockedReason,
      message: typeof message === 'string' && message ? message : `fake 判定为 ${hinted}`,
    }
  }
  const last = [...snapshot.tail].reverse().find((l) => l.trim() !== '')
  if (last === undefined) return null
  if (APPROVAL_RE.test(last))
    return { reason: 'awaiting_approval', message: `等待授权：${last.trim()}` }
  if (QUESTION_RE.test(last)) return { reason: 'question', message: last.trim() }
  return null
}

export function createFakeExecutor(options: FakeExecutorOptions = {}): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  return {
    type: 'fake',
    mode: 'headless',
    classify: classifyFake,
    run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun {
      const queue = new ActivityQueue()
      const cancels: Array<() => void> = []
      let settle: (r: Result<ExecutorOutcome>) => void = () => {}
      const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
        settle = resolve
      })
      let finished = false
      /** 正在执行 `hang(ignore_cancel)`：取消也不结束（测试超时后的强制结束）。 */
      let ignoringCancel = false
      const replies: DeliveredReply[] = []
      let replyWaiter: (() => void) | undefined
      let wake: (() => void) | undefined

      const finish = (r: Result<ExecutorOutcome>) => {
        if (finished) return
        finished = true
        for (const c of cancels) c()
        ctx.signal.removeEventListener('abort', onAbort)
        queue.close()
        wake?.()
        replyWaiter?.()
        settle(r)
      }
      const onAbort = () => {
        if (ignoringCancel) return
        finish(ok({ outcome: 'cancelled', message: 'fake 执行器已取消' }))
      }
      const iso = () => new Date(clock.now()).toISOString()
      const output = (text: string) => queue.push({ ts: iso(), kind: 'output', text })
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          wake = resolve
          cancels.push(clock.setTimeout(resolve, ms))
        })

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
      const resume = ctx.resume
      const spec: FakeResumeInputs = resume
        ? (parsed.data.resume ?? fakeResumeInputs.parse({}))
        : parsed.data
      let deliverFailures = spec.deliver_failures ?? 0
      const resumedSummary = resume
        ? `已恢复（会话 ${resume.session ?? '无'}）：${resume.reply.kind}${resume.reply.text ? ` ${resume.reply.text}` : ''}`
        : undefined
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
            return {
              outcome: 'done',
              result: result(spec.message ?? resumedSummary ?? 'fake 执行完成'),
            }
          case 'failed':
            return { outcome: 'failed', result: result(spec.message ?? 'fake 模拟失败') }
          case 'blocked':
            return {
              outcome: 'blocked',
              reason: spec.blocked_reason ?? 'other',
              message: spec.message ?? 'fake 模拟卡住',
              ...(spec.activity.length > 0 ? { tail: spec.activity.slice(-200) } : {}),
              ...(spec.session ? { session: spec.session } : {}),
            }
        }
      }

      /** 执行一步；返回 false 表示执行已结束（exit 或被取消）。 */
      const step = async (s: FakeStep): Promise<boolean> => {
        switch (s.do) {
          case 'output':
            output(s.text)
            break
          case 'wait':
            await wait(s.ms)
            break
          case 'idle':
            queue.push(
              idleSignal(
                iso(),
                typeof s.hint?.message === 'string' ? s.hint.message : 'fake：worker 已停下',
                s.hint,
              ),
            )
            break
          case 'await_reply': {
            while (replies.length === 0 && !finished) {
              await new Promise<void>((resolve) => {
                replyWaiter = resolve
              })
            }
            const r = replies.shift()
            if (r) output(`收到回复（${r.kind}，${r.by}）${r.text ? `：${r.text}` : ''}`)
            break
          }
          case 'resumed':
            queue.push(resumedSignal(iso(), 'fake：worker 自行恢复'))
            break
          case 'exit':
            finish(
              ok({
                outcome: 'exited',
                exit_code: s.code,
                ...(s.signal ? { signal: s.signal } : {}),
                message: 'fake 模拟进程意外退出',
              }),
            )
            return false
          case 'hang':
            ignoringCancel = s.ignore_cancel
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            break
        }
        return !finished
      }

      const main = async () => {
        for (const s of spec.script ?? []) {
          if (!(await step(s))) return
        }
        const gap = spec.delay_ms / (spec.activity.length + 1)
        for (const text of spec.activity) {
          await wait(gap)
          if (finished) return
          output(text)
        }
        await wait(gap)
        finish(ok(outcome()))
      }

      if (ctx.signal.aborted) onAbort()
      else {
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        void main()
      }

      return {
        activity: queue,
        done,
        cancel: async () => {
          onAbort()
        },
        deliver: async (reply): Promise<DeliverResult> => {
          if (finished) return 'not_running'
          if (deliverFailures > 0) {
            deliverFailures--
            throw new Error('fake：模拟送达失败')
          }
          if (spec.deliver_delay_ms) {
            await new Promise<void>((resolve) => {
              cancels.push(clock.setTimeout(resolve, spec.deliver_delay_ms ?? 0))
            })
            if (finished) return 'not_running'
          }
          replies.push(reply)
          const w = replyWaiter
          replyWaiter = undefined
          w?.()
          return 'delivered'
        },
      }
    },
  }
}
