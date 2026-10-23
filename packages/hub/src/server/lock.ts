import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { fail, flowPaths, ok, type Result } from '@flow/core'
import { z } from 'zod'

const lockInfo = z.strictObject({ pid: z.number().int().positive(), token: z.string().min(1) })
type LockInfo = z.infer<typeof lockInfo>

export interface HubLock {
  readonly path: string
  readonly pid: number
  release(): Promise<void>
}

const isErrno = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
}

function parseLock(text: string): LockInfo {
  return lockInfo.parse(JSON.parse(text))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM 同样表示进程存在。
    return !isErrno(err, 'ESRCH')
  }
}

/** 完整写入临时文件后再原子 link，目标文件永远不会暴露半条锁记录。 */
async function atomicCreate(path: string, info: LockInfo): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(info)}\n`, { flag: 'wx', mode: 0o600 })
  try {
    await link(tmp, path)
    return true
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return false
    throw err
  } finally {
    await unlink(tmp)
  }
}

const ignoreMissing = (err: unknown) => {
  if (!isErrno(err, 'ENOENT')) throw err
}

/**
 * 只在文件内容仍等于 expected 时删除它。先原子 rename 到唯一的临时名，只有一个竞争者能拿到这个文件；
 * 拿到的若不是预期的记录（期间已被换成新的），就 link 回原处，不破坏别人的锁或守护。
 * 直接"读一遍再 unlink"不是原子的：读和删之间文件可能已被替换。
 */
async function removeIfUnchanged(path: string, expected: string): Promise<boolean> {
  // 先读：内容已经变了就绝不碰它。否则 rename 会把别人刚建好的锁短暂移走，
  // 在它被 link 回来之前，第三个竞争者可能趁空位拿到锁，造成两个持有者。
  if ((await readOptional(path)) !== expected) return false
  const moved = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.removing`
  try {
    await rename(path, moved)
  } catch (err) {
    ignoreMissing(err)
    return false
  }
  try {
    if ((await readOptional(moved)) === expected) return true
    await link(moved, path).catch((err) => {
      // 原处已有新记录：说明有人在此期间写入了更新的状态，保留它即可。
      if (!isErrno(err, 'EEXIST')) throw err
    })
    return false
  } finally {
    await unlink(moved).catch(ignoreMissing)
  }
}

/** 接管守护也记录 pid；守护内重新比较原锁，避免并发接管误删新持有者。 */
async function breakStale(path: string, staleText: string, info: LockInfo): Promise<void> {
  const guard = `${path}.steal`
  if (!(await atomicCreate(guard, info))) {
    const text = await readOptional(guard)
    // 崩溃遗留的守护：只有内容未变时才移除，避免删掉别人刚建立的守护。
    if (text && !pidAlive(parseLock(text).pid)) await removeIfUnchanged(guard, text)
    return
  }
  try {
    await removeIfUnchanged(path, staleText)
  } finally {
    await unlink(guard).catch(ignoreMissing)
  }
}

/** 同一个 flow-home 只能有一个中枢；不等待存活的持有者。 */
export async function acquireHubLock(home: string): Promise<Result<HubLock>> {
  const { hubPid: path, state } = flowPaths(home)
  const info: LockInfo = { pid: process.pid, token: randomBytes(16).toString('hex') }
  try {
    await mkdir(state, { recursive: true })
    for (;;) {
      if (await atomicCreate(path, info)) {
        let releasing: Promise<void> | undefined
        // exit 不允许异步工作；只删除仍属于自己的锁。
        const onExit = () => {
          try {
            if (parseLock(readFileSync(path, 'utf8')).token === info.token) unlinkSync(path)
          } catch (err) {
            if (!isErrno(err, 'ENOENT')) console.warn('释放中枢锁失败', err)
          }
        }
        process.once('exit', onExit)
        return ok({
          path,
          pid: info.pid,
          release() {
            releasing ??= (async () => {
              const text = await readOptional(path)
              if (text && parseLock(text).token === info.token) await unlink(path)
              process.off('exit', onExit)
            })()
            return releasing
          },
        })
      }
      const text = await readOptional(path)
      if (!text) continue
      const holder = parseLock(text)
      if (pidAlive(holder.pid)) {
        return fail('failure', 'hub_already_running', `中枢已在运行（pid ${holder.pid}）`, {
          pid: holder.pid,
        })
      }
      await breakStale(path, text, info)
      // 让持有接管守护的进程继续执行文件操作，避免忙循环。
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  } catch (err) {
    return fail('failure', 'hub_lock_failed', `无法获取中枢锁：${(err as Error).message}`)
  }
}
