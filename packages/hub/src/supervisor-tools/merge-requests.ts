import { randomBytes } from 'node:crypto'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import {
  clipText,
  type EventOf,
  effectiveRoleKind,
  fail,
  git,
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
  parseRemoteUrl,
  prRepoOf,
  type RepoRef,
  type Result,
  type ReviewResult,
  resolveInboxLevel,
  reviewApproves,
  reviewResult,
  type SupervisorConfig,
  samePrUrl,
  sameRepo,
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
 * - 开出 PR 的任务上报过任务分支（`task.branch_reported`，投影 `branch`）：merger 据此要求 PR 的 head 分支
 *   等于它且不是 fork PR；多个候选任务的分支不一致时无法确定；
 * - PR 链接的 host/owner/repo 等于开出 PR 的任务在 worker 启动前采集的 `repo_snapshot.remote_url`，且等于 merger
 *   所用登记仓库当前 `remote.origin.url` 的仓库（纵深核对，pr-merge 再核对一次）；
 * - 同一 PR 没有未结束的审查任务（任何带 `inputs.review` 指向该 PR 的未结束任务都算，比 pr-merge 更严）；
 * - 该审查任务的合并请求没有被驳回过（`rejected_before`：驳回后必须重新审查）；
 * - merger 的工作目录能唯一确定为登记仓库（取开出 PR 的任务的 `inputs.repo` / `cwd` 所在的登记仓库；
 *   都没写时只有恰好登记一个仓库才行）；
 * - 有且只有一个有效类别为 merge、执行器为 pr-merge 的角色。
 *
 * 通过后：`supervisor.auto_merge: true` **且请求来自 instruction 唤醒** → 中枢以 hub 建 merger 任务（与
 * `merge_request.created` 同一事务）；否则（含 autonomous 唤醒）写 `merge_request.created` 与 `source: merge_request`
 * 的 Decide 条目。同一审查任务只能有一个未结束的合并请求，且最多建一个 merger（幂等键 `merge:<审查任务>`，
 * 保留前缀只限 hub）。
 *
 * 用户批准（只有 user，经收件箱）：重新核对资格、解析 merge 角色并构造完整的 merger 合同，任何一步失败都不写
 * 事件；然后 `merge_request.approved`（actor user）、`task.created`（actor hub）与条目关闭（actor user）在**同一
 * 事务**中写入——有批准事件就一定有 merger。用户驳回：写 `merge_request.rejected`（actor user）并关闭条目；
 * 唤醒调度器按请求所在唤醒的 origin 唤醒 supervisor（与 `task_proposal.rejected` 一致）。
 *
 * supervisor 停用后，已生成的合并审批条目仍可由用户批准（批准是用户的决定，资格的其余各项照常核对）。
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
  /** 开出 PR 的任务上报的任务分支（投影 `branch`），写入 `inputs.merge.branch`。 */
  branch: string
  /** merger 的工作目录：登记仓库（登记时的写法）。 */
  repo: string
}

/** 读取登记仓库 `remote.origin.url` 所指的仓库；读不到或无法解析时失败。 */
export type RepoOriginLookup = (repoPath: string) => Promise<Result<RepoRef>>

/** 基于本机 git：`git config --get-all remote.origin.url`，必须恰好一个值且能解析。 */
export function repoOriginFromGit(opts: { homedir?: () => string } = {}): RepoOriginLookup {
  return async (repoPath) => {
    const home = opts.homedir ?? osHomedir
    const dir =
      repoPath === '~'
        ? home()
        : repoPath.startsWith('~/')
          ? join(home(), repoPath.slice(2))
          : repoPath
    const r = await git(dir, ['config', '--get-all', 'remote.origin.url'])
    const values = r.code === 0 ? r.stdout.split('\n').filter((l) => l !== '') : []
    if (values.length !== 1 || values[0] === undefined) {
      return fail('failure', 'repo_not_in_workspace', `${repoPath} 的 origin 应恰好有一个地址`)
    }
    const parsed = parseRemoteUrl(values[0])
    return parsed
      ? ok(parsed)
      : fail('failure', 'repo_not_in_workspace', `无法从 origin 地址识别仓库：${values[0]}`)
  }
}

