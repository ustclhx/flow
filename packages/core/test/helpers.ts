import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { stringify } from 'yaml'

/** 新建一个临时 flow-home 路径（目录本身尚不存在），绝不触碰真实的 ~/flow-home。 */
export function tempHome(prefix = 'flow-test-'): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'home')
}

export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** 在 `home/brain/<id>.md` 写入一个条目。 */
export function writeEntry(
  home: string,
  id: string,
  frontmatter: Record<string, unknown>,
  body = '正文\n',
): void {
  writeText(join(home, 'brain', `${id}.md`), `---\n${stringify(frontmatter)}---\n${body}`)
}

export function writeWorkspace(home: string, id: string, data: Record<string, unknown>): void {
  writeText(join(home, 'config', 'workspaces', `${id}.yaml`), stringify(data))
}

/** 递归记录目录下每个文件的内容与 mtime，用于比较"没有任何改动"。 */
export function snapshot(dir: string): Map<string, { content: string; mtimeMs: number }> {
  const out = new Map<string, { content: string; mtimeMs: number }>()
  const walk = (d: string) => {
    for (const item of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, item.name)
      if (item.isDirectory()) walk(p)
      else if (item.isFile()) {
        out.set(relative(dir, p), {
          content: readFileSync(p).toString('base64'),
          mtimeMs: statSync(p).mtimeMs,
        })
      }
    }
  }
  walk(dir)
  return out
}

/** 由片段拼出一个假 Stripe 密钥，避免源码本身被扫描器当作泄漏。 */
export const fakeStripeKey = (): string =>
  ['sk', 'live', '51Hq8ZtLm3Xr7VbN2cKd9WfPy4Gs6Ja'].join('_')
