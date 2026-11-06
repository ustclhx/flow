import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from '@raindown/core'
import { openLedger } from '../src/index.ts'
import { contract, drafts, must, result, startTask, sys, tempLedger, WS } from './ledger-helpers.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
const PR = 'https://github.com/acme/repo/pull/31'

test('PR索引覆盖合同与历史终态产物，重试、重放与旧库初始化保持一致', async () => {
  const env = await tempLedger()
  cleanups.push(env.cleanup)
  const { store } = env
  for (const [id, inputs] of [
    ['developer', undefined],
    ['reviewer', { review: { pr: PR } }],
    ['merger', { pr: PR }],
  ] as const) {
    must(
      store.append(
        {
          type: 'task.created',
          task_id: id,
          workspace: WS,
          payload: {
            contract: contract({ inputs, role: id === 'reviewer' ? '审查😀' : 'developer' }),
          },
        },
        sys,
      ),
    )
  }
  must(
    store.append(
      {
        type: 'task.created',
        task_id: 'other-workspace',
        workspace: 'ws/other',
        payload: { contract: contract({ workspace: 'ws/other', inputs: { review: { pr: PR } } }) },
      },
      sys,
    ),
  )
  startTask(store, 'developer')
  must(
    store.append(
      {
        type: 'task.failed',
        task_id: 'developer',
        workspace: WS,
        payload: { result: { ...result(), artifacts: [{ kind: 'pr', ref: PR }] } },
      },
      sys,
    ),
  )
  must(store.append(drafts('developer')['task.requeued:manual'], sys))
  startTask(store, 'developer', 2)
  must(store.append(drafts('developer')['task.done'], sys))
  const ids = () =>
    store.tasksForPr(WS, 'https://WWW.GitHub.com:443/Acme/Repo/pull/31', 10).map((task) => task.id)
  expect(ids()).toEqual(['merger', 'reviewer', 'developer'])
  expect(store.taskPrs('developer')).toEqual([PR])
  const summaries = store
    .tasksForPr(WS, PR)
    .map((task) => ({ id: task.id, role: task.contract.role, status: task.status }))
  expect(store.prTasksSummary(WS, PR)).toEqual({
    count: 3,
    chars: JSON.stringify(summaries).length,
  })
  expect(
    store.listTasks({ workspace: WS, pr: PR, offset: 1, limit: 1 }).map((task) => task.id),
  ).toEqual(['reviewer'])
  const before = store.snapshot().task_prs
  must(store.rebuild())
  expect(store.snapshot().task_prs).toEqual(before)
  expect(ids()).toEqual(['merger', 'reviewer', 'developer'])
  store.close()
  const db = await openDatabase(env.path)
  db.exec('DROP TABLE task_prs')
  db.close()
  const upgraded = await openLedger(env.path)
  cleanups.push(() => upgraded.close())
  expect(upgraded.snapshot().task_prs).toEqual(before)
  expect(upgraded.tasksForPr(WS, PR).map((task) => task.id)).toEqual([
    'merger',
    'reviewer',
    'developer',
  ])
})
