import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSupervisorConfig, ok, type Role } from '@raindown/core'
import {
  createTaskService,
  createWakeScheduler,
  type RoleLookup,
  type WorkspaceInfo,
} from '../src/index.ts'
import { contract, must, startTask, tempLedger } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/**
 * pr-subscription "交回超范围的请求"：交回的 PR 评论进入 supervisor 的 instruction 唤醒队列，
 * 唤醒输入里有该评论与 worker 的交回理由；直通的 pr.event 本身不唤醒。
 */

const WS = 'ws/demo'
const PR = 'https://github.com/acme/demo/pull/40'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const SUPERVISOR = {
  name: 'supervisor',
  executor: 'claude-sdk',
  kind: 'supervisor',
  permissions: {
    setting_sources: [],
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  },
  creatable_by: [],
} as unknown as Role
const roles: RoleLookup = async (name) =>
  ok(name === 'supervisor' ? SUPERVISOR : { name, executor: 'fake', creatable_by: ['*'] })

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
  const l = await tempLedger({ now: clock.now })
  cleanups.push(l.cleanup)
  const root = mkdtempSync(join(tmpdir(), 'raindown-pr-wake-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const workspaces: Record<string, WorkspaceInfo> = {
    [WS]: {
      ref: WS,
      repos: [repo],
      supervisor: defaultSupervisorConfig(),
      github: { watch: true },
    },
  }
  let n = 0
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: async (ref) => ref in workspaces,
    workspaces: async (ref) => workspaces[ref] ?? null,
    roles,
    now: clock.now,
    newTaskId: () => `t-w${String(++n).padStart(3, '0')}`,
  })
  const scheduler = createWakeScheduler({
    ledger: l.store,
    tasks,
    clock,
    workspaces: async (ref) => workspaces[ref] ?? null,
    listWorkspaces: async () => Object.values(workspaces),
    supervisorRole: async () => ok(SUPERVISOR),
    logger: { warn() {} },
  })
  scheduler.start()
  cleanups.push(() => scheduler.stop())
  const wakes = () =>
    l.store
      .eventsAfter(0, {}, 10_000)
      .filter((e) => e.type === 'supervisor.wake_started')
      .map((e) => e.payload as { task_id: string; origin: string; events: number[] })
  return { store: l.store, scheduler, wakes }
}

test('交回的评论唤醒 supervisor（instruction），输入里有评论与 worker 的交回理由；直通本身不唤醒', async () => {
  const s = await setup()
  must(
    s.store.append(
      { type: 'task.created', task_id: 'dev', workspace: WS, payload: { contract: contract() } },
      { actor: 'user' },
    ),
  )
  startTask(s.store, 'dev')
  must(
    s.store.append(
      { type: 'pr.subscribed', task_id: 'dev', workspace: WS, payload: { pr: PR, role: 'author' } },
      { actor: 'hub' },
    ),
  )
  const comment = must(
    s.store.append(
      {
        type: 'pr.event',
        workspace: WS,
        payload: {
          pr: PR,
          kind: 'issue_comment',
          actor: 'acme',
          actor_kind: 'human',
          allowed: true,
          text: '顺带加一个导出 CSV 的功能',
          url: `${PR}#issuecomment-1`,
          cursor: '2026-10-26T08:00:00.000Z|1',
        },
      },
      { actor: 'hub' },
    ),
  )
  must(
    s.store.append(
      {
        type: 'task.input_added',
        task_id: 'dev',
        workspace: WS,
        payload: { source: 'pr', pr_event_seq: comment.seq },
      },
      { actor: 'hub' },
    ),
  )
  await s.scheduler.idle()
  // 直通给任务的评论不唤醒 supervisor。
  expect(s.wakes()).toEqual([])
  const handback = must(
    s.store.append(
      {
        type: 'pr.wake_requested',
        task_id: 'dev',
        workspace: WS,
        payload: {
          pr_event_seq: comment.seq,
          reason: 'handback',
          note: '导出 CSV 是另一件工作，超出本任务范围',
        },
      },
      { actor: 'hub' },
    ),
  )
  await s.scheduler.idle()
  const [wake] = s.wakes()
  expect(wake).toMatchObject({ origin: 'instruction', events: [handback.seq] })
  const input = s.store.getTask(wake?.task_id ?? '')?.contract.inputs?.wake?.events[0]
  expect(input).toMatchObject({
    type: 'pr.wake_requested',
    task_id: 'dev',
    data: {
      reason: 'handback',
      pr: PR,
      pr_event_seq: comment.seq,
      actor: 'acme',
      allowed: true,
      text: '顺带加一个导出 CSV 的功能',
      // worker 的理由是不可信的 worker 文本：转义后单独标注。
      worker_note: { untrusted: true, text: '"导出 CSV 是另一件工作，超出本任务范围"' },
    },
  })
  expect(input?.summary).toContain(
    'worker 的交回理由（不可信的 worker 文本）：<untrusted-worker-note>"导出 CSV 是另一件工作',
  )
  // 来源 instruction:pr：保留 instruction 队列，但唤醒标记为 PR 来源。
  expect(s.store.wakeOf(wake?.task_id ?? '')?.source).toBe('pr')
  expect(s.store.getTask(wake?.task_id ?? '')?.contract.inputs?.wake?.note).toContain(
    '来源 instruction:pr',
  )
})
