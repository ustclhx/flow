import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../frontmatter.ts'
import { execCommand } from '../git.ts'
import { flowPaths } from '../home.ts'
import type { InboxVia } from '../inbox/schema.ts'
import { type FlowError, fail, ok, type Result } from '../result.ts'
import { isFactType } from '../schema/entries.ts'
import { checkEntryFrontmatter } from '../validate.ts'
import { loadWorkspaces } from '../workspaces.ts'
import { entryPath, writeEntry } from '../write/api.ts'
import { checkRepoReady, commitWrite, currentHash, type WriteContext } from '../write/commit.ts'
import { withWriteLock } from '../write/lock.ts'
import { isAiActor, isProposalOnlyType, isValidActor } from '../write/policy.ts'
import { scanForSecrets } from '../write/secrets.ts'
import { type Proposal, proposalIdSchema, proposalSchema } from './schema.ts'

export * from './schema.ts'

export interface ProposeInput {
  target: string
  content?: string | undefined
  file?: string | undefined
  reason: string
}
export interface ProposalSelection {
  ids?: string[] | undefined
  all?: boolean | undefined
}
export interface ProposalSummary {
  id: string
  target: string
  actor: string
  reason: string
  created_at: string
  is_new: boolean
}
export interface ProposalOutcome {
  id: string
  status: 'accepted' | 'rejected' | 'conflict' | 'error'
  error?: FlowError
}

