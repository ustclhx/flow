import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { flowPaths, operations } from '@flow/core'
import { createFlowMcpServer, FlowMcpConfigError, resolveMcpBinding } from '../src/index.ts'
import { callJson, connect, initTempHome } from './helpers.ts'

/**
 * add-m1-supervisor 4.1：`flow mcp --workspace --task` 会话绑定（knowledge-access "MCP 会话按 workspace 绑定"）。
 * 经中枢的请求发往一个本地的记录服务器（不是真实中枢），只检查 MCP 发出的请求体。
 */

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function home() {
  const h = await initTempHome('flow-mcp-binding-')
  cleanups.push(() => rmSync(join(h, '..'), { recursive: true, force: true }))
  return h
}

/** 记录请求的假中枢：任何请求都返回一个 403 错误体（MCP 只需要把请求发出去）。 */
async function recordingHub(h: string) {
  const requests: { method: string; url: string; body: unknown; auth?: string }[] = []
  const server: Server = createServer((req, res) => {
    let text = ''
    req.on('data', (c) => {
      text += c
    })
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        body: text ? JSON.parse(text) : null,
      })
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ ok: false, error: { kind: 'failure', code: 'stub', message: 'stub' } }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const paths = flowPaths(h)
  writeFileSync(paths.hubConfig, `port: ${port}\n`)
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(paths.hubToken, `${'t'.repeat(43)}\n`)
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
  return requests
}

/** 第一个请求体中的 parent。 */
const parentOf = (requests: { body: unknown }[]) =>
  (requests[0]?.body as { parent?: string } | undefined)?.parent

const contract = (over: Record<string, unknown> = {}) => ({
  goal: '做点事',
  workspace: 'ws/product-res',
  role: 'reviewer',
  executor: 'claude-sdk',
  ...over,
})

describe('绑定参数', () => {
  test('规范化 workspace；--task / --reply-only 需要 --workspace；不合法的值是用法错误', () => {
    expect(resolveMcpBinding(undefined)).toEqual({ ok: true, binding: undefined })
    expect(resolveMcpBinding({ workspace: 'product-res', task: 't-1' })).toEqual({
      ok: true,
      binding: { workspace: 'ws/product-res', task: 't-1' },
    })
    expect(resolveMcpBinding({ workspace: 'ws/a', replyOnly: true })).toEqual({
      ok: true,
      binding: { workspace: 'ws/a', replyOnly: true },
    })
    for (const bad of [
      { task: 't-1' },
      { replyOnly: true },
      { workspace: 'ws/A B' },
      { workspace: '../x' },
      { workspace: 'ws/a', task: '../t' },
    ]) {
      const r = resolveMcpBinding(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'usage', code: 'invalid_binding' })
    }
    expect(() => createFlowMcpServer({ actor: 'supervisor', binding: { task: 't-1' } })).toThrow(
      FlowMcpConfigError,
    )
  })
})

describe('task_create', () => {
  test('绑定 --task t-1 的会话未写 parent：请求以 parent: t-1 发送', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const client = await connect({
      actor: 'supervisor',
      home: h,
      binding: { workspace: 'ws/product-res', task: 't-1' },
    })
    await callJson(client, 'task_create', contract())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/v1/tasks' })
    expect(parentOf(requests)).toBe('t-1')
  })

  test('显式写了 parent 时原样发送（是否允许由中枢判定）', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const client = await connect({
      actor: 'supervisor',
      home: h,
      binding: { workspace: 'ws/product-res', task: 't-1' },
    })
    await callJson(client, 'task_create', contract({ parent: 't-9' }))
    expect(parentOf(requests)).toBe('t-9')
  })

  test('写别的 workspace：本地 workspace_mismatch，不发请求', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const client = await connect({
      actor: 'supervisor',
      home: h,
      binding: { workspace: 'ws/product-res', task: 't-1' },
    })
    const { isError, doc } = await callJson(
      client,
      'task_create',
      contract({ workspace: 'ws/xuanxue-saas' }),
    )
    expect(isError).toBe(true)
    expect(doc).toMatchObject({ ok: false, error: { code: 'workspace_mismatch' } })
    expect(requests).toHaveLength(0)
  })

  test('没有绑定时不填 parent', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const client = await connect({ actor: 'reviewer', home: h })
    await callJson(client, 'task_create', contract())
    expect(parentOf(requests)).toBeUndefined()
  })
})

describe('brief_update', () => {
  test('写别的 workspace 的笔记：workspace_mismatch，不发请求', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const client = await connect({
      actor: 'supervisor',
      home: h,
      binding: { workspace: 'ws/product-res', task: 't-1' },
    })
    const { doc } = await callJson(client, 'brief_update', {
      workspace: 'xuanxue-saas',
      text: '笔记',
      base_hash: '0'.repeat(64),
    })
    expect(doc).toMatchObject({ ok: false, error: { code: 'workspace_mismatch' } })
    expect(requests).toHaveLength(0)
    // 绑定的 workspace（简写）照常发往中枢。
    await callJson(client, 'brief_update', {
      workspace: 'product-res',
      text: '笔记',
      base_hash: '0'.repeat(64),
    })
    expect(requests).toHaveLength(1)
  })
})

