import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flowAuthor, git, gitCommit } from '../git.ts'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { scanForSecrets } from './secrets.ts'

export async function readSecretFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** 调用方持有 withWriteLock；这里只接收密文和公开配置，明文绝不落盘。 */
export async function commitSecretFiles(
  home: string,
  files: Map<string, string>,
): Promise<Result<void>> {
  if (files.size === 0) return ok(undefined)
  const dir = flowPaths(home).config
  for (const content of files.values()) {
    const scanned = await scanForSecrets(content, { configPath: join(dir, '.gitleaks.toml') })
    if (!scanned.ok) return scanned
    if (scanned.data.findings.length)
      return fail('failure', 'secret_detected', '配置中检测到疑似明文密钥，已拒绝写入')
  }
  const originals = new Map<string, string | null>()
  try {
    for (const [path, content] of files) {
      const abs = join(dir, path)
      originals.set(path, await readSecretFile(abs))
      const tmp = `${abs}.flow-${randomUUID()}.tmp`
      try {
        await writeFile(tmp, content, { flag: 'wx' })
        await rename(tmp, abs)
      } finally {
        await unlink(tmp).catch(() => {})
      }
    }
    const committed = await gitCommit(dir, {
      paths: [...files.keys()],
      author: flowAuthor('user'),
      message: 'secrets: 更新加密密钥配置',
    })
    if (committed.ok) return ok(undefined)
  } catch {
    /* 错误不引用子进程输出，防止明文经诊断泄漏。 */
  }
  for (const [path, before] of originals) {
    const abs = join(dir, path)
    if (before === null) await rm(abs, { force: true })
    else await writeFile(abs, before)
  }
  await git(dir, ['reset', '-q', '--', ...files.keys()])
  return fail('failure', 'secrets_commit_failed', '提交密钥配置失败，已恢复文件')
}
