import { randomBytes } from 'node:crypto'
import {
  clipText,
  type EventOf,
  effectiveRoleKind,
  fail,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxItemView,
  type InboxVia,
  latestTrustedReview,
  loadRoles,
  type MergeRequestData,
  type MergeRequestRequest,
  normalizePrUrl,
  ok,
  type Result,
  type ReviewResult,
  resolveInboxLevel,
  reviewApproves,
  reviewResult,
  type SupervisorConfig,
  samePrUrl,
  type TaskContract,
  type TaskView,
  taskContract,
} from '@flow/core'
import type { EventInput } from '../ledger/store.ts'
import {
  checkRepoInWorkspace,
  HUB_ACTOR,
  isTerminal,
  MERGE_IDEMPOTENCY_PREFIX,
  type RoleForKind,
  taskKind,
} from '../ledger/supervisor-checks.ts'
import type { WorkspaceInfo } from '../ledger/tasks.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'
import type { SupervisorToolsDeps } from './common.ts'

/**
 * supervisor 的合并请求（design D10 第 4 步；pr-acceptance "合并请求的资格""合并请求按开关分流"；tasks 4.8）。
 *
 * 安全关键：**资格的每一项都由中枢从账本与配置确定性核对**，supervisor 只给出 PR 链接与审查任务 id，
 * 其余（workspace、开出 PR 的任务、审查结论、reviewed_sha、仓库）都不取自请求。任何一项拿不准即
 * `merge_not_eligible`（details.reasons 列出原因）：
 * - workspace 存在且启用 supervisor（只核对 supervisor 发起的请求；用户批准时不要求）；
 * - 该 PR 是本 workspace 内某个**已 done**、origin 为 instruction、有效类别恰为 write（按当前角色配置，
 *   角色缺失即不算）、不是唤醒或审查任务的 `kind: pr` 产物（`samePrUrl`）；
 * - `review_task` 存在、同 workspace、角色在 `reviewer_roles`、执行器 claude-sdk、done、`inputs.review.pr`
 *   等于该 PR、`result.review.verdict = approve`（core `reviewApproves`），且是该 PR 最新一次可信审查
 *   （core `latestTrustedReview`）；
 * - 同一 PR 没有未结束的审查任务（任何带 `inputs.review` 指向该 PR 的未结束任务都算，比 pr-merge 更严）；
 * - merger 的工作目录能唯一确定为登记仓库（取开出 PR 的任务的 `inputs.repo` / `cwd` 所在的登记仓库；
 *   都没写时只有恰好登记一个仓库才行）；
 * - 有且只有一个有效类别为 merge、执行器为 pr-merge 的角色。
 *
 * 通过后：`supervisor.auto_merge: true` → 中枢以 hub 建 merger 任务（与 `merge_request.created` 同一事务）；
 * 否则写 `merge_request.created` 与 `source: merge_request` 的 Decide 条目。同一审查任务只能有一个未结束的
 * 合并请求，且最多建一个 merger（幂等键 `merge:<审查任务>`，保留前缀只限 hub）。
 *
 * 用户批准（只有 user，经收件箱）：重新核对资格 → 写 `merge_request.approved`（actor user）→ 以 hub 建
 * merger（同上）→ 条目关闭。重试安全：已写过批准时不重复写，merger 幂等命中时核对它就是本审查的 merger。
 * 用户驳回：写 `merge_request.rejected`（actor user）并关闭条目，唤醒调度器据此唤醒 supervisor（instruction 队列）。
 *
 * 合并审批条目不轮询 PR 状态：批准时 PR 已关闭或已合并，merger 以 `pr_not_open` 结束（pr-merge 执行器核对）。
 */

/** merger 合同的 timeout_s：不小于 pr-merge 执行器要求的 2400 秒（合并前核对加 30 分钟流水线等待）。 */
export const MERGER_TIMEOUT_S = 3600
/** pr-merge 执行器接受的 timeout_s 下限（与 `packages/node` 的 `MIN_MERGER_TIMEOUT_S` 一致）。 */
export const MIN_MERGER_TIMEOUT_S = 2400
export const MERGE_EXECUTOR = 'pr-merge'

