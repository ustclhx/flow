import {
  type Artifact,
  clipText,
  fail,
  gitSha,
  loadWorkspaces,
  mergeInputs,
  ok,
  type Result,
  redactSecrets,
  reviewApproves,
  type SupervisorConfig,
  type TaskContract,
  type TaskResult,
  type TaskView,
} from '@flow/core'
import type { NodeHubClient } from './client.ts'
import { nodeHubClientFromHome } from './client.ts'
import { type NodeClock, sleep, systemClock } from './clock.ts'
import {
  ActivityQueue,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
} from './executor.ts'
import {
  createGitHubCli,
  type GhCheck,
  type GhRun,
  type GitHubCli,
  type GitOptions,
  originRepo,
  parsePrUrl,
  type RepoRef,
  sameRepo,
} from './github.ts'
import { resolveContractCwd } from './workdir.ts'

/**
 * pr-merge 执行器（add-m1-supervisor D10 第 5 步；tasks 5.4；pr-acceptance "合并前的条件核对"
 * "合并后确认发布流水线"）。**不调用任何模型**，全部条件由确定性代码核对，任何一项拿不准都判失败、不合并。
 *
 * 合并前依次核对（任一不满足 → `failed(<原因码>)`，不合并）：
 * 1. 合同 `inputs.merge = {pr, review_task}` 合法（`invalid_inputs`）；
 * 2. 工作目录是本 workspace 登记的仓库，PR 链接的仓库等于其 `remote.origin.url`（`repo_not_in_workspace`）；
 * 3. 本任务由 hub 或 user 创建、origin 为 instruction、`parent` 就是审查任务（`merge_not_eligible`）；
 * 4. 审查任务：同一 workspace、执行器 claude-sdk、角色在 `supervisor.reviewer_roles` 中、已 done、
 *    `inputs.review.pr` 等于该 PR、结论 approve（`review_not_approved`）；
 * 5. PR：open（`pr_not_open`）、不是草稿且可合并（`not_mergeable`）、base 为默认分支（`base_not_default`）、
 *    gh 报告的仓库一致（`repo_not_in_workspace`）、当前 head 等于 `reviewed_sha`（`head_moved`）；
 * 6. 检查：至少一项且全部成功、没有进行中的（`checks_not_green`）；`supervisor.allow_no_checks` 时允许没有检查。
 *    `skipping` 不算失败，但不计入"至少一项成功"。
 *
 * 合并：`gh pr merge <url> --<merge_method> --match-head-commit <reviewed_sha>`（head 在核对之后变化时 GitHub 拒绝合并）；
 * 之后读取 PR 状态，必须为 MERGED 且有合并提交，否则尝试关闭可能被打开的自动合并并 `failed(merge_failed)`。
 *
 * 合并后等待默认分支上该合并提交的 workflow runs（`gh run list --commit <sha> --branch <default>`）：
 * 全部成功（success / skipped / neutral）→ done 附 run 链接；有失败 → `failed(pipeline_failed)`；
 * 超时（默认 30 分钟）→ `failed(pipeline_timeout)` 附 run 链接；发现窗口（默认 2 分钟）内一直没有 run →
 * done 并注明未发现发布流水线。全部结束后再查一次确认没有新出现的 run。
 */

export const PR_MERGE_EXECUTOR = 'pr-merge'
export const DEFAULT_PIPELINE_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_PIPELINE_POLL_MS = 15_000
export const DEFAULT_RUN_DISCOVERY_MS = 2 * 60_000

type HubReader = Pick<NodeHubClient, 'showTask'>

export interface PrMergeOptions {
  home: string
  clock?: NodeClock
  /** 注入的 gh；缺省调用本机 gh。测试绝不调用真实 gh。 */
  gh?: GitHubCli
  git?: GitOptions
  /** 读取任务详情的中枢客户端；缺省按 flow-home 构造。 */
  hub?: HubReader
  /** 读取 workspace 的 supervisor 配置；缺省读 `config/workspaces/`，没有该 workspace 时返回 undefined。 */
  resolveSupervisor?: (workspace: string) => Promise<Result<SupervisorConfig | undefined>>
  /** 合并后等待流水线的最长毫秒数，缺省 30 分钟。 */
  pipelineTimeoutMs?: number
  /** 查询 workflow runs 的间隔，缺省 15 秒。 */
  pollMs?: number
  /** 合并后多久仍没有任何 run 即视为没有发布流水线，缺省 2 分钟。 */
  discoveryMs?: number
}

