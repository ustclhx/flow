import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Activity,
  type DeliveredReply,
  fail,
  loadRoles,
  ok,
  type Result,
  type Role,
  redactLines,
  redactSecrets,
  SUPERVISOR_ACTOR,
  type TaskContract,
  type TaskResult,
} from '@raindown/core'
import { z } from 'zod'
import { type NodeClock, sleep, systemClock } from '../clock.ts'
import { orcaCodexHome, prepareCodexHome, sameCodexHome } from '../codex-home.ts'
import { CHILD_ENV_DENYLIST, dualRaindownEnv, executorRoleEnv } from '../env.ts'
import {
  ActivityQueue,
  type DeliverResult,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
  idleSignal,
  resumedSignal,
} from '../executor.ts'
import { autoApprovedText, needsUserText } from '../precheck.ts'
import { resolveContractCwd } from '../workdir.ts'
import {
  analyzeTail,
  approvalExecutionLines,
  approvalForPrecheck,
  CODEX_ORCA_PRECHECK_TOOL,
  classifyCodexOrca,
  type TailAnalysis,
} from './classify.ts'
import {
  type CommandRunner,
  createGhCli,
  createOrcaCli,
  execRunner,
  type GhCli,
  type OrcaCli,
  type OrcaSendResult,
  orcaErrorCode,
} from './orca.ts'
import { renderTaskSpec, resolveContext, taskStateDir, writeTaskSpec } from './spec.ts'
import { checkProjectCodexTrust } from './trust.ts'

/**
 * codex-orca 执行器（add-m1-executors 2.1–2.3；executor-codex-orca spec；design D2–D4）。
 *
 * 流程：校验仓库属于合同的 workspace → 以任务 id 建 Orca worktree（基于 origin/<默认分支>，等 setup）
 * → 渲染任务说明写入 `state/tasks/<id>/spec.md` → 在 Orca 终端中启动 Codex → 每 30 秒读一次终端末尾。
 *
 * 监控循环（D4）：
 * - 有忙碌标记：在工作；终端有新内容时作为 output 上报，否则上报 heartbeat（无进展计时只看"既无输出也不忙"）；
 *   之前报告过停下的，补一个 resumed 信号（用户直接在终端里答复的情形）；
 * - 信任提示：启动、恢复与确认前均拒绝项目 `.codex/`；仅在本次新终端首次忙碌之前发回车（最多 3 次）。
 *   之后再看到信任提示文字也不自动确认，交给 classify（PR #24 审查第 1 条）；
 * - 连续两次没有忙碌标记：查本任务分支上的 PR（`gh pr list --head`），有则以 done 结束（`workdir` 为 worktree，
 *   验收在这里运行）；gh 不可用时**不判 done**，上报 idle 并在 hint 中带上 gh 的错误，classify 判为 other；
 *   没有 PR 时上报 idle 信号（hint 中带终端末尾 40 行），节点调用 `classify` 判定原因并上报 blocked，租约继续持有；
 * - 终端退出：先查 PR；没有 PR 且目录仍在时上报 exited，由节点归为 crashed。只有目录确实丢失才记录 session_removed。
 *
 * `terminal_handle_stale` 的语义（在本机 Orca 1.4.218 上确认，2026-10-25）：
 * - 对一个已关闭的终端执行 `terminal read`，返回的是 `ok: true` 加 `status: "exited"`，不是 stale；
 * - Orca 自带的 orca-cli 技能说明里写着："Handles are runtime-scoped: after an Orca restart or a
 *   `terminal_handle_stale` error, re-list and continue with the replacement only"。也就是说 stale 只表示
 *   这个 handle 在当前 runtime 中失效（例如 Orca 重启），终端和 Codex 可能还活着、换了新 handle。
 * 因此 stale 按临时错误处理：用 `terminal list --worktree` 在本 worktree 中找唯一且进程身份匹配的 Codex 终端接上；
 * 找不到或缺少原进程身份时继续重试，不返回 not_running，也不判为退出（持续找不到由节点的无进展计时兜底）。
 *
 * 策略预检（add-m1-inbox 2.3；design D2）：轮询发现一个新的授权弹窗、且尚未上报停下时，先用
 * `approvalForPrecheck` 严格提取命令（提取不到按需要用户处理），以工具 `CodexCommand` 加命令调用
 * `ctx.precheck`。只有判定 auto / auto-report 时才放行：发回车之前**再读一次实时终端**，弹窗仍在底部、
 * 命令与弹窗全文都和预检时一致才发，否则不发、下一轮重新判定。其余结果与调用失败照常走 idle → blocked。
 * 同一个弹窗只预检一次（每次预检都会在中枢入账 `policy.decided`）。
 *
 * `deliver` 把授权回复绑定到首次投递的阻塞回合；只有同一回合且实时命令一致才发送 Enter/Esc。
 * 已关闭回合的迟到回复不作为普通文字发送。按 reply_id 幂等，送达状态与 Orca 的 request id
 * 持久化在 `state/tasks/<id>/orca.json`，节点重启后不会重复送达。
 * "input accepted but no turn start" 时用同一个 request id 复核（Orca 只回放回执，不会再发一次），
 * 仍未开始时补发一次回车。`cancel` 关闭终端，worktree 保留。
 */

export interface CodexOrcaLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
}

export interface CodexOrcaOptions {
  /** raindown-home：读取 workspace、角色、brain，写 `state/tasks/<id>/`。 */
  home: string
  clock?: NodeClock
  orca?: OrcaCli
  gh?: GhCli
  /** 读取终端的间隔，默认 30 秒（D4）。 */
  pollMs?: number
  /** Codex 可执行文件，默认 `codex`。 */
  codexBin?: string
  /** 仅共享此用户 Codex 目录中的 auth.json；测试传临时目录。 */
  codexAuthSource?: string
  /** 仓库的基准分支，默认取 `origin/HEAD` 指向的分支，取不到时为 `origin/main`。 */
  baseBranch?: (repo: string) => Promise<string>
  /** 等待 worktree 的 setup 完成；默认按 dispatch-codex.sh 的约定检查 node_modules。 */
  waitForSetup?: (worktreePath: string, signal: AbortSignal) => Promise<Result<void>>
  /** 默认 setup 检查的超时与间隔。 */
  setupTimeoutMs?: number
  setupPollMs?: number
  /** `orca terminal send --wait-submit` 的秒数，默认 10。 */
  sendWaitS?: number
  /** 自动确认信任提示的最多次数，默认 3。 */
  trustRetries?: number
  /** 执行 git 的方式（默认的 baseBranch 用），测试注入。 */
  run?: CommandRunner
  /** 目录状态读取；测试可注入暂时性文件系统错误。 */
  directoryStat?: (path: string) => { isDirectory(): boolean }
  logger?: CodexOrcaLogger
}

/** 合同 `inputs` 中 codex-orca 使用的字段。 */
export const codexOrcaInputs = z.looseObject({
  repo: z.string().min(1).optional().meta({ description: '仓库的本地路径；缺省为合同的 cwd' }),
  scope: z.array(z.string().min(1)).optional().meta({ description: '允许修改的范围' }),
})

