import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  type EventOf,
  fail,
  ok,
  parseRemoteUrl,
  prRepoOf,
  prUrl,
  type Result,
  samePrUrl,
  sameRepo,
  taskKind,
} from '@raindown/core'
import { z } from 'zod'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { RoleLookup, WorkspaceLookup } from '../ledger/tasks.ts'
import { type HubClock, systemClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import { recordedTaskPrs } from './recovery.ts'

const existingPr = z.object({
  url: prUrl,
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefName: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
})
export type ExistingPr = z.infer<typeof existingPr>
export type ExistingPrLookup = (repo: string, branch: string) => Promise<Result<ExistingPr[]>>

/** 在登记仓库查询，工作目录或 worktree 消失不影响查询；失败保留原 blocked。 */
export const queryExistingPrs: ExistingPrLookup = (repo, branch) =>
  new Promise((done) => {
    // gh 的仓库选择必须来自 cwd，不继承可改写目标仓库的环境变量。
    const env = { ...process.env }
    delete env.GH_REPO
    delete env.GH_HOST
    execFile(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '100',
        '--json',
        'url,state,headRefName,createdAt,isCrossRepository,isDraft',
      ],
      { cwd: repo, env, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          done(fail('retryable', 'existing_pr_query_failed', '无法查询任务分支的 PR'))
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(stdout)
        } catch {
          done(fail('failure', 'existing_pr_query_failed', 'PR 查询返回了无效 JSON'))
          return
        }
        const parsed = z.array(existingPr).safeParse(raw)
        done(
          parsed.success
            ? ok(parsed.data)
            : fail('failure', 'existing_pr_query_failed', 'PR 查询结果不合法'),
        )
      },
    )
  })

export interface ExistingPrReactorOptions {
  ledger: LedgerStore
  roles: RoleLookup
  workspaces: WorkspaceLookup
  query?: ExistingPrLookup
  logger?: Pick<HubLogger, 'warn'>
  clock?: HubClock
  /** 测试的家目录展开注入点。 */
  homedir?: () => string
}

