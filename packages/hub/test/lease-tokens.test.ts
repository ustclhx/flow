import { afterEach, expect, test } from 'bun:test'
import { redactSecrets } from '@raindown/core'
import { Hono } from 'hono'
import { createHubApp } from '../src/app.ts'
import { createTaskTokenAuthority } from '../src/server/lease-tokens.ts'
import { drafts, must, startTask, sys, tempLedger } from './ledger-helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup() {
  let time = Date.parse('2026-10-24T00:00:00.000Z')
  const l = await tempLedger({ now: () => time })
  cleanups.push(l.cleanup)
  const id = 't-worker'
  must(l.store.append(drafts(id)['task.created'], sys))
  const d = startTask(l.store, id)
  const authority = createTaskTokenAuthority({ ledger: () => l.store, now: () => time })
  const token = authority.issue({ task_id: id, lease_id: `l-${id}-1` })
  if (!token) throw new Error('未签发派工凭证')
  return { ...l, id, d, authority, token, advance: (ms: number) => (time += ms) }
}

test('派工凭证由当前合同认定角色、任务与 attempt，且明文可脱敏', async () => {
  const e = await setup()
  expect(e.token).toMatch(/^fls_[A-Za-z0-9_-]{43}$/)
  expect(e.authority.authenticate(e.token)).toEqual({
    actor: 'developer',
    task_id: e.id,
    workspace: 'ws/demo',
    lease_id: `l-${e.id}-1`,
    attempt: 1,
  })
  expect(redactSecrets(e.token)).toBe('[REDACTED:raindown-lease-token]')
  expect(createTaskTokenAuthority({ ledger: () => e.store }).authenticate(e.token)).toBeNull()
  expect(e.authority.issue({ task_id: 't-other', lease_id: `l-${e.id}-1` })).toBeUndefined()
})

test.each(['expired', 'ended', 'terminal', 'requeued'] as const)(
  '派工凭证在 %s 后失效',
  async (reason) => {
    const e = await setup()
    if (reason === 'expired') e.advance(3_600_000)
    if (reason === 'terminal') must(e.store.append(e.d['task.done'], sys))
    if (reason === 'requeued') must(e.store.append(e.d['task.requeued:lease_expired'], sys))
    if (reason === 'ended')
      must(
        e.store.append(
          {
            type: 'task.attempt_ended',
            task_id: e.id,
            workspace: 'ws/demo',
            payload: { attempt: 1, reason: 'retry' },
          },
          sys,
        ),
      )
    expect(e.authority.authenticate(e.token)).toBeNull()
    expect(e.authority.size()).toBe(0)
  },
)

test('HTTP 强制派工 scope，不能改 actor、task id 或调用写操作；绑定查询来自凭证', async () => {
  const e = await setup()
  const child = new Hono()
  child.all('*', (c) => c.json({ actor: c.get('actor') }))
  const app = createHubApp({ taskTokens: e.authority, mount: [{ path: '/v1', app: child }] })
  const headers = { Authorization: `Bearer ${e.token}` }
  const binding = await app.request('/v1/binding', { headers })
  expect(await binding.json()).toMatchObject({
    ok: true,
    data: {
      kind: 'task',
      task: { task_id: e.id, actor: 'developer', attempt: 1 },
    },
  })
  for (const [method, path] of [
    ['GET', `/v1/tasks/${e.id}`],
    ['POST', `/v1/tasks/${e.id}/report`],
  ] as const)
    expect((await app.request(path ?? '', { method, headers })).status).toBe(200)
  for (const [method, path] of [
    ['GET', '/v1/tasks/t-other'],
    ['POST', '/v1/tasks/t-other/report'],
    ['POST', '/v1/tasks'],
    ['POST', '/v1/supervisor/respond'],
    ['POST', '/v1/inbox/i-1/act'],
    ['POST', '/v1/secrets/resolve'],
    ['GET', '/v1/events'],
    ['POST', '/v1/leases'],
  ] as const) {
    const response = await app.request(path ?? '', { method, headers })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } })
  }
  expect(
    (
      await app.request('/v1/binding', {
        headers: { ...headers, 'X-Raindown-Actor': 'user' },
      })
    ).status,
  ).toBe(403)
  e.advance(3_600_000)
  expect((await app.request('/v1/binding', { headers })).status).toBe(401)
})