export const mergeRequestItemId = (requestId: string) => `mr.${requestId.slice(3)}`
const newRequestId = () => `mr-${randomBytes(6).toString('hex')}`
export const mergeKey = (reviewTask: string) => `${MERGE_IDEMPOTENCY_PREFIX}${reviewTask}`

const notEligible = (reasons: string[], details: Record<string, unknown> = {}) =>
  fail('failure', 'merge_not_eligible', `不满足合并资格：${reasons.join('；')}`, {
    reasons,
    ...details,
  })

/** 资格核对通过后，建 merger 与条目需要的全部事实（均取自账本与配置）。 */
export interface MergeEligibility {
  workspace: WorkspaceInfo
  /** 规范化的 PR 链接（`normalizePrUrl`）。 */
  pr: string
  review: TaskView
  verdict: ReviewResult
  reviewed_sha: string
  dev: TaskView
  /** merger 的工作目录：登记仓库（登记时的写法）。 */
  repo: string
}

/** 全部角色（`config/roles/`），供按有效类别查找 merger 角色；缺省按 flow-home 读取。 */
export function mergeRolesFromHome(home: string): () => Promise<Result<RoleForKind[]>> {
  return async () => {
    const loaded = await loadRoles(home)
    return loaded.ok ? ok(loaded.data.roles) : loaded
  }
}

/** 开出该 PR 的任务（D10 第 4 步前半）。多个时取最早创建的；没有时返回原因。 */
async function findDevTask(
  deps: SupervisorToolsDeps,
  candidates: readonly TaskView[],
  pr: string,
): Promise<{ ok: true; task: TaskView } | { ok: false; reasons: string[] }> {
  const reasons: string[] = []
  const hits: TaskView[] = []
  for (const t of candidates) {
    if (!(t.result?.artifacts ?? []).some((a) => a.kind === 'pr' && samePrUrl(a.ref, pr))) continue
    const why = await devTaskProblem(deps, t)
    if (why) reasons.push(`任务 ${t.id}：${why}`)
    else hits.push(t)
  }
  if (hits.length === 0) {
    return {
      ok: false,
      reasons: [
        `PR 不是本 workspace 内 origin 为 instruction 的写类任务的产物${reasons.length ? `（${reasons.join('，')}）` : '（没有任务产出该 PR）'}`,
      ],
    }
  }
  const first = [...hits].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
  )[0] as TaskView
  return { ok: true, task: first }
}

/** 某个产出了该 PR 的任务不能作为"开出 PR 的 dev 任务"的原因；可以时返回 null。 */
async function devTaskProblem(deps: SupervisorToolsDeps, t: TaskView): Promise<string | null> {
  if (t.status !== 'done') return `状态为 ${t.status}，不是 done`
  if (t.origin !== 'instruction') return `origin 为 ${t.origin ?? '空'}，不是 instruction`
  if (deps.ledger.wakeOf(t.id)) return '是唤醒任务'
  if (t.contract.inputs?.review !== undefined) return '是审查任务'
  if (t.contract.inputs?.merge !== undefined) return '是合并任务'
  const found = await deps.roles(t.contract.role)
  if (!found.ok || !found.data) return `角色 ${t.contract.role} 未定义或加载失败，无法确认有效类别`
  const kind = taskKind(found.data, t.contract, { actor: t.created_by })
  if (kind !== 'write') return `有效类别为 ${kind}，不是 write`
  return null
}

