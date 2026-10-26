import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { stringify } from 'yaml'
import { git } from '../src/git.ts'
import { initFlowHome } from '../src/init.ts'

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

/** 新建并初始化一个临时 flow-home，并定义 `ws/product-res` 与 `ws/xuanxue-saas` 两个产品 workspace。 */
export async function initTempHome(prefix = 'flow-write-'): Promise<string> {
  const home = tempHome(prefix)
  const r = await initFlowHome(home)
  if (!r.ok) throw new Error(r.error.message)
  for (const id of ['product-res', 'xuanxue-saas']) {
    writeWorkspace(home, id, {
      id,
      kind: 'product',
      name: id,
      description: `${id} workspace`,
      repos: [`~/workspace/${id}`],
    })
  }
  return home
}

/** 仓库的提交数。 */
export async function commitCount(dir: string): Promise<number> {
  const r = await git(dir, ['rev-list', '--count', 'HEAD'])
  return Number(r.stdout.trim())
}

/** `git status --porcelain` 的输出；空串表示工作区与暂存区都干净。 */
export async function gitStatus(dir: string): Promise<string> {
  return (await git(dir, ['status', '--porcelain'])).stdout
}

/** 工作区文件内容（排除 `.git`、忽略 mtime），用于比较"写入前后内容完全一致"。 */
export function treeContents(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [path, v] of snapshot(dir)) {
    if (path === '.git' || path.startsWith(`.git/`)) continue
    out.set(path, v.content)
  }
  return out
}

/**
 * 让测试不可能连到真实中枢：把临时 home 的中枢端口配成不可达的 1，并清除环境变量
 * `FLOW_HUB_TOKEN`（临时 home 没有 `state/hub.token`）。返回恢复环境变量的函数。
 */
export function isolateHub(home: string): () => void {
  writeText(join(home, 'config', 'hub.yaml'), 'port: 1\n')
  const saved = process.env.FLOW_HUB_TOKEN
  delete process.env.FLOW_HUB_TOKEN
  return () => {
    if (saved === undefined) delete process.env.FLOW_HUB_TOKEN
    else process.env.FLOW_HUB_TOKEN = saved
  }
}
