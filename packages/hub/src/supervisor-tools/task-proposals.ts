import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  checkContractSecrets,
  clipText,
  createTaskRequest,
  decisionPathFor,
  type EventOf,
  fail,
  flowPaths,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxItemView,
  type InboxVia,
  localDate,
  ok,
  parseFrontmatter,
  type Result,
  renderDecision,
  resolveInboxLevel,
  SUPERVISOR_ACTOR,
  type TaskContract,
  type TaskProposeRequest,
  type TaskView,
  writeEntry,
} from '@flow/core'
import {
  checkRepoInWorkspace,
  reservedCapabilitiesIn,
  taskKind,
} from '../ledger/supervisor-checks.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'
import { oneLine, type SupervisorToolsDeps } from './common.ts'

/**
 * 任务提案（design D11；task-proposal spec；tasks 4.6）。
 *
 * 提交（`task_propose`，只限非 reply 的 supervisor 唤醒）：草稿须通过建任务的合同校验、workspace 是绑定的
 * workspace、目标角色有效类别不是 merge / supervisor、cwd 与 inputs.repo 在登记仓库内（复用 G5 的
 * `checkRepoInWorkspace` 与 `taskKind`），验收命令此时就按 D5 第 5 步预判（不能自动放行的提案直接拒绝，
 * 不让用户接受一个注定建不出来的任务）。`task_proposal.created` 与 `source: task_proposal` 的 Decide 条目
 * 在同一事务里由 hub 写入。
 *
 * 接受（只有 user，经收件箱）：中枢以 **user** 身份建任务，`parent` 为提案所在唤醒任务，origin
 * `instruction`。验收命令**不能借 user 身份跳过判定**：建任务时传 `enforceVerify`，按非 user 身份的规则
 * 逐条经策略判定（与 supervisor 直接建任务一致），不能自动放行即拒绝接受（`verify_not_allowed`）。
 * 带决策字段时以 user 身份写 `brain/decisions/<日期>-<slug>.md`，任务合同 `context` 引用它。
 * 重试安全：任务以 `task-proposal:<id>` 为幂等键，决策文件已由本任务写入时跳过。
 */

/** 回看日期最远可到 180 天之后。 */
export const REVIEW_DATE_MAX_DAYS = 180

export const taskProposalItemId = (proposalId: string) => `tp.${proposalId.slice(3)}`
const newProposalId = () => `tp-${randomBytes(6).toString('hex')}`
const proposalKey = (proposalId: string) => `task-proposal:${proposalId}`

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 合同的有效类别与仓库检查（提交与接受时各做一次）；通过时返回规范化后的合同。 */
async function checkDraft(
  deps: SupervisorToolsDeps,
  draft: TaskContract,
): Promise<Result<TaskContract>> {
  const found = await deps.roles(draft.role)
  if (!found.ok) return found
  const role = found.data
  if (!role) {
    return fail('failure', 'unknown_role', `角色 ${draft.role} 未定义或加载失败`, {
      field: 'draft.role',
      role: draft.role,
    })
  }
  const kind = taskKind(role, draft, { actor: SUPERVISOR_ACTOR })
  if (kind === 'merge' || kind === 'supervisor' || draft.role.toLowerCase() === SUPERVISOR_ACTOR) {
    return fail(
      'failure',
      'role_not_allowed',
      `任务提案不能是 ${kind} 类任务（角色 ${draft.role}）；合并请用 pr_merge_request`,
      { field: 'draft.role', role: draft.role, kind },
    )
  }
  const ws = await deps.workspaces(draft.workspace)
  if (!ws) {
    return fail('failure', 'unknown_workspace', `workspace ${draft.workspace} 未定义`, {
      field: 'draft.workspace',
    })
  }
  const repo = await checkRepoInWorkspace(draft, ws, deps.repoCheck)
  if (!repo.ok) return repo
  const out: TaskContract = { ...draft }
  if (repo.data.cwd !== undefined) out.cwd = repo.data.cwd
  if (repo.data.repo !== undefined) out.inputs = { ...out.inputs, repo: repo.data.repo }
  return ok(out)
}