/** merger 的工作目录：开出 PR 的任务所在的登记仓库。 */
async function mergerRepo(
  deps: SupervisorToolsDeps,
  ws: WorkspaceInfo,
  dev: TaskView,
): Promise<{ ok: true; repo: string } | { ok: false; reason: string }> {
  const raw = typeof dev.contract.inputs?.repo === 'string' ? dev.contract.inputs.repo : undefined
  const candidate = raw ?? dev.contract.cwd
  if (candidate === undefined) {
    return ws.repos.length === 1
      ? { ok: true, repo: ws.repos[0] as string }
      : {
          ok: false,
          reason: `开出 PR 的任务没有 cwd / inputs.repo，且 ${ws.ref} 没有唯一的登记仓库`,
        }
  }
  const probe = taskContract.parse({
    goal: 'probe',
    workspace: ws.ref,
    role: 'probe',
    executor: MERGE_EXECUTOR,
    cwd: candidate,
  })
  const matched: string[] = []
  for (const r of ws.repos) {
    const inside = await checkRepoInWorkspace(probe, { ref: ws.ref, repos: [r] }, deps.repoCheck)
    if (inside.ok) matched.push(r)
  }
  if (matched.length !== 1) {
    return {
      ok: false,
      reason:
        matched.length === 0
          ? `开出 PR 的任务的工作目录 ${candidate} 不在 ${ws.ref} 登记的仓库内`
          : `开出 PR 的任务的工作目录 ${candidate} 同时位于多个登记仓库内，无法确定`,
    }
  }
  return { ok: true, repo: matched[0] as string }
}

/**
 * 合并资格（D10 第 4 步），全部取自账本与配置。`requireActive`：supervisor 发起请求时要求 workspace 仍启用
 * supervisor；用户批准时不要求（批准本身就是用户的决定）。
 */
export async function checkMergeEligibility(
  deps: SupervisorToolsDeps,
  input: { workspace: string; pr: string; review_task: string },
  opts: { requireActive: boolean },
): Promise<Result<MergeEligibility>> {
  const ws = await deps.workspaces(input.workspace)
  if (!ws) return notEligible([`workspace ${input.workspace} 未定义`])
  if (opts.requireActive && !(ws.supervisor.enabled && (await deps.supervisorActive(ws.ref)))) {
    return notEligible([`${ws.ref} 未启用 supervisor`])
  }
  const pr = normalizePrUrl(input.pr)
  if (!pr) return notEligible([`PR 链接不合法：${input.pr}`])
  const sup: Pick<SupervisorConfig, 'reviewer_roles'> = ws.supervisor
  const reasons: string[] = []

  // ---- 审查任务 ----
  const review = deps.ledger.getTask(input.review_task)
  let verdict: ReviewResult | undefined
  let reviewedSha: string | undefined
  if (!review) {
    reasons.push(`审查任务 ${input.review_task} 不存在`)
  } else {
    const approves = reviewApproves(review, { workspace: ws.ref, pr }, sup)
    if (!approves.ok) reasons.push(`审查任务 ${review.id}：${approves.reason}`)
    else {
      const parsed = reviewResult.safeParse(review.result?.review)
      if (parsed.success) {
        reviewedSha = approves.reviewed_sha
        verdict = parsed.data
      } else reasons.push(`审查任务 ${review.id} 没有合法的 result.review`)
    }
  }

  // ---- 最新一次可信审查、没有未结束的审查 ----
  const related = deps.ledger.prRelatedTasks(ws.ref)
  const pendingReviews = related.filter(
    (t) =>
      !isTerminal(t) &&
      typeof t.contract.inputs?.review?.pr === 'string' &&
      samePrUrl(t.contract.inputs.review.pr, pr),
  )
  if (pendingReviews.length > 0) {
    reasons.push(
      `同一 PR 还有未结束的审查任务 ${pendingReviews.map((t) => `${t.id}（${t.status}）`).join('、')}`,
    )
  }
  if (review && reviewedSha !== undefined) {
    const latest = latestTrustedReview(
      related.some((t) => t.id === review.id) ? related : [...related, review],
      { workspace: ws.ref, pr },
      sup,
    )
    if (latest?.id !== review.id) {
      reasons.push(
        `审查任务 ${review.id} 不是该 PR 最新一次可信审查（最新为 ${latest?.id ?? '无'}）`,
      )
    }
  }

  // ---- 开出 PR 的任务与仓库 ----
  const dev = await findDevTask(deps, related, pr)
  let repo: string | undefined
  if (!dev.ok) reasons.push(...dev.reasons)
  else {
    const r = await mergerRepo(deps, ws, dev.task)
    if (!r.ok) reasons.push(r.reason)
    else repo = r.repo
  }

  if (
    reasons.length > 0 ||
    !review ||
    !verdict ||
    reviewedSha === undefined ||
    !dev.ok ||
    repo === undefined
  ) {
    return notEligible(reasons.length > 0 ? reasons : ['资格核对未完成'], {
      pr,
      review_task: input.review_task,
    })
  }
  return ok({
    workspace: ws,
    pr,
    review,
    verdict,
    reviewed_sha: reviewedSha,
    dev: dev.task,
    repo,
  })
}

