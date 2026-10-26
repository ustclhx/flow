import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { entryIdOf, readBrainEntries } from '../entries.ts'
import { parseFrontmatter } from '../frontmatter.ts'
import { flowAuthor, type GitOptions, git, gitCommit } from '../git.ts'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { checkEntryFrontmatter, localDate } from '../validate.ts'
import type { ValidationIssue } from '../validation-issue.ts'
import { loadWorkspaces, type Workspace } from '../workspaces.ts'
import { BRIEF_WRITE } from './brief-capability.ts'
import { acquireWriteLock, type WriteLock } from './lock.ts'
import {
  checkPolicy,
  checkRepoPath,
  classifyBrainPath,
  type FileChange,
  isValidActor,
  type WriteRepo,
} from './policy.ts'
import { formatLogLine, isLogOp, type LogOp, renderIndex } from './render.ts'
import { type SecretFinding, scanForSecrets } from './secrets.ts'

/**
 * 统一写入路径（design D5–D8，knowledge-base "写入即提交"）。CLI 与 MCP 的所有写操作都经过
 * `commitWrite`：
 *
 *   加锁 → 策略检查 → 校验 → 密钥扫描 → 写文件 → 重新生成 index.md → 追加 log.md
 *   → git 提交（作者 `Flow (<actor>)`）→ 释放锁
 *
 * 一次调用只写一个仓库、恰好产生一次提交。任一步失败都会把文件恢复到写入前的内容、
 * 撤销暂存，不留下半写入状态，也不产生提交。
 *
 * brain 写入会重新生成 index.md 并向 log.md 追加一行，三者在同一次提交里。
 * raw 写入（随手记）只在 raw 仓库产生一次提交，不触碰 brain：随手记的 spec 要求
 * "brain/ 没有任何变化"，raw 提交信息本身（`capture(<actor>): ...`）就是审计记录。
 */

export interface WriteChange {
  repo: WriteRepo
  /** 操作类型：决定 log 行与提交信息的前缀。 */
  op: LogOp
  /** 一句话简述，写入 log 行与提交信息（压成单行）。 */
  summary: string
  /** 本次的文件操作，路径相对仓库根（posix），不能重复。 */
  files: FileChange[]
}

export interface WriteContext {
  /** 操作者；`user` 是用户本人，其他值一律视为 AI（design D8）。 */
  actor: string
  /** 写入时间，决定 log 日期等；测试中注入。 */
  now?: Date
  /** 调用方已持有的写锁（见 `withWriteLock`）；给出时不再重复加锁。 */
  lock?: WriteLock
  /** 等待写锁的超时，默认 10 秒。 */
  lockTimeoutMs?: number
  /** gitleaks 可执行文件，默认 `gitleaks`。 */
  gitleaksBin?: string
  /** 传给 git 调用的选项（例如替换 git 可执行文件），测试用。 */
  git?: GitOptions
  /** 简报笔记写入能力，只由 `writeBrief` 设置（见 brief-capability.ts）。 */
  [BRIEF_WRITE]?: true
}

export interface WriteReceipt {
  repo: WriteRepo
  op: LogOp
  actor: string
  /** 新提交的 sha。 */
  sha: string
  /** 本次提交涉及的文件（相对 flow-home，posix），含 index.md / log.md。 */
  files: string[]
  /** 追加到 log.md 的行；raw 写入为 null。 */
  logLine: string | null
  /** index.md 是否因本次写入而改变。 */
  indexChanged: boolean
}

/** 内容哈希（sha256 十六进制），用于提案的 base_hash 冲突检测（design D4）。 */
export const hashContent = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

const repoDir = (home: string, repo: WriteRepo): string => flowPaths(home)[repo]

