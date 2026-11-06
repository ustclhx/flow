import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanLeaseTokenFiles,
  leaseTokenDir,
  removeLeaseTokenFile,
  writeLeaseTokenFile,
} from '../src/lease-token.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
const tempHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'raindown-dispatch-token-'))
  homes.push(home)
  return home
}

test('派工凭证文件 0600、目录 0700；旧派工清理不会删除新租约文件', async () => {
  const home = await tempHome()
  const first = await writeLeaseTokenFile(home, 't-1', 'l-1', 'first')
  const next = await writeLeaseTokenFile(home, 't-1', 'l-2', 'next')
  expect((await stat(first)).mode & 0o777).toBe(0o600)
  expect((await stat(leaseTokenDir(home, 't-1'))).mode & 0o777).toBe(0o700)
  await removeLeaseTokenFile(first)
  expect(existsSync(first)).toBe(false)
  expect((await readFile(next, 'utf8')).trim()).toBe('next')
  for (const id of ['../x', '.hidden', 'x/y', '']) {
    await expect(writeLeaseTokenFile(home, id, 'l-1', 'bad')).rejects.toThrow()
    await expect(writeLeaseTokenFile(home, 't-1', id, 'bad')).rejects.toThrow()
  }
})

test('启动只删除受管 token 文件，保留任务产物且不跟随目录符号链接', async () => {
  const home = await tempHome()
  await cleanLeaseTokenFiles(home)
  const token = await writeLeaseTokenFile(home, 't-1', 'l-1', 'token')
  const artifact = join(home, 'state', 'tasks', 't-1', 'result.json')
  await writeFile(artifact, '{}')
  const unrelated = join(leaseTokenDir(home, 't-1'), 'keep.json')
  await writeFile(unrelated, '{}')
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'l-2.token'), 'keep')
  await symlink(outside, join(home, 'state', 'tasks', 't-link'))
  await mkdir(join(home, 'state', 'tasks', 't-2'))
  await symlink(outside, leaseTokenDir(home, 't-2'))
  await expect(writeLeaseTokenFile(home, 't-2', 'l-2', 'bad')).rejects.toThrow()
  await cleanLeaseTokenFiles(home)
  expect(existsSync(token)).toBe(false)
  for (const path of [artifact, unrelated, join(outside, 'l-2.token')])
    expect(existsSync(path)).toBe(true)
})

test.each(['done', 'abandon'] as const)('节点只传派工凭证文件路径，%s 后删除', async (ending) => {
  const { bench, fake } = await import('./harness.ts')
  const { createFakeExecutor } = await import('../src/fake.ts')
  const inner = createFakeExecutor()
  let path: string | undefined
  let seen: string | undefined
  let forward: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
  let release: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const token = `fls_${'a'.repeat(43)}`
  const b = await bench({
    executors: [
      {
        ...inner,
        run(contract, ctx) {
          path = ctx.leaseTokenFile
          expect(ctx.env?.RAINDOWN_LEASE_TOKEN_FILE).toBeUndefined()
          const run = inner.run(contract, ctx)
          return {
            ...run,
            done: (async () => {
              if (path) seen = (await readFile(path, 'utf8')).trim()
              return run.done
            })(),
          }
        },
      },
    ],
    fetch: async (input, init) => {
      await ready
      if (!forward) throw new Error('测试中枢未就绪')
      const response = await forward(input, init)
      if (!input.endsWith('/v1/leases')) return response
      const body = (await response.json()) as { data?: { lease?: { dispatch_token?: string } } }
      if (body.data?.lease) body.data.lease.dispatch_token = token
      return new Response(JSON.stringify(body), response)
    },
  })
  forward = b.hubFetch
  release()
  try {
    const id = await b.create(fake({ delay_ms: ending === 'done' ? 0 : 60_000 }))
    if (ending === 'done') await b.until(id, (task) => task.status === 'done')
    else {
      await b.until(id, (task) => task.status === 'running' && path !== undefined)
      await b.node.stop()
    }
    expect(path).toBeDefined()
    expect(seen).toBe(token)
    expect(existsSync(path ?? '')).toBe(false)
  } finally {
    await b.close()
  }
})