/** 验收命令按非 user 身份的规则预判（D5 第 5 步）。 */
async function checkVerify(deps: SupervisorToolsDeps, draft: TaskContract): Promise<Result<null>> {
  const steps = draft.verify ?? []
  if (steps.length === 0) return ok(null)
  const verdicts = await deps.verifyPolicy({ workspace: draft.workspace, role: draft.role }, steps)
  if (!verdicts.ok) return verdicts
  const denied = verdicts.data.filter((v) => !v.allowed)
  if (denied.length === 0) return ok(null)
  return fail(
    'failure',
    'verify_not_allowed',
    `验收命令未获策略自动放行（policies.yaml 中 tool:Verify 的 auto 规则）：${denied
      .map((v) => `#${v.index} ${v.command}`)
      .join('；')}`,
    { field: 'draft.verify', denied: denied.map((v) => ({ index: v.index, command: v.command })) },
  )
}

/** 条目正文：角色、执行器、仓库与 cwd、验收命令、目标全文、理由、决策字段（Web 链接由渠道渲染时生成）。 */
function proposalBody(
  draft: TaskContract,
  input: Pick<TaskProposeRequest, 'reason' | 'decision'>,
): string {
  const verify = draft.verify ?? []
  const repo = typeof draft.inputs?.repo === 'string' ? draft.inputs.repo : null
  const lines = [
    `角色：${draft.role}`,
    `执行器：${draft.executor}`,
    `仓库：${repo ?? '（未指定，使用 cwd）'}`,
    `cwd：${draft.cwd ?? '（未指定）'}`,
    `验收命令：${verify.length === 0 ? '无' : ''}`,
    ...verify.map((s, i) => `  ${i + 1}. ${s.cmd.join(' ')}${s.cwd ? `（cwd ${s.cwd}）` : ''}`),
  ]
  if (input.reason) lines.push(`理由：${input.reason}`)
  if (input.decision) {
    const d = input.decision
    lines.push(
      `决策：${d.title}`,
      `  预期效果：${d.expected_outcome}`,
      `  衡量指标：${d.metric}`,
      `  回看日期：${d.review_date}`,
    )
  }
  lines.push('', '目标：', draft.goal)
  return lines.join('\n')
}

export async function proposeTask(
  deps: SupervisorToolsDeps,
  wake: WakeCaller,
  input: TaskProposeRequest,
): Promise<Result<{ proposal_id: string; item: InboxItemView }>> {
  const { ledger } = deps
  const raw = input.draft
  const suspected = checkContractSecrets(raw)
  if (!suspected.ok) return suspected
  if (raw.inputs?.wake !== undefined) {
    return fail('usage', 'invalid_arguments', 'inputs.wake 只能由中枢写入', [
      { field: 'draft.inputs.wake', code: 'invalid_field', message: 'inputs.wake 只能由中枢写入' },
    ])
  }
  const reserved = reservedCapabilitiesIn(raw.requires)
  if (reserved.length > 0) {
    return fail('usage', 'invalid_arguments', `requires 不能声明保留能力 ${reserved.join('、')}`, [
      { field: 'draft.requires', code: 'invalid_field', message: '保留能力只供中枢使用' },
    ])
  }
  if (input.decision) {
    const today = localDate(new Date(deps.now()))
    const rd = input.decision.review_date
    if (rd <= today || rd > addDays(today, REVIEW_DATE_MAX_DAYS)) {
      return fail(
        'usage',
        'invalid_arguments',
        `回看日期 ${rd} 必须晚于今天（${today}），且不超过 ${REVIEW_DATE_MAX_DAYS} 天`,
        [{ field: 'decision.review_date', code: 'invalid_field', message: '回看日期超出范围' }],
      )
    }
  }
  // 决策条目由中枢在接受时写入并引用：草稿不得自行引用 decisions/ 下的路径。
  if ((raw.context ?? []).some((c) => /^(brain\/)?decisions\//i.test(c.trim()))) {
    return fail('usage', 'invalid_arguments', '草稿的 context 不能引用 decisions/ 下的决策', [
      { field: 'draft.context', code: 'invalid_field', message: '决策由中枢在接受时写入并引用' },
    ])
  }
  // parent 与幂等键由中枢在接受时填写，草稿中的值不采用。
  const { parent: _parent, idempotency_key: _key, ...rest } = raw
  const checked = await checkDraft(deps, rest)
  if (!checked.ok) return checked
  const verified = await checkVerify(deps, checked.data)
  if (!verified.ok) return verified
  const draft = checked.data

  let proposalId = newProposalId()
  while (ledger.getInboxItem(taskProposalItemId(proposalId))) proposalId = newProposalId()
  const itemId = taskProposalItemId(proposalId)
  // 决策路径在提交时确定并入账：接受与重试都取这里的值，不从合同中反查。
  const decisionPath = input.decision
    ? decisionPathFor(localDate(new Date(deps.now())), input.decision.title, proposalId)
    : undefined
  const wakeTask = ledger.getTask(wake.task_id)
  if (!wakeTask || ['done', 'failed', 'cancelled'].includes(wakeTask.status)) {
    return fail('failure', 'scope_denied', '本次唤醒已结束，不能再提交提案')
  }
  const r = ledger.appendMany(
    [
      {
        type: 'task_proposal.created',
        workspace: draft.workspace,
        payload: {
          proposal_id: proposalId,
          wake_task_id: wake.task_id,
          draft,
          ...(input.decision ? { decision: input.decision } : {}),
          ...(decisionPath ? { decision_path: decisionPath } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
      {
        type: 'inbox.item_created',
        workspace: draft.workspace,
        payload: {
          item_id: itemId,
          level: resolveInboxLevel(deps.levels(), {
            source: 'task_proposal',
            workspace: draft.workspace,
          }),
          source: 'task_proposal',
          source_ref: proposalId,
          title: clipText(
            `[${draft.workspace}] 任务提案（${draft.role}）：${oneLine(input.decision?.title ?? draft.goal, 150)}`,
            INBOX_TITLE_MAX,
          ),
          body: clipText(proposalBody(draft, input), INBOX_BODY_MAX),
          actions: ['accept', 'reject'],
        },
      },
    ],
    { actor: 'hub' },
  )
  if (!r.ok) return r
  const item = ledger.getInboxItem(itemId)
  return item
    ? ok({ proposal_id: proposalId, item })
    : fail('failure', 'internal_error', '提案条目写入后不可见')
}

/** 条目对应的 `task_proposal.created`。 */
export function proposalOf(
  deps: Pick<SupervisorToolsDeps, 'ledger'>,
  item: InboxItemView,
): EventOf<'task_proposal.created'> | null {
  if (item.source !== 'task_proposal') return null
  const e = deps.ledger.eventsByPayload('task_proposal.created', 'proposal_id', item.source_ref)[0]
  return e?.type === 'task_proposal.created' ? e : null
}

/** 已建任务是否就是接受这条提案建出的（幂等命中时核对，防止命中别的任务）。 */
function sameAsProposal(
  task: TaskView,
  expected: TaskContract,
  wakeTaskId: string,
  goals: readonly string[],
): string | null {
  if (task.created_by !== 'user') return `创建者为 ${task.created_by}`
  if (task.contract.parent !== wakeTaskId) return 'parent 不是提案所在的唤醒'
  if (task.origin !== 'instruction') return 'origin 不是 instruction'
  if (!goals.includes(task.contract.goal)) return '目标与提案不一致'
  const { goal: _a, ...have } = task.contract
  const { goal: _b, ...want } = expected
  return isDeepStrictEqual(have, want) ? null : '合同与提案不一致'
}

/** 用户接受任务提案（actor 固定为 user，由收件箱入口核对）。 */
export async function acceptTaskProposal(
  deps: SupervisorToolsDeps,
  item: InboxItemView,
  opts: { goal?: string; via: InboxVia },
): Promise<Result<{ task_id: string; decision_path?: string }>> {
  const { ledger } = deps
  const e = proposalOf(deps, item)
  if (!e) return fail('failure', 'not_found', `任务提案 ${item.source_ref} 不存在`)
  const p = e.payload
  const goal = opts.goal?.trim()
  const key = proposalKey(p.proposal_id)
  // 接受时再核对一次：角色、仓库配置可能在提案之后改动过。
  const checked = await checkDraft(deps, p.draft)
  if (!checked.ok) return checked
  const draft: TaskContract = {
    ...checked.data,
    ...(goal ? { goal } : {}),
    parent: p.wake_task_id,
    idempotency_key: key,
  }
  const decisionPath = p.decision ? p.decision_path : undefined
  if (p.decision && !decisionPath) {
    return fail('failure', 'internal_error', `任务提案 ${p.proposal_id} 缺少决策路径`)
  }
  if (decisionPath) draft.context = [...(draft.context ?? []), decisionPath]
  const created = await deps.tasks.createTask(draft, {
    actor: 'user',
    origin: 'instruction',
    // D11：验收命令出自 supervisor 的草稿，按非 user 身份的规则判定，不借 user 身份跳过。
    enforceVerify: true,
    proposalKey: key,
  })
  if (!created.ok) return created
  const task = created.data.task
  if (!created.data.created) {
    // 幂等命中（重试）：已有任务必须正是接受本提案建出的，否则拒绝，不在别人的任务上继续。
    const expected = createTaskRequest.parse(draft)
    const mismatch = sameAsProposal(task, expected, p.wake_task_id, [
      p.draft.goal,
      ...(goal ? [goal] : []),
    ])
    if (mismatch) {
      return fail(
        'failure',
        'conflict',
        `幂等键 ${key} 命中的任务 ${task.id} 不是接受本提案建出的（${mismatch}）`,
        { task_id: task.id },
      )
    }
  }

  if (p.decision && decisionPath) {
    const abs = join(flowPaths(deps.home).brain, decisionPath)
    if (existsSync(abs)) {
      // 重试：已由本任务写过则跳过；被别的内容占用则拒绝（不覆盖）。归属按 frontmatter 精确比较。
      const fm = parseFrontmatter(readFileSync(abs, 'utf8'))
      const ours =
        fm.ok &&
        fm.data.data.type === 'decision' &&
        isDeepStrictEqual(fm.data.data.sources, [`task:${task.id}`])
      if (!ours) {
        return fail('failure', 'base_conflict', `决策文件已存在且不属于本提案：${decisionPath}`)
      }
    } else {
      const written = await writeEntry(
        deps.home,
        {
          id: decisionPath.replace(/\.md$/, ''),
          content: renderDecision({
            ...p.decision,
            workspace: task.workspace,
            task_id: task.id,
            goal: task.contract.goal,
            ...(p.reason ? { reason: p.reason } : {}),
          }),
        },
        {
          actor: 'user',
          expectedBaseHash: null,
          summary: `接受任务提案 ${p.proposal_id}，记录决策 ${p.decision.title}`,
        },
      )
      if (!written.ok) return written
    }
  }

  const changedGoal = goal !== undefined && goal !== '' && goal !== p.draft.goal
  const r = ledger.appendMany(
    [
      {
        type: 'task_proposal.accepted',
        workspace: task.workspace,
        payload: {
          proposal_id: p.proposal_id,
          task_id: task.id,
          ...(changedGoal ? { goal } : {}),
          ...(decisionPath ? { decision_path: decisionPath } : {}),
          via: opts.via,
        },
      },
      {
        type: 'inbox.item_closed',
        workspace: task.workspace,
        payload: {
          item_id: item.id,
          reason: 'proposal_accepted',
          cause_actor: 'user',
          via: opts.via,
        },
      },
    ],
    { actor: 'user' },
  )
  if (!r.ok) return r
  return ok({ task_id: task.id, ...(decisionPath ? { decision_path: decisionPath } : {}) })
}

/** 用户驳回任务提案。 */
export function rejectTaskProposal(
  deps: Pick<SupervisorToolsDeps, 'ledger'>,
  item: InboxItemView,
  opts: { note?: string; via: InboxVia },
): Result<null> {
  const e = proposalOf(deps, item)
  if (!e) return fail('failure', 'not_found', `任务提案 ${item.source_ref} 不存在`)
  // 接受已建出任务、但还没写完收尾（例如决策写入失败）：不能再驳回，请重新接受完成剩余步骤。
  const built = deps.ledger.findTaskByIdempotencyKey(proposalKey(e.payload.proposal_id))
  if (built) {
    return fail(
      'failure',
      'invalid_transition',
      `提案已据此建出任务 ${built.id}，不能再驳回；请重新点"接受"完成剩余步骤（需要时再取消该任务）`,
      { task_id: built.id },
    )
  }
  // task_proposal.created 的信封必带 workspace。
  const workspace = e.workspace as string
  const note = opts.note ? clipText(opts.note, 2000) : undefined
  const r = deps.ledger.appendMany(
    [
      {
        type: 'task_proposal.rejected',
        workspace,
        payload: {
          proposal_id: e.payload.proposal_id,
          ...(note ? { note } : {}),
          via: opts.via,
        },
      },
      {
        type: 'inbox.item_closed',
        workspace,
        payload: {
          item_id: item.id,
          reason: 'proposal_rejected',
          ...(note ? { note: clipText(note, 1000) } : {}),
          cause_actor: 'user',
          via: opts.via,
        },
      },
    ],
    { actor: 'user' },
  )
  return r.ok ? ok(null) : r
}