/** 角色 `permissions` 中 codex-orca 使用的字段（D3）。 */
export const codexOrcaPermissions = z.looseObject({
  writable_paths: z.never({ error: 'writable_paths 仅适用于 claude-sdk 执行器' }).optional(),
  read_scope: z.never({ error: 'read_scope 仅适用于 claude-sdk 执行器' }).optional(),
  /** `never` 与 `danger-full-access` 同时出现时使用 `--dangerously-bypass-approvals-and-sandbox`。 */
  approval: z.string().min(1).optional(),
  sandbox: z.string().min(1).optional(),
  /** 额外的 `-c key=value`。 */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

const replyStateSchema = z.object({
  /** 首次投递时绑定的阻塞回合，重试不得转移到另一授权。 */
  round_id: z.string().optional(),
  /** 第一次发送时 Orca 给的 request id：复核时用它，Orca 只回放回执不会重发。 */
  request_id: z.string().optional(),
  esc_sent: z.boolean().optional(),
  done: z.boolean().optional(),
  /** supervisor 的批准被拒收（待批请求已变或环境复查未通过，D15）：没有发送任何按键。 */
  dropped: z.boolean().optional(),
  drop_reason: z.literal('round_closed').optional(),
})
type ReplyState = z.infer<typeof replyStateSchema>

/** 授权回合随 Orca 会话保存，恢复时仍按原请求和 blocked seq 复核。 */
const approvalRoundSchema = z.object({
  request_id: z.string().min(1),
  fingerprint: z.string().min(1),
  command: z.string().optional(),
  blockSeq: z.number().int().min(1).optional(),
  closed: z.boolean(),
  attempted: z.boolean(),
  evidence: z.number().int().min(0),
  reportedApproval: z.boolean(),
})

const stateSchema = z.object({
  repo: z.string(),
  worktree_path: z.string(),
  branch: z.string(),
  base_branch: z.string(),
  handle: z.string().optional(),
  /** 启动终端时使用的隔离目录；旧记录缺失时不接管，避免继续运行未隔离的进程。 */
  codex_home: z.string().optional(),
  /** 创建终端时 Orca 给出的进程身份；stale 后接管其他 handle 前必须一致（PR #24 复核）。 */
  pty_id: z.string().optional(),
  incarnation_id: z.string().optional(),
  /** 按 reply_id 的送达状态（PR #24 审查第 8 条：节点重启后不重复送达）。 */
  replies: z.record(z.string(), replyStateSchema).default({}),
  approval_round: approvalRoundSchema.optional(),
})
type OrcaTaskState = z.infer<typeof stateSchema>

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * 确定任务的仓库：`inputs.repo`，其次合同的 cwd；都没有时取合同 workspace 唯一的仓库。
 * 仓库必须出现在**合同自己的 workspace**（`config/workspaces/<id>.yaml`）的 repos 中，否则为 `repo_not_in_workspace`。
 */
export async function resolveTaskRepo(
  home: string,
  contract: TaskContract,
): Promise<Result<string>> {
  const inputs = codexOrcaInputs.safeParse(contract.inputs ?? {})
  if (!inputs.success) {
    return fail('usage', 'invalid_inputs', `inputs 不合法：${inputs.error.message}`)
  }
  // inputs.repo 仍优先选择 Orca 的基础仓库；节点上下文的 cwd 按通用合同规则解析。
  return resolveContractCwd(
    home,
    inputs.data.repo ? { ...contract, cwd: inputs.data.repo } : contract,
    true,
  )
}

/** 由角色参数拼出启动 Codex 的终端命令（与 run-codex.sh 等价；任务说明经文件传入）。 */
export function buildCodexCommand(input: {
  codexBin: string
  codexHome: string
  worktreePath: string
  specPath: string
  task?: { id: string; workspace: string; home: string }
  role: Pick<Role, 'name' | 'model' | 'effort' | 'permissions'>
}): Result<string> {
  if (input.codexBin.includes('=')) {
    return fail('usage', 'invalid_codex_bin', 'codexBin 不能包含 =，避免被 env 当作环境变量赋值')
  }
  const env = executorRoleEnv(input.role.name, {})
  if (!env.ok) return env
  const perms = codexOrcaPermissions.safeParse(input.role.permissions ?? {})
  if (!perms.success) {
    return fail('usage', 'invalid_permissions', `角色 permissions 不合法：${perms.error.message}`)
  }
  const p = perms.data
  const argv = [input.codexBin]
  if (input.role.model) argv.push('-m', input.role.model)
  if (input.role.effort) argv.push('-c', `model_reasoning_effort=${input.role.effort}`)
  for (const [k, v] of Object.entries(p.config ?? {})) argv.push('-c', `${k}=${String(v)}`)
  if (p.approval === 'never' && p.sandbox === 'danger-full-access') {
    argv.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    // 避免用户级 auto_review 吞掉授权弹窗；角色显式配置 reviewer 时以角色为准。
    if (p.approval !== 'never' && p.config?.approvals_reviewer === undefined) {
      argv.push('-c', 'approvals_reviewer=user')
    }
    if (p.approval) argv.push('-a', p.approval)
    if (p.sandbox) argv.push('-s', p.sandbox)
  }
  const cmd = argv.map(quote).join(' ')
  const taskEnv = input.task
    ? dualRaindownEnv({
        RAINDOWN_TASK_ID: input.task.id,
        RAINDOWN_WORKSPACE: input.task.workspace,
        RAINDOWN_HOME: input.task.home,
      })
    : {}
  const assignments = Object.entries({
    ...taskEnv,
    RAINDOWN_ACTOR: env.data.RAINDOWN_ACTOR,
    FLOW_ACTOR: env.data.FLOW_ACTOR,
    CODEX_HOME: input.codexHome,
  })
    .map(([key, value]) => quote(`${key}=${value}`))
    .join(' ')
  const unset = CHILD_ENV_DENYLIST.flatMap((key) => ['-u', quote(key)]).join(' ')
  return ok(
    `cd ${quote(input.worktreePath)} && exec env ${unset} ${assignments} ${cmd} "$(cat ${quote(input.specPath)})"`,
  )
}

/** 默认的基准分支：`git symbolic-ref --short refs/remotes/origin/HEAD`，取不到时 `origin/main`。 */
export async function defaultBaseBranch(repo: string, run: CommandRunner = execRunner) {
  try {
    const out = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repo,
      timeoutMs: 10_000,
    })
    const ref = out.stdout.trim()
    if (out.code === 0 && /^origin\/[\w./-]+$/.test(ref)) return ref
  } catch {}
  return 'origin/main'
}

/**
 * 默认的 setup 等待（与 dispatch-codex.sh 的约定一致）：worktree 有 package.json 时，
 * 等 `node_modules/.bin` 或 `node_modules/.pnpm` 出现；带 `scripts/orca/setup.sh` 的仓库还要等 `.env.worktree`。
 */
export function setupWaiter(
  clock: NodeClock,
  timeoutMs: number,
  pollMs: number,
  stat?: (path: string) => { isDirectory(): boolean },
) {
  return async (wt: string, signal: AbortSignal): Promise<Result<void>> => {
    const ready = () =>
      (existsSync(join(wt, 'node_modules', '.bin')) ||
        existsSync(join(wt, 'node_modules', '.pnpm'))) &&
      (!existsSync(join(wt, 'scripts', 'orca', 'setup.sh')) ||
        existsSync(join(wt, '.env.worktree')))
    for (let waited = 0; ; waited += pollMs) {
      let accessible = false
      try {
        if (!isDirectory(wt, stat))
          return fail('failure', 'workdir_missing', `工作目录不存在：${wt}`)
        accessible = true
      } catch {
        // 暂时无法访问时等待下一轮，不能将其当作目录被删除。
      }
      if (accessible && (!existsSync(join(wt, 'package.json')) || ready())) return ok(undefined)
      if (signal.aborted) return fail('failure', 'cancelled', '等待 setup 时被取消')
      if (waited >= timeoutMs) {
        return fail(
          'failure',
          'setup_timeout',
          `worktree 的 setup 超过 ${timeoutMs / 1000} 秒仍未完成`,
        )
      }
      await sleep(clock, pollMs, signal)
    }
  }
}

