import {
  type LedgerEvent,
  normalizePrUrl,
  type PrSubscriptionRole,
  prUrl,
  type TaskView,
} from '@raindown/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { WorkspaceLookup } from '../ledger/tasks.ts'
import type { HubLogger } from '../server/maintenance.ts'

/**
 * PR 自动订阅（harness-neutral D11；tasks 8.1）。只在 workspace `github.watch: true` 时生效，
 * 缺省时不写任何事件，行为与之前完全相同。
 *
 * - 审查任务（合同带 `inputs.review.pr`）创建后订阅它审查的 PR（reviewer）；
 * - 开发任务上报任务分支（`task.branch_reported`）后，账本记录到它的 PR（`task.reported` 的交付物、
 *   结果里的 PR 产物或已有 PR 判定）时订阅（author）。PR 确实由任务分支开出、不是 fork，由 pr-watcher
 *   在首次轮询时用 GitHub 的 head 信息核对，不符即取消订阅（not_task_branch）；
 * - 同一任务对同一 PR 只自动订阅一次：用户取消后不会被重新订阅；唤醒任务不订阅。
 */

export interface PrSubscriptionReactorOptions {
  ledger: LedgerStore
  workspaces: WorkspaceLookup
  logger?: Pick<HubLogger, 'warn'>
}

/** 一条事件给出的 (PR, 关系) 候选；不涉及 PR 时为空。 */
export function subscriptionCandidates(
  event: LedgerEvent,
  task: TaskView,
): { pr: string; role: PrSubscriptionRole }[] {
  const urls: string[] = []
  let role: PrSubscriptionRole = 'author'
  if (event.type === 'task.created') {
    const review = event.payload.contract.inputs?.review?.pr
    if (review) {
      urls.push(review)
      role = 'reviewer'
    }
  } else if (task.branch) {
    if (event.type === 'task.reported' && event.payload.status === 'ready') {
      urls.push(...(event.payload.deliverables ?? []))
    } else if (
      event.type === 'task.done' ||
      event.type === 'task.failed' ||
      event.type === 'task.cancelled'
    ) {
      const result = event.payload.result
      urls.push(
        ...(result?.artifacts ?? []).filter((a) => a.kind === 'pr').map((a) => a.ref),
        ...(result?.prs ?? []),
      )
    }
  }
  const out: { pr: string; role: PrSubscriptionRole }[] = []
  for (const url of urls) {
    if (!prUrl.safeParse(url).success) continue
    const pr = normalizePrUrl(url)
    if (pr && !out.some((c) => c.pr === pr)) out.push({ pr, role })
  }
  return out
}

export function createPrSubscriptionReactor(o: PrSubscriptionReactorOptions) {
  const { ledger } = o
  let unsubscribe: (() => void) | undefined
  let chain: Promise<void> = Promise.resolve()
  let stopped = false

  /** 任务在 `upto` 之前（含）的账本里给出的全部候选。 */
  const candidatesUpTo = (task: TaskView, upto: number) =>
    ledger
      .taskEvents(task.id)
      .filter((e) => e.seq <= upto)
      .flatMap((e) => subscriptionCandidates(e, task))

  async function handle(event: LedgerEvent) {
    if (!event.task_id || !event.workspace) return
    const task = ledger.getTask(event.task_id)
    if (!task || ledger.wakeOf(task.id)) return
    // 分支在 PR 之后才上报时，补上此前账本已记录的 PR。
    const candidates =
      event.type === 'task.branch_reported'
        ? candidatesUpTo(task, event.seq)
        : subscriptionCandidates(event, task)
    await subscribe(task, candidates)
  }

  async function subscribe(task: TaskView, candidates: { pr: string; role: PrSubscriptionRole }[]) {
    if (!candidates.length) return
    const ws = await o.workspaces(task.workspace)
    if (stopped || !ws?.github?.watch) return
    for (const c of candidates) {
      // 订阅过（含用户已取消的）就不再自动订阅。
      if (ledger.prSubscriptions(task.id).some((s) => s.pr === c.pr)) continue
      const r = ledger.append(
        {
          type: 'pr.subscribed',
          task_id: task.id,
          workspace: task.workspace,
          payload: { pr: c.pr, role: c.role },
        },
        { actor: 'hub' },
      )
      if (!r.ok && r.error.code !== 'duplicate_subscription') {
        o.logger?.warn('PR 订阅写入失败', { task_id: task.id, pr: c.pr, error: r.error })
      }
    }
  }

  function enqueue(event: LedgerEvent) {
    if (stopped) return
    // 订阅回调里不写账（保持其他订阅者收到 seq 的顺序），排到微任务之后依次处理。
    chain = chain
      .then(() => handle(event))
      .catch((error: unknown) => o.logger?.warn('PR 自动订阅失败', String(error)))
  }

  const RELEVANT = new Set([
    'task.created',
    'task.reported',
    'task.done',
    'task.failed',
    'task.cancelled',
    'task.branch_reported',
  ])

  return {
    /** 开始监听；同时补订近 14 天内有变化的任务（例如刚打开 github.watch）。 */
    start(now = Date.now()) {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe((event) => {
        if (RELEVANT.has(event.type)) enqueue(event)
      })
      const since = new Date(now - 14 * 86_400_000).toISOString()
      for (const task of ledger.listTasks({ limit: 100_000 })) {
        if (task.updated_at < since || ledger.wakeOf(task.id)) continue
        chain = chain
          .then(() =>
            stopped ? undefined : subscribe(task, candidatesUpTo(task, Number.MAX_SAFE_INTEGER)),
          )
          .catch((error: unknown) => o.logger?.warn('PR 自动订阅失败', String(error)))
      }
    },
    async idle() {
      await chain
    },
    async stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      await chain
    },
  }
}
