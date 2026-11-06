import { expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { raindownPaths } from '@raindown/core'
import { createTaskRoutes, createTaskService, startHub } from '../../hub/src/index.ts'
import {
  anyRole,
  contractInput,
  must,
  startTask,
  sys,
  tempLedger,
} from '../../hub/test/ledger-helpers.ts'
import { callJson, connect, initTempHome } from './helpers.ts'

test('task_retry 由共享操作生成 MCP；普通身份拒绝，reply 绑定本地拒绝', async () => {
  const home = await initTempHome('raindown-retry-cli-')
  const l = await tempLedger()
  const tasks = createTaskService({ ledger: l.store, workspaceExists: () => true, roles: anyRole })
  const task = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
  const d = startTask(l.store, task.id)
  must(
    l.store.append({ ...d['task.blocked'], payload: { reason: 'crashed', message: '退出' } }, sys),
  )
  const hub = must(
    await startHub({
      home,
      ledger: l.store,
      port: 0,
      mount: [{ path: '/', app: createTaskRoutes({ ledger: l.store, tasks }) }],
    }),
  )
  try {
    await writeFile(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
    const mcp = await connect({ home, actor: 'codex' })
    const reply = await connect({
      home,
      actor: 'supervisor',
      binding: { workspace: 'demo', task: 't-wake', replyOnly: true },
    })
    try {
      expect((await mcp.listTools()).tools.some((tool) => tool.name === 'task_retry')).toBe(true)
      expect((await callJson(mcp, 'task_retry', { id: task.id })).doc).toMatchObject({
        ok: false,
        error: { code: 'role_not_allowed' },
      })
      expect((await callJson(reply, 'task_retry', { id: task.id })).doc).toMatchObject({
        ok: false,
        error: { code: 'reply_only_wake' },
      })
    } finally {
      await mcp.close()
      await reply.close()
    }
  } finally {
    await hub.stop()
    l.cleanup()
    await rm(home, { recursive: true, force: true })
  }
})
