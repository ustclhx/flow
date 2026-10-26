import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BRAIN_BRIEFS_DIR } from '../entries.ts'
import { type GitOptions, git, headState } from '../git.ts'
import { flowPaths } from '../home.ts'
import { redactSecrets } from '../ledger/redact.ts'
import { fail, ok, type Result } from '../result.ts'
import { WS_REF_RE } from '../schema/common.ts'
import { loadWorkspaces } from '../workspaces.ts'
import { BRIEF_WRITE } from './brief-capability.ts'
import { checkRepoReady, commitWrite, hashContent, type WriteContext } from './commit.ts'
import { type WriteLock, withWriteLock } from './lock.ts'
import { BRIEF_WRITERS } from './policy.ts'

/**
 * supervisor 简报笔记（design D8、supervisor "简报读写"）：`brain/briefs/<id>.md`，
 * `<id>` 是 workspace 标识去掉 `ws/` 前缀。
 *
 * - 只能由中枢经 `writeBrief` 写入（user 或 supervisor 身份），整体替换；
 * - 写入前脱敏，再经 `commitWrite` 的 gitleaks 扫描与提交；
 * - 不是条目：`readBrainEntries`、校验、索引与搜索都跳过 `briefs/`。
 */

/** 笔记上限（字符，按 UTF-16 码元计，与简报预算一致）。 */
export const BRIEF_MAX_CHARS = 3000

/** 笔记相对 brain 的路径；workspace 标识不合法时返回错误。 */
export function briefPath(workspace: string): Result<string> {
  if (!WS_REF_RE.test(workspace)) {
    return fail('usage', 'invalid_workspace', `workspace 标识应形如 ws/<id>：${workspace}`)
  }
  return ok(`${BRAIN_BRIEFS_DIR}/${workspace.slice('ws/'.length)}.md`)
}

/**
 * 笔记内容的哈希，作为 `brief_update` 的 `base_hash`。笔记不存在时按空内容计算，
 * 因此第一次写入也有确定的 `base_hash`。
 */
export const briefHash = (content: string | null): string => hashContent(content ?? '')

export interface BriefNote {
  workspace: string
  /** 笔记全文；不存在时为空串。 */
  text: string
  hash: string
  exists: boolean
}

/**
 * 笔记在 brain 仓库 HEAD 中已提交的内容；不存在时为 null。
 *
 * 只读提交过的内容、不读工作区文件：笔记只能经 `writeBrief` 提交，工作区里绕过写入层放进来的文件
 * （例如在不区分大小写的文件系统上经 `Briefs/` 写入的条目）不会被当作笔记读出。
 */
async function committedBrief(
  home: string,
  path: string,
  opts: GitOptions = {},
): Promise<Result<string | null>> {
  const dir = flowPaths(home).brain
  // 还没有任何提交（unborn HEAD）：笔记一定没有提交过，按不存在处理；其他 git 失败报错。
  const head = await headState(dir, opts)
  if (head === 'unborn') return ok(null)
  if (head === 'error') return fail('failure', 'read_failed', '无法读取 brain 仓库的 HEAD')
  const listed = await git(dir, ['ls-tree', '--name-only', 'HEAD', '--', path], opts)
  if (listed.code !== 0) return fail('failure', 'read_failed', '无法读取 brain 仓库中的简报笔记')
  if (listed.stdout.trim() !== path) return ok(null)
  const shown = await git(dir, ['cat-file', 'blob', `HEAD:${path}`], opts)
  if (shown.code !== 0) return fail('failure', 'read_failed', '无法读取 brain 仓库中的简报笔记')
  return ok(shown.stdout)
}

/** 读取某 workspace 已提交的笔记（只读，不加锁）。 */
export async function readBrief(
  home: string,
  workspace: string,
  opts: { git?: GitOptions } = {},
): Promise<Result<BriefNote>> {
  const path = briefPath(workspace)
  if (!path.ok) return path
  const notReady = checkRepoReady(home, 'brain')
  if (notReady) return notReady
  const text = await committedBrief(home, path.data, opts.git)
  if (!text.ok) return text
  return ok({
    workspace,
    text: text.data ?? '',
    hash: briefHash(text.data),
    exists: text.data !== null,
  })
}

