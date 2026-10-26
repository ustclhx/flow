import {
  type AskUserRequest,
  clipText,
  defaultSupervisorConfig,
  fail,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxItemView,
  type InboxVia,
  ok,
  type Result,
  resolveInboxLevel,
} from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'
import { oneLine, type SupervisorToolsDeps } from './common.ts'

/**
 * supervisor 提问（design D11；inbox spec "supervisor 提问条目"；tasks 4.4）。
 *
 * - `ask_user`：创建 `source: supervisor` 的条目（默认 Decide），`source_ref` 为唤醒任务 id，动作 `reply`，
 *   有选项时附在条目上（渠道显示为按钮）。提问不挂起唤醒任务。
 * - 用户回复（`inbox_act reply`、Telegram 回复或点选项、Web）：条目以 `answered` 关闭，同一事务写
 *   `supervisor.answered{item_id, text, via}`（actor user）。**唤醒调度器（G10）消费这条事件**。
 * - 7 天未回答：条目以 `expired` 关闭（actor hub）。**这条 `inbox.item_closed{reason: expired}`
 *   （`source: supervisor` 的条目）就是唤醒事件**：调度器据此唤醒一次，origin 取提问所在唤醒
 *   （条目的 `source_ref`）的 origin。
 */

/** 提问过期时间：7 天。 */
export const QUESTION_TTL_MS = 7 * 24 * 3600 * 1000

/** 提问条目 id：`ask.<唤醒任务 id>.<序号>`（确定性，同一唤醒内按提问先后递增）。 */
export const questionItemId = (wakeTaskId: string, n: number) => `ask.${wakeTaskId}.${n}`

export async function askUser(
  deps: SupervisorToolsDeps,
  wake: WakeCaller,
  input: AskUserRequest,
): Promise<Result<{ item: InboxItemView }>> {
  const { ledger } = deps
  const ws = await deps.workspaces(input.workspace)
  if (!ws) return fail('failure', 'unknown_workspace', `workspace ${input.workspace} 未定义`)
  const limit = (ws.supervisor ?? defaultSupervisorConfig()).limits.open_questions
  // 以下到 append 都是同步代码：并发的提问不能各自通过上限检查后一起写入。
  const open = ledger.listInboxItems({
    source: 'supervisor',
    state: 'open',
    workspace: input.workspace,
    limit: -1,
  })
  if (open.length >= limit) {
    return fail(
      'failure',
      'too_many_questions',
      `${input.workspace} 已有 ${open.length} 条未回答的提问，达到上限 ${limit}（supervisor.limits.open_questions）`,
      { open: open.length, max: limit },
    )
  }
  const mine = ledger
    .listInboxItems({ source: 'supervisor', workspace: input.workspace, limit: -1 })
    .filter((i) => i.source_ref === wake.task_id).length
  const id = questionItemId(wake.task_id, mine + 1)
  const options = input.options
  const body = [
    input.question,
    ...(options ? ['', '可选答复：', ...options.map((o, i) => `${i + 1}. ${o}`)] : []),
    '',
    `（来自 supervisor 唤醒 ${wake.task_id}；回复即答复，提问 7 天未答复会过期）`,
  ].join('\n')
  const r = ledger.append(
    {
      type: 'inbox.item_created',
      workspace: input.workspace,
      payload: {
        item_id: id,
        level: resolveInboxLevel(deps.levels(), {
          source: 'supervisor',
          workspace: input.workspace,
        }),
        source: 'supervisor',
        source_ref: wake.task_id,
        title: clipText(
          `[${input.workspace}] supervisor 提问：${oneLine(input.question, 150)}`,
          INBOX_TITLE_MAX,
        ),
        body: clipText(body, INBOX_BODY_MAX),
        actions: ['reply'],
        ...(options ? { options } : {}),
      },
    },
    { actor: 'hub' },
  )
  if (!r.ok) return r
  const item = ledger.getInboxItem(id)
  return item ? ok({ item }) : fail('failure', 'internal_error', '提问条目写入后不可见')
}

/**
 * 用户答复提问：条目以 `answered` 关闭并写 `supervisor.answered`（同一事务，actor user）。
 * 只由收件箱操作入口（`actOnInbox`，已核对身份为 user）调用。
 */
export function answerQuestion(
  ledger: LedgerStore,
  item: InboxItemView,
  text: string | undefined,
  via: InboxVia,
): Result<null> {
  if (item.source !== 'supervisor' || item.workspace === null) {
    return fail('failure', 'action_not_available', '条目不是 supervisor 的提问')
  }
  const answer = text?.trim()
  if (!answer) return fail('usage', 'invalid_arguments', '答复内容不能为空')
  if (answer.length > INBOX_BODY_MAX) {
    return fail('usage', 'invalid_arguments', `答复最多 ${INBOX_BODY_MAX} 字符`)
  }
  const r = ledger.appendMany(
    [
      {
        type: 'inbox.item_closed',
        workspace: item.workspace,
        payload: { item_id: item.id, reason: 'answered', cause_actor: 'user', via },
      },
      {
        type: 'supervisor.answered',
        workspace: item.workspace,
        payload: { item_id: item.id, text: answer, via },
      },
    ],
    { actor: 'user' },
  )
  return r.ok ? ok(null) : r
}

/** 关闭 7 天未答复的提问（`expired`，actor hub）；返回关闭的条目 id。逐条写，单条失败不影响其他。 */
export function expireQuestions(
  ledger: LedgerStore,
  now: number,
  ttlMs = QUESTION_TTL_MS,
): string[] {
  const closed: string[] = []
  for (const item of ledger.listInboxItems({ source: 'supervisor', state: 'open', limit: -1 })) {
    if (Date.parse(item.created_at) > now - ttlMs) continue
    const r = ledger.append(
      {
        type: 'inbox.item_closed',
        ...(item.workspace ? { workspace: item.workspace } : {}),
        payload: { item_id: item.id, reason: 'expired', note: '提问 7 天未答复，已过期' },
      },
      { actor: 'hub' },
    )
    if (r.ok) closed.push(item.id)
  }
  return closed
}
