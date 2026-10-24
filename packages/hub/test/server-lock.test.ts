import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { flowPaths } from '@flow/core'
import { acquireHubLock } from '../src/index.ts'

let home: string
let previousHome: string | undefined
const children: ChildProcessWithoutNullStreams[] = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'flow-hub-lock-'))
  previousHome = process.env.FLOW_HOME
  process.env.FLOW_HOME = home
})
afterEach(async () => {
  for (const proc of children.splice(0)) if (proc.exitCode === null) proc.kill('SIGKILL')
  if (previousHome === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/**
 * 子进程竞争者：打印 ready 后等待一行 go 再取锁，打印结果后持锁直到 stdin 关闭再正常退出。
 * 子进程故意不保留 HubLock 的引用并触发 GC，验证锁连接不会因回收而被悄悄关闭。
 */
const contenderScript = `
  import { createInterface } from 'node:readline';
  import { acquireHubLock } from './src/index.ts';
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  console.log('ready');
  await lines.next();
  const result = await acquireHubLock(process.env.FLOW_HOME);
  const summary = result.ok ? { ok: true } : { ok: false, error: result.error };
  globalThis.Bun?.gc(true);
  console.log(JSON.stringify(summary));
  await lines.next();
  process.exit(0);
`

interface Contender {
  proc: ChildProcessWithoutNullStreams
  next(): Promise<string>
  exited: Promise<number | null>
}

function spawnContender(): Contender {
  const proc = spawn(process.execPath, ['-e', contenderScript], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, FLOW_HOME: home },
    stdio: 'pipe',
  })
  children.push(proc)
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('exit', resolve)
  })
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  proc.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return {
    proc,
    exited,
    async next() {
      const line = await lines.next()
      if (line.done) throw new Error(`子进程提前退出：${stderr}`)
      return line.value
    },
  }
}

type Summary = { ok: true } | { ok: false; error: { code: string; details?: { pid?: number } } }

async function acquireIn(contender: Contender): Promise<Summary> {
  expect(await contender.next()).toBe('ready')
  contender.proc.stdin.write('go\n')
  return JSON.parse(await contender.next())
}

const missing = { code: 'ENOENT' }

