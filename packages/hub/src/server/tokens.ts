import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  actor,
  fail,
  flowPaths,
  type HubTokenView,
  hubTokenId,
  type IssueTokenRequest,
  ok,
  type Result,
  timestamp,
} from '@flow/core'
import { z } from 'zod'

/**
 * 绑定 token 的存储（design D9）：`state/hub-tokens.json`，权限 0600。
 *
 * - 文件中只有 sha256 摘要、id、actor、签发时间、备注、最近使用时间、撤销时间与 `remote` 标注；
 *   明文只在签发时返回一次，中枢不保留；
 * - 校验时对**每一条**记录做常数时间比较，不提前退出；
 * - 撤销先在内存中生效（立即拒绝），再持久化；签发只有持久化成功才生效；
 * - 文件损坏时中枢拒绝启动（不静默清空，避免已撤销的记录丢失后被覆盖）；
 * - 最近使用时间只在内存中更新，最多每 30 秒落盘一次，停止时再落盘。
 */

export const BOUND_TOKEN_PREFIX = 'fht_'

const recordSchema = z.strictObject({
  id: hubTokenId,
  actor,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  issued_at: timestamp,
  note: z.string().max(200).optional(),
  last_used_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  remote: z.boolean().optional(),
})
type TokenRecord = z.infer<typeof recordSchema>

const fileSchema = z.strictObject({ version: z.literal(1), tokens: z.array(recordSchema) })

export interface BoundIdentity {
  id: string
  actor: string
}

/** 鉴权中间件需要的最小接口。 */
export interface BoundTokenLookup {
  /** 未撤销且摘要匹配时返回绑定身份；否则 null（撤销与不存在不区分）。 */
  authenticate(presented: string): BoundIdentity | null
}

export interface HubTokenStore extends BoundTokenLookup {
  issue(req: IssueTokenRequest): Promise<Result<{ token: HubTokenView; secret: string }>>
  list(): HubTokenView[]
  revoke(id: string): Promise<Result<{ token: HubTokenView }>>
  /** 把最近使用时间写盘并停止定时器。 */
  close(): Promise<void>
}

export interface TokenStoreOptions {
  now?: () => number
  /** 最近使用时间的落盘间隔，默认 30 秒。 */
  flushMs?: number
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

const view = (r: TokenRecord): HubTokenView => ({
  id: r.id,
  actor: r.actor,
  issued_at: r.issued_at,
  ...(r.note === undefined ? {} : { note: r.note }),
  last_used_at: r.last_used_at,
  revoked_at: r.revoked_at,
  ...(r.remote === undefined ? {} : { remote: r.remote }),
})

export const hubTokensPath = (home: string) => join(flowPaths(home).state, 'hub-tokens.json')

/** 先写 0600 临时文件再原子改名，最后再 chmod 一次（防止既有文件权限过宽）。 */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tmp, content, { flag: 'wx', mode: 0o600 })
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  await chmod(path, 0o600)
}

export async function openTokenStore(
  home: string,
  opts: TokenStoreOptions = {},
): Promise<Result<HubTokenStore>> {
  const path = hubTokensPath(home)
  const now = opts.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  let records: TokenRecord[] = []
  try {
    const text = await readFile(path, 'utf8')
    await chmod(path, 0o600)
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error('schema')
    records = parsed.data.tokens
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(
        'failure',
        'invalid_hub_tokens',
        `${path} 无法读取或格式不合法；请修复或移走该文件后再启动中枢`,
      )
    }
  }

  let chain: Promise<unknown> = Promise.resolve()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 串行写盘：每次写入最新的内存状态。 */
  const persist = (): Promise<void> => {
    const run = () =>
      writeAtomic(path, `${JSON.stringify({ version: 1, tokens: records }, null, 2)}\n`)
    const next = chain.then(run, run)
    chain = next.catch(() => {})
    return next
  }
  const scheduleFlush = () => {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (!dirty) return
      dirty = false
      void persist().catch(() => {
        dirty = true
      })
    }, opts.flushMs ?? 30_000)
    timer.unref?.()
  }

  return ok({
    authenticate(presented) {
      const digest = createHash('sha256').update(presented).digest()
      let found: TokenRecord | null = null
      for (const r of records) {
        // 每条都比较，不因命中而提前结束；撤销的记录也参与比较，结果再按撤销状态过滤。
        const equal = timingSafeEqual(Buffer.from(r.sha256, 'hex'), digest)
        if (equal && found === null) found = r
      }
      if (!found || found.revoked_at !== null) return null
      found.last_used_at = iso()
      scheduleFlush()
      return { id: found.id, actor: found.actor }
    },

    async issue(req) {
      const secret = `${BOUND_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      let id: string
      do id = `tok_${randomBytes(6).toString('hex')}`
      while (records.some((r) => r.id === id))
      const record: TokenRecord = {
        id,
        actor: req.actor,
        sha256: sha256Hex(secret),
        issued_at: iso(),
        ...(req.note === undefined ? {} : { note: req.note }),
        last_used_at: null,
        revoked_at: null,
        ...(req.remote === undefined ? {} : { remote: req.remote }),
      }
      const before = records
      records = [...records, record]
      try {
        await persist()
      } catch {
        records = before
        return fail('failure', 'hub_tokens_write_failed', '无法写入 token 文件，未签发')
      }
      return ok({ token: view(record), secret })
    },

    list: () => records.map(view),

    async revoke(id) {
      const record = records.find((r) => r.id === id)
      if (!record) return fail('failure', 'not_found', `没有这个 token：${id}`)
      // 先在内存中撤销：即使写盘失败，本进程也立即拒绝该 token。
      if (record.revoked_at === null) record.revoked_at = iso()
      try {
        await persist()
      } catch {
        return fail(
          'failure',
          'hub_tokens_write_failed',
          '已在内存中撤销，但写入 token 文件失败；中枢重启前请重试撤销',
        )
      }
      return ok({ token: view(record) })
    },

    async close() {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (dirty) {
        dirty = false
        await persist().catch(() => {})
      }
      await chain
    },
  })
}
