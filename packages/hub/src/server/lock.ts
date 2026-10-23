import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
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

/** 接管守护也记录 pid；守护内重新比较原锁，避免并发接管误删新持有者。 */
async function breakStale(path: string, staleText: string, info: LockInfo): Promise<void> {
  const guard = `${path}.steal`
  if (!(await atomicCreate(guard, info))) {
    const text = await readOptional(guard)
    if (text && !pidAlive(parseLock(text).pid)) {
      // 重新确认崩溃遗留的守护身份，避免删除已经更换的记录。
      if ((await readOptional(guard)) === text)
        await unlink(guard).catch((err) => {
          if (!isErrno(err, 'ENOENT')) throw err
        })
    }
    return
  }
  try {
    if ((await readOptional(path)) === staleText) await unlink(path)
  } finally {
    await unlink(guard)
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