/** 目录被删除或被普通文件替换时均不可作为命令 cwd。 */
function isDirectory(
  path: string,
  stat: (path: string) => { isDirectory(): boolean } = statSync,
): boolean {
  try {
    return stat(path).isDirectory()
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

/** 末尾输出用于比较时去掉计时（`Working (3m 00s • …`），计时变化不算新输出。 */
const normLine = (l: string) => l.replace(/\(\d+[hms][^)]*\)/g, '()').replace(/\s+$/, '')
/** 以识别出的整个弹窗绑定回合；严格命令解析仅用于代批与额外的执行证据。 */
const approvalFingerprint = (a: TailAnalysis): string | undefined =>
  a.kind === 'awaiting_approval' ? a.last_message.map(normLine).join('\n') : undefined

/** 把回复渲染成发进终端的文字（终端输入框里换行会提前提交，换成空格）。 */
function replyText(reply: DeliveredReply): string {
  const t = (reply.text ?? '').replace(/\r?\n/g, ' ').trim()
  switch (reply.kind) {
    case 'approve':
      return t ? `同意。${t}` : '同意，请继续。'
    case 'deny':
      return t ? `不同意：${t}` : '不同意。请停下，说明可选的替代方案。'
    case 'text':
      return t
  }
}

const STUCK_TAIL = 40
/** 预检期间界面连续变化这么多次后不再重新预检，交给用户。 */
const PRECHECK_CHANGE_MAX = 3

/** 临时错误：节点会在下一次续约时重送（不确认、不取消 worker）。 */
class TransientDeliverError extends Error {}
/** 请求已经失效，重试不会使旧回复重新获得授权。 */
class RoundClosedError extends Error {}

export function createCodexOrcaExecutor(options: CodexOrcaOptions): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  const orca = options.orca ?? createOrcaCli()
  const gh = options.gh ?? createGhCli()
  const pollMs = options.pollMs ?? 30_000
  const codexBin = options.codexBin ?? 'codex'
  const sendWaitS = options.sendWaitS ?? 10
  const trustRetries = options.trustRetries ?? 3
  const baseBranchOf =
    options.baseBranch ?? ((repo: string) => defaultBaseBranch(repo, options.run))
  const waitForSetup =
    options.waitForSetup ??
    setupWaiter(
      clock,
      options.setupTimeoutMs ?? 600_000,
      options.setupPollMs ?? 15_000,
      options.directoryStat,
    )
  const logger = options.logger

  return {
    type: 'codex-orca',
    mode: 'interactive',
    adapterCapabilities: {
      approval_requests: 'inferred',
      inject_while_running: true,
      resume_session: false,
      raindown_mcp: false,
      out_of_band_detection: true,
    },
    classify: classifyCodexOrca,
    run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun {
      const queue = new ActivityQueue()
      let settle: (r: Result<ExecutorOutcome>) => void = () => {}
      const done = new Promise<Result<ExecutorOutcome>>((r) => {
        settle = r
      })
      let finished = false
      let stopping = false
      let handle: string | undefined
      let state: OrcaTaskState | undefined
      /** 终端是本执行器这一次新建的（只有这种终端才自动确认信任提示）。 */
      let launchedHere = false
      /** 终端里出现过忙碌标记：之后不再自动确认信任提示。 */
      let seenBusy = false
      /** 已报告停下（idle 信号已发出），等待回复或自行恢复。 */
      let reported = false
      let reportedKind: TailAnalysis['kind'] | undefined
      let idlePolls = 0
      /** 送达回复后补发一次 idle：防止 idle 信号早于节点确认送达而被忽略。 */
      let reemit = false
      let prevTail: string[] = []
      /** 已预检过的授权弹窗（弹窗全文）；界面离开该弹窗后清空。 */
      let prechecked: string | undefined
      /** 连续"预检期间界面变化"的次数；达到上限后不再重试，交给用户（避免一直不上报）。 */
      let precheckChanges = 0
      /** 连续变化达到上限后，等待稳定屏幕并交给用户，不再使用变化前的快照。 */
      let precheckSuspended = false
      /** 当前弹窗预检得到的 supervisor 判定（D15）：上报停下时放进 hint，界面离开该弹窗后清空。 */
      let decision: { popup: string; id: number } | undefined
      /** 关闭的回合也保留，迟到的回复不能借实时界面操作另一个请求。 */
      let approvalRound: z.infer<typeof approvalRoundSchema> | undefined
      let resumeReplyHandled = false
      const inflight = new Map<string, Promise<DeliverResult>>()
      const directoryRetry = new AbortController()

      const iso = () => new Date(clock.now()).toISOString()
      const status = (text: string, data?: Record<string, unknown>) =>
        queue.push({ ts: iso(), kind: 'status', text, ...(data ? { data } : {}) })
      const rejectResumeReply = () => {
        if (resumeReplyHandled || !ctx.resume) return
        resumeReplyHandled = true
        ctx.reportResumeReplyDropped?.()
      }
      const finish = (r: Result<ExecutorOutcome>) => {
        if (finished) return
        rejectResumeReply()
        finished = true
        directoryRetry.abort()
        ctx.signal.removeEventListener('abort', onAbort)
        queue.close()
        settle(r)
      }
      const result = (summary: string, extra: Partial<TaskResult> = {}): TaskResult => ({
        summary,
        artifacts: [],
        verify: [],
        executor: 'codex-orca',
        node_id: ctx.nodeId,
        ...extra,
      })
      const failed = (code: string, message: string) =>
        finish(ok({ outcome: 'failed', result: result(message, { reason: code }) }))

      let isolationBlock: Promise<void> | undefined
      const blockProjectConfig = async (worktree: string): Promise<boolean> => {
        if (isolationBlock) {
          await isolationBlock
          return true
        }
        if (finished || stopping) return true
        if (!(await requireDirectory(worktree, true))) return true
        const checked = await checkProjectCodexTrust(worktree)
        if (isolationBlock) {
          await isolationBlock
          return true
        }
        if (finished || stopping) return true
        if (checked.ok) return false
        if (!(await requireDirectory(worktree, true))) return true
        isolationBlock ??= (async () => {
          const message = `[${checked.error.code}] ${checked.error.message}`
          status(message, { reason: checked.error.code })
          // 关闭已由本次执行接管的终端；恢复前尚未核对身份的旧 handle 不能直接关闭。
          if (handle) {
            const closed = await orca.terminalClose({ handle })
            if (!closed.ok)
              logger?.warn(`隔离检查失败后关闭终端 ${handle} 失败`, closed.error.message)
          }
          finish(ok({ outcome: 'blocked', reason: 'other', message }))
        })()
        await isolationBlock
        return true
      }

      const missing = (path: string, removed = false): false => {
        if (finished) return false
        const message = `工作目录不存在：${path}`
        if (removed) {
          status(message, {
            out_of_band: {
              id: randomUUID(),
              kind: 'session_removed',
              ...(approvalRound?.command ? { command: redactSecrets(approvalRound.command) } : {}),
              message,
            },
          })
        }
        finish(
          ok({
            outcome: 'blocked',
            reason: 'workdir_missing',
            message,
            tail: redactLines(prevTail).slice(-STUCK_TAIL),
          }),
        )
        return false
      }
      const directoryExists = async (path: string): Promise<boolean | undefined> => {
        while (!finished && !stopping && !ctx.signal.aborted) {
          try {
            return isDirectory(path, options.directoryStat)
          } catch (error) {
            logger?.warn(`目录暂时不可访问，稍后重试：${path}`, (error as Error).message)
            await sleep(clock, pollMs, directoryRetry.signal)
          }
        }
        return undefined
      }
      const requireDirectory = async (path: string, removed: boolean): Promise<boolean> => {
        const exists = await directoryExists(path)
        return exists === true || (exists === false && missing(path, removed))
      }
      const requireWorkdir = async (): Promise<boolean> =>
        !!state && requireDirectory(state.worktree_path, true)
      const requireRepo = (repo: string): Promise<boolean> => requireDirectory(repo, false)

      const stop = async (message: string) => {
        if (finished || stopping) return
        stopping = true
        // 取消：关闭终端，worktree 保留用于排查（由后续清理流程处理）。
        if (handle) {
          const r = await orca.terminalClose({ handle })
          if (!r.ok) logger?.warn(`关闭任务 ${ctx.taskId} 的终端失败`, r.error.message)
        }
        finish(ok({ outcome: 'cancelled', message }))
      }
      const onAbort = () => {
        void stop('codex-orca 已取消：终端已关闭，worktree 保留')
      }

      const statePath = join(taskStateDir(options.home, ctx.taskId), 'orca.json')
      const readState = async (): Promise<OrcaTaskState | undefined> => {
        try {
          const parsed = stateSchema.safeParse(JSON.parse(await readFile(statePath, 'utf8')))
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      }
      /** 串行写入状态文件，避免监控循环与 deliver 并发写。 */
      let saving: Promise<void> = Promise.resolve()
      const saveState = () => {
        const s = state
        if (!s) return saving
        if (approvalRound) s.approval_round = approvalRound
        else delete s.approval_round
        saving = saving
          .catch(() => {})
          .then(async () => {
            await mkdir(taskStateDir(options.home, ctx.taskId), { recursive: true })
            const tmp = `${statePath}.tmp`
            await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`)
            await rename(tmp, statePath)
          })
        return saving
      }
      const replyState = (id: string): ReplyState => {
        if (!state) return {}
        const existing = state.replies[id]
        if (existing) return existing
        const created: ReplyState = {}
        state.replies[id] = created
        return created
      }

      type PrCheck = { pr: { url: string } } | { none: true } | { error: string }
      /** 本任务分支上的 PR（OPEN 或 MERGED）。gh 失败时不猜测：返回错误，由调用方上报。 */
      const checkPr = async (): Promise<PrCheck> => {
        if (!state) return { none: true }
        const branch = state.branch
        if (!(await requireRepo(state.repo))) return { none: true }
        const r = await gh.prList({ cwd: state.repo, branch })
        if (!r.ok && (await directoryExists(state.repo)) === false) {
          missing(state.repo)
          return { none: true }
        }
        if (!r.ok) {
          logger?.warn(`查询分支 ${state.branch} 的 PR 失败`, r.error.message)
          return { error: r.error.message }
        }
        // 只认本仓库、head 正是任务分支的 PR：fork 上的同名分支开出的 PR 不是本任务的产物（D10）。
        const own = r.data.filter((p) => !p.isCrossRepository && p.headRefName === branch)
        if (own.length < r.data.length) {
          logger?.warn(
            `分支 ${branch} 查到不属于本任务的 PR（fork 或分支不符），已忽略`,
            r.data
              .filter((p) => !own.includes(p))
              .map((p) => p.url)
              .join(' '),
          )
        }
        const pr = own.find((p) => p.state === 'OPEN' || p.state === 'MERGED')
        return pr ? { pr: { url: pr.url } } : { none: true }
      }
      const finishWithPr = (pr: { url: string }) => {
        const wt = state?.worktree_path
        finish(
          ok({
            outcome: 'done',
            result: result(`Codex 已开 PR：${pr.url}`, {
              artifacts: [
                { kind: 'pr', ref: pr.url },
                ...(wt
                  ? [
                      {
                        kind: 'other' as const,
                        ref: wt,
                        note: `Orca worktree，分支 ${state?.branch}`,
                      },
                    ]
                  : []),
              ],
            }),
            // 验收命令在 Codex 实际工作的 worktree 中运行（PR #24 审查第 3 条）。
            ...(wt ? { workdir: wt } : {}),
          }),
        )
      }

      /** exited 只证明进程结束；先保留既有 PR 完成判定，再区分目录丢失与进程退出。 */
      const terminalExited = async (term: { status: string; tail: string[] }) => {
        const pr = await checkPr()
        if (finished || stopping) return
        if ('pr' in pr) return finishWithPr(pr.pr)
        if (!(await requireWorkdir())) return
        const ghNote = 'error' in pr ? `；gh 不可用，无法确认 PR：${pr.error}` : ''
        finish(
          ok({
            outcome: 'exited',
            exit_code: null,
            message: `Codex 终端已退出（${term.status}）：${analyzeTail(term.tail).message}${ghNote}`,
          }),
        )
      }

      /**
       * handle 失效（stale）时在本 worktree 中找替代的终端：只有恰好一个且与已记录进程身份匹配的 Codex 终端时才接上。
       * 返回是否换到了新的 handle。
       */
      const relocate = async (): Promise<boolean> => {
        if (!state || !(await requireWorkdir())) return false
        const r = await orca.terminalList({ worktreePath: state.worktree_path })
        if (!r.ok) return false
        const s = state
        // 缺少原进程身份时，唯一候选也可能是用户另开的未隔离 Codex，不能接管。
        if (s.pty_id === undefined && s.incarnation_id === undefined) return false
        // 只考虑仍连接、未成为孤儿的 Codex 终端。
        const codex = r.data.filter(
          (t) =>
            (t.worktreePath === undefined || t.worktreePath === s.worktree_path) &&
            t.agentIdentity === 'codex' &&
            t.orphaned !== true &&
            t.connected !== false,
        )
        const only = codex.length === 1 ? codex[0] : undefined
        const next = only?.handle
        if (!only || !next || next === handle) return false
        // 记录过进程身份时必须一致：不一致（或候选没有该字段）说明不是同一个终端，不接管，继续重试。
        if (s.pty_id !== undefined && only.ptyId !== s.pty_id) return false
        if (s.incarnation_id !== undefined && only.incarnationId !== s.incarnation_id) return false
        status(`终端 handle 已失效，改用同一 worktree 中的 Codex 终端 ${next}`)
        handle = next
        state.handle = next
        await saveState()
        return true
      }

      /** 终端末尾中新出现的行作为 output 上报；没有新内容返回 false。 */
      const emitOutput = (tail: string[]): boolean => {
        const seen = new Set(prevTail.map(normLine))
        prevTail = tail
        const fresh = tail.filter((l) => l.trim() !== '' && !seen.has(normLine(l)))
        if (fresh.length === 0) return false
        // 活动会随续约进入账本：先脱敏（终端里可能出现令牌），再按协议上限截断。
        let text = redactSecrets(fresh.join('\n'))
        if (text.length > 16_000) text = text.slice(-16_000)
        queue.push({ ts: iso(), kind: 'output', text })
        return true
      }

      const send = async (
        input: Parameters<OrcaCli['terminalSend']>[0],
        beforeSend?: () => void | Promise<void>,
      ) => {
        if (!(await requireWorkdir()))
          return fail('failure', 'workdir_missing', `工作目录不存在：${state?.worktree_path}`)
        if (!state || (await blockProjectConfig(state.worktree_path)))
          return fail('failure', 'codex_isolation_blocked', '隔离检查未通过，没有向 Codex 发送输入')
        await beforeSend?.()
        if (!state || (await blockProjectConfig(state.worktree_path)))
          return fail('failure', 'codex_isolation_blocked', '隔离检查未通过，没有向 Codex 发送输入')
        return orca.terminalSend(input)
      }
      const started = (r: OrcaSendResult) =>
        !r.send.prompt || r.send.prompt.stages.includes('turn_started')
      /** 发送失败一律按临时错误处理（stale 也不代表终端已死，见文件头注释）。 */
      const sendOrThrow = async (
        input: Parameters<OrcaCli['terminalSend']>[0],
        beforeSend?: () => void | Promise<void>,
      ) => {
        const r = await send(input, beforeSend)
        if (!r.ok) {
          if (orcaErrorCode(r) === 'terminal_handle_stale') await relocate()
          throw new TransientDeliverError(r.error.message)
        }
        return r.data
      }

      /** 发一段文字并确认 Codex 开始了这一轮（幂等：同一个 request id 不会重发）。 */
      const sendPrompt = async (h: string, text: string, st: ReplyState) => {
        // Esc 后的文字可以重试，但复核回执和补发回车前也不能越过新的授权弹窗。
        const guardPrompt = st.esc_sent
          ? async () => {
              const current = await orca.terminalRead({ handle: h, limit: 200 })
              if (!current.ok) throw new TransientDeliverError(current.error.message)
              if (current.data.status !== 'running') {
                await terminalExited(current.data)
                throw new TransientDeliverError('终端已退出，回复尚未送达')
              }
              const kind = analyzeTail(current.data.tail).kind
              if (kind === 'awaiting_approval' || kind === 'trust_prompt')
                throw new RoundClosedError('拒绝后出现新的授权弹窗，回复尚未送达')
            }
          : undefined
        if (!st.request_id) {
          const r = await sendOrThrow(
            { handle: h, text, enter: true, waitSubmitS: sendWaitS },
            guardPrompt,
          )
          if (!r.send.accepted) throw new TransientDeliverError('Orca 没有接受这次输入')
          const id = r.send.prompt?.requestId
          if (started(r) || !id) return
          st.request_id = id
          await saveState()
        }
        for (let i = 0; i < 2; i++) {
          const r = await send(
            {
              handle: h,
              text,
              enter: true,
              retryRequest: st.request_id,
              waitSubmitS: sendWaitS,
            },
            guardPrompt,
          )
          if (r.ok && started(r.data)) return
        }
        // 输入已被接受但没观察到开始：回车可能被吞掉，补发一次。
        status('终端没有确认这一轮开始，补发一次回车')
        await send({ handle: h, enter: true }, guardPrompt)
      }

      /** 轮询与送达前共用同一判定，防止外部批准恰好发生在两次轮询之间。 */
      const detectOutsideApproval = async (tail: readonly string[]): Promise<boolean> => {
        const pending = approvalRound
        if (!pending?.command || pending.closed || pending.attempted || !pending.reportedApproval)
          return false
        const evidence = approvalExecutionLines(tail, pending.command)
        // 尾部窗口若恰好滚出一条旧记录、又新增相同记录，数量不变时仍会漏报。
        // 计数只用于附加带外审计；屏幕恢复工作后的 resumed 信号照常兜底。
        const fresh = evidence.length > pending.evidence
        pending.evidence = evidence.length
        if (!fresh) return false
        pending.closed = true
        await saveState()
        status('授权在 Raindown 之外被批准', {
          out_of_band: {
            id: pending.request_id,
            kind: 'approval_outside_raindown',
            command: redactSecrets(pending.command),
          },
        })
        reported = false
        idlePolls = 0
        queue.push(resumedSignal(iso(), '待批命令已在 Raindown 之外获准执行'))
        return true
      }

      const doDeliver = async (reply: DeliveredReply): Promise<DeliverResult> => {
        if (!handle || finished || !state) return 'not_running'
        if (!(await requireWorkdir())) return 'not_running'
        const st = replyState(reply.reply_id)
        if (st.done) return 'delivered'
        if (st.dropped)
          return st.drop_reason ? { outcome: 'dropped', reason: st.drop_reason } : 'dropped'
        if (await blockProjectConfig(state.worktree_path)) return 'not_running'
        const round = approvalRound
        if (round && reply.block_seq === round.blockSeq && st.round_id === undefined) {
          st.round_id = round.request_id
          await saveState()
        }
        // 按实时的末尾内容判断（PR #24 审查第 5 条），不用上一次轮询的分析。
        const now = await orca.terminalRead({ handle, limit: 200 })
        if (!now.ok) {
          if (orcaErrorCode(now) === 'terminal_handle_stale') await relocate()
          throw new TransientDeliverError(`读取终端失败：${now.error.message}`)
        }
        if (now.data.status === 'exited') {
          await terminalExited(now.data)
          return 'not_running'
        }
        if (!(await requireWorkdir())) return 'not_running'
        if (now.data.status !== 'running') return 'not_running'
        if (await detectOutsideApproval(now.data.tail)) {
          throw new RoundClosedError('待批命令已在 Raindown 之外获准执行，回复尚未送达')
        }
        const h = handle
        const live = analyzeTail(now.data.tail)
        if (round && approvalFingerprint(live) !== round.fingerprint) {
          round.closed = true
          await saveState()
        }
        if (live.kind === 'trust_prompt') {
          throw new RoundClosedError('Codex 仍在文件夹信任弹窗，不能把回复作为信任确认')
        }
        const approval = live.kind === 'awaiting_approval'
        const prompt = approvalForPrecheck(now.data.tail)
        const bound =
          round !== undefined &&
          !round.closed &&
          round === approvalRound &&
          reply.block_seq !== undefined &&
          reply.block_seq === round.blockSeq &&
          st.round_id === round.request_id &&
          approvalFingerprint(live) === round.fingerprint
        // approve/deny 不得降级成普通文字；在授权弹窗上发送 Esc 的文字回复也受同一回合约束。
        // 跨重启携带的授权回复须重新验证完整回合，不能沿用上个进程的 Esc 中间状态。
        const restoringApproval =
          !resumeReplyHandled &&
          ctx.resume?.reply.reply_id === reply.reply_id &&
          reply.kind !== 'text'
        if (
          (restoringApproval ||
            (!st.esc_sent && (reply.kind !== 'text' || approval || st.round_id !== undefined))) &&
          !bound
        ) {
          // 没有可绑定的授权时也留下记录，同一 reply_id 之后不能改绑到新回合。
          st.round_id ??= 'unbound'
          await saveState()
          throw new RoundClosedError('授权回合已关闭或请求已变化，回复尚未送达')
        }
        const drop = async (): Promise<DeliverResult> => {
          if (round) round.closed = true
          st.dropped = true
          await saveState()
          // 新的卡住直接交给用户：当前弹窗不再预检，监控循环随后照常上报停下。
          prechecked = approval ? live.last_message.join('\n') : undefined
          decision = undefined
          reported = false
          idlePolls = 0
          status(`回复 ${reply.reply_id}（${reply.by} 批准）未送达：待批请求已变化或环境复查未通过`)
          return 'dropped'
        }
        if (reply.kind === 'approve' && reply.by === SUPERVISOR_ACTOR && !prompt) return drop()
        if (reply.kind === 'approve' && ctx.confirmApproval) {
          // D15：放行前重读实时的待批弹窗交给节点复核（supervisor 的批准须与判定时的请求一致、
          // 推送或 gh 环境复查通过）；不一致时不发送任何按键，回复标记为拒收。
          const confirmed = await ctx.confirmApproval(
            reply,
            prompt
              ? {
                  tool: CODEX_ORCA_PRECHECK_TOOL,
                  command: prompt.command,
                  cwd: state.worktree_path,
                }
              : undefined,
          )
          if (finished) return 'not_running'
          if (!confirmed) return drop()
          if (reply.by === SUPERVISOR_ACTOR) {
            // 复核期间界面可能已变：发回车之前再读一次终端，弹窗全文与复核时一致才放行（TOCTOU）。
            if (!(await requireWorkdir())) return 'not_running'
            const again = await orca.terminalRead({ handle: h, limit: 200 })
            if (again.ok && again.data.status === 'exited') {
              await terminalExited(again.data)
              return 'not_running'
            }
            if (finished) return 'not_running'
            const latest =
              again.ok && again.data.status === 'running'
                ? approvalForPrecheck(again.data.tail)
                : undefined
            if (
              !prompt ||
              !latest ||
              latest.prompt.join('\n') !== prompt.prompt.join('\n') ||
              round?.closed ||
              round !== approvalRound
            ) {
              return drop()
            }
          }
        }
        const authorizeKey = async () => {
          const current = await orca.terminalRead({ handle: h, limit: 200 })
          if (!current.ok) throw new TransientDeliverError(current.error.message)
          if (current.data.status !== 'running') {
            await terminalExited(current.data)
            throw new TransientDeliverError('终端已退出，回复尚未送达')
          }
          if (
            !round ||
            round.closed ||
            round !== approvalRound ||
            reply.block_seq !== round.blockSeq ||
            st.round_id !== round.request_id ||
            approvalFingerprint(analyzeTail(current.data.tail)) !== round.fingerprint
          ) {
            if (round) round.closed = true
            throw new RoundClosedError('授权回合已关闭，回复尚未送达')
          }
          // 按键可能已送达但回执超时；从第一次尝试起，执行证据不能再归为带外批准。
          round.attempted = true
          await saveState()
        }
        if (approval && reply.kind === 'approve') {
          // 授权弹窗的默认选项是"Yes, proceed"，只发回车（发 "1" 或 "y" 会被 Orca 拦下）。
          await sendOrThrow({ handle: h, enter: true }, authorizeKey)
        } else {
          if (approval && !st.esc_sent) {
            // 拒绝或文字回复：Esc 选"No, and tell Codex what to do differently"，再把文字作为新一轮发出。
            await sendOrThrow({ handle: h, text: '\u001b' }, authorizeKey)
            st.esc_sent = true
            await saveState()
            await sleep(clock, 1_000)
          }
          const text = replyText(reply)
          if (text) await sendPrompt(h, text, st)
        }
        if (round) round.closed = true
        st.done = true
        await saveState()
        reported = false
        idlePolls = 0
        reemit = true
        status(`已把回复 ${reply.reply_id}（${reply.kind}）送进终端`)
        return 'delivered'
      }

      const deliver = (reply: DeliveredReply): Promise<DeliverResult> => {
        if (finished) return Promise.resolve('not_running')
        if (state?.replies[reply.reply_id]?.done) return Promise.resolve('delivered')
        if (state?.replies[reply.reply_id]?.dropped) {
          const reason = state.replies[reply.reply_id]?.drop_reason
          return Promise.resolve(reason ? { outcome: 'dropped', reason } : 'dropped')
        }
        const running = inflight.get(reply.reply_id)
        if (running) return running
        // 失败后允许重送；已持久化的 request id 与 Esc 状态保证重送不会让 Codex 收到第二次。
        const p = doDeliver(reply)
          .catch(async (error): Promise<DeliverResult> => {
            if (!(error instanceof RoundClosedError)) throw error
            const st = replyState(reply.reply_id)
            st.dropped = true
            st.drop_reason = 'round_closed'
            await saveState()
            status(`这条回复没有送达：${error.message}`)
            return { outcome: 'dropped', reason: 'round_closed' }
          })
          .finally(() => inflight.delete(reply.reply_id))
        inflight.set(reply.reply_id, p)
        return p
      }

      const deliverResumeReply = async () => {
        if (resumeReplyHandled || !ctx.resume) return
        try {
          const delivered = await deliver(ctx.resume.reply)
          if (delivered === 'delivered') resumeReplyHandled = true
          else rejectResumeReply()
        } catch (error) {
          if (!(error instanceof TransientDeliverError)) throw error
          logger?.warn('恢复回复暂时未送达，下一轮重试', error.message)
        }
      }

      /** 停下的是预检过的同一个授权弹窗时，把 supervisor 判定 id 放进 hint（节点核对后上报）。 */
      const decisionHint = (a: TailAnalysis): Record<string, unknown> =>
        decision && a.kind === 'awaiting_approval' && decision.popup === a.last_message.join('\n')
          ? { decision_id: decision.id }
          : {}

      const idleHint = (
        a: TailAnalysis,
        tail: string[],
        extra: Record<string, unknown> = {},
      ): Record<string, unknown> => ({
        kind: a.kind,
        message: a.message,
        tail: redactLines(tail).slice(-STUCK_TAIL),
        ...(approvalRound && approvalFingerprint(a) === approvalRound.fingerprint
          ? { request_id: approvalRound.request_id }
          : {}),
        ...extra,
      })

      /**
       * 对屏幕底部的授权弹窗做策略预检：approved 表示已发回车放行；changed 表示预检期间界面变了，
       * 没有发送任何按键，下一轮重新判定；user 表示交给用户（照常 idle → blocked）。
       */
      const precheckApproval = async (
        tail: readonly string[],
        popup: string,
      ): Promise<'approved' | 'changed' | 'user'> => {
        if (!state || (await blockProjectConfig(state.worktree_path))) return 'user'
        const precheck = ctx.precheck
        if (!precheck) return 'user'
        const p = approvalForPrecheck(tail)
        if (!p) {
          status('授权请求中提取不到可核对的命令，交给用户审批')
          return 'user'
        }
        const verdict = await precheck({
          tool: CODEX_ORCA_PRECHECK_TOOL,
          command: p.command,
          // 命令在 Orca worktree 中执行（D15：节点据此上报 command_cwd、检查推送与 gh 环境）。
          ...(state ? { cwd: state.worktree_path } : {}),
          ...(p.reason ? { reason: p.reason } : {}),
        })
        if (finished || stopping || !handle) return 'user'
        if (!verdict.allow) {
          if (verdict.decision_id !== undefined) decision = { popup, id: verdict.decision_id }
          status(needsUserText(verdict))
          return 'user'
        }
        // 预检期间界面可能已经变了：按实时终端再核对一次，弹窗与命令都一致才发回车。
        const h = handle
        if (!(await requireWorkdir())) return 'user'
        const live = await orca.terminalRead({ handle: h, limit: 200 })
        if (live.ok && live.data.status === 'exited') {
          await terminalExited(live.data)
          return 'user'
        }
        if (finished || stopping) return 'user'
        const again =
          live.ok && live.data.status === 'running'
            ? approvalForPrecheck(live.data.tail)
            : undefined
        if (
          !again ||
          again.command !== p.command ||
          again.prompt.join('\n') !== p.prompt.join('\n')
        ) {
          status('策略预检期间终端界面已变化，没有发送回车，下一轮重新判定')
          return 'changed'
        }
        const sent = await send({ handle: h, enter: true })
        if (!sent.ok) {
          status(redactSecrets(`策略已放行，但发送回车失败，交给用户审批：${sent.error.message}`))
          return 'user'
        }
        status(autoApprovedText(redactSecrets(`执行命令 ${p.command}`), verdict), {
          policy: {
            level: verdict.level,
            actions: verdict.actions,
            tool: CODEX_ORCA_PRECHECK_TOOL,
          },
        })
        return 'approved'
      }

      const monitor = async () => {
        let trustSent = 0
        let readFailures = 0
        while (!finished && !stopping) {
          await sleep(clock, pollMs, ctx.signal)
          if (finished || stopping || !handle || !(await requireWorkdir())) return
          await deliverResumeReply()
          if (finished || stopping) return
          if (!state || (await blockProjectConfig(state.worktree_path))) return
          const r = await orca.terminalRead({ handle, limit: 200 })
          if (finished || stopping) return
          if (!r.ok) {
            if (!(await requireWorkdir())) return
            // stale 只表示 handle 在当前 Orca runtime 中失效，终端可能还活着：先找替代的终端。
            if (orcaErrorCode(r) === 'terminal_handle_stale' && (await relocate())) continue
            // 读失败不算活动：持续失败时由节点的无进展计时兜底。
            if (readFailures++ % 10 === 0) logger?.warn(`读取终端 ${handle} 失败`, r.error.message)
            continue
          }
          readFailures = 0
          const term = r.data
          if (term.status !== 'running') return terminalExited(term)
          if (!(await requireWorkdir())) return
          if (inflight.size === 0) await detectOutsideApproval(term.tail)
          const fresh = emitOutput(term.tail)
          const a = analyzeTail(term.tail)
          const liveApproval = approvalForPrecheck(term.tail)
          const fingerprint = approvalFingerprint(a)
          if (
            approvalRound &&
            !approvalRound.closed &&
            fingerprint !== approvalRound.fingerprint &&
            inflight.size === 0
          ) {
            approvalRound.closed = true
            await saveState()
          }
          if (a.kind !== 'awaiting_approval') {
            prechecked = undefined
            precheckChanges = 0
            precheckSuspended = false
          }
          if (
            decision &&
            (a.kind !== 'awaiting_approval' || decision.popup !== a.last_message.join('\n'))
          ) {
            decision = undefined
          }
          // 恢复回复因临时错误尚未处理时，保留原回合供下轮复试，不用新 request_id 覆盖它。
          if (ctx.resume && !resumeReplyHandled) {
            if (!fresh) queue.push({ ts: iso(), kind: 'heartbeat' })
            continue
          }
          if (a.kind === 'working') {
            seenBusy = true
            idlePolls = 0
            reemit = false
            if (reported) {
              reported = false
              queue.push(resumedSignal(iso(), 'Codex 重新开始工作'))
            }
            if (!fresh) queue.push({ ts: iso(), kind: 'heartbeat' })
            continue
          }
          // 弹窗离开或重新出现：先结束旧阻塞回合，再为当前请求重新上报。
          if (
            reported &&
            ((a.kind === 'awaiting_approval' &&
              (approvalRound?.closed || fingerprint !== approvalRound?.fingerprint)) ||
              (reportedKind === 'awaiting_approval' && a.kind !== 'awaiting_approval'))
          ) {
            reported = false
            idlePolls = 0
            queue.push(resumedSignal(iso(), '原授权弹窗已离开，等待新请求'))
          }
          if (a.kind === 'trust_prompt' && launchedHere && !seenBusy && trustSent < trustRetries) {
            // Codex 0.167 没有不信任继续选项；确认前重查，防止启动后才出现的项目配置被激活。
            if (!state || (await blockProjectConfig(state.worktree_path))) return
            trustSent++
            const s = await send({ handle, enter: true })
            // 信任提示只会出现一次：成功确认过一次就关闭自动确认，只有发送失败时才重试。
            if (s.ok) trustSent = trustRetries
            status(
              s.ok
                ? '已自动确认 Codex 的文件夹信任提示'
                : `自动确认信任提示失败：${s.error.message}`,
            )
            idlePolls = 0
            continue
          }
          if (
            a.kind === 'awaiting_approval' &&
            ctx.precheck &&
            !precheckSuspended &&
            !reported &&
            inflight.size === 0 &&
            prechecked !== a.last_message.join('\n')
          ) {
            // 新的授权弹窗：交给用户之前先问策略引擎（同一个弹窗只问一次）。
            prechecked = a.last_message.join('\n')
            decision = undefined
            const r = await precheckApproval(term.tail, prechecked)
            if (finished || stopping) return
            if (r === 'approved') precheckChanges = 0
            if (r === 'approved' || r === 'changed') {
              if (r === 'changed') {
                prechecked = undefined
                precheckSuspended = ++precheckChanges >= PRECHECK_CHANGE_MAX
              }
              idlePolls = 0
              continue
            }
          }
          idlePolls++
          if (idlePolls >= 2 && !reported) {
            const pr = await checkPr()
            if (finished || stopping) return
            if ('pr' in pr) return finishWithPr(pr.pr)
            reported = true
            reportedKind = a.kind
            if (fingerprint !== undefined) {
              const command = liveApproval?.command
              approvalRound = {
                request_id: randomUUID(),
                fingerprint,
                ...(command ? { command } : {}),
                closed: false,
                attempted: false,
                evidence: command ? approvalExecutionLines(term.tail, command).length : 0,
                // gh_error 时 classify 仍归为 other，但用户回复依然绑定可核对的实时请求。
                reportedApproval: !('error' in pr),
              }
            } else approvalRound = undefined
            await saveState()
            const extra = {
              ...('error' in pr ? { gh_error: pr.error } : {}),
              ...decisionHint(a),
            }
            const text = 'error' in pr ? `Codex 已停下，gh 不可用：${pr.error}` : a.message
            queue.push(idleSignal(iso(), text, idleHint(a, term.tail, extra)))
          } else if (reported && reemit && idlePolls >= 6) {
            reemit = false
            queue.push(idleSignal(iso(), a.message, idleHint(a, term.tail, decisionHint(a))))
          }
        }
      }

      /** 复用记录中的 handle 前确认它仍属于这个 worktree，并且终端还在运行。 */
      const reusable = async (h: string, wt: string): Promise<string[] | undefined> => {
        if (!(await requireWorkdir())) return undefined
        const list = await orca.terminalList({ worktreePath: wt })
        if (!list.ok) return undefined
        const t = list.data.find((x) => x.handle === h)
        if (!t || (t.worktreePath !== undefined && t.worktreePath !== wt)) return undefined
        if (state?.pty_id !== undefined && t.ptyId !== state.pty_id) return undefined
        if (state?.incarnation_id !== undefined && t.incarnationId !== state.incarnation_id) {
          return undefined
        }
        const alive = await orca.terminalRead({ handle: h, limit: 50 })
        if (alive.ok && alive.data.status !== 'running') {
          await terminalExited(alive.data)
          return undefined
        }
        return alive.ok && alive.data.status === 'running' ? alive.data.tail : undefined
      }

      const main = async () => {
        const roles = await loadRoles(options.home)
        if (!roles.ok) return finish(roles)
        const role = roles.data.roles.find((r) => r.name === contract.role)
        if (!role) return failed('unknown_role', `节点上没有角色 ${contract.role}（config/roles/）`)
        const actorEnv = executorRoleEnv(role.name, ctx.env)
        if (!actorEnv.ok) return failed(actorEnv.error.code, actorEnv.error.message)
        const repoR = await resolveTaskRepo(options.home, contract)
        if (!repoR.ok) return failed(repoR.error.code, repoR.error.message)
        const repo = repoR.data
        if (!(await requireRepo(repo))) return
        const scope = codexOrcaInputs.parse(contract.inputs ?? {}).scope

        state = await readState()
        if (state && state.repo !== repo) state = undefined
        approvalRound = state?.approval_round
        if (state && !(await requireWorkdir())) return
        let fresh = false
        if (!state) {
          const base = await baseBranchOf(repo)
          if (finished || stopping || !(await requireRepo(repo))) return
          const wt = await orca.worktreeCreate({
            repo,
            name: ctx.taskId,
            baseBranch: base,
            setup: 'run',
            comment: `raindown 任务 ${ctx.taskId}`,
          })
          if (finished || stopping) return
          if (!wt.ok)
            return failed('worktree_create_failed', `创建 Orca worktree 失败：${wt.error.message}`)
          state = {
            repo,
            worktree_path: wt.data.path,
            branch: (wt.data.branch ?? ctx.taskId).replace(/^refs\/heads\//, ''),
            base_branch: base,
            replies: {},
          }
          fresh = true
          await saveState()
          status(`已创建 worktree ${state.worktree_path}（分支 ${state.branch}，基于 ${base}）`)
        }
        const st = state
        if (!(await requireWorkdir())) return
        // D15：codex-orca 开始时上报任务分支与 worktree（中枢每个任务只记录一次）。等节点采集完仓库快照
        // 再启动 Codex，快照（remote_url 等）反映 worker 改动之前的状态。
        await ctx.reportBranch?.({ branch: st.branch, worktree: st.worktree_path, repo })
        if (finished || stopping) return
        if (fresh) {
          if (!(await requireWorkdir())) return
          const ready = await waitForSetup(st.worktree_path, ctx.signal)
          if (finished || stopping) return
          if (!(await requireWorkdir())) return
          if (!ready.ok) return failed(ready.error.code, ready.error.message)
        }

        const context = await resolveContext(options.home, contract.context)
        const spec = renderTaskSpec({
          taskId: ctx.taskId,
          contract,
          role: { name: role.name, prompt: role.prompt },
          worktree: { path: st.worktree_path, branch: st.branch },
          baseBranch: st.base_branch,
          context,
          ...(scope ? { scope } : {}),
          ...(ctx.resume?.reply.kind === 'text' ? { resume: ctx.resume } : {}),
        })
        const specPath = await writeTaskSpec(options.home, ctx.taskId, spec)
        if (finished || stopping) return

        const isolated = await prepareCodexHome(
          orcaCodexHome(options.home),
          options.codexAuthSource ??
            actorEnv.data.CODEX_HOME ??
            process.env.CODEX_HOME ??
            join(homedir(), '.codex'),
        )
        if (!isolated.ok) return failed(isolated.error.code, isolated.error.message)
        if (finished || stopping) return

        // 每次派工都检查，包含已运行终端的恢复；worker 上轮可能自行创建了项目配置。
        if (await blockProjectConfig(st.worktree_path)) return

        // 上一次执行留下的终端仍在运行且属于这个 worktree：接着用它，把带来的回复送进去。
        if (st.handle) {
          const tail = await reusable(st.handle, st.worktree_path)
          if (finished || stopping) return
          if (tail) {
            // 无法改变存活进程的 CODEX_HOME；升级前的终端不能通过重挂接绕过隔离。
            if (!(await sameCodexHome(st.codex_home, isolated.data)))
              return failed(
                'codex_home_mismatch',
                '已有 Codex 终端未使用当前隔离目录；请先关闭旧终端后重试',
              )
            handle = st.handle
            prevTail = tail
            status(`接着使用已有的终端 ${handle}`)
            await deliverResumeReply()
          }
        }
        if (!handle) {
          if (ctx.resume?.reply.kind === 'text') resumeReplyHandled = true
          else rejectResumeReply()
          if (approvalRound) {
            approvalRound.closed = true
            await saveState()
          }
          if (!(await requireWorkdir())) return
          const cmd = buildCodexCommand({
            codexBin,
            codexHome: isolated.data,
            worktreePath: st.worktree_path,
            specPath,
            task: { id: ctx.taskId, workspace: contract.workspace, home: options.home },
            role,
          })
          if (!cmd.ok) return failed(cmd.error.code, cmd.error.message)
          const title = `[Raindown] ${ctx.taskId}`
          const term = await orca.terminalCreate({
            worktreePath: st.worktree_path,
            command: cmd.data,
            title,
          })
          if (finished || stopping) {
            if (term.ok) await orca.terminalClose({ handle: term.data.handle })
            return
          }
          if (!term.ok)
            return failed('terminal_create_failed', `创建 Orca 终端失败：${term.error.message}`)
          handle = term.data.handle
          // 另一个同仓库任务可能刚写入共享信任记录，本终端可能已跳过信任弹窗。
          if (await blockProjectConfig(st.worktree_path)) return
          launchedHere = true
          st.handle = handle
          st.codex_home = isolated.data
          if (term.data.ptyId) st.pty_id = term.data.ptyId
          else delete st.pty_id
          if (term.data.incarnationId) st.incarnation_id = term.data.incarnationId
          else delete st.incarnation_id
          await saveState()
          status(`已在终端 ${handle} 中启动 Codex`)
        }
        await monitor()
      }

      if (ctx.signal.aborted) onAbort()
      else {
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        main().catch((err) =>
          finish(
            fail('failure', 'executor_error', `codex-orca 执行器出错：${(err as Error).message}`),
          ),
        )
      }

      return {
        activity: queue as AsyncIterable<Activity>,
        done,
        cancel: () => stop('codex-orca 已取消：终端已关闭，worktree 保留'),
        deliver,
        bindBlocked(binding) {
          if (approvalRound?.request_id === binding.request_id) {
            approvalRound.blockSeq = binding.seq
            void saveState()
          }
        },
      }
    },
  }
}