/** 唯一的合并类角色（有效类别 merge、执行器 pr-merge）。 */
async function mergeRole(deps: SupervisorToolsDeps): Promise<Result<RoleForKind>> {
  const listed = await (deps.mergeRoles ?? mergeRolesFromHome(deps.home))()
  if (!listed.ok) return notEligible([`无法读取角色配置：${listed.error.message}`])
  const merges = listed.data.filter(
    (r) =>
      r.executor !== undefined &&
      effectiveRoleKind({
        executor: r.executor,
        ...(r.permissions === undefined ? {} : { permissions: r.permissions }),
        ...(r.kind === undefined ? {} : { kind: r.kind }),
      }) === 'merge',
  )
  if (merges.length !== 1) {
    return notEligible([
      merges.length === 0
        ? '没有有效类别为 merge 的角色（运行 flow init 补齐 merger 模板）'
        : `有多个有效类别为 merge 的角色（${merges.map((r) => r.name).join('、')}），无法确定`,
    ])
  }
  const role = merges[0] as RoleForKind
  if (role.executor !== MERGE_EXECUTOR) {
    return notEligible([
      `合并类角色 ${role.name} 的执行器为 ${role.executor}，不是 ${MERGE_EXECUTOR}`,
    ])
  }
  return ok(role)
}

/** merger 任务合同（D10）：parent 为审查任务、inputs.merge、cwd 为登记仓库、timeout_s ≥ 2400。 */
function mergerContract(e: MergeEligibility, role: string): TaskContract {
  return taskContract.parse({
    goal: `合并 PR ${e.pr}：审查任务 ${e.review.id} 的结论为 approve（reviewed_sha ${e.reviewed_sha}）。pr-merge 执行器核对条件后合并，并确认默认分支的发布流水线。`,
    workspace: e.workspace.ref,
    role,
    executor: MERGE_EXECUTOR,
    parent: e.review.id,
    cwd: e.repo,
    inputs: { merge: { pr: e.pr, review_task: e.review.id } },
    timeout_s: Math.max(MERGER_TIMEOUT_S, MIN_MERGER_TIMEOUT_S),
    idempotency_key: mergeKey(e.review.id),
  })
}

/** 已有的 merger 是否就是本审查的 merger（幂等命中时核对，不在别人的任务上继续）。 */
function sameMerger(task: TaskView, e: MergeEligibility): string | null {
  if (task.created_by !== HUB_ACTOR) return `创建者为 ${task.created_by}`
  if (task.workspace !== e.workspace.ref) return `属于 ${task.workspace}`
  if (task.contract.parent !== e.review.id) return 'parent 不是审查任务'
  const m = task.contract.inputs?.merge
  if (m?.review_task !== e.review.id || !samePrUrl(m.pr, e.pr)) return 'inputs.merge 不一致'
  if (task.origin !== 'instruction') return 'origin 不是 instruction'
  return null
}

