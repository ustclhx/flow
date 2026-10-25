import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { ok, taskContract } from '@flow/core'
import { ActivityQueue, type ExecutorContext, type ExecutorPlugin } from '../src/executor.ts'
import { resolveContractCwd } from '../src/workdir.ts'
import { type Bench, bench } from './harness.ts'

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

function workspace(b: Bench, repos: string[]) {
  const dir = join(b.home, 'config/workspaces')
  mkdirSync(dir, { recursive: true })
  for (const repo of repos) mkdirSync(repo, { recursive: true })
  writeFileSync(
    join(dir, 'demo.yaml'),
    JSON.stringify({ id: 'demo', name: 'Demo', description: '测试', kind: 'product', repos }),
  )
}

async function setup(type = 'claude-sdk') {
  const contexts: ExecutorContext[] = []
  const policyPaths: string[][] = []
  const executor: ExecutorPlugin = {
    type,
    run(contract, ctx) {
      contexts.push(ctx)
      const activity = new ActivityQueue()
      activity.close()
      return {
        activity,
        done: (async () => {
          await ctx.precheck?.({ tool: 'Read', paths: ['src/file.ts'] })
          return ok({
            outcome: 'done' as const,
            result: {
              summary: '完成',
              artifacts: [],
              verify: [],
              executor: contract.executor,
              node_id: ctx.nodeId,
            },
          })
        })(),
        async cancel() {},
      }
    },
  }
  const b = await bench(
    { executors: [executor], policies: [{ scope: '*', action: '*', level: 'auto' }] },
    60,
    (url, init) => {
      if (url.endsWith('/policy/check')) policyPaths.push(JSON.parse(String(init?.body)).paths)
      return undefined
    },
  )
  current = b
  return { b, contexts, policyPaths }
}

async function finish(b: Bench, id: string) {
  const deadline = Date.now() + 5000
  while (!['done', 'failed', 'blocked'].includes(b.task(id).status)) {
    if (Date.now() > deadline) throw new Error(`任务未结束：${b.task(id).status}`)
    await b.clock.advance(0)
    await new Promise((r) => setTimeout(r, 5))
  }
  return b.task(id)
}

for (const type of ['claude-sdk', 'codex-exec']) {
  test(`${type} 缺省 cwd：执行器、预检和验收均使用 workspace 唯一仓库`, async () => {
    const { b, contexts, policyPaths } = await setup(type)
    const repo = join(b.home, '..', 'repo')
    workspace(b, [repo])
    const id = await b.create({ executor: type, cwd: undefined, verify: [{ cmd: ['pwd'] }] })
    const task = await finish(b, id)
    expect(contexts[0]?.cwd).toBe(repo)
    expect(policyPaths[0]).toContain(join(realpathSync(repo), 'src/file.ts'))
    expect(task.status).toBe('done')
    expect(task.result?.verify[0]?.cwd).toBe(repo)
    expect(task.result?.verify[0]?.output_tail).toContain(realpathSync(repo))
  })
}

for (const count of [0, 2]) {
  test(`workspace 有 ${count} 个仓库且未指定目录：failed(repo_not_in_workspace)，不启动执行器`, async () => {
    const { b, contexts } = await setup()
    workspace(
      b,
      Array.from({ length: count }, (_, i) => join(b.home, '..', `repo-${i}`)),
    )
    const id = await b.create({ executor: 'claude-sdk', cwd: undefined })
    const task = await finish(b, id)
    expect(task).toMatchObject({ status: 'failed', result: { reason: 'repo_not_in_workspace' } })
    expect(task.result?.summary).toContain('cwd')
    expect(task.result?.summary).toContain('inputs.repo')
    expect(contexts).toHaveLength(0)
  })
}

test('inputs.repo 从多仓库中选择，且必须属于合同的 workspace', async () => {
  const { b, contexts } = await setup()
  const repo = join(b.home, '..', 'repo')
  workspace(b, [repo, join(b.home, '..', 'other')])
  const selected = await b.create({
    executor: 'claude-sdk',
    cwd: undefined,
    inputs: { repo: `${repo}/` },
  })
  expect((await finish(b, selected)).status).toBe('done')
  expect(contexts[0]?.cwd).toBe(repo)
  const outside = await b.create({
    executor: 'claude-sdk',
    cwd: undefined,
    inputs: { repo: b.home },
  })
  expect(await finish(b, outside)).toMatchObject({
    status: 'failed',
    result: { reason: 'repo_not_in_workspace' },
  })
  expect(contexts).toHaveLength(1)
})

test('显式 cwd 优先于 inputs.repo，允许使用 workspace 仓库以外的工作目录', async () => {
  const { b, contexts } = await setup()
  workspace(b, [])
  const cwd = join(b.home, '..', 'explicit')
  mkdirSync(cwd)
  const id = await b.create({ executor: 'claude-sdk', cwd, inputs: { repo: '/outside' } })
  expect((await finish(b, id)).status).toBe('done')
  expect(contexts[0]?.cwd).toBe(cwd)
})

test('workspace 不存在：沿用 repo_not_in_workspace', async () => {
  const { b, contexts } = await setup()
  const id = await b.create({ executor: 'claude-sdk', workspace: 'ws/missing', cwd: undefined })
  expect(await finish(b, id)).toMatchObject({
    status: 'failed',
    result: { reason: 'repo_not_in_workspace' },
  })
  expect(contexts).toHaveLength(0)
})

test('inputs.repo 与显式 cwd 的 ~/ 路径在节点展开；根目录保持为 /', async () => {
  const { b } = await setup()
  const repo = join(b.home, '..', 'repo')
  workspace(b, [repo, '/'])
  const base = taskContract.parse({
    goal: '目录测试',
    workspace: 'ws/demo',
    role: 'triage',
    executor: 'codex-exec',
  })
  const tildeRepo = `~/${relative(homedir(), repo)}`
  expect(await resolveContractCwd(b.home, { ...base, inputs: { repo: tildeRepo } })).toEqual(
    ok(repo),
  )
  expect(await resolveContractCwd(b.home, { ...base, cwd: tildeRepo })).toEqual(ok(repo))
  expect(await resolveContractCwd(b.home, { ...base, inputs: { repo: '/' } })).toEqual(ok('/'))
  expect(await resolveContractCwd(b.home, { ...base, cwd: '/' }, true)).toEqual(ok('/'))
})
