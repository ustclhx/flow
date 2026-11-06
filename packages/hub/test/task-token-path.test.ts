import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createHubApp } from '../src/app.ts'

test('任务凭证访问非法百分号编码路径返回用法错误，不进入业务路由', async () => {
  let invoked = 0
  const child = new Hono()
  child.all('*', (c) => {
    invoked++
    return c.json({ ok: true })
  })
  const app = createHubApp({
    taskTokens: {
      authenticate: () => ({
        actor: 'dev',
        task_id: 't1',
        workspace: 'ws/demo',
        lease_id: 'l1',
        attempt: 1,
      }),
    },
    mount: [{ path: '/v1', app: child }],
  })
  for (const [method, path] of [
    ['GET', '/v1/tasks/%'],
    ['POST', '/v1/tasks/%E0%A4%A/report'],
  ] as const) {
    const response = await app.request(path, {
      method,
      headers: { Authorization: 'Bearer fixture' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
  }
  expect(invoked).toBe(0)
})