describe('中枢单实例锁', () => {
  test('拒绝存活持有者并返回 pid；重复释放无害；释放后可重新取得', async () => {
    const first = await acquireHubLock(home)
    if (!first.ok) throw new Error(first.error.message)
    try {
      expect(await acquireHubLock(home)).toMatchObject({
        ok: false,
        error: { kind: 'failure', code: 'hub_already_running', details: { pid: process.pid } },
      })
    } finally {
      await first.data.release()
    }
    await first.data.release()
    await expect(stat(flowPaths(home).hubPid)).rejects.toMatchObject(missing)
    const next = await acquireHubLock(home)
    expect(next.ok).toBe(true)
    if (next.ok) await next.data.release()
  })

  test('取得锁后写入 hub.pid；释放只删除自己写的记录', async () => {
    const acquired = await acquireHubLock(home)
    if (!acquired.ok) throw new Error(acquired.error.message)
    const paths = flowPaths(home)
    expect(acquired.data.path).toBe(paths.hubLock)
    expect(JSON.parse(await readFile(paths.hubPid, 'utf8'))).toMatchObject({ pid: process.pid })
    expect((await stat(paths.hubPid)).mode & 0o777).toBe(0o600)
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' })
    await writeFile(paths.hubPid, replacement)
    await acquired.data.release()
    expect(await readFile(paths.hubPid, 'utf8')).toBe(replacement)
  })

  test('同进程并发取锁恰好一个成功；崩溃遗留的 hub.pid 与旧版守护文件不影响取锁', async () => {
    const paths = flowPaths(home)
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => dead.once('exit', resolve))
    const initial = await acquireHubLock(home)
    if (!initial.ok) throw new Error(initial.error.message)
    await initial.data.release()
    const stale = JSON.stringify({ pid: dead.pid, token: 'stale' })
    await writeFile(paths.hubPid, stale)
    await writeFile(`${paths.hubPid}.steal`, stale)
    for (let round = 0; round < 5; round++) {
      const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireHubLock(home)))
      const winners = attempts.filter((result) => result.ok)
      try {
        expect(winners).toHaveLength(1)
        for (const result of attempts.filter((result) => !result.ok)) {
          expect(result).toMatchObject({ ok: false, error: { code: 'hub_already_running' } })
        }
      } finally {
        await Promise.all(winners.map((result) => (result.ok ? result.data.release() : undefined)))
      }
    }
  })

  test('跨进程同时取锁恰好一个成功；持有者正常退出后锁与 hub.pid 都被释放', async () => {
    const contenders = Array.from({ length: 6 }, spawnContender)
    for (const contender of contenders) expect(await contender.next()).toBe('ready')
    for (const contender of contenders) contender.proc.stdin.write('go\n')
    const results: Summary[] = await Promise.all(
      contenders.map(async (contender) => JSON.parse(await contender.next())),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    for (const result of results.filter((result) => !result.ok)) {
      expect(result).toMatchObject({ ok: false, error: { code: 'hub_already_running' } })
    }
    const winner = contenders[results.findIndex((result) => result.ok)]
    if (!winner) throw new Error('没有胜者')
    // 胜者仍在持锁（并已经历 GC）：本进程同样被拒绝，并读到胜者的 pid。
    expect(await acquireHubLock(home)).toMatchObject({
      ok: false,
      error: { code: 'hub_already_running', details: { pid: winner.proc.pid } },
    })
    for (const contender of contenders) contender.proc.stdin.end()
    expect(await Promise.all(contenders.map((contender) => contender.exited))).toEqual(
      contenders.map(() => 0),
    )
    await expect(stat(flowPaths(home).hubPid)).rejects.toMatchObject(missing)
    const next = await acquireHubLock(home)
    expect(next.ok).toBe(true)
    if (next.ok) await next.data.release()
  })

  test('持有者被 kill -9 后锁立即可取得', async () => {
    const holder = spawnContender()
    expect(await acquireIn(holder)).toEqual({ ok: true })
    expect(await acquireHubLock(home)).toMatchObject({
      ok: false,
      error: { code: 'hub_already_running', details: { pid: holder.proc.pid } },
    })
    holder.proc.kill('SIGKILL')
    await holder.exited
    // 崩溃遗留的 hub.pid 仍在，但不影响取锁，新持有者会覆盖它。
    expect(JSON.parse(await readFile(flowPaths(home).hubPid, 'utf8')).pid).toBe(holder.proc.pid)
    const acquired = await acquireHubLock(home)
    if (!acquired.ok) throw new Error(acquired.error.message)
    expect(JSON.parse(await readFile(flowPaths(home).hubPid, 'utf8')).pid).toBe(process.pid)
    await acquired.data.release()
  })

  test('hub.pid 损坏或失效时：无持有者可取锁并覆盖；有持有者仍拒绝但不报 pid', async () => {
    const paths = flowPaths(home)
    const holder = await acquireHubLock(home)
    if (!holder.ok) throw new Error(holder.error.message)
    await writeFile(paths.hubPid, 'broken')
    const busy = await acquireHubLock(home)
    expect(busy).toMatchObject({ ok: false, error: { code: 'hub_already_running' } })
    expect(busy.ok || busy.error.details).toBeFalsy()
    await holder.data.release()
    expect(await readFile(paths.hubPid, 'utf8')).toBe('broken')
    const next = await acquireHubLock(home)
    if (!next.ok) throw new Error(next.error.message)
    expect(JSON.parse(await readFile(paths.hubPid, 'utf8')).pid).toBe(process.pid)
    await next.data.release()
  })
})