/** 一次资格核对最多读取的同 PR 相关任务数；达到上限时无法确认，判不合格。 */
export const PR_RELATED_LIMIT = 1000

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
  const branches = new Set(hits.map((t) => t.branch))
  if (branches.size !== 1) {
    return {
      ok: false,
      reasons: [
        `产出该 PR 的任务上报的分支不一致（${[...branches].join('、')}），无法确定 PR 的任务分支`,
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
  if (!t.branch) return '没有上报任务分支（task.branch_reported），无法核对 PR 的 head 分支'
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
  const prNumber = Number(/\/pull\/(\d+)$/.exec(pr ?? '')?.[1])
  const prRepo = pr ? prRepoOf(pr) : undefined
  if (!pr || !prRepo || !Number.isSafeInteger(prNumber)) {
    return notEligible([`PR 链接不合法：${input.pr}`])
  }
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

  // ---- 驳回过的审查不能再请求（必须重新审查） ----
  if (
    deps.ledger
      .eventsByPayload('merge_request.rejected', 'review_task', input.review_task)
      .some((e) => e.workspace === ws.ref)
  ) {
    reasons.push(
      `rejected_before：审查任务 ${input.review_task} 的合并请求已被用户驳回，需要重新审查`,
    )
  }

  // ---- 最新一次可信审查、没有未结束的审查 ----
  const related = deps.ledger.prRelatedTasks(ws.ref, prNumber, PR_RELATED_LIMIT)
  if (related.length >= PR_RELATED_LIMIT) {
    return notEligible([`同一 PR 号的相关任务超过 ${PR_RELATED_LIMIT} 个，无法确认`], { pr })
  }
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
    // 纵深核对：PR 必须属于开出它的任务在 worker 启动前采集的仓库快照（`repo_snapshot.remote_url`）。
    // worker 在沙箱外运行，可能改写登记仓库的 remote（worktree 与主仓库共用配置），只认快照。
    const snapshot = dev.task.repo_snapshot
      ? parseRemoteUrl(dev.task.repo_snapshot.remote_url)
      : undefined
    if (!snapshot) {
      reasons.push(
        `开出 PR 的任务 ${dev.task.id} 没有可识别的登记仓库快照（repo_snapshot），无法确认 PR 属于登记仓库`,
      )
    } else if (!sameRepo(snapshot, prRepo)) {
      reasons.push(
        `PR 不属于开出它的任务启动前的登记仓库 ${snapshot.host}/${snapshot.owner}/${snapshot.repo}`,
      )
    }
    if (!r.ok) reasons.push(r.reason)
    else {
      // 当前的 origin 也必须仍是同一仓库（merger 在登记仓库里调用 gh；pr-merge 执行器合并前还会再核对一次）。
      const origin = await (deps.repoOrigin ?? repoOriginFromGit(deps.repoCheck))(r.repo)
      if (!origin.ok) reasons.push(`无法确认登记仓库 ${r.repo} 的 origin：${origin.error.message}`)
      else if (!sameRepo(origin.data, prRepo)) {
        reasons.push(
          `PR 不属于登记仓库 ${origin.data.host}/${origin.data.owner}/${origin.data.repo}`,
        )
      } else if (snapshot && sameRepo(snapshot, prRepo)) repo = r.repo
    }
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
    branch: dev.task.branch as string,
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
    inputs: { merge: { pr: e.pr, review_task: e.review.id, branch: e.branch } },
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
  if (m?.review_task !== e.review.id || !samePrUrl(m.pr, e.pr) || m.branch !== e.branch)
    return 'inputs.merge 不一致'
  if (task.origin !== e.dev.origin) return `origin 不是 ${e.dev.origin}`
  return null
}

/** merge 角色与 merger 合同：任何一步失败都在写入事件之前返回。 */
async function prepareMerger(
  deps: SupervisorToolsDeps,
  e: MergeEligibility,
): Promise<Result<TaskContract>> {
  const role = await mergeRole(deps)
  if (!role.ok) return role
  try {
    return ok(mergerContract(e, role.data.name))
  } catch (err) {
    return notEligible([`无法构造 merger 合同：${(err as Error).message}`])
  }
}

/**
 * 以 hub 建 merger 任务。`withCreated`（hub）与 `coWrite`（其他身份，例如批准者 user）与 `task.created`
 * 在同一事务里写入，只在真正新建时写。`allowExisting`：幂等命中时核对后返回已有任务；否则命中即 `conflict`。
 */
async function createMerger(
  deps: SupervisorToolsDeps,
  e: MergeEligibility,
  contract: TaskContract,
  o: {
    allowExisting: boolean
    withCreated?: (taskId: string) => EventInput[]
    coWrite?: { actor: 'user'; before?: EventInput[]; after?: (taskId: string) => EventInput[] }
  },
): Promise<Result<{ task: TaskView; created: boolean }>> {
  const created = await deps.tasks.createTask(contract, {
    actor: HUB_ACTOR,
    // origin 直接取自开出 PR 的任务（资格要求它是 instruction），不继承审查任务。
    ...(e.dev.origin ? { origin: e.dev.origin } : {}),
    ...(o.withCreated ? { withCreated: o.withCreated } : {}),
    ...(o.coWrite ? { coWrite: o.coWrite } : {}),
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
  return ok({ task, created: created.data.created })
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

  // auto_merge 只对 instruction 唤醒生效：autonomous 唤醒（巡检、回看）发起的请求一律交给用户批准。
  if (e.workspace.supervisor.auto_merge && wake.origin === 'instruction') {
    // 先同步检查一次尽早拒绝；之后建任务的幂等键保证最多一个 merger（并发请求命中即 conflict）。
    const dup = existingRequest(deps, e.review.id)
    if (dup) return fail('failure', 'conflict', dup)
    const contract = await prepareMerger(deps, e)
    if (!contract.ok) return contract
    const task = await createMerger(deps, e, contract.data, {
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
    return ok({ request_id: requestId, mode: 'auto', task: task.data.task })
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
  // 写入任何事件之前：解析 merge 角色并构造完整的 merger 合同，失败即返回、不留下批准事件。
  const contract = await prepareMerger(deps, elig.data)
  if (!contract.ok) return contract
  // 批准、建 merger、关闭条目在同一事务里：条目已被（并发的）驳回或忽略关闭时，关闭事件校验失败，
  // 整个事务回滚，不会出现"已驳回却建了 merger"。
  // allowExisting：并发的两次批准都通过核对时，后到者幂等命中先到者建出的 merger（sameMerger 核对），
  // 下面再确认条目已由本条目的批准关闭，才按成功返回。
  const task = await createMerger(deps, elig.data, contract.data, {
    allowExisting: true,
    coWrite: {
      actor: 'user',
      before: [
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
      ],
      after: (taskId) => [
        {
          type: 'inbox.item_closed',
          workspace,
          payload: {
            item_id: item.id,
            reason: 'acted',
            note: `已批准，建了 merger 任务 ${taskId}`,
            cause_actor: 'user',
            via: opts.via,
          },
        },
      ],
    },
  })
  if (!task.ok) return task
  if (!task.data.created) {
    const closed = deps.ledger.getInboxItem(item.id)?.state === 'closed'
    if (!closed || !approvalOf(deps, item.id)) {
      return fail(
        'failure',
        'conflict',
        `审查任务 ${p.review_task} 已建过 merger 任务 ${task.data.task.id}（${task.data.task.status}），不是本条目批准建出的`,
        { task_id: task.data.task.id },
      )
    }
  }
  return ok({ task_id: task.data.task.id })
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
  // 批准与建 merger 在同一事务里：有批准事件就一定有 merger，不能再驳回（需要时取消 merger 任务）。
  if (approvalOf(deps, item.id)) {
    const built = deps.ledger.findTaskByIdempotencyKey(mergeKey(p.review_task))
    return fail(
      'failure',
      'invalid_transition',
      `合并请求已批准${built ? `并建出 merger 任务 ${built.id}` : ''}，不能再驳回；需要时请取消该任务`,
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
