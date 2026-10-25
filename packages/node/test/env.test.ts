import { afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { HUB_TOKEN_ENV } from '@flow/core'
import { execRunner } from '../src/codex-orca/orca.ts'
import { executorRoleEnv } from '../src/env.ts'
import { createFakeExecutor, type ExecutorContext, executorEnv, systemClock } from '../src/index.ts'
import { verifyTask } from '../src/verify.ts'
import { bench, fake } from './harness.ts'

const saved = process.env[HUB_TOKEN_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[HUB_TOKEN_ENV]
  else process.env[HUB_TOKEN_ENV] = saved
})

// 运行时拼接，不写像真 token 的字面量。
const fakeToken = () => `fht_${'z'.repeat(43)}`

describe('子进程环境不继承中枢凭证（design D9）', () => {
  test('executorEnv 去掉 FLOW_HUB_TOKEN，保留其他变量，不修改原对象', () => {
    const base = { [HUB_TOKEN_ENV]: fakeToken(), PATH: '/bin', KEEP: '1' }
    const env = executorEnv(base)
    expect(env[HUB_TOKEN_ENV]).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/bin', KEEP: '1' })
    expect(base[HUB_TOKEN_ENV]).toBe(fakeToken())
  })

  test('验收命令的子进程看不到 FLOW_HUB_TOKEN', async () => {
    process.env[HUB_TOKEN_ENV] = fakeToken()
    const [outcome] = await verifyTask(
      [{ cmd: ['sh', '-c', `echo "token=\${${HUB_TOKEN_ENV}:-absent}"`] }],
      tmpdir(),
      systemClock,
      new AbortController().signal,
    )
    expect(outcome?.exit_code).toBe(0)
    expect(outcome?.output_tail.join('\n')).toContain('token=absent')
  })
})

test('节点交给执行器的 ctx.env 不含 FLOW_HUB_TOKEN', async () => {
  const inner = createFakeExecutor()
  let seen: ExecutorContext['env']
  const spy = {
    ...inner,
    run(contract: Parameters<typeof inner.run>[0], ctx: ExecutorContext) {
      seen = ctx.env
      return inner.run(contract, ctx)
    },
  }
  process.env[HUB_TOKEN_ENV] = fakeToken()
  // bench 显式传入 user token，FLOW_HUB_TOKEN 不会被节点使用，只检验子进程环境。
  const b = await bench({ executors: [spy] })
  try {
    const id = await b.create(fake({ delay_ms: 0 }))
    await b.until(id, (t) => t.status === 'done')
    expect(seen).toBeDefined()
    expect(seen?.[HUB_TOKEN_ENV]).toBeUndefined()
    expect(seen?.PATH).toBe(process.env.PATH)
  } finally {
    await b.close()
  }
})

test('codex-orca 的命令执行（orca、gh）不继承 FLOW_HUB_TOKEN', async () => {
  process.env[HUB_TOKEN_ENV] = fakeToken()
  for (const env of [undefined, { ...process.env }]) {
    const out = await execRunner('sh', ['-c', `echo "token=\${${HUB_TOKEN_ENV}:-absent}"`], {
      timeoutMs: 5000,
      ...(env ? { env } : {}),
    })
    expect(out.stdout.trim()).toBe('token=absent')
  }
})

test('执行器身份覆盖继承值，并拒绝 user、保留身份与非法格式', () => {
  const base = { FLOW_ACTOR: 'user', FLOW_HUB_TOKEN: fakeToken(), KEEP: '1' }
  expect(executorRoleEnv('reviewer', base)).toEqual({
    ok: true,
    data: { FLOW_ACTOR: 'reviewer', KEEP: '1' },
  })
  expect(base.FLOW_ACTOR).toBe('user')
  for (const actor of [
    'user',
    'User',
    'hub',
    'POLICY',
    'scheduler',
    'unknown',
    'node:n1',
    'bad name',
    '',
  ]) {
    expect(executorRoleEnv(actor, base)).toMatchObject({
      ok: false,
      error: { code: 'invalid_actor' },
    })
  }
})
