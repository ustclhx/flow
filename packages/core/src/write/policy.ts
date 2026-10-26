import { BRAIN_BRIEFS_DIR, BRAIN_JOURNAL_DIR } from '../entries.ts'
import { parseFrontmatter } from '../frontmatter.ts'
import { fail, type Result } from '../result.ts'
import { isFactType, isResourceType } from '../schema/entries.ts'

/**
 * AI 写入边界（design D8、knowledge-access "AI 写入边界"）。`actor !== 'user'` 即视为 AI。
 * 这里的规则在统一写入路径的最前面执行，CLI、MCP 以及第 4 组的提案合入都绕不过去。
 */

export const USER_ACTOR = 'user'
export const isAiActor = (actor: string): boolean => actor !== USER_ACTOR

const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/
export const isValidActor = (actor: string): boolean => ACTOR_RE.test(actor)

export type WriteRepo = 'brain' | 'raw'

export type FileChange =
  /** 新建文件；文件已存在时失败。 */
  | { op: 'create'; path: string; content: string }
  /** 整体替换已有文件；`baseHash` 给出时必须与当前内容的哈希一致。 */
  | { op: 'replace'; path: string; content: string; baseHash?: string }
  /** 追加到文件末尾（不存在则新建，此时先写入 `header`）。 */
  | { op: 'append'; path: string; content: string; header?: string }
  /** 删除已有文件；`baseHash` 给出时必须与当前内容的哈希一致。 */
  | { op: 'delete'; path: string; baseHash?: string }

/** brain 中由 Flow 维护、不能经文件操作直接写入的文件。 */
const BRAIN_INDEX = 'index.md'
const BRAIN_LOG = 'log.md'
const BRAIN_AGENTS = 'AGENTS.md'
const JOURNAL_FILE_RE = new RegExp(`^${BRAIN_JOURNAL_DIR}/\\d{4}-\\d{2}-\\d{2}\\.md$`)
/** `briefs/<id>.md`，`<id>` 与 workspace 标识去掉 `ws/` 前缀后的写法一致。 */
const BRIEF_FILE_RE = new RegExp(`^${BRAIN_BRIEFS_DIR}/[a-z0-9][a-z0-9-]*\\.md$`)

export type BrainFileKind = 'entry' | 'journal' | 'agents' | 'brief'

/** 可以经中枢写简报笔记的身份（design D7：supervisor、user）。 */
export const BRIEF_WRITERS = ['user', 'supervisor'] as const

/** 仓库内相对路径是否安全：posix、不越界、不含隐藏段（`.git`、`.gitleaks.toml` 等）。 */
export function checkRepoPath(path: string): Result<never> | null {
  const segs = path.split('/')
  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))
  ) {
    return fail('usage', 'invalid_path', `不合法的仓库内路径：${JSON.stringify(path)}`)
  }
  return null
}

/** brain 内路径的分类；index.md / log.md 等不允许直接写的返回错误。 */
export function classifyBrainPath(path: string): Result<never> | BrainFileKind {
  if (path === BRAIN_LOG) {
    return fail('failure', 'log_append_only', 'log.md 只能由 Flow 在写入时追加，已有行不得修改')
  }
  if (path === BRAIN_INDEX) {
    return fail('failure', 'index_generated', 'index.md 由 Flow 自动生成，不能直接写入')
  }
  if (path === BRAIN_AGENTS) return 'agents'
  if (path.startsWith(`${BRAIN_JOURNAL_DIR}/`)) {
    if (!JOURNAL_FILE_RE.test(path)) {
      return fail('usage', 'invalid_path', `journal 文件应为 journal/YYYY-MM-DD.md：${path}`)
    }
    return 'journal'
  }
  if (path.startsWith(`${BRAIN_BRIEFS_DIR}/`)) {
    if (!BRIEF_FILE_RE.test(path)) {
      return fail('usage', 'invalid_path', `简报笔记文件应为 briefs/<workspace id>.md：${path}`)
    }
    return 'brief'
  }
  if (!path.endsWith('.md')) {
    return fail('usage', 'invalid_path', `brain 中只能写 Markdown 条目（.md）：${path}`)
  }
  return 'entry'
}

const frontmatterOf = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null
  const parsed = parseFrontmatter(text)
  return parsed.ok ? parsed.data.data : null
}

