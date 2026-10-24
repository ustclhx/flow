import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEvent, TaskContractInput, TaskView } from '@flow/core'
import {
  createHubApp,
  createNodeProtocol,
  createTaskRoutes,
  createTaskService,
  type LedgerStore,
  type NodeProtocol,
  openLedger,
  type TaskService,
} from '@flow/hub'
import { type RunningNode, type StartNodeOptions, startNode } from '../src/index.ts'

/**
 * 进程内的"中枢 + 节点"测试台（add-m1-executors 1.2 / 1.3）：
 * 中枢的 Hono 应用直接作为节点的 fetch，二者共用一个完全由测试拨动的虚拟时钟，
 * 因此"15 分钟无进展""第 601 秒超时"这类场景可以确定地在毫秒内跑完。
 * 中枢的过期扫描不自动运行，需要时调用 `sweep()`。
 */

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r))
}

export class ManualClock {
  private timers = new Map<number, { at: number; cb: () => void | Promise<void> }>()
  private nextId = 0
  constructor(public time = Date.parse('2026-10-25T08:00:00.000Z')) {}
  now = () => this.time
  monotonic = () => this.time
  setTimeout(cb: () => void | Promise<void>, delayMs: number) {
    const id = ++this.nextId
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), cb })
    return () => {
      this.timers.delete(id)
    }
  }
  /** 按到期顺序触发定时器，每个回调之后让出足够多轮事件循环，让 HTTP 往返完成。 */
  async advance(ms: number) {
    const target = this.time + ms
    await flush()
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next || next[1].at > target) break
      this.time = next[1].at
      this.timers.delete(next[0])
      void next[1].cb()
      await flush()
    }
    this.time = target
    await flush()
  }
}

const quiet = { info() {}, warn() {} }
const TOKEN = 'k'.repeat(43)

export interface Bench {
  home: string
  clock: ManualClock
  ledger: LedgerStore
  tasks: TaskService
  protocol: NodeProtocol
  node: RunningNode
  /** 经 HTTP 调用中枢（与节点同一个应用）。 */
  api<T>(method: string, path: string, body?: unknown, actor?: string): Promise<T>
  create(over?: Partial<TaskContractInput>): Promise<string>
  task(id: string): TaskView
  events(id: string): LedgerEvent[]
  types(id: string): string[]
  /** 拨动时钟直到任务满足条件（每次 1 秒，最多 maxMs）。 */
  until(id: string, pred: (t: TaskView) => boolean, maxMs?: number): Promise<TaskView>
  sweep(): number
  close(): Promise<void>
}

export async function bench(
  nodeOptions: Partial<StartNodeOptions> = {},
  leaseTtlS = 60,
): Promise<Bench> {
  const clock = new ManualClock()
  const home = join(mkdtempSync(join(tmpdir(), 'flow-node-bench-')), 'home')
  const ledger = await openLedger(':memory:', { now: clock.now })
  const tasks = createTaskService({ ledger, workspaceExists: () => true, now: clock.now })
  const protocol = createNodeProtocol({ ledger, clock, leaseTtlS, leaseWaitMaxS: 30 })
  const app = createHubApp({
    token: TOKEN,
    ledger,
    clock,
    mount: [
      { path: '/', app: createTaskRoutes({ ledger, tasks }) },
      { path: '/', app: protocol.routes },
    ],
  })
  const fetch = async (input: string, init?: RequestInit) => app.fetch(new Request(input, init))
  const started = await startNode({
    home,
    clock,
    token: TOKEN,
    hubUrl: 'http://hub.test',
    fetch,
    nodeId: 'n-bench',
    hostname: 'bench',
    logger: quiet,
    waitS: 30,
    ...nodeOptions,
  })
  if (!started.ok) throw new Error(started.error.message)
  const node = started.data
  await clock.advance(0)

  const b: Bench = {
    home,
    clock,
    ledger,
    tasks,
    protocol,
    node,
    async api<T>(method: string, path: string, body?: unknown, actor = 'user') {
      const res = await fetch(`http://hub.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Flow-Actor': actor,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return (await res.json()) as T
    },
    async create(over = {}) {
      const r = await tasks.createTask(
        { goal: '卡住检测', workspace: 'ws/demo', role: 'dev', executor: 'fake', ...over },
        { actor: 'user' },
      )
      if (!r.ok) throw new Error(r.error.message)
      await clock.advance(0)
      return r.data.task.id
    },
    task(id) {
      const t = ledger.getTask(id)
      if (!t) throw new Error(`没有任务 ${id}`)
      return t
    },
    events: (id) => ledger.taskEvents(id),
    types: (id) => ledger.taskEvents(id).map((e) => e.type),
    async until(id, pred, maxMs = 3_600_000) {
      for (let waited = 0; ; waited += 1000) {
        const t = b.task(id)
        if (pred(t)) return t
        if (waited >= maxMs) {
          throw new Error(`等待超时：${t.status} ${b.types(id).join(',')}`)
        }
        await clock.advance(1000)
      }
    },
    sweep: () => protocol.sweep(),
    async close() {
      const stopping = node.stop()
      await clock.advance(60_000)
      await stopping
      protocol.stop()
      ledger.close()
      rmSync(join(home, '..'), { recursive: true, force: true })
    },
  }
  return b
}

export const fake = (f: Record<string, unknown>) => ({ inputs: { fake: f } })