/**
 * 以 hub 建 merger 任务。`withCreated` 在同一事务里写入（auto_merge 的 `merge_request.created`）。
 * `allowExisting`：幂等命中时（批准的重试）核对后返回已有任务；否则命中即 `conflict`。
 */
async function createMerger(
  deps: SupervisorToolsDeps,
  e: MergeEligibility,
  o: { allowExisting: boolean; withCreated?: (taskId: string) => EventInput[] },
): Promise<Result<TaskView>> {
  const role = await mergeRole(deps)
  if (!role.ok) return role
  const created = await deps.tasks.createTask(mergerContract(e, role.data.name), {
    actor: HUB_ACTOR,
    // origin 直接取自开出 PR 的任务（资格要求它是 instruction），不继承审查任务。
    origin: 'instruction',
    ...(o.withCreated ? { withCreated: o.withCreated } : {}),
  })
  if (!created.ok) return created
  const task = created.data.task
  if (!created.data.created) {
    const mismatch = sameMerger(task, e)
    if (!o.allowExisting || mismatch) {
      return fail(
        'failure',
        'conflict',
        mismatch
          ? `幂等键 ${mergeKey(e.review.id)} 命中的任务 ${task.id} 不是本审查的 merger（${mismatch}）`
          : `审查任务 ${e.review.id} 已建过 merger 任务 ${task.id}（${task.status}）；需要重新审查后再请求合并`,
        { task_id: task.id },
      )
    }
  }
  return ok(task)
}

/** 同一审查任务未结束的合并请求或已建出的 merger（D10：同一审查任务只能有一个）。 */
function existingRequest(deps: SupervisorToolsDeps, reviewTask: string): string | null {
  const merger = deps.ledger.findTaskByIdempotencyKey(mergeKey(reviewTask))
  if (merger) {
    return `审查任务 ${reviewTask} 已建过 merger 任务 ${merger.id}（${merger.status}）；需要重新审查后再请求合并`
  }
  for (const e of deps.ledger.eventsByPayload('merge_request.created', 'review_task', reviewTask)) {
    if (e.type !== 'merge_request.created' || !e.payload.item_id) continue
    const item = deps.ledger.getInboxItem(e.payload.item_id)
    if (item && item.state !== 'closed') {
      return `审查任务 ${reviewTask} 已有未处理的合并请求 ${e.payload.request_id}（条目 #${item.short_id}）`
    }
  }
  return null
}

/** 条目正文：PR、审查结论摘要、reviewed_sha、开出 PR 的任务、仓库。 */
function requestBody(e: MergeEligibility, wakeTaskId: string): string {
  const v = e.verdict
  const lines = [
    `PR：${e.pr}`,
    `审查结论：${v.verdict}（审查任务 ${e.review.id}，角色 ${e.review.contract.role}）`,
    `reviewed_sha：${e.reviewed_sha}`,
    `开出 PR 的任务：${e.dev.id}（${e.dev.contract.role}）`,
    `仓库：${e.repo}`,
    `发起：唤醒任务 ${wakeTaskId}`,
  ]
  if (v.notes) lines.push('', '审查备注：', v.notes)
  lines.push(
    '',
    '批准后由 pr-merge 执行器再次核对（PR 仍为 open、head 等于 reviewed_sha、检查全部通过）后合并；条件不满足时不合并。',
  )
  return lines.join('\n')
}