/** 检查的判定（纯函数）。 */
export function evaluateChecks(
  checks: readonly GhCheck[],
  allowNoChecks: boolean,
): { ok: true; note: string } | { ok: false; reason: string } {
  if (checks.length === 0) {
    return allowNoChecks
      ? { ok: true, note: 'PR 没有任何检查（supervisor.allow_no_checks 允许）' }
      : { ok: false, reason: 'PR 没有任何检查（未配置 supervisor.allow_no_checks）' }
  }
  const bad = checks.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')
  if (bad.length > 0) {
    const list = bad.map((c) => `${c.name}（${c.bucket}/${c.state}）`).join('、')
    return { ok: false, reason: `检查未全部成功：${list}` }
  }
  const passed = checks.filter((c) => c.bucket === 'pass').length
  if (passed === 0 && !allowNoChecks)
    return { ok: false, reason: '所有检查都被跳过，没有一项成功的检查' }
  return { ok: true, note: `${passed} 项检查成功` }
}

const RUN_OK = new Set(['success', 'skipped', 'neutral'])

/** workflow runs 的判定（纯函数）：有未结束的为 pending；全部结束时看结论。 */
export function evaluateRuns(runs: readonly GhRun[]): 'pending' | 'success' | 'failed' {
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  return runs.every((r) => RUN_OK.has(r.conclusion)) ? 'success' : 'failed'
}

const MERGE_ACTORS = new Set(['hub', 'user'])

