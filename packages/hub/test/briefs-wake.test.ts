import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  briefHash,
  briefUpdateOp,
  defaultSupervisorConfig,
  ok,
  type WakeOrigin,
  wsBriefOp,
} from '@flow/core'
import { initTempHome, isolateHub } from '../../core/test/helpers.ts'
import {
  createBriefRoutes,
  createHubApp,
  createNodeProtocol,
  createTaskService,
  createWakeTokenAuthority,
  type EventInput,
  type RoleLookup,
  wakeBinding,
} from '../src/index.ts'
import { must, tempLedger } from './ledger-helpers.ts'
import { FakeClock, testToken } from './server-fixtures.ts'

/**
 * brief_update / ws_brief 经唤醒绑定 token 的端到端测试（D6、D8、D15）：真实签发的 wake token →
 * 鉴权中间件 → 与 run.ts 相同的 binding → 简报路由 → 写入层。
 */

const WS = 'ws/product-res'
const OTHER = 'ws/xuanxue-saas'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const roles: RoleLookup = async (name) =>
  ok(
    name === 'supervisor'
      ? {
          name: 'supervisor',
          executor: 'claude-sdk',
          kind: 'supervisor' as const,
          permissions: {
            setting_sources: [],
            allowedTools: ['Read', 'Grep', 'Glob'],
            disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
          },
          creatable_by: ['*'],
        }
      : null,
  )

async function setup() {
  const home = await initTempHome('flow-brief-wake-')
  const restore = isolateHub(home)
  const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
  const l = await tempLedger({ now: clock.now })
  const wakeTokens = createWakeTokenAuthority({ ledger: () => l.store, now: clock.now })
  const protocol = createNodeProtocol({
    ledger: l.store,
    clock,
    leaseTtlS: 60,
    leaseWaitMaxS: 0,
    issueWakeToken: (g) => wakeTokens.issue(g),
  })
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: async (ref) => ref === WS || ref === OTHER,
    workspaces: async (ref) =>
      ref === WS || ref === OTHER
        ? { ref, repos: [], supervisor: defaultSupervisorConfig() }
        : null,
    roles,
    now: clock.now,
  })
  const app = createHubApp({
    token: testToken,
    wakeTokens,
    ledger: l.store,
    mount: [
      { path: '/', app: protocol.routes },
      {
        path: '/',
        app: createBriefRoutes({
          ledger: l.store,
          home,
          // 与 run.ts 相同：只信任鉴权中间件按唤醒 token 认定的绑定。
          binding: wakeBinding,
        }),
      },
    ],
  })
  cleanups.push(() => {
    protocol.stop()
    l.cleanup()
    restore()
    rmSync(join(home, '..'), { recursive: true, force: true })
  })
  must(
    protocol.service.registerNode(
      { node_id: 'nw', hostname: 'h', version: '0.0.0', capabilities: ['executor:fake', 'wake'] },
      'unknown',
    ),
  )
  let generation = 0
  /** 中枢以 hub 建唤醒任务并由节点领取，返回租约下发的唤醒 token。 */
  const wake = async (origin: WakeOrigin, ws = WS) => {
    const g = ++generation
    const t = must(
      await tasks.createTask(
        {
          goal: '处理唤醒',
          workspace: ws,
          role: 'supervisor',
          executor: 'fake',
          requires: ['wake'],
          idempotency_key: `supervisor:${ws}:${g}`,
          inputs: { wake: { origin, generation: g, events: [] } },
        },
        {
          actor: 'hub',
          ...(origin === 'reply' ? {} : { origin }),
          withCreated: (id): EventInput[] => [
            {
              task_id: id,
              workspace: ws,
              type: 'supervisor.wake_started',
              payload: { task_id: id, workspace: ws, origin, events: [], generation: g },
            },
          ],
        },
      ),
    ).task
    const r = must(
      await protocol.service.acquire(
        { node_id: 'nw', capabilities: ['executor:fake', 'wake'] },
        { actor: 'node:nw' },
      ),
    )
    expect(r.lease?.task_id).toBe(t.id)
    const token = r.lease?.wake_token
    if (!token) throw new Error('没有下发唤醒 token')
    return token
  }
  /** MCP 中 supervisor 的操作上下文：以唤醒 token 访问进程内的中枢应用。 */
  const ctx = (token: string) => ({
    home,
    actor: 'supervisor',
    via: 'mcp' as const,
    token,
    fetch: (req: Request) => app.fetch(req),
  })
  return { home, app, wake, ctx }
}

const notePath = (home: string, id = 'product-res') => join(home, 'brain', 'briefs', `${id}.md`)
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

describe('唤醒 token → 鉴权中间件 → 简报路由', () => {
  test('同 workspace 写成功，下一次 ws_brief 第一节是新笔记', async () => {
    const { home, wake, ctx } = await setup()
    const token = await wake('instruction')
    const before = must(await wsBriefOp.run({ workspace: 'product-res', budget: 8000 }, ctx(token)))
    expect(before.hub).toBe('ok')
    const r = must(
      await briefUpdateOp.run(
        { workspace: 'product-res', text: '状态：进行中', base_hash: before.note_hash },
        ctx(token),
      ),
    )
    expect(r.changed).toBe(true)
    expect(readFileSync(notePath(home), 'utf8')).toBe('状态：进行中\n')
    const after = must(await wsBriefOp.run({ workspace: 'product-res', budget: 8000 }, ctx(token)))
    expect(after.text.startsWith('## 简报笔记（supervisor 维护）\n\n状态：进行中')).toBe(true)
  })

  test('跨 workspace 写返回 workspace_mismatch，读中枢数据同样被拒', async () => {
    const { home, app, wake, ctx } = await setup()
    const token = await wake('instruction')
    const r = await briefUpdateOp.run(
      { workspace: 'xuanxue-saas', text: '越界', base_hash: briefHash(null) },
      ctx(token),
    )
    expect(code(r)).toBe('workspace_mismatch')
    expect(existsSync(notePath(home, 'xuanxue-saas'))).toBe(false)
    const read = await app.request(`/v1/briefs/context?workspace=${encodeURIComponent(OTHER)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(read.status).toBe(403)
    expect(await read.json()).toMatchObject({ error: { code: 'workspace_mismatch' } })
    const own = await app.request(`/v1/briefs/context?workspace=${encodeURIComponent(WS)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(own.status).toBe(200)
    // user 不受唤醒绑定约束。
    const asUser = await app.request(`/v1/briefs/context?workspace=${encodeURIComponent(OTHER)}`, {
      headers: { Authorization: `Bearer ${testToken}` },
    })
    expect(asUser.status).toBe(200)
  })

  test('reply 唤醒返回 reply_only_wake，文件不变', async () => {
    const { home, wake, ctx } = await setup()
    const token = await wake('reply')
    const r = await briefUpdateOp.run(
      { workspace: 'product-res', text: '代回复唤醒写笔记', base_hash: briefHash(null) },
      ctx(token),
    )
    expect(code(r)).toBe('reply_only_wake')
    expect(existsSync(notePath(home))).toBe(false)
  })
})
