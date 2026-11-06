import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ENDPOINTS,
  fail,
  ok,
  type Result,
  sanitizeText,
  type TaskView,
  type WorkerReport,
  workerReportData,
  workerReportRequest,
} from '@raindown/core'
import { Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import type { LedgerStore } from '../ledger/store.ts'

const execFileAsync = promisify(execFile)
const githubPr =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/

/** 默认只核对 GitHub PR；不将不能核实的地址当成交付物存在。 */
export async function verifyReportDeliverable(ref: string): Promise<Result<null>> {
  if (!githubPr.test(ref))
    return fail('failure', 'deliverable_not_found', '交付物必须是可核实的 GitHub PR 地址')
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', ref, '--json', 'url'], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })
    const pr: unknown = JSON.parse(stdout)
    if (
      typeof pr !== 'object' ||
      pr === null ||
      !('url' in pr) ||
      pr.url !== ref.replace(/\/$/, '')
    )
      return fail('failure', 'deliverable_not_found', '交付物查询未返回指定 PR')
    return ok(null)
  } catch (error) {
    const stderr =
      error !== null &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string'
        ? error.stderr
        : ''
    const message = error instanceof Error ? error.message : String(error)
    return fail('failure', 'deliverable_check_failed', '无法核实交付物', {
      reason: sanitizeText(stderr.trim() || message, 2000),
    })
  }
}

export interface WorkerReportRoutesDeps {
  ledger: LedgerStore
  verifyDeliverable?: (ref: string, task: TaskView) => Promise<Result<null>>
  now?: () => number
}

/** 这里只记录 worker 的事实；状态转换由节点消费上报后通过续约/完成协议提交。 */
export function createWorkerReportRoutes({
  ledger,
  verifyDeliverable = verifyReportDeliverable,
  now = Date.now,
}: WorkerReportRoutesDeps): Hono {
  const app = new Hono()
  app.post(ENDPOINTS['tasks-report'].path, async (c) => {
    const auth = c.get('auth')
    if (auth?.kind !== 'task' || auth.task.task_id !== c.req.param('id'))
      return respond(
        c,
        fail('failure', 'forbidden', '只能由当前派工令牌为本任务上报'),
        workerReportData,
      )
    const caller = auth.task
    const current = () => {
      const task = ledger.getTask(caller.task_id)
      const lease = ledger.getLease(caller.lease_id)
      return task?.status === 'running' &&
        task.attempt === caller.attempt &&
        task.workspace === caller.workspace &&
        lease?.state === 'active' &&
        lease.task_id === caller.task_id &&
        lease.attempt === caller.attempt &&
        Date.parse(lease.expires_at) > now() &&
        ledger.activeLease(caller.task_id)?.lease_id === caller.lease_id &&
        !ledger
          .taskEvents(caller.task_id)
          .some(
            (event) =>
              event.type === 'task.attempt_ended' && event.payload.attempt === caller.attempt,
          )
        ? task
        : null
    }
    const task = current()
    if (!task)
      return respond(
        c,
        fail('failure', 'not_running', '任务当前没有运行中的有效派工'),
        workerReportData,
      )
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, workerReportData)
    const parsed = workerReportRequest.safeParse(body.data)
    if (!parsed.success)
      return respond(
        c,
        fail(
          'usage',
          'invalid_arguments',
          '上报字段不合法',
          parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        ),
        workerReportData,
      )
    const report: WorkerReport = parsed.data
    if (report.status === 'ready') {
      for (const ref of report.deliverables ?? []) {
        const checked = await verifyDeliverable(ref, task)
        if (!checked.ok) return respond(c, checked, workerReportData)
      }
    }
    // 外部核对期间派工可能结束，写入前重新核对；后续同步写入不会与其他请求交错。
    if (!current())
      return respond(c, fail('failure', 'not_running', '核对交付物时派工已结束'), workerReportData)
    const written = ledger.append(
      {
        task_id: task.id,
        workspace: task.workspace,
        type: 'task.reported',
        payload: { ...report, attempt: caller.attempt, lease_id: caller.lease_id },
      },
      { actor: caller.actor },
    )
    return respond(
      c,
      written.ok ? ok({ seq: written.data.seq, attempt: caller.attempt }) : written,
      workerReportData,
    )
  })
  return app
}
