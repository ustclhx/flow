import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operations } from '@raindown/core'
import { serve } from '../../hub/src/serve.ts'
import { resolveLeaseMcpOptions } from '../src/server.ts'
import { callJson, connect } from './helpers.ts'

const roots: string[] = []
const originalTokenFile = process.env.RAINDOWN_LEASE_TOKEN_FILE
afterEach(async () => {
  if (originalTokenFile === undefined) delete process.env.RAINDOWN_LEASE_TOKEN_FILE
  else process.env.RAINDOWN_LEASE_TOKEN_FILE = originalTokenFile
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('任务绑定只列只读知识、本任务详情与上报；隐藏操作不能调用', async () => {
  const client = await connect({
    actor: 'developer',
    binding: { kind: 'task', workspace: 'ws/demo', task: 'task-a' },
  })
  try {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'kb_get',
      'kb_proposals_diff',
      'kb_proposals_list',
      'kb_query',
      'kb_search',
      'raindown_report',
      'task_show',
    ])
    for (const name of ['task_create', 'task_respond', 'inbox_act', 'kb_journal']) {
      expect(await callJson(client, name, {})).toMatchObject({
        isError: true,
        doc: { ok: false, error: { code: 'unknown_tool' } },
      })
    }
    for (const [name, args] of [
      ['task_show', { id: 'task-b' }],
      ['raindown_report', { id: 'task-b', status: 'progress', summary: '已有进展' }],
    ] as const) {
      expect(await callJson(client, name, args)).toMatchObject({
        isError: true,
        doc: { ok: false, error: { code: 'forbidden' } },
      })
    }
  } finally {
    await client.close()
  }
})

test('supervisor 唤醒绑定继续列出全部操作', async () => {
  const client = await connect({
    actor: 'supervisor',
    binding: { workspace: 'ws/demo', task: 'wake-a', replyOnly: true },
  })
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      operations.map((op) => op.name),
    )
  } finally {
    await client.close()
  }
})

test('MCP 启动绑定以中枢响应为准，命令行仅核对，凭证失效就启动失败', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raindown-mcp-binding-'))
  roots.push(home)
  await mkdir(join(home, 'config'))
  const tokenFile = join(home, 'lease.token')
  await writeFile(tokenFile, 'fls_test')
  process.env.RAINDOWN_LEASE_TOKEN_FILE = tokenFile
  let valid = true
  const hub = await serve(
    async (request) => {
      const path = new URL(request.url).pathname
      expect(request.headers.get('authorization')).toBe('Bearer fls_test')
      if (path === '/v1/tasks/task-a/report') {
        expect(await request.json()).toEqual({ status: 'progress', summary: '已有进展' })
        return Response.json({ ok: true, data: { seq: 10, attempt: 1 } })
      }
      expect(path).toBe('/v1/binding')
      return valid
        ? Response.json({
            ok: true,
            data: {
              kind: 'task',
              task: {
                actor: 'developer',
                task_id: 'task-a',
                workspace: 'ws/demo',
                lease_id: 'lease-a',
                attempt: 1,
              },
            },
          })
        : Response.json(
            {
              ok: false,
              error: { kind: 'failure', code: 'unauthorized', message: '未授权', retryable: false },
            },
            { status: 401 },
          )
    },
    { port: 0 },
  )
  try {
    await writeFile(join(home, 'config', 'hub.yaml'), `port: ${hub.port}\n`)
    const options = await resolveLeaseMcpOptions({
      actor: 'developer',
      home,
      binding: { task: 'task-a' },
    })
    expect(options).toMatchObject({
      binding: { kind: 'task', task: 'task-a', workspace: 'ws/demo' },
    })
    const client = await connect(options)
    try {
      expect(
        await callJson(client, 'raindown_report', { status: 'progress', summary: '已有进展' }),
      ).toMatchObject({ isError: false, doc: { ok: true, data: { seq: 10, attempt: 1 } } })
    } finally {
      await client.close()
    }
    await expect(
      resolveLeaseMcpOptions({ actor: 'developer', home, binding: { task: 'task-b' } }),
    ).rejects.toMatchObject({ error: { code: 'forbidden' } })
    valid = false
    await expect(resolveLeaseMcpOptions({ actor: 'developer', home })).rejects.toMatchObject({
      error: { code: 'unauthorized' },
    })
  } finally {
    await hub.close()
  }
})