export interface BriefInput {
  /** `ws/<id>`。 */
  workspace: string
  text: string
  /** 调用方读到的笔记哈希（`ws_brief` 的 `note_hash`）；与当前内容不一致时返回 `conflict`。 */
  base_hash: string
}

export interface BriefReceipt {
  workspace: string
  /** 相对 flow-home 的路径，例如 `brain/briefs/product-res.md`。 */
  file: string
  /** 写入后的笔记哈希，下一次更新以它为 `base_hash`。 */
  hash: string
  /** 新提交的 sha；内容未变时为 null（不产生提交）。 */
  sha: string | null
  changed: boolean
}

/**
 * **只供中枢使用**（`packages/hub/src/briefs/`）。core 的操作（CLI、MCP）一律不得调用它：
 * `brief_update` 只把请求发给中枢，由中枢按唤醒绑定认定调用方后再调用这里。之所以留在 core，
 * 是因为它依赖写入层内部的简报写入能力（`brief-capability.ts`，不从包入口导出）。
 *
 * 整体替换某 workspace 的笔记。只由中枢调用：调用方身份（user / supervisor）与 workspace 绑定
 * 由中枢在调用前核对；这里再核对身份、长度、workspace 是否已定义，并在写锁内比较 `base_hash`。
 */
export async function writeBrief(
  home: string,
  input: BriefInput,
  ctx: WriteContext,
): Promise<Result<BriefReceipt>> {
  if (!(BRIEF_WRITERS as readonly string[]).includes(ctx.actor)) {
    return fail('failure', 'role_not_allowed', `身份 ${ctx.actor} 不能写简报笔记`)
  }
  const path = briefPath(input.workspace)
  if (!path.ok) return path
  if (input.text.length > BRIEF_MAX_CHARS) {
    return fail(
      'failure',
      'brief_too_long',
      `简报笔记最多 ${BRIEF_MAX_CHARS} 个字符，当前 ${input.text.length} 个`,
      { max: BRIEF_MAX_CHARS, length: input.text.length },
    )
  }
  const notReady = checkRepoReady(home, 'brain')
  if (notReady) return notReady
  const loaded = await loadWorkspaces(home)
  if (!loaded.ok) return loaded
  if (!loaded.data.workspaces.some((w) => w.ref === input.workspace)) {
    return fail('failure', 'unknown_workspace', `未定义的 workspace：${input.workspace}`)
  }
  const redacted = redactSecrets(input.text).trim()
  const content = redacted === '' ? '' : `${redacted}\n`
  const file = `brain/${path.data}`

  const writeLocked = async (lock: WriteLock): Promise<Result<BriefReceipt>> => {
    const committed = await committedBrief(home, path.data, ctx.git)
    if (!committed.ok) return committed
    const before = committed.data
    const actual = briefHash(before)
    if (actual !== input.base_hash) {
      return fail(
        'failure',
        'conflict',
        '简报笔记在你读取之后已被改动，请重新调用 ws_brief 读取后再更新',
        { workspace: input.workspace, expected: input.base_hash, actual },
      )
    }
    if ((before ?? '') === content) {
      return ok({ workspace: input.workspace, file, hash: actual, sha: null, changed: false })
    }
    const r = await commitWrite(
      home,
      {
        repo: 'brain',
        op: 'brief',
        summary: `${input.workspace} 简报笔记`,
        // 冲突已按已提交内容在锁内判定；工作区文件只决定是新建还是替换。
        files: [
          existsSync(join(flowPaths(home).brain, path.data))
            ? { op: 'replace', path: path.data, content }
            : { op: 'create', path: path.data, content },
        ],
      },
      { ...ctx, lock, [BRIEF_WRITE]: true },
    )
    if (!r.ok) return r
    return ok({
      workspace: input.workspace,
      file,
      hash: briefHash(content),
      sha: r.data.sha,
      changed: true,
    })
  }
  if (ctx.lock) return writeLocked(ctx.lock)
  return withWriteLock(
    home,
    writeLocked,
    ctx.lockTimeoutMs === undefined ? {} : { timeoutMs: ctx.lockTimeoutMs },
  )
}
