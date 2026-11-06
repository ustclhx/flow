import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubClient } from '../src/daemon/client.ts'

const keys = [
  'RAINDOWN_HUB_TOKEN',
  'FLOW_HUB_TOKEN',
  'RAINDOWN_HUB_TOKEN_FILE',
  'FLOW_HUB_TOKEN_FILE',
] as const
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const roots: string[] = []
afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('HubClient token 新名优先、空白回退旧名，只发送新身份头', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raindown-client-'))
  roots.push(home)
  for (const key of keys) delete process.env[key]
  let received: Headers | undefined
  const client = new HubClient({
    home,
    actor: 'codex',
    fetch: async (request) => {
      received = request.headers
      return Response.json({
        ok: false,
        error: { kind: 'failure', code: 'fixture', message: 'fixture' },
      })
    },
  })
  process.env.FLOW_HUB_TOKEN = 'legacy'
  process.env.RAINDOWN_HUB_TOKEN = 'new'
  await client.listTasks()
  expect(received?.get('authorization')).toBe('Bearer new')
  expect(received?.get('x-raindown-actor')).toBe('codex')
  expect(received?.has('x-flow-actor')).toBe(false)
  process.env.RAINDOWN_HUB_TOKEN = ' '
  await client.listTasks()
  expect(received?.get('authorization')).toBe('Bearer legacy')
  const file = join(home, 'legacy.token')
  await writeFile(file, 'file-token')
  process.env.FLOW_HUB_TOKEN_FILE = file
  process.env.RAINDOWN_HUB_TOKEN_FILE = ' '
  await client.listTasks()
  expect(received?.get('authorization')).toBe('Bearer file-token')
  process.env.RAINDOWN_HUB_TOKEN_FILE = join(home, 'missing.token')
  expect(await client.listTasks()).toMatchObject({
    ok: false,
    error: { code: 'token_file_missing' },
  })
})