describe('ask_user / task_propose（#59 遗留：本地 bind 预检）', () => {
  test.each([
    [
      'ask_user',
      { workspace: 'xuanxue-saas', question: '用哪个方案？' },
      { workspace: 'product-res', question: '用哪个方案？' },
    ],
    ['task_propose', { draft: contract({ workspace: 'ws/xuanxue-saas' }) }, { draft: contract() }],
  ] as const)(
    '%s 写别的 workspace：workspace_mismatch，不发请求；绑定的照常发出',
    async (tool, other, own) => {
      const h = await home()
      const requests = await recordingHub(h)
      const client = await connect({
        actor: 'supervisor',
        home: h,
        binding: { workspace: 'ws/product-res', task: 't-1' },
      })
      const { isError, doc } = await callJson(client, tool, other)
      expect(isError).toBe(true)
      expect(doc).toMatchObject({ ok: false, error: { code: 'workspace_mismatch' } })
      expect(requests).toHaveLength(0)
      await callJson(client, tool, own)
      expect(requests).toHaveLength(1)
    },
  )
})

describe('kb_journal（本地执行，只有绑定这一层检查）', () => {
  test('只能写绑定 workspace 的 journal；未写 workspace 时记到绑定的 workspace', async () => {
    const h = await home()
    const client = await connect({
      actor: 'supervisor',
      home: h,
      binding: { workspace: 'ws/product-res', task: 't-1' },
    })
    const other = await callJson(client, 'kb_journal', {
      text: '越界',
      workspace: 'ws/xuanxue-saas',
    })
    expect(other.doc).toMatchObject({ ok: false, error: { code: 'workspace_mismatch' } })

    const plain = await callJson(client, 'kb_journal', { text: '巡检完成' })
    expect(plain.doc.ok).toBe(true)
    const file = (plain.doc as unknown as { data: { file: string } }).data.file
    const text = readFileSync(join(h, file), 'utf8')
    expect(text).toContain('巡检完成')
    expect(text).toContain('ws/product-res')
    expect(text).not.toContain('越界')
  })
})

describe('reply 唤醒（--reply-only）', () => {
  test('写类操作一律 reply_only_wake，只读操作照常', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const client = await connect({
      actor: 'supervisor',
      home: h,
      binding: { workspace: 'ws/product-res', task: 't-1', replyOnly: true },
    })
    for (const [name, args] of [
      ['kb_journal', { text: 'x' }],
      ['capture', { text: 'x' }],
      ['task_create', contract()],
      ['brief_update', { workspace: 'ws/product-res', text: 'x', base_hash: '0'.repeat(64) }],
    ] as const) {
      const { doc } = await callJson(client, name, args)
      expect(doc).toMatchObject({ ok: false, error: { code: 'reply_only_wake' } })
    }
    expect(requests).toHaveLength(0)
    const read = await callJson(client, 'ws_list', {})
    expect(read.doc.ok).toBe(true)
  })

  test('只读操作清单（其余视为写类）', () => {
    const reads = operations.filter((op) => op.access === 'read').map((op) => op.name)
    expect(reads.sort()).toEqual(
      [
        'inbox_list',
        'kb_get',
        'kb_proposals_diff',
        'kb_proposals_list',
        'kb_query',
        'kb_search',
        'task_list',
        'task_show',
        'ws_brief',
        'ws_list',
        'ws_resources',
      ].sort(),
    )
  })
})

describe('FLOW_HUB_TOKEN_FILE（add-m1-supervisor D6）', () => {
  test('优先于 FLOW_HUB_TOKEN 与 state/hub.token；文件不存在时失败，不回退到 user token', async () => {
    const h = await home()
    const requests = await recordingHub(h)
    const file = join(h, '..', 'wake.token')
    writeFileSync(file, `${'f'.repeat(43)}\n`, { mode: 0o600 })
    const saved = { file: process.env.FLOW_HUB_TOKEN_FILE, token: process.env.FLOW_HUB_TOKEN }
    try {
      process.env.FLOW_HUB_TOKEN_FILE = file
      process.env.FLOW_HUB_TOKEN = 'e'.repeat(43)
      const client = await connect({ actor: 'supervisor', home: h })
      await callJson(client, 'task_create', contract())
      expect(requests.at(-1)?.auth).toBe(`Bearer ${'f'.repeat(43)}`)
      rmSync(file)
      const { doc } = await callJson(client, 'task_create', contract())
      expect(doc).toMatchObject({ ok: false, error: { code: 'token_file_missing' } })
      expect(requests).toHaveLength(1)
    } finally {
      for (const [k, v] of [
        ['FLOW_HUB_TOKEN_FILE', saved.file],
        ['FLOW_HUB_TOKEN', saved.token],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
