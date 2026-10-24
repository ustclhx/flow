import { readFileSync } from 'node:fs'

/** Linux 的孤儿可能尚未被回收；僵尸已终止，不再执行脚本或占有管道。 */
export function processStopped(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw err
    }
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw err
  }
}