/** supervisor 请求合并（`pr_merge_request`，只限非 reply 的唤醒 token，由路由核对）。 */
export async function requestMerge(
  deps: SupervisorToolsDeps,
  wake: WakeCaller,
  input: MergeRequestRequest,
): Promise<Result<MergeRequestData>> {
  const { ledger } = deps
  const wakeTask = ledger.getTask(wake.task_id)
  if (!wakeTask || isTerminal(wakeTask)) {
    return fail('failure', 'scope_denied', '本次唤醒已结束，不能再请求合并')
  }
  const elig = await checkMergeEligibility(
    deps,
    { workspace: wake.workspace, pr: input.pr, review_task: input.review_task },
    { requireActive: true },
  )
  if (!elig.ok) return elig
  const e = elig.data
  const requestId = newRequestId()
  const base = {
    request_id: requestId,
    wake_task_id: wake.task_id,
    pr: e.pr,
    review_task: e.review.id,
    dev_task: e.dev.id,
    reviewed_sha: e.reviewed_sha,
  }

  if (e.workspace.supervisor.auto_merge) {
    // 先同步检查一次尽早拒绝；之后建任务的幂等键保证最多一个 merger（并发请求命中即 conflict）。
    const dup = existingRequest(deps, e.review.id)
    if (dup) return fail('failure', 'conflict', dup)
    const task = await createMerger(deps, e, {
      allowExisting: false,
      withCreated: (taskId) => [
        {
          type: 'merge_request.created',
          workspace: e.workspace.ref,
          payload: { ...base, auto_merge: true, merger_task: taskId },
        },
      ],
    })
    if (!task.ok) return task
    return ok({ request_id: requestId, mode: 'auto', task: task.data })
  }

  // 从这里到 append 都是同步代码：重复检查与写入之间不会与其他请求交错。
  const dup = existingRequest(deps, e.review.id)
  if (dup) return fail('failure', 'conflict', dup)
  let id = requestId
  while (ledger.getInboxItem(mergeRequestItemId(id))) id = newRequestId()
  const itemId = mergeRequestItemId(id)
  const r = ledger.appendMany(
    [
      {
        type: 'merge_request.created',
        workspace: e.workspace.ref,
        payload: { ...base, request_id: id, auto_merge: false, item_id: itemId },
      },
      {
        type: 'inbox.item_created',
        workspace: e.workspace.ref,
        payload: {
          item_id: itemId,
          level: resolveInboxLevel(deps.levels(), {
            source: 'merge_request',
            workspace: e.workspace.ref,
          }),
          source: 'merge_request',
          source_ref: id,
          title: clipText(`[${e.workspace.ref}] 批准合并：${e.pr}`, INBOX_TITLE_MAX),
          body: clipText(requestBody(e, wake.task_id), INBOX_BODY_MAX),
          actions: ['approve', 'reject'],
        },
      },
    ],
    { actor: HUB_ACTOR },
  )
  if (!r.ok) return r
  const item = ledger.getInboxItem(itemId)
  return item
    ? ok({ request_id: id, mode: 'approval', item })
    : fail('failure', 'internal_error', '合并请求条目写入后不可见')
}

/** 条目对应的 `merge_request.created`。 */
export function mergeRequestOf(
  deps: Pick<SupervisorToolsDeps, 'ledger'>,
  item: InboxItemView,
): EventOf<'merge_request.created'> | null {
  if (item.source !== 'merge_request') return null
  const e = deps.ledger.eventsByPayload('merge_request.created', 'item_id', item.id)[0]
  if (e?.type !== 'merge_request.created' || e.payload.request_id !== item.source_ref) return null
  return e
}

const approvalOf = (deps: Pick<SupervisorToolsDeps, 'ledger'>, itemId: string) =>
  deps.ledger
    .eventsByPayload('merge_request.approved', 'item_id', itemId)
    .find((e) => e.type === 'merge_request.approved' && e.actor === 'user') ?? null