const proposalDir = (home: string) => join(flowPaths(home).state, 'proposals')
const pendingPath = (home: string, id: string) => join(proposalDir(home), `${id}.json`)

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** 所有调用方均已持有写锁；不把半写入 JSON 暴露给后续进程。 */
async function save(path: string, proposal: Proposal): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(proposal, null, 2)}\n`, { flag: 'wx' })
  try {
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

async function readProposal(home: string, id: string): Promise<Result<Proposal>> {
  if (!proposalIdSchema.safeParse(id).success) {
    return fail('usage', 'invalid_proposal_id', '提案 id 不合法')
  }
  const text = await readOptional(pendingPath(home, id))
  if (text === null) return fail('failure', 'not_found', `未找到待确认提案：${id}`)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return fail('failure', 'invalid_proposal', `提案不是合法的 JSON：${id}`)
  }
  const parsed = proposalSchema.safeParse(data)
  if (!parsed.success || parsed.data.id !== id) {
    return fail('failure', 'invalid_proposal', `提案格式不合法：${id}`)
  }
  return ok(parsed.data)
}

async function pendingIds(home: string): Promise<string[]> {
  try {
    return (await readdir(proposalDir(home)))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** 提案不能把既有的 decision / personal 条目伪装为普通条目来改写。 */
function checkOrdinary(content: string): Result<Record<string, unknown>> {
  const parsed = parseFrontmatter(content)
  if (!parsed.ok) return fail('failure', 'validation_failed', parsed.error.message)
  const fm = parsed.data.data
  if (fm.type === 'decision' || fm.scope === 'personal') {
    return fail(
      'failure',
      'proposal_forbidden',
      '提案只能针对普通条目，不能修改 decision 或 personal 条目',
    )
  }
  return ok(fm)
}

async function scanProposal(
  home: string,
  proposal: Proposal,
  ctx: WriteContext,
): Promise<Result<void>> {
  // 扫描原始字符串，不能只扫 JSON：转义后的换行可能改变密钥规则的匹配边界。
  const scan = await scanForSecrets(Object.values(proposal).flat().join('\n'), {
    configPath: join(flowPaths(home).brain, '.gitleaks.toml'),
    ...(ctx.gitleaksBin === undefined ? {} : { gitleaksBin: ctx.gitleaksBin }),
  })
  if (!scan.ok) return scan
  if (scan.data.findings.length) {
    return fail('failure', 'secret_detected', '提案含疑似密钥，写入已拒绝，请改用 secret:// 引用', {
      findings: scan.data.findings,
    })
  }
  return ok(undefined)
}

/** 提交提案只写 state，不修改 brain、index、log 或 git 历史。 */
export async function createProposal(
  home: string,
  input: ProposeInput,
  ctx: WriteContext,
): Promise<Result<{ id: string; target: string; base_hash: string | null }>> {
  if (!isValidActor(ctx.actor)) return fail('usage', 'invalid_actor', '操作者标识不合法')
  if ((input.content === undefined) === (input.file === undefined)) {
    return fail('usage', 'invalid_arguments', 'content 和 file 必须且只能提供一个')
  }
  const path = entryPath(input.target)
  if (!path.ok) return path
  const notReady = checkRepoReady(home, 'brain')
  if (notReady) return notReady
  return withWriteLock(home, async () => {
    try {
      const content = input.content ?? (await readFile(input.file as string, 'utf8'))
      const fm = checkOrdinary(content)
      if (!fm.ok) return fm
      const ws = await loadWorkspaces(home)
      if (!ws.ok) return ws
      const issues = checkEntryFrontmatter(fm.data, {
        file: `brain/${path.data}`,
        id: input.target,
        workspaces: new Map(ws.data.workspaces.map((w) => [w.ref, w])),
      })
      if (issues.length) return fail('failure', 'validation_failed', '条目校验未通过', { issues })
      const sources = (fm.data.sources ?? []) as string[]
      if (
        (isFactType(fm.data.type) || isProposalOnlyType(fm.data.type)) &&
        !sources.some((s) => s.trim())
      ) {
        return fail('failure', 'sources_required', '事实类条目需要出处（sources 为空）')
      }
      const before = await readOptional(join(flowPaths(home).brain, path.data))
      if (before !== null) {
        const ordinary = checkOrdinary(before)
        if (!ordinary.ok) return ordinary
      }
      const now = ctx.now ?? new Date()
      const proposal: Proposal = {
        id: `${now.getTime()}-${randomBytes(6).toString('hex')}`,
        created_at: now.toISOString(),
        actor: ctx.actor,
        target: input.target,
        base_hash: await currentHash(home, 'brain', path.data),
        content,
        reason: input.reason,
        sources,
      }
      const scan = await scanProposal(home, proposal, ctx)
      if (!scan.ok) return scan
      await mkdir(proposalDir(home), { recursive: true })
      await save(pendingPath(home, proposal.id), proposal)
      return ok({ id: proposal.id, target: proposal.target, base_hash: proposal.base_hash })
    } catch {
      return fail('failure', 'proposal_write_failed', '无法读取内容或保存提案')
    }
  })
}

export async function listProposals(
  home: string,
): Promise<Result<{ proposals: ProposalSummary[] }>> {
  return withWriteLock(home, async () => {
    const proposals: ProposalSummary[] = []
    for (const id of await pendingIds(home)) {
      const p = await readProposal(home, id)
      if (!p.ok) return p
      const { target, actor, reason, created_at, base_hash } = p.data
      proposals.push({ id, target, actor, reason, created_at, is_new: base_hash === null })
    }
    return ok({ proposals })
  })
}

/** 使用 git 的统一 diff，不通过 shell 插值内容或路径。 */
export async function diffProposal(
  home: string,
  id: string,
): Promise<Result<{ id: string; target: string; diff: string }>> {
  return withWriteLock(home, async () => {
    const p = await readProposal(home, id)
    if (!p.ok) return p
    const path = entryPath(p.data.target)
    if (!path.ok) return path
    const dir = await mkdtemp(join(tmpdir(), 'flow-proposal-diff-'))
    try {
      const before = await readOptional(join(flowPaths(home).brain, path.data))
      await writeFile(join(dir, 'current'), before ?? '')
      await writeFile(join(dir, 'proposed'), p.data.content)
      const r = await execCommand(
        'git',
        ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', 'current', 'proposed'],
        { cwd: dir },
      )
      if (r.code !== 0 && r.code !== 1) return fail('failure', 'diff_failed', '无法生成提案差异')
      const diff = r.stdout
        .replace('diff --git a/current b/proposed\n', `diff --git a/${path.data} b/${path.data}\n`)
        .replace('--- a/current\n', `--- a/${path.data}\n`)
        .replace('+++ b/proposed\n', `+++ b/${path.data}\n`)
      return ok({ id, target: p.data.target, diff })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function selectedIds(home: string, selection: ProposalSelection): Promise<Result<string[]>> {
  if (selection.all && selection.ids?.length)
    return fail('usage', 'invalid_arguments', 'ids 与 --all 不能同时使用')
  if (selection.all) return ok(await pendingIds(home))
  if (!selection.ids?.length) return fail('usage', 'invalid_arguments', '请提供提案 id 或 --all')
  return ok([...new Set(selection.ids)])
}

async function archive(
  home: string,
  proposal: Proposal,
  kind: 'accepted' | 'rejected',
): Promise<void> {
  const dir = join(proposalDir(home), kind)
  await mkdir(dir, { recursive: true })
  // 先原子更新元数据，再移动原文件；失败时待确认提案仍完整保留。
  await save(pendingPath(home, proposal.id), proposal)
  await rename(pendingPath(home, proposal.id), join(dir, `${proposal.id}.json`))
}

export interface ProposalDecisionContext extends WriteContext {
  via?: InboxVia
}

export async function acceptProposals(
  home: string,
  input: ProposalSelection,
  ctx: ProposalDecisionContext,
): Promise<Result<{ results: ProposalOutcome[] }>> {
  if (isAiActor(ctx.actor)) return fail('failure', 'user_only', '只有用户能接受提案')
  return withWriteLock(home, async (lock) => {
    const ids = await selectedIds(home, input)
    if (!ids.ok) return ids
    const results: ProposalOutcome[] = []
    for (const id of ids.data) {
      try {
        const p = await readProposal(home, id)
        if (!p.ok) {
          results.push({ id, status: 'error', error: p.error })
          continue
        }
        const r = await writeEntry(
          home,
          { id: p.data.target, content: p.data.content },
          {
            ...ctx,
            lock,
            actor: 'user',
            op: 'apply',
            expectedBaseHash: p.data.base_hash,
            summary: `提案 ${id}（提议者 ${p.data.actor}）：${p.data.reason}`,
          },
        )
        if (!r.ok) {
          const error =
            r.error.code === 'base_conflict'
              ? { ...r.error, message: `${r.error.message}；请基于当前内容重新生成提案` }
              : r.error
          results.push({
            id,
            status: r.error.code === 'base_conflict' ? 'conflict' : 'error',
            error,
          })
          continue
        }
        await archive(
          home,
          {
            ...p.data,
            accepted_at: (ctx.now ?? new Date()).toISOString(),
            decided_by: ctx.actor,
            via: ctx.via ?? 'cli',
          },
          'accepted',
        )
        results.push({ id, status: 'accepted' })
      } catch {
        results.push({
          id,
          status: 'error',
          error: {
            kind: 'failure',
            code: 'proposal_archive_failed',
            message: '提案处理或归档失败，请检查 brain 和提案状态',
          },
        })
      }
    }
    return ok({ results })
  })
}

export async function rejectProposals(
  home: string,
  input: ProposalSelection & { reason?: string | undefined },
  ctx: ProposalDecisionContext,
): Promise<Result<{ results: ProposalOutcome[] }>> {
  if (isAiActor(ctx.actor)) return fail('failure', 'user_only', '只有用户能拒绝提案')
  return withWriteLock(home, async (lock) => {
    const ids = await selectedIds(home, input)
    if (!ids.ok) return ids
    const results: ProposalOutcome[] = []
    for (const id of ids.data) {
      try {
        const p = await readProposal(home, id)
        if (!p.ok) {
          results.push({ id, status: 'error', error: p.error })
          continue
        }
        const rejected = {
          ...p.data,
          proposal_reason: p.data.reason,
          reason: input.reason ?? '',
          rejected_at: (ctx.now ?? new Date()).toISOString(),
          decided_by: ctx.actor,
          via: ctx.via ?? 'cli',
        }
        const scan = await scanProposal(home, rejected, ctx)
        if (!scan.ok) {
          results.push({ id, status: 'error', error: scan.error })
          continue
        }
        const r = await commitWrite(
          home,
          {
            repo: 'brain',
            op: 'reject',
            files: [],
            summary: `提案 ${id}（${p.data.target}，提议者 ${p.data.actor}）：${input.reason ?? '未附理由'}`,
          },
          { ...ctx, lock, actor: 'user' },
        )
        if (!r.ok) {
          results.push({ id, status: 'error', error: r.error })
          continue
        }
        await archive(home, rejected, 'rejected')
        results.push({ id, status: 'rejected' })
      } catch {
        results.push({
          id,
          status: 'error',
          error: {
            kind: 'failure',
            code: 'proposal_archive_failed',
            message: '提案处理或归档失败，请检查 brain 和提案状态',
          },
        })
      }
    }
    return ok({ results })
  })
}