/** D6：只对写类开发任务根据分支上的已有交付物结束任务，审查和合并仍走原资格检查。 */
export function createExistingPrReactor(o: ExistingPrReactorOptions) {
  const { ledger } = o
  let stopped = false
  let unsubscribe: (() => void) | undefined
  const clock = o.clock ?? systemClock
  type Job = { event: EventOf<'task.blocked'>; attempts: number; cancelRetry?: () => void }
  const pending = new Map<number, Job>()
  const queue: Job[] = []
  const active = new Set<Promise<void>>()
  const idleWaiters = new Set<() => void>()
  let pumpScheduled = false
  const notifyIdle = () => {
    if (pending.size || active.size) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }
  const latestBlocked = (id: string) =>
    ledger.taskEvents(id).findLast((e) => e.type === 'task.blocked')
  const current = (event: EventOf<'task.blocked'>) => {
    const task = ledger.getTask(event.task_id ?? '')
    return task?.status === 'blocked' &&
      !task.cancel_requested &&
      latestBlocked(task.id)?.seq === event.seq
      ? task
      : null
  }
  const expand = (path: string) =>
    path === '~'
      ? (o.homedir ?? homedir)()
      : path.startsWith('~/')
        ? join((o.homedir ?? homedir)(), path.slice(2))
        : path

  async function complete(event: EventOf<'task.blocked'>): Promise<boolean | undefined> {
    const task = current(event)
    if (
      !task?.branch ||
      ledger.wakeOf(task.id) ||
      task.contract.inputs?.review ||
      task.contract.inputs?.merge
    )
      return
    const role = await o.roles(task.contract.role)
    if (
      stopped ||
      !role.ok ||
      !role.data ||
      taskKind(role.data, task.contract, { actor: task.created_by }) !== 'write'
    )
      return
    const ws = await o.workspaces(task.workspace)
    if (
      stopped ||
      !current(event) ||
      !ws ||
      ws.supervisor.reviewer_roles.includes(task.contract.role)
    )
      return
    // 使用合同里的登记仓库路径而非上报的 worktree；路径已在建任务时校验。
    // 此时目录可能已丢失，因此只进行词法定位，查询本身会核对仓库可用性。
    const candidate =
      typeof task.contract.inputs?.repo === 'string' ? task.contract.inputs.repo : task.contract.cwd
    const repos =
      candidate === undefined
        ? ws.repos
        : ws.repos.filter((repo) => {
            const path = expand(candidate)
            const root = expand(repo)
            if (!isAbsolute(path) || !isAbsolute(root)) return false
            const rel = relative(resolve(root), resolve(path))
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
          })
    if (repos.length !== 1) return
    const found = await (o.query ?? queryExistingPrs)(expand(repos[0] as string), task.branch)
    if (stopped || !current(event)) return
    if (!found.ok) return found.error.kind === 'retryable'
    const events = ledger.taskEvents(task.id)
    const start = events.find((e) => e.type === 'task.started')
    if (!start) return
    const known = recordedTaskPrs(ledger, task.id)
    const snapshot = task.repo_snapshot ? parseRemoteUrl(task.repo_snapshot.remote_url) : undefined
    const prs = found.data.filter((pr) => {
      const repo = prRepoOf(pr.url)
      return (
        (pr.state === 'MERGED' || (pr.state === 'OPEN' && !pr.isDraft)) &&
        !pr.isCrossRepository &&
        pr.headRefName === task.branch &&
        (Date.parse(pr.createdAt) > Date.parse(start.ts) ||
          known.some((url) => samePrUrl(url, pr.url))) &&
        (!snapshot || (repo !== undefined && sameRepo(snapshot, repo)))
      )
    })
    if (!prs.length) return
    const fresh = current(event)
    if (!fresh || fresh.attempt !== task.attempt || fresh.branch !== task.branch) return
    const started = events.findLast((e) => e.type === 'task.started')
    if (started?.type !== 'task.started') return
    const urls = [...new Set(prs.map((pr) => pr.url))]
    const summary = `任务因 ${event.payload.reason} 受阻；登记仓库中分支 ${task.branch} 的已有 PR（非草稿 OPEN 或 MERGED，首次派工 ${start.ts}，PR 创建于此后或已由本任务记录）证明交付物已存在：${prs.map((pr) => `${pr.url}（${pr.state}，创建于 ${pr.createdAt}${known.some((url) => samePrUrl(url, pr.url)) ? '，本任务已有记录' : ''}）`).join('、')}。审查与合并资格仍须另行核对。`
    const ended = events.some(
      (e) => e.type === 'task.attempt_ended' && e.payload.attempt === task.attempt,
    )
    const drafts: EventInput[] = ended
      ? []
      : [
          {
            type: 'task.attempt_ended',
            task_id: task.id,
            workspace: task.workspace,
            payload: { attempt: task.attempt, reason: 'done' },
          },
        ]
    drafts.push({
      type: 'task.done',
      task_id: task.id,
      workspace: task.workspace,
      payload: {
        result: {
          completed_via: 'existing_pr',
          prs: urls,
          summary,
          executor: task.contract.executor,
          node_id: started.payload.node_id,
          artifacts: urls.map((ref) => ({ kind: 'pr', ref })),
        },
      },
    })
    const result = ledger.appendMany(drafts, { actor: 'hub' })
    if (!result.ok)
      o.logger?.warn('已有 PR 完成判定写入失败', { task_id: task.id, error: result.error })
  }

  function pump() {
    pumpScheduled = false
    while (!stopped && active.size < 2 && queue.length) {
      const job = queue.shift() as Job
      if (!current(job.event)) {
        pending.delete(job.event.seq)
        continue
      }
      job.attempts++
      const work = complete(job.event)
        .then((retryable) => {
          if (retryable && !stopped && current(job.event) && job.attempts < 3) {
            // 延迟不占查询槽；同一 blocked 事件最多查询三次。
            job.cancelRetry = clock.setTimeout(() => {
              delete job.cancelRetry
              if (stopped) return
              queue.push(job)
              schedulePump()
            }, 1_000)
          } else {
            pending.delete(job.event.seq)
          }
        })
        .catch((error: unknown) => {
          pending.delete(job.event.seq)
          o.logger?.warn('已有 PR 完成判定失败，保留卡住状态', {
            task_id: job.event.task_id,
            error: String(error),
          })
        })
        .finally(() => {
          active.delete(work)
          pump()
          notifyIdle()
        })
      active.add(work)
    }
    notifyIdle()
  }

  function schedulePump() {
    if (pumpScheduled || stopped) return
    pumpScheduled = true
    // 订阅回调不写账，保持其他账本订阅者接收 seq 的顺序。
    void Promise.resolve().then(pump)
  }

  function enqueue(event: EventOf<'task.blocked'>) {
    if (
      stopped ||
      pending.has(event.seq) ||
      !['workdir_missing', 'crashed'].includes(event.payload.reason)
    )
      return
    const job = { event, attempts: 0 }
    pending.set(event.seq, job)
    queue.push(job)
    schedulePump()
  }

  return {
    start() {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe((event) => {
        if (event.type === 'task.blocked') enqueue(event)
      })
      for (const task of ledger.listTasks({ status: 'blocked', limit: 100_000 })) {
        const event = latestBlocked(task.id)
        if (event?.type === 'task.blocked' && Date.parse(event.ts) >= clock.now() - 7 * 86_400_000)
          enqueue(event)
      }
    },
    async idle() {
      if (pending.size || active.size)
        await new Promise<void>((resolve) => idleWaiters.add(resolve))
    },
    async stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      for (const job of pending.values()) job.cancelRetry?.()
      pending.clear()
      queue.length = 0
      await Promise.all(active)
      notifyIdle()
    },
  }
}
