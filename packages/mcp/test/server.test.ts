import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineOperation, fail, ok, operations, writeEntry } from '@flow/core'
import { z } from 'zod'
import { createFlowMcpServer, FlowMcpConfigError, toolInputSchema } from '../src/index.ts'
import { callJson, connect, initTempHome } from './helpers.ts'

const decision = {
  type: 'decision',
  title: '东方站加日语',
  summary: '是否为东方站上线日语版',
  scope: 'work',
  status: 'proposed',
  expected_outcome: '日本流量提升',
  metric: '日本地区月访问量',
  review_date: '2027-01-24',
}

/** fixture：以调用方身份写入一个决策条目，用来触发 AI 写入边界。 */
const writeDecisionOp = defineOperation({
  name: 'test_write_decision',
  cli: 'test write-decision',
  summary: '测试用：写入决策条目',
  input: z.object({ id: z.string().describe('条目标识') }),
  run: async (input: { id: string }, ctx) => {
    const r = await writeEntry(ctx.home, { id: input.id, frontmatter: decision }, ctx)
    return r.ok ? ok({ id: r.data.id }) : r
  },
})

/** fixture：回显上下文、返回可重试错误、抛出异常。 */
const echoOp = defineOperation({
  name: 'test_echo',
  cli: 'test echo',
  summary: '测试用：回显',
  input: z.object({
    mode: z.enum(['echo', 'retry', 'throw']).describe('行为'),
    limit: z.number().int().optional().describe('上限'),
  }),
  run: async (input: { mode: string; limit?: number | undefined }, ctx) => {
    if (input.mode === 'retry') return fail('retryable', 'lock_timeout', '写锁超时')
    if (input.mode === 'throw') throw new Error('boom')
    return ok({ input, actor: ctx.actor, via: ctx.via, home: ctx.home })
  },
})

const fixtures = [writeDecisionOp, echoOp] as never[]

describe('actor 规则', () => {
  test('缺少、格式非法或为 user 时启动即失败', () => {
    const codeOf = (actor: string) => {
      try {
        createFlowMcpServer({ actor })
      } catch (err) {
        expect(err).toBeInstanceOf(FlowMcpConfigError)
        return (err as FlowMcpConfigError).error
      }
      throw new Error('应当抛出')
    }
    expect(codeOf('')).toMatchObject({ kind: 'usage', code: 'actor_required' })
    expect(codeOf('has space')).toMatchObject({ kind: 'usage', code: 'invalid_actor' })
    expect(codeOf('user')).toMatchObject({ kind: 'usage', code: 'invalid_actor' })
    // 保留身份（不区分大小写）与 node:* 也不能作为 MCP 的 actor（add-m1-inbox D9）。
    for (const reserved of ['User', 'hub', 'POLICY', 'scheduler', 'unknown', 'node:n1']) {
      expect(codeOf(reserved)).toMatchObject({ kind: 'usage', code: 'invalid_actor' })
    }
    expect(codeOf('user').message).toContain('不能是 user')
    expect(() => createFlowMcpServer({ actor: 'claude' })).not.toThrow()
  })
})

describe('工具清单', () => {
  test('每个操作一个工具：名称、描述与 inputSchema 来自操作定义', async () => {
    const client = await connect({ actor: 'claude' })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(operations.map((o) => o.name))
    for (const op of operations) {
      const tool = tools.find((t) => t.name === op.name)
      expect(tool?.description).toBe(op.summary)
      expect(tool?.inputSchema).toEqual(toolInputSchema(op) as never)
      expect(tool?.inputSchema.type).toBe('object')
    }
  })

  test('kb_journal 的 inputSchema 带字段说明与必填项', async () => {
    const client = await connect({ actor: 'claude' })
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'kb_journal')?.inputSchema).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', description: '日志正文' },
        workspace: { type: 'string', description: '关联的 workspace，例如 ws/product-res' },
      },
      required: ['text'],
    })
  })
})

