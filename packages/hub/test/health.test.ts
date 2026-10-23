import { describe, expect, test } from 'bun:test'
import { errorBody, healthData, okBody, VERSION } from '@flow/core'
import { createHubApp, serve } from '../src/index.ts'

describe('GET /v1/health', () => {
  test('app.request：200 与 { ok, data: { version, uptime, ledger_seq } }', async () => {
    let t = 1_000_000
    const app = createHubApp({ now: () => t, startedAt: t })
    t += 2500
    const res = await app.request('/v1/health')
    expect(res.status).toBe(200)
    const body = okBody(healthData).parse(await res.json())
    expect(body.data).toEqual({ version: VERSION, uptime: 2.5, ledger_seq: 0 })
  })

  test('未知路径返回 404 与协议错误体', async () => {
    const res = await createHubApp().request('/v1/nope')
    expect(res.status).toBe(404)
    const body = errorBody.parse(await res.json())
    expect(body.error).toMatchObject({ code: 'not_found', retryable: false })
  })

  test('异常转为 500 internal_error', async () => {
    const app = createHubApp({
      ledgerSeq: () => {
        throw new Error('boom')
      },
    })
    const res = await app.request('/v1/health')
    expect(res.status).toBe(500)
    expect(errorBody.parse(await res.json()).error.code).toBe('internal_error')
  })
})

describe('serve：真实端口', () => {
  test.each(['bun', 'node'] as const)(
    '%s 运行时：随机端口启动、只监听 127.0.0.1、可关闭',
    async (runtime) => {
      const app = createHubApp()
      const server = await serve(app.fetch, { port: 0, runtime })
      try {
        expect(server.runtime).toBe(runtime)
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
        const res = await fetch(`${server.url}/v1/health`)
        expect(res.status).toBe(200)
        expect(okBody(healthData).parse(await res.json()).data.ledger_seq).toBe(0)
      } finally {
        await server.close()
      }
      await expect(fetch(`${server.url}/v1/health`)).rejects.toThrow()
    },
  )
})