const userOnly = (fm: Record<string, unknown> | null, path: string): Result<never> | null => {
  if (!fm) return null
  if (fm.type === 'decision') {
    return fail('failure', 'ai_forbidden_decision', `决策条目只能由用户写入：${path}`)
  }
  if (fm.scope === 'personal') {
    return fail('failure', 'ai_forbidden_personal', `personal 范围的条目只能由用户写入：${path}`)
  }
  return null
}

/**
 * 资源、product、project-card 是共享事实：AI 只能通过修改提案提交，由用户确认后合入
 * （knowledge-access "修改提案"）。合入时以用户身份写入，因此不受此限制。runbook 允许 AI 直写。
 */
export const isProposalOnlyType = (type: unknown): boolean =>
  isResourceType(type) || type === 'product' || type === 'project-card'

const proposalOnly = (fm: Record<string, unknown> | null, path: string): Result<never> | null =>
  fm && isProposalOnlyType(fm.type)
    ? fail(
        'failure',
        'proposal_required',
        `AI 不能直接写入 ${String(fm.type)} 条目，请提交修改提案：${path}`,
      )
    : null

export interface PolicyOptions {
  /**
   * 本次写入来自中枢的简报写入函数（`writeBrief`）。简报笔记（design D8）只能这样写：
   * 条目写入、提案合入等其他路径一律拒绝，包括 user 身份。
   */
  briefWrite?: boolean
}

/**
 * 对单个文件操作做策略检查。`existing` 是文件当前内容（不存在为 null）。
 * 返回 null 表示允许。
 */
export function checkPolicy(
  repo: WriteRepo,
  change: FileChange,
  existing: string | null,
  actor: string,
  options: PolicyOptions = {},
): Result<never> | null {
  const bad = checkRepoPath(change.path)
  if (bad) return bad
  const ai = isAiActor(actor)

  if (repo === 'raw') {
    // raw 只追加：任何人都只能新建文件，已有文件不得修改或删除。
    if (change.op !== 'create') {
      return fail(
        'failure',
        'raw_immutable',
        `raw 中已有的文件不得修改或删除，只能新增文件：${change.path}`,
      )
    }
    return null
  }

  const kind = classifyBrainPath(change.path)
  if (typeof kind !== 'string') return kind
  if (kind === 'brief') {
    if (!options.briefWrite) {
      return fail(
        'failure',
        'brief_hub_only',
        `简报笔记只能经中枢的 brief_update 写入，不能直接写：${change.path}`,
      )
    }
    if (!(BRIEF_WRITERS as readonly string[]).includes(actor)) {
      return fail('failure', 'role_not_allowed', `身份 ${actor} 不能写简报笔记`)
    }
    if (change.op !== 'create' && change.op !== 'replace') {
      return fail('usage', 'invalid_op', `简报笔记只能整体替换：${change.path}`)
    }
    return null
  }
  if (kind === 'agents') {
    if (ai) return fail('failure', 'ai_forbidden_file', 'brain/AGENTS.md 只能由用户修改')
    return change.op === 'append' ? fail('usage', 'invalid_op', 'AGENTS.md 只能整体替换') : null
  }
  if (kind === 'journal') {
    if (ai && change.op !== 'append') {
      return fail(
        'failure',
        'journal_append_only',
        `AI 只能追加 journal，不能改写或删除：${change.path}`,
      )
    }
    return null
  }

  // 条目：整体写入，不支持追加。
  if (change.op === 'append') {
    return fail('usage', 'invalid_op', `条目只能整体新建、替换或删除，不能追加：${change.path}`)
  }
  if (!ai) return null
  const before = frontmatterOf(existing)
  const after = change.op === 'delete' ? null : frontmatterOf(change.content)
  const denied = userOnly(before, change.path) ?? userOnly(after, change.path)
  if (denied) return denied
  const proposal = proposalOnly(before, change.path) ?? proposalOnly(after, change.path)
  if (proposal) return proposal
  if (after && isFactType(after.type)) {
    const sources = after.sources
    const has =
      Array.isArray(sources) && sources.some((s) => typeof s === 'string' && s.trim() !== '')
    if (!has) {
      return fail(
        'failure',
        'sources_required',
        `事实类条目需要出处（sources 为空）：${change.path}`,
      )
    }
  }
  return null
}
