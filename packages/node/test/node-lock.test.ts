import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startNode } from '../src/node.ts'
import { acquireNodeLock } from '../src/node-lock.ts'
import { writeWakeTokenFile } from '../src/wake-token.ts'
import { type Bench, bench } from './harness.ts'

/** 节点单实例锁（#57 遗留）：并行节点不能启动，因此启动清理不会误删对方的唤醒 token 文件。 */

const roots: string[] = []
let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('acquireNodeLock', () => {
  test('同一 flow-home 只有一个持有者；释放后可再次取得', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-node-lock-'))
    roots.push(root)
    const home = join(root, 'flow-home')
    const a = await acquireNodeLock(home)
    expect(a.ok).toBe(true)
    const b = await acquireNodeLock(home)
    expect(b.ok ? 'ok' : b.error.code).toBe('node_already_running')
    if (a.ok) a.data.release()
    const c = await acquireNodeLock(home)
    expect(c.ok).toBe(true)
    if (c.ok) c.data.release()
  })
})

describe('startNode 持锁', () => {
  test('已有节点运行时第二个节点拒绝启动，且不清理 state/wake；停止后可重新启动', async () => {
    current = await bench()
    const b = current
    const token = await writeWakeTokenFile(b.home, 't-1', 'l-1', 'fwk_placeholder')
    const second = await startNode({
      home: b.home,
      clock: b.clock,
      token: 'x',
      hubUrl: 'http://hub.test',
      fetch: async () => new Response(null, { status: 503 }),
      nodeId: 'n-second',
      logger: { info() {}, warn() {} },
    })
    expect(second.ok ? 'ok' : second.error.code).toBe('node_already_running')
    expect(existsSync(token)).toBe(true)
    await b.node.stop()
    const third = await startNode({
      home: b.home,
      clock: b.clock,
      token: 'x',
      hubUrl: 'http://hub.test',
      fetch: async () => new Response(null, { status: 503 }),
      nodeId: 'n-third',
      logger: { info() {}, warn() {} },
    })
    expect(third.ok).toBe(true)
    // 新节点持锁后清理上次残留。
    expect(existsSync(token)).toBe(false)
    if (third.ok) await third.data.stop()
  })
})
