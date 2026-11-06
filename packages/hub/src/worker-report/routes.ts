import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ENDPOINTS,
  fail,
  ok,
  parseRemoteUrl,
  prRepoOf,
  type Result,
  samePrUrl,
  sameRepo,
  type TaskView,
  type WorkerReport,
  workerReportData,
  workerReportRequest,
} from '@raindown/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { respond } from '../ledger/routes.ts'
import type { LedgerStore } from '../ledger/store.ts'

const execFileAsync = promisify(execFile)
const githubPr =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/

const checkedPr = z.object({
  url: z.string().url(),
  headRefName: z.string().min(1),
  headRepository: z.object({ nameWithOwner: z.string().min(1) }),
  isCrossRepository: z.boolean(),
})
type RunGh = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>

/** 只查询任务仓库的 PR，所有核对失败都隐藏 gh 的诊断与仓库信息。 */
export async function verifyReportDeliverable(
  ref: string,
  task: Pick<TaskView, 'branch' | 'repo_snapshot'>,
  run: RunGh = execFileAsync,
): Promise<Result<null>> {
  const rejected = () => fail('failure', 'deliverable_check_failed', '无法核实本任务的交付物')
  const repo = task.repo_snapshot ? parseRemoteUrl(task.repo_snapshot.remote_url) : undefined
  const requested = githubPr.test(ref) ? prRepoOf(ref.replace(/\/$/, '')) : undefined
  if (!task.branch || !repo || !requested || !sameRepo(repo, requested)) return rejected()
  try {
    const { stdout } = await run(
      'gh',
      ['pr', 'view', ref, '--json', 'url,headRefName,headRepository,isCrossRepository'],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    )
    const parsed = checkedPr.safeParse(JSON.parse(stdout))
    if (!parsed.success) return rejected()
    const pr = parsed.data
    const head = parseRemoteUrl(`https://github.com/${pr.headRepository.nameWithOwner}`)
    if (
      !samePrUrl(pr.url, ref.replace(/\/$/, '')) ||
      pr.isCrossRepository ||
      pr.headRefName !== task.branch ||
      !head ||
      !sameRepo(repo, head)
    )
      return rejected()
    return ok(null)
  } catch {
    return rejected()
  }
}

const REPORT_BODY_MAX = 32 * 1024
const REPORT_WINDOW_MS = 60_000
const REPORT_WINDOW_MAX = 10
const REPORT_ATTEMPT_MAX = 200

/** 不依赖 Content-Length；逐块限制实际字节数，在 JSON 解析前限制内存。 */
async function reportBody(c: Context): Promise<Result<unknown>> {
  const invalid = () => fail('usage', 'invalid_arguments', '上报请求体不合法或超过 32 KiB')
  const length = c.req.header('content-length')
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > REPORT_BODY_MAX))
    return invalid()
  const reader = c.req.raw.body?.getReader()
  if (!reader) return invalid()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > REPORT_BODY_MAX) {
        await reader.cancel()
        return invalid()
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return ok(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    return invalid()
  } finally {
    reader.releaseLock()
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
  const inFlight = new Set<string>()
  // 成功报告从账本恢复限额；失败请求也消耗额度，但这部分只保留到中枢重启。
  const failures = new Map<string, { total: number; times: number[] }>()
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
        ledger.activeLease(caller.task_id)?.lease_id === caller.lease_id &&
        !ledger.attemptEnded(caller.task_id, caller.attempt)
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
    // 清理已经结束的租约；无需读取该任务的事件历史。
    for (const leaseId of failures.keys()) {
      if (ledger.getLease(leaseId)?.state !== 'active') failures.delete(leaseId)
    }
    if (inFlight.has(caller.lease_id))
      return respond(
        c,
        fail('retryable', 'report_busy', '当前派工正在处理上报，请稍后重试'),
        workerReportData,
      )
    const admittedAt = now()
    const since = admittedAt - REPORT_WINDOW_MS
    const failed = failures.get(caller.lease_id) ?? { total: 0, times: [] }
    failed.times = failed.times.filter((time) => time >= since)
    const usage = ledger.workerReportUsage(
      caller.task_id,
      caller.lease_id,
      caller.attempt,
      new Date(since).toISOString(),
    )
    if (
      usage.total + failed.total >= REPORT_ATTEMPT_MAX ||
      usage.recent + failed.times.length >= REPORT_WINDOW_MAX
    )
      return respond(
        c,
        fail('retryable', 'report_rate_limited', '当前派工上报已达限额'),
        workerReportData,
      )
    failures.set(caller.lease_id, failed)
    failed.total++
    failed.times.push(admittedAt)
    inFlight.add(caller.lease_id)
    try {
      const body = await reportBody(c)
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
        if (!task.branch)
          return respond(
            c,
            fail(
              'failure',
              'branch_unknown',
              '尚未登记本任务分支；请先上报 blocked，说明缺少的分支信息与已尝试的办法',
            ),
            workerReportData,
          )
        for (const ref of report.deliverables ?? []) {
          const checked = await verifyDeliverable(ref, task)
          if (!checked.ok) return respond(c, checked, workerReportData)
        }
      }
      // 外部核对期间派工可能结束，写入前重新核对；后续同步写入不会与其他请求交错。
      if (!current())
        return respond(
          c,
          fail('failure', 'not_running', '核对交付物时派工已结束'),
          workerReportData,
        )
      const written = ledger.append(
        {
          task_id: task.id,
          workspace: task.workspace,
          type: 'task.reported',
          payload: { ...report, attempt: caller.attempt, lease_id: caller.lease_id },
        },
        { actor: caller.actor },
      )
      if (written.ok) {
        failed.total--
        failed.times.splice(failed.times.indexOf(admittedAt), 1)
      }
      return respond(
        c,
        written.ok ? ok({ seq: written.data.seq, attempt: caller.attempt }) : written,
        workerReportData,
      )
    } finally {
      inFlight.delete(caller.lease_id)
    }
  })
  return app
}
