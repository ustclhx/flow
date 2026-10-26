import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  flowAuthor,
  type GitOptions,
  git,
  gitCommit,
  gitInit,
  hasCommits,
  isRepoRoot,
} from './git.ts'
import { flowPaths, GIT_REPOS, type RepoName } from './home.ts'
import { fail, ok, type Result } from './result.ts'
import { DEFAULT_ROLE_FILES } from './role-templates.ts'
import {
  BRAIN_INDEX_MD,
  BRAIN_LOG_MD,
  brainAgentsMd,
  CONFIG_GITLEAKS_TOML,
  GITLEAKS_TOML,
  POLICIES_YAML,
  PRE_COMMIT_HOOK,
  SCHEDULES_YAML,
} from './templates.ts'

export interface InitReport {
  home: string
  /** 本次补齐的目录与文件（相对 flow-home，目录以 `/` 结尾）。 */
  created: string[]
  /** 本次产生了提交的仓库。 */
  committed: RepoName[]
  /** 没有任何缺失项。 */
  complete: boolean
}

interface RepoFile {
  /** 相对仓库根的路径。 */
  path: string
  content: () => string
}

const REPO_FILES: Record<RepoName, RepoFile[]> = {
  config: [
    { path: '.gitleaks.toml', content: () => CONFIG_GITLEAKS_TOML },
    { path: 'policies.yaml', content: () => POLICIES_YAML },
    // 只有注释掉的巡检示例（D13）；已有 schedules.yaml 不覆盖。
    { path: 'schedules.yaml', content: () => SCHEDULES_YAML },
    ...Object.entries(DEFAULT_ROLE_FILES).map(([name, content]) => ({
      path: `roles/${name}`,
      content: () => content,
    })),
  ],
  brain: [
    { path: '.gitleaks.toml', content: () => GITLEAKS_TOML },
    { path: 'AGENTS.md', content: brainAgentsMd },
    { path: 'index.md', content: () => BRAIN_INDEX_MD },
    { path: 'log.md', content: () => BRAIN_LOG_MD },
  ],
  raw: [{ path: '.gitleaks.toml', content: () => GITLEAKS_TOML }],
}

const toPosix = (p: string) => p.split(sep).join('/')

/** 仅在文件不存在时创建（`wx`，即使并发也绝不覆盖）。返回是否创建。 */
async function createIfMissing(path: string, content: string, mode?: number): Promise<boolean> {
  if (existsSync(path)) return false
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, content, { flag: 'wx', ...(mode === undefined ? {} : { mode }) })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  if (mode !== undefined) await chmod(path, mode)
  return true
}

async function ensureDir(path: string): Promise<boolean> {
  if (existsSync(path)) return false
  await mkdir(path, { recursive: true })
  return true
}

/**
 * 初始化 flow-home（flow-home spec）。幂等：已有文件绝不覆盖或删除，只补齐缺失项并报告。
 * - 创建 config/、brain/、raw/、state/；前三者各自 `git init`，state/ 不进 git。
 * - 写入各仓库的 `.gitleaks.toml` 与提交前钩子，以及 brain 的 AGENTS.md、index.md、log.md。
 * - 把本次新建的被跟踪文件提交一次，作者 `Flow (init)`。
 */
export async function initFlowHome(
  home: string,
  opts: GitOptions = {},
): Promise<Result<InitReport>> {
  const paths = flowPaths(home)
  const created: string[] = []
  const committed: RepoName[] = []
  const rel = (p: string) => toPosix(relative(home, p))

  try {
    await mkdir(home, { recursive: true })
    for (const dir of [paths.config, paths.brain, paths.raw, paths.state, paths.workspaces]) {
      if (await ensureDir(dir)) created.push(`${rel(dir)}/`)
    }

    for (const repo of GIT_REPOS) {
      const dir = paths[repo]
      if (!isRepoRoot(dir)) {
        const r = await gitInit(dir, opts)
        if (!r.ok) return r
        created.push(`${repo}/.git/`)
      }

      const newFiles: string[] = []
      for (const f of REPO_FILES[repo]) {
        if (await createIfMissing(join(dir, f.path), f.content())) newFiles.push(f.path)
      }
      created.push(...newFiles.map((f) => `${repo}/${f}`))

      const fresh = !(await hasCommits(dir, opts))
      // 重建的文件可能与已提交版本完全相同（例如误删后补回），这些不需要提交。
      const toCommit: string[] = []
      for (const f of newFiles) {
        if (fresh || (await git(dir, ['status', '--porcelain', '--', f], opts)).stdout !== '') {
          toCommit.push(f)
        }
      }
      if (toCommit.length > 0 || fresh) {
        // 只提交本次由模板生成的文件；内容不含密钥，因此跳过钩子（此时 gitleaks 可能尚未安装）。
        const c = await gitCommit(dir, {
          ...opts,
          message: fresh ? 'init: 初始化 flow-home 仓库' : `init: 补齐 ${toCommit.join(', ')}`,
          author: flowAuthor('init'),
          paths: toCommit,
          allowEmpty: toCommit.length === 0,
          noVerify: true,
        })
        if (!c.ok) return c
        committed.push(repo)
      }

      // 钩子不被 git 跟踪，放在提交之后安装。用户已有的钩子不覆盖，由 flow doctor 检查。
      const hook = join(dir, '.git', 'hooks', 'pre-commit')
      if (await createIfMissing(hook, PRE_COMMIT_HOOK, 0o755)) created.push(rel(hook))
    }
  } catch (err) {
    return fail('failure', 'init_failed', `初始化失败：${(err as Error).message}`)
  }

  return ok({ home, created, committed, complete: created.length === 0 })
}

export function formatInitReport(r: InitReport): string {
  if (r.complete) return `flow-home：${r.home}\n无缺失项`
  return [`flow-home：${r.home}`, '补齐了以下项：', ...r.created.map((c) => `  + ${c}`)].join('\n')
}