export function createPrMergeExecutor(options: PrMergeOptions): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  const gh = options.gh ?? createGitHubCli()
  const timeoutMs = options.pipelineTimeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_PIPELINE_POLL_MS
  const discoveryMs = options.discoveryMs ?? DEFAULT_RUN_DISCOVERY_MS
  const resolveSupervisor =
    options.resolveSupervisor ??
    (async (workspace: string) => {
      const loaded = await loadWorkspaces(options.home)
      if (!loaded.ok) return loaded
      return ok(loaded.data.workspaces.find((w) => w.ref === workspace)?.supervisor)
    })
  let hubClient: HubReader | undefined = options.hub
  const hub = async (): Promise<Result<HubReader>> => {
    if (hubClient) return ok(hubClient)
    const r = await nodeHubClientFromHome(options.home)
    if (!r.ok) return r
    hubClient = r.data
    return ok(hubClient)
  }

  return {
    type: PR_MERGE_EXECUTOR,
    mode: 'headless',
    classify: () => null,
    run(contract: TaskContract, ctx: ExecutorContext) {
      const queue = new ActivityQueue()
      const abort = new AbortController()
      const signal = AbortSignal.any([ctx.signal, abort.signal])
      const iso = () => new Date(clock.now()).toISOString()
      const status = (text: string) =>
        queue.push({ ts: iso(), kind: 'status', text: clipText(redactSecrets(text), 4000) })
      const artifacts: Artifact[] = []
      const result = (summary: string, reason?: string): TaskResult => ({
        summary: clipText(redactSecrets(summary), 16_000),
        artifacts: [...artifacts],
        verify: [],
        executor: PR_MERGE_EXECUTOR,
        node_id: ctx.nodeId,
        ...(reason ? { reason } : {}),
      })
      const failed = (reason: string, summary: string): ExecutorOutcome => {
        status(`未合并或流水线未通过（${reason}）：${summary}`)
        return { outcome: 'failed', result: result(summary, reason) }
      }
      const cancelled = (message: string): ExecutorOutcome => ({ outcome: 'cancelled', message })

      const main = async (): Promise<ExecutorOutcome> => {
        // ---- 1. 合同 ----
        const inputs = mergeInputs.safeParse(contract.inputs?.merge)
        if (!inputs.success)
          return failed('invalid_inputs', `合同缺少合法的 inputs.merge：${inputs.error.message}`)
        const { pr: prUrl, review_task: reviewTaskId } = inputs.data
        const pr = parsePrUrl(prUrl)
        if (!pr) return failed('invalid_inputs', `PR 链接不合法：${prUrl}`)
        artifacts.push({ kind: 'pr', ref: pr.url })

        // ---- 2. 登记仓库与 PR 归属 ----
        const repoDir = await resolveContractCwd(options.home, contract, true)
        if (!repoDir.ok) return failed(repoDir.error.code, repoDir.error.message)
        const origin = await originRepo(repoDir.data, options.git)
        if (!origin.ok) return failed(origin.error.code, origin.error.message)
        if (!sameRepo(origin.data, pr))
          return failed(
            'repo_not_in_workspace',
            `PR ${pr.url} 不属于登记仓库 ${origin.data.host}/${origin.data.owner}/${origin.data.repo}`,
          )
        const repo: RepoRef = origin.data
        const sup = await resolveSupervisor(contract.workspace)
        if (!sup.ok)
          return failed('merge_not_eligible', `无法读取 workspace 配置：${sup.error.message}`)
        if (!sup.data) return failed('merge_not_eligible', `没有 workspace ${contract.workspace}`)
        const supervisor = sup.data

        // ---- 3、4. 本任务与审查任务（D10 第 4 步，再次核对） ----
        const client = await hub()
        if (!client.ok)
          return failed('review_not_approved', `无法连接中枢核对审查任务：${client.error.message}`)
        const self = await client.data.showTask(ctx.taskId)
        if (!self.ok) return failed('merge_not_eligible', `无法读取本任务：${self.error.message}`)
        const eligible = checkSelf(self.data.task, contract, reviewTaskId)
        if (eligible) return failed('merge_not_eligible', eligible)
        const reviewTask = await client.data.showTask(reviewTaskId)
        if (!reviewTask.ok)
          return failed(
            'review_not_approved',
            `无法读取审查任务 ${reviewTaskId}：${reviewTask.error.message}`,
          )
        const approves = reviewApproves(
          reviewTask.data.task,
          { workspace: contract.workspace, pr: pr.url },
          supervisor,
        )
        if (!approves.ok) return failed('review_not_approved', approves.reason)
        const reviewedSha = approves.reviewed_sha
        status(`审查任务 ${reviewTaskId} 结论 approve，审查的 head ${reviewedSha}`)
        if (signal.aborted) return cancelled('合并前已取消')

        // ---- 5. PR 状态 ----
        const view = await gh.prView(pr.url)
        if (!view.ok) return failed('pr_unverifiable', `读取 PR 失败：${view.error.message}`)
        const v = view.data
        if (v.number !== pr.number)
          return failed('pr_unverifiable', `gh 返回的 PR 编号 ${v.number} 与链接不符`)
        if (v.state !== 'OPEN') return failed('pr_not_open', `PR 状态为 ${v.state}，不是 OPEN`)
        const repoInfo = await gh.repoView(repo)
        if (!repoInfo.ok)
          return failed('pr_unverifiable', `读取仓库失败：${repoInfo.error.message}`)
        if (
          repoInfo.data.nameWithOwner.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()
        )
          return failed(
            'repo_not_in_workspace',
            `gh 报告的仓库 ${repoInfo.data.nameWithOwner} 与登记仓库 ${repo.owner}/${repo.repo} 不一致`,
          )
        const defaultBranch = repoInfo.data.defaultBranchRef.name
        if (v.baseRefName !== defaultBranch)
          return failed(
            'base_not_default',
            `PR 的 base 为 ${v.baseRefName}，不是默认分支 ${defaultBranch}`,
          )
        if (v.headRefOid !== reviewedSha)
          return failed(
            'head_moved',
            `PR 当前 head ${v.headRefOid} 与审查时的 ${reviewedSha} 不一致（审查后有新提交）`,
          )
        if (v.isDraft) return failed('not_mergeable', 'PR 仍是草稿')
        if (v.mergeable !== 'MERGEABLE')
          return failed('not_mergeable', `PR 当前不可合并（mergeable=${v.mergeable}）`)

        // ---- 6. 检查 ----
        const checks = await gh.prChecks(pr.url)
        if (!checks.ok) return failed('checks_not_green', `读取检查失败：${checks.error.message}`)
        const verdict = evaluateChecks(checks.data, supervisor.allow_no_checks)
        if (!verdict.ok) return failed('checks_not_green', verdict.reason)
        status(verdict.note)
        if (signal.aborted) return cancelled('合并前已取消')

        // ---- 合并 ----
        const method = supervisor.merge_method
        status(`合并 ${pr.url}（${method}，要求 head 为 ${reviewedSha}）`)
        const merged = await gh.prMerge(pr.url, method, reviewedSha)
        let after = await gh.prMergeState(pr.url)
        // 合并后立即读取可能失败或尚未反映合并：短暂重试几次再下结论。
        for (let i = 0; i < 3 && (!after.ok || (merged.ok && after.data.state !== 'MERGED')); i++) {
          await sleep(clock, 2_000)
          after = await gh.prMergeState(pr.url)
        }
        const mergeCommit = after.ok ? after.data.mergeCommit?.oid : undefined
        if (
          !after.ok ||
          after.data.state !== 'MERGED' ||
          !mergeCommit ||
          !gitSha.safeParse(mergeCommit).success
        ) {
          // 必需检查未完成时 gh 会改为打开自动合并：没有确认合并时一律尝试关掉它（未打开时 gh 报错，忽略），
          // 避免之后在无人核对时合并。
          if (!(after.ok && after.data.state === 'MERGED')) await gh.prDisableAuto(pr.url)
          const why = !merged.ok
            ? merged.error.message
            : after.ok
              ? `合并后 PR 状态为 ${after.data.state}，没有合并提交`
              : after.error.message
          return failed('merge_failed', `合并没有完成：${why}`)
        }
        artifacts.push({ kind: 'commit', ref: mergeCommit, note: `合并到 ${defaultBranch}` })
        status(
          merged.ok
            ? `已合并，合并提交 ${mergeCommit}`
            : `gh pr merge 报错但 PR 已合并（合并提交 ${mergeCommit}）：${merged.error.message}`,
        )

        // ---- 等待流水线 ----
        return waitPipeline(repo, defaultBranch, mergeCommit, pr.url)
      }

      const runLinks = (runs: readonly GhRun[]) => {
        for (const r of runs)
          if (!artifacts.some((a) => a.ref === r.url))
            artifacts.push({
              kind: 'url',
              ref: r.url,
              note: `${r.name}：${r.status}/${r.conclusion || '-'}`,
            })
      }

      const waitPipeline = async (
        repo: RepoRef,
        branch: string,
        sha: string,
        prLink: string,
      ): Promise<ExecutorOutcome> => {
        const start = clock.now()
        let seen = false
        let stable: string | undefined
        let lastRuns: GhRun[] = []
        let lastError: string | undefined
        for (;;) {
          if (signal.aborted) return cancelled(`PR 已合并（${sha}），取消了流水线等待`)
          const listed = await gh.runList(repo, sha, branch)
          if (listed.ok) {
            lastError = undefined
            const runs = listed.data.filter((r) => r.headSha === sha)
            lastRuns = runs
            if (runs.length > 0) seen = true
            const state = runs.length > 0 ? evaluateRuns(runs) : 'pending'
            if (state !== 'pending') {
              // 全部结束后再查一次：确认没有新出现的 run（例如 workflow_run 触发的部署）。
              const key = runs
                .map((r) => `${r.databaseId}:${r.conclusion}`)
                .sort()
                .join(',')
              if (stable === key) {
                runLinks(runs)
                const summary = runs.map((r) => `${r.name}：${r.conclusion}（${r.url}）`).join('\n')
                if (state === 'success')
                  return {
                    outcome: 'done',
                    result: result(`已合并 ${prLink}（${sha}），流水线全部成功：\n${summary}`),
                  }
                return failed(
                  'pipeline_failed',
                  `已合并 ${prLink}（${sha}），流水线失败：\n${summary}`,
                )
              }
              stable = key
            } else stable = undefined
          } else {
            lastError = listed.error.message
            status(`查询 workflow runs 失败，稍后重试：${listed.error.message}`)
          }
          const elapsed = clock.now() - start
          if (!seen && listed.ok && elapsed >= discoveryMs) {
            return {
              outcome: 'done',
              result: result(
                `已合并 ${prLink}（${sha}）；${Math.round(discoveryMs / 1000)} 秒内未发现默认分支 ${branch} 上该提交的 workflow run，未发现发布流水线`,
              ),
            }
          }
          if (elapsed >= timeoutMs) {
            runLinks(lastRuns)
            const pending = lastRuns
              .filter((r) => r.status !== 'completed')
              .map((r) => `${r.name}（${r.url}）`)
            return failed(
              'pipeline_timeout',
              `已合并 ${prLink}（${sha}），等待流水线超过 ${Math.round(timeoutMs / 60_000)} 分钟仍未结束${
                pending.length ? `：${pending.join('、')}` : ''
              }${lastError ? `；最近一次查询失败：${lastError}` : ''}`,
            )
          }
          await sleep(clock, pollMs, signal)
        }
      }

      const done = main()
        .then((o) => ok(o))
        .catch((err) => fail('failure', 'pr_merge_error', String((err as Error)?.message ?? err)))
        .finally(() => queue.close())
      return {
        activity: queue,
        done,
        cancel: async () => {
          abort.abort()
        },
        deliver: async () => 'not_running',
      }
    },
  }
}

/** 本任务的资格：由 hub 或 user 创建、origin 为 instruction、parent 为审查任务。返回不满足的原因。 */
function checkSelf(task: TaskView, contract: TaskContract, reviewTask: string): string | undefined {
  if (task.workspace !== contract.workspace) return `本任务属于 ${task.workspace}`
  if (!MERGE_ACTORS.has(task.created_by))
    return `merger 任务由 ${task.created_by} 创建，只接受 hub 或 user`
  if (task.origin !== 'instruction')
    return `merger 任务的 origin 为 ${task.origin ?? '空'}，不是 instruction`
  if (task.contract.parent !== reviewTask)
    return `merger 任务的 parent 为 ${task.contract.parent ?? '空'}，不是审查任务 ${reviewTask}`
  const own = task.contract.inputs?.merge
  if (own?.pr !== contract.inputs?.merge?.pr || own?.review_task !== reviewTask)
    return '中枢记录的 inputs.merge 与本次执行的合同不一致'
  return undefined
}