/** 用户批准合并请求（actor 固定为 user，由收件箱入口核对）。 */
export async function approveMergeRequest(
  deps: SupervisorToolsDeps,
  item: InboxItemView,
  opts: { via: InboxVia },
): Promise<Result<{ task_id: string }>> {
  const { ledger } = deps
  const e = mergeRequestOf(deps, item)
  if (!e) return fail('failure', 'not_found', `合并请求 ${item.source_ref} 不存在`)
  const p = e.payload
  // merge_request.created 的信封必带 workspace。
  const workspace = e.workspace as string
  // 批准时再核对一次资格（审查之后可能又有新的审查、配置可能改动过）；不通过时条目保持打开。
  const elig = await checkMergeEligibility(
    deps,
    { workspace, pr: p.pr, review_task: p.review_task },
    { requireActive: false },
  )
  if (!elig.ok) return elig
  if (elig.data.reviewed_sha !== p.reviewed_sha || elig.data.dev.id !== p.dev_task) {
    return notEligible(['审查结论或开出 PR 的任务与请求时不一致'])
  }
  // 核对与写入之间有 await：写批准前同步地再确认条目仍未关闭（例如同时被驳回或忽略）。
  if (ledger.getInboxItem(item.id)?.state === 'closed') {
    return fail('failure', 'item_closed', '收件箱条目已关闭')
  }
  if (!approvalOf(deps, item.id)) {
    const r = ledger.append(
      {
        type: 'merge_request.approved',
        workspace,
        payload: {
          item_id: item.id,
          pr: p.pr,
          review_task: p.review_task,
          approved_by: 'user',
          via: opts.via,
        },
      },
      { actor: 'user' },
    )
    if (!r.ok) return r
  }
  const task = await createMerger(deps, elig.data, { allowExisting: true })
  if (!task.ok) return task
  // 并发的重复批准已经关闭了条目：merger 是同一个，视为成功。
  if (ledger.getInboxItem(item.id)?.state === 'closed') return ok({ task_id: task.data.id })
  const closed = ledger.append(
    {
      type: 'inbox.item_closed',
      workspace,
      payload: {
        item_id: item.id,
        reason: 'acted',
        note: `已批准，建了 merger 任务 ${task.data.id}`,
        cause_actor: 'user',
        via: opts.via,
      },
    },
    { actor: 'user' },
  )
  if (!closed.ok) return closed
  return ok({ task_id: task.data.id })
}

/** 用户驳回合并请求：写 `merge_request.rejected`（唤醒 supervisor）并关闭条目。 */
export async function rejectMergeRequest(
  deps: Pick<SupervisorToolsDeps, 'ledger'>,
  item: InboxItemView,
  opts: { note?: string; via: InboxVia },
): Promise<Result<null>> {
  const e = mergeRequestOf(deps, item)
  if (!e) return fail('failure', 'not_found', `合并请求 ${item.source_ref} 不存在`)
  const p = e.payload
  // 已批准（merger 可能已建出或正在建）：不能再驳回，避免"驳回唤醒了 supervisor、merger 却照建"。
  // 需要时取消 merger 任务；批准后 merger 一直建不出来时可以忽略条目。
  if (approvalOf(deps, item.id)) {
    const built = deps.ledger.findTaskByIdempotencyKey(mergeKey(p.review_task))
    return fail(
      'failure',
      'invalid_transition',
      built
        ? `合并请求已批准并建出 merger 任务 ${built.id}，不能再驳回；需要时请取消该任务`
        : '合并请求已批准，不能再驳回；请重新点"批准合并"完成剩余步骤，或忽略该条目',
      built ? { task_id: built.id } : undefined,
    )
  }
  const workspace = e.workspace as string
  const note = opts.note ? clipText(opts.note, 2000) : undefined
  const r = deps.ledger.appendMany(
    [
      {
        type: 'merge_request.rejected',
        workspace,
        payload: {
          item_id: item.id,
          pr: p.pr,
          review_task: p.review_task,
          ...(note ? { note } : {}),
          via: opts.via,
        },
      },
      {
        type: 'inbox.item_closed',
        workspace,
        payload: {
          item_id: item.id,
          reason: 'acted',
          note: clipText(`已驳回${note ? `：${note}` : ''}`, 1000),
          cause_actor: 'user',
          via: opts.via,
        },
      },
    ],
    { actor: 'user' },
  )
  return r.ok ? ok(null) : r
}