describe('调用', () => {
  test('kb_journal 写入当天 journal，返回与 CLI --json 相同形态的文档', async () => {
    const home = await initTempHome()
    const client = await connect({ actor: 'codex', home })
    const { isError, doc } = await callJson(client, 'kb_journal', {
      text: '部署完成',
      workspace: 'ws/product-res',
    })
    expect(isError).toBe(false)
    expect(doc.ok).toBe(true)
    const data = doc.data as { file: string; sha: string }
    expect(Object.keys(data).sort()).toEqual(['date', 'file', 'sha', 'time'])
    const text = readFileSync(join(home, data.file), 'utf8')
    expect(text).toContain('部署完成')
    expect(text).toContain('codex')
    expect(text).toContain('ws/product-res')
  })

  test('capture 写入 raw/inbox/，source 为 mcp:<actor>，brain 不变', async () => {
    const home = await initTempHome()
    const brainBefore = readdirSync(join(home, 'brain')).sort()
    const client = await connect({ actor: 'claude', home })
    const { isError, doc } = await callJson(client, 'capture', { text: '考虑给东方站加日语' })
    expect(isError).toBe(false)
    const { file } = doc.data as { file: string }
    expect(file.startsWith('raw/inbox/')).toBe(true)
    const text = readFileSync(join(home, file), 'utf8')
    expect(text).toContain('考虑给东方站加日语')
    expect(text).toContain('source: mcp:claude')
    expect(readdirSync(join(home, 'brain')).sort()).toEqual(brainBefore)
    expect(existsSync(join(home, 'brain', 'journal'))).toBe(false)
  })

  test('输入不符合 schema：usage 错误 invalid_arguments，isError', async () => {
    const home = await initTempHome()
    const client = await connect({ actor: 'claude', home })
    const { isError, doc } = await callJson(client, 'kb_journal', { text: 42 })
    expect(isError).toBe(true)
    expect(doc).toMatchObject({
      ok: false,
      error: { kind: 'usage', code: 'invalid_arguments', retryable: false },
    })
    expect((doc.error as { message: string }).message).toContain('text')
    const missing = await callJson(client, 'kb_journal', {})
    expect(missing.isError).toBe(true)
    expect((missing.doc.error as { code: string }).code).toBe('invalid_arguments')
  })

  test('未知工具：usage 错误 unknown_tool', async () => {
    const client = await connect({ actor: 'claude' })
    const { isError, doc } = await callJson(client, 'no_such_tool', {})
    expect(isError).toBe(true)
    expect((doc.error as { code: string }).code).toBe('unknown_tool')
  })

  test('AI 写入边界错误码原样透传：写决策被拒绝', async () => {
    const home = await initTempHome()
    const client = await connect({ actor: 'codex', home, operations: fixtures })
    const { isError, doc } = await callJson(client, 'test_write_decision', { id: 'decisions/jp' })
    expect(isError).toBe(true)
    expect(doc).toMatchObject({
      ok: false,
      error: { kind: 'failure', code: 'ai_forbidden_decision', retryable: false },
    })
    expect((doc.error as { message: string }).message).toContain('决策条目只能由用户写入')
    expect(existsSync(join(home, 'brain', 'decisions', 'jp.md'))).toBe(false)
  })

  test('上下文为 via=mcp 与给定 actor；可重试错误带 retryable；异常转 internal_error', async () => {
    const home = await initTempHome()
    const client = await connect({ actor: 'pi', home, operations: fixtures })
    const echo = await callJson(client, 'test_echo', { mode: 'echo', limit: 3 })
    expect(echo.doc).toEqual({
      ok: true,
      data: { input: { mode: 'echo', limit: 3 }, actor: 'pi', via: 'mcp', home },
    })
    const retry = await callJson(client, 'test_echo', { mode: 'retry' })
    expect(retry.isError).toBe(true)
    expect(retry.doc).toMatchObject({
      ok: false,
      error: { kind: 'retryable', code: 'lock_timeout', retryable: true },
    })
    const thrown = await callJson(client, 'test_echo', { mode: 'throw' })
    expect(thrown.isError).toBe(true)
    expect(thrown.doc).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  })

  test('未给 home 时按 FLOW_HOME 解析', async () => {
    const home = await initTempHome()
    const prev = process.env.FLOW_HOME
    process.env.FLOW_HOME = home
    try {
      const client = await connect({ actor: 'pi', operations: fixtures })
      const echo = await callJson(client, 'test_echo', { mode: 'echo' })
      expect((echo.doc.data as { home: string }).home).toBe(home)
    } finally {
      if (prev === undefined) delete process.env.FLOW_HOME
      else process.env.FLOW_HOME = prev
    }
  })
})