/** 仓库内某文件当前内容的哈希；文件不存在返回 null。 */
export async function currentHash(
  home: string,
  repo: WriteRepo,
  path: string,
): Promise<string | null> {
  const text = await readText(join(repoDir(home, repo), path))
  return text === null ? null : hashContent(text)
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length - 1)
const withTrailingNewline = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`)

/** 一个文件在本次写入后的完整内容，以及新写入部分在文件中的起始行。 */
interface Planned {
  change: FileChange
  abs: string
  before: string | null
  after: string | null
  /** 需要扫描的新文本；删除时为空。 */
  newText: string
  /** newText 在最终文件中的起始行（从 1 开始）。 */
  firstLine: number
}

function plan(change: FileChange, abs: string, before: string | null): Planned {
  switch (change.op) {
    case 'create':
    case 'replace':
      return { change, abs, before, after: change.content, newText: change.content, firstLine: 1 }
    case 'delete':
      return { change, abs, before, after: null, newText: '', firstLine: 1 }
    case 'append': {
      const base = before === null ? (change.header ?? '') : withTrailingNewline(before)
      const added = withTrailingNewline(change.content)
      const newText = before === null ? base + added : added
      return {
        change,
        abs,
        before,
        after: base + added,
        newText,
        firstLine: before === null ? 1 : countLines(base) + 1,
      }
    }
  }
}

/** 存在性与 base hash 检查。 */
function checkPreconditions(p: Planned): Result<never> | null {
  const { change, before } = p
  if (change.op === 'create' && before !== null) {
    return fail('failure', 'already_exists', `文件已存在，不能新建：${change.path}`)
  }
  if ((change.op === 'replace' || change.op === 'delete') && before === null) {
    return fail('failure', 'not_found', `文件不存在：${change.path}`)
  }
  if (
    (change.op === 'replace' || change.op === 'delete') &&
    change.baseHash !== undefined &&
    before !== null &&
    hashContent(before) !== change.baseHash
  ) {
    return fail(
      'failure',
      'base_conflict',
      `目标文件在此之后已被改动，不予写入，请基于当前内容重新生成：${change.path}`,
      { path: change.path, expected: change.baseHash, actual: hashContent(before) },
    )
  }
  return null
}

/** brain 条目的 frontmatter 校验，与 `flow kb validate` 使用同一套规则。 */
function validateEntry(
  p: Planned,
  workspaces: ReadonlyMap<string, Workspace>,
  brain: string,
): ValidationIssue[] {
  if (p.after === null) return []
  const id = entryIdOf(brain, p.abs)
  const file = `brain/${p.change.path}`
  const parsed = parseFrontmatter(p.after)
  if (!parsed.ok) return [{ file, id, code: parsed.error.code, message: parsed.error.message }]
  return checkEntryFrontmatter(parsed.data.data, { file, id, workspaces })
}

/** 把多段新文本合在一次 gitleaks 调用里扫描，再把行号映射回各自的文件。 */
async function scanPieces(
  pieces: { file: string; text: string; firstLine: number }[],
  ctx: WriteContext,
  configPath: string,
): Promise<Result<{ file: string; line: number; ruleId: string }[]>> {
  const nonEmpty = pieces.filter((p) => p.text !== '')
  if (nonEmpty.length === 0) return ok([])
  const ranges: { piece: (typeof nonEmpty)[number]; start: number; lines: number }[] = []
  let combined = ''
  let line = 1
  for (const piece of nonEmpty) {
    const text = withTrailingNewline(piece.text)
    const lines = countLines(text)
    ranges.push({ piece, start: line, lines })
    combined += `${text}\n`
    line += lines + 1
  }
  const scanned = await scanForSecrets(combined, {
    configPath,
    ...(ctx.gitleaksBin === undefined ? {} : { gitleaksBin: ctx.gitleaksBin }),
  })
  if (!scanned.ok) return scanned
  return ok(
    scanned.data.findings.map((f: SecretFinding) => {
      const r = ranges.find((x) => f.line >= x.start && f.line < x.start + x.lines) ?? ranges[0]
      if (!r) return { file: '?', line: f.line, ruleId: f.ruleId }
      return { file: r.piece.file, line: r.piece.firstLine + (f.line - r.start), ruleId: f.ruleId }
    }),
  )
}

/** 写文件时记录的回滚信息。 */
class Rollback {
  private readonly originals = new Map<string, string | null>()
  private readonly createdDirs: string[] = []

  async ensureDir(dir: string): Promise<void> {
    const missing: string[] = []
    let d = dir
    while (!existsSync(d)) {
      missing.push(d)
      const parent = dirname(d)
      if (parent === d) break
      d = parent
    }
    if (missing.length === 0) return
    await mkdir(dir, { recursive: true })
    this.createdDirs.push(...missing)
  }

  /** 原子写入（临时文件 + rename）。首次触碰某文件时记录其原始内容。 */
  async write(abs: string, before: string | null, content: string | null): Promise<void> {
    if (!this.originals.has(abs)) this.originals.set(abs, before)
    if (content === null) {
      await unlink(abs)
      return
    }
    await this.ensureDir(dirname(abs))
    const tmp = `${abs}.flow-${process.pid}-${Date.now()}.tmp`
    await writeFile(tmp, content)
    await rename(tmp, abs)
  }

  async restore(): Promise<void> {
    for (const [abs, before] of [...this.originals].reverse()) {
      try {
        if (before === null) await unlink(abs).catch(() => {})
        else await writeFile(abs, before)
      } catch {}
    }
    // 从最深的目录开始，只删除本次新建且已为空的目录。
    for (const dir of [...this.createdDirs].sort((a, b) => b.length - a.length)) {
      await rmdir(dir).catch(() => {})
    }
  }
}

function describeFindings(findings: { file: string; line: number; ruleId: string }[]): string {
  return findings.map((f) => `${f.file} 第 ${f.line} 行（${f.ruleId}）`).join('；')
}

function describeIssues(issues: ValidationIssue[]): string {
  const shown = issues.slice(0, 5).map((i) => `${i.field ? `${i.field}：` : ''}${i.message}`)
  const more = issues.length > 5 ? `；另有 ${issues.length - 5} 项` : ''
  return `${shown.join('；')}${more}`
}

/** 目标仓库是否已由 `flow init` 初始化；未初始化返回 `not_initialized`。 */
export function checkRepoReady(home: string, repo: WriteRepo): Result<never> | null {
  const dir = repoDir(home, repo)
  if (existsSync(join(dir, '.git'))) return null
  return fail('failure', 'not_initialized', `未找到 ${dir} 仓库，请先运行 flow init`)
}

/** 统一写入：见文件头说明。成功返回提交回执。 */
export async function commitWrite(
  home: string,
  change: WriteChange,
  ctx: WriteContext,
): Promise<Result<WriteReceipt>> {
  if (!isValidActor(ctx.actor)) {
    return fail('usage', 'invalid_actor', `操作者标识不合法：${JSON.stringify(ctx.actor)}`)
  }
  if (change.repo !== 'brain' && change.repo !== 'raw') {
    return fail('usage', 'invalid_change', `不支持写入仓库：${String(change.repo)}`)
  }
  if (!isLogOp(change.op)) {
    return fail('usage', 'invalid_change', `未知操作类型：${String(change.op)}`)
  }
  // brain 允许只追加审计日志（例如拒绝提案），raw 仍必须包含文件操作。
  if (change.files.length === 0 && change.repo !== 'brain') {
    return fail('usage', 'invalid_change', '没有任何文件操作')
  }
  const seen = new Set<string>()
  for (const f of change.files) {
    if (seen.has(f.path)) return fail('usage', 'invalid_change', `同一文件出现多次：${f.path}`)
    seen.add(f.path)
  }
  const notReady = checkRepoReady(home, change.repo)
  if (notReady) return notReady

  let ownLock: WriteLock | undefined
  if (!ctx.lock) {
    const acquired = await acquireWriteLock(
      home,
      ctx.lockTimeoutMs === undefined ? {} : { timeoutMs: ctx.lockTimeoutMs },
    )
    if (!acquired.ok) return acquired
    ownLock = acquired.data
  }
  try {
    return await commitLocked(home, change, ctx)
  } catch (err) {
    return fail('failure', 'write_failed', `写入失败：${(err as Error).message}`)
  } finally {
    await ownLock?.release()
  }
}

async function commitLocked(
  home: string,
  change: WriteChange,
  ctx: WriteContext,
): Promise<Result<WriteReceipt>> {
  const paths = flowPaths(home)
  const dir = paths[change.repo]
  const brain = change.repo === 'brain'
  const now = ctx.now ?? new Date()
  const rel = (p: string) => `${change.repo}/${p}`

  // 1. 策略检查（AI 写入边界、只追加规则）。
  const planned: Planned[] = []
  for (const f of change.files) {
    const abs = join(dir, f.path)
    // 路径不合法时不能去读文件（可能越界），先单独判断。
    const pathBad = checkRepoPath(f.path)
    if (pathBad) return pathBad
    const before = await readText(abs)
    const denied = checkPolicy(change.repo, f, before, ctx.actor, {
      briefWrite: ctx[BRIEF_WRITE] === true,
    })
    if (denied) return denied
    planned.push(plan(f, abs, before))
  }

  // 2. 校验：存在性、base hash、条目 frontmatter。
  for (const p of planned) {
    const bad = checkPreconditions(p)
    if (bad) return bad
  }
  if (brain) {
    const entries = planned.filter((p) => classifyBrainPath(p.change.path) === 'entry')
    if (entries.length > 0) {
      const ws = await loadWorkspaces(home)
      if (!ws.ok) return ws
      const workspaces = new Map(ws.data.workspaces.map((w) => [w.ref, w]))
      const issues = entries.flatMap((p) => validateEntry(p, workspaces, dir))
      if (issues.length > 0) {
        return fail('failure', 'validation_failed', `条目校验未通过：${describeIssues(issues)}`, {
          issues,
        })
      }
    }
  }

  // 3. 密钥扫描：只扫描本次新写入的文本（含 log 行），已有内容不重复扫描。
  const logPath = paths.brainLog
  const logBefore = brain ? ((await readText(logPath)) ?? '') : ''
  const logLine = brain ? formatLogLine(localDate(now), change.op, ctx.actor, change.summary) : null
  const pieces = planned.map((p) => ({
    file: rel(p.change.path),
    text: p.newText,
    firstLine: p.firstLine,
  }))
  if (logLine !== null) {
    pieces.push({
      file: 'brain/log.md',
      text: logLine,
      firstLine: countLines(withTrailingNewline(logBefore)) + 1,
    })
  }
  const scan = await scanPieces(pieces, ctx, join(dir, '.gitleaks.toml'))
  if (!scan.ok) return scan
  if (scan.data.length > 0) {
    return fail(
      'failure',
      'secret_detected',
      `检测到疑似密钥，写入已拒绝：${describeFindings(scan.data)}。请改用 secret://<路径> 引用；确属误报可把规则加入该仓库 .gitleaks.toml 的允许列表`,
      { findings: scan.data },
    )
  }

  // 4–7. 写文件 → index → log → 提交；任何失败都回滚。
  const rollback = new Rollback()
  const committed: string[] = planned.map((p) => p.change.path)
  let indexChanged = false
  try {
    for (const p of planned) await rollback.write(p.abs, p.before, p.after)

    if (brain) {
      const read = await readBrainEntries(home)
      if (!read.ok) throw new FlowWriteError(read.error.code, read.error.message)
      const indexBefore = await readText(paths.brainIndex)
      const index = renderIndex(read.data.entries)
      if (index !== indexBefore) {
        await rollback.write(paths.brainIndex, indexBefore, index)
        committed.push('index.md')
        indexChanged = true
      }
      await rollback.write(logPath, logBefore, `${withTrailingNewline(logBefore)}${logLine}\n`)
      committed.push('log.md')
    }

    const summary = change.summary.replace(/\s+/g, ' ').trim()
    const c = await gitCommit(dir, {
      ...(ctx.git ?? {}),
      message: `${change.op}(${ctx.actor}): ${summary || change.op}`,
      author: flowAuthor(ctx.actor),
      paths: committed,
    })
    if (!c.ok) throw new FlowWriteError(c.error.code, c.error.message)
    return ok({
      repo: change.repo,
      op: change.op,
      actor: ctx.actor,
      sha: c.data.sha,
      files: committed.map(rel),
      logLine,
      indexChanged,
    })
  } catch (err) {
    await rollback.restore()
    // gitCommit 会先 git add；恢复内容后把这些路径的暂存区也恢复到 HEAD。
    await git(dir, ['reset', '-q', '--', ...committed], ctx.git ?? {})
    if (err instanceof FlowWriteError) return fail('failure', err.code, err.message)
    throw err
  }
}

class FlowWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
