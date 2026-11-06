import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubClient } from '@raindown/core'
import { Hono } from 'hono'
import { createHubApp } from '../src/app.ts'

test('同 Unix 用户可读取 user 凭证，任务绑定是纵深防御而非进程隔离', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raindown-worker-trust-'))
  try {
    await mkdir(join(home, 'state'))
    const path = join(home, 'state', 'hub.token')
    await writeFile(path, 'owner-token', { mode: 0o600 })
    const tasks = new Hono()
    tasks.get('/v1/tasks', (c) => c.json({ ok: true, data: { tasks: [] } }))
    const app = createHubApp({
      token: 'owner-token',
      taskTokens: {
        authenticate: (token) =>
          token === 'worker-token'
            ? {
                actor: 'dev',
                task_id: 't1',
                lease_id: 'l1',
                workspace: 'ws/demo',
                attempt: 1,
              }
            : null,
      },
      mount: [{ path: '/', app: tasks }],
    })
    const worker = new HubClient({
      home,
      actor: 'dev',
      token: 'worker-token',
      fetch: async (request) => app.fetch(request),
    })
    expect(await worker.listTasks()).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    // 未启用沙箱、与节点同 uid 的进程可读此 0600 文件，随后持 user 凭证调用。
    const user = new HubClient({
      home,
      actor: 'user',
      token: await readFile(path, 'utf8'),
      fetch: async (request) => app.fetch(request),
    })
    expect(await user.listTasks()).toMatchObject({ ok: true, data: { tasks: [] } })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
