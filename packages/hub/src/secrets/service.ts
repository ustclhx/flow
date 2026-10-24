import { existsSync, type FSWatcher, watch } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flowPaths, loadSecrets, type Result, secretPathSchema } from '@flow/core'
import { parse } from 'yaml'
import type { HubLogger } from '../server/maintenance.ts'
import { SecretRedactor } from './redactor.ts'

/**
 * 中枢运行时的 `secret://` 解析（secret-provider "运行时解析"、design D6）。
 *
 * - 启动时和 `config/` 下的 YAML 变化时，用 sops 解密 `secrets.sops.yaml`（`loadSecrets`），
 *   结果只放在内存，并加入脱敏名单；
 * - 扫描 `config/*.yaml` 中所有 `secret://<路径>` 引用，路径不存在的记为缺失，
 *   由 `flow hub status` 报告；
 * - 依赖密钥的功能（例如 Telegram 渠道）调用 `resolve(配置)`：返回替换后的配置和缺失的路径，
 *   有缺失时该功能不启动，中枢其余功能照常；
 * - 解密失败（sops 不可用等）时保留上一次成功的结果，并在状态中报告错误码。
 *
 * 只有整个字符串恰好是 `secret://<路径>` 时才替换；嵌在其他文本中的引用不解析。
 */

export const SECRET_REF_RE = /^secret:\/\/(.+)$/

export interface MissingSecret {
  path: string
  /** 引用所在的配置文件（相对 `config/`）。 */
  file: string
}

export interface SecretsStatus {
  /** 已解析的密钥个数。 */
  loaded: number
  missing: MissingSecret[]
  /** 最近一次解密失败的错误码；成功或尚未初始化且无引用时为 null。 */
  error: string | null
}

export interface HubSecretsOptions {
  home: string
  /** 默认 `loadSecrets(home)`；测试注入。 */
  load?: (home: string) => Promise<Result<Map<string, string>>>
  redactor?: SecretRedactor
  logger?: Pick<HubLogger, 'warn'>
  /** 配置变化后重新解析的去抖毫秒数，默认 300。 */
  debounceMs?: number
  /** 每次重新解析完成后回调（功能据此决定启停）。 */
  onChange?: (status: SecretsStatus) => void
}

export interface HubSecrets {
  readonly redactor: SecretRedactor
  reload(): Promise<SecretsStatus>
  status(): SecretsStatus
  /** 把值中的 `secret://` 引用替换为密钥值；缺失的引用保持原样并列在 missing 中。 */
  resolve<T>(value: T): { value: T; missing: string[] }
  /** 监听 `config/` 的变化；返回停止函数。 */
  watch(): () => void
  close(): void
}

/** 收集一个值中出现的全部引用路径（去重、按出现顺序）。 */
export function collectSecretRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const m = SECRET_REF_RE.exec(value)
    if (m?.[1]) out.add(m[1])
  } else if (Array.isArray(value)) {
    for (const v of value) collectSecretRefs(v, out)
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectSecretRefs(v, out)
  }
  return out
}

/** 纯函数：替换引用，返回缺失的路径。 */
export function resolveSecretRefs<T>(
  value: T,
  secrets: ReadonlyMap<string, string>,
): { value: T; missing: string[] } {
  const missing = new Set<string>()
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = SECRET_REF_RE.exec(v)
      if (!m?.[1]) return v
      const path = m[1]
      const found = secretPathSchema.safeParse(path).success ? secrets.get(path) : undefined
      if (found === undefined) {
        missing.add(path)
        return v
      }
      return found
    }
    if (Array.isArray(v)) return v.map(visit)
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, item] of Object.entries(v)) out[k] = visit(item)
      return out
    }
    return v
  }
  return { value: visit(value) as T, missing: [...missing] }
}

const SKIP_FILES = new Set(['secrets.sops.yaml', '.sops.yaml'])
const isConfigYaml = (name: string) =>
  !SKIP_FILES.has(name) && !name.startsWith('.') && /\.ya?ml$/.test(name)

async function scanRefs(home: string): Promise<MissingSecret[]> {
  const dir = flowPaths(home).config
  let names: string[]
  try {
    names = (await readdir(dir)).filter(isConfigYaml).sort()
  } catch {
    return []
  }
  const refs: MissingSecret[] = []
  for (const file of names) {
    try {
      // 解析出错的文件由各自的加载器报告，这里只关心引用。
      for (const path of collectSecretRefs(parse(await readFile(join(dir, file), 'utf8')))) {
        refs.push({ path, file })
      }
    } catch {
      /* 忽略 */
    }
  }
  return refs
}

export function createHubSecrets(o: HubSecretsOptions): HubSecrets {
  const redactor = o.redactor ?? new SecretRedactor()
  const load = o.load ?? ((home: string) => loadSecrets(home))
  let values = new Map<string, string>()
  let current: SecretsStatus = { loaded: 0, missing: [], error: null }
  let chain: Promise<SecretsStatus> = Promise.resolve(current)
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  async function doReload(): Promise<SecretsStatus> {
    const refs = await scanRefs(o.home)
    let error: string | null = null
    const initialized = existsSync(join(flowPaths(o.home).config, 'secrets.sops.yaml'))
    if (initialized) {
      const loaded = await load(o.home)
      if (loaded.ok) {
        values = loaded.data
        redactor.addAll(values)
      } else error = loaded.error.code
    } else if (refs.length > 0) error = 'secrets_not_initialized'
    current = {
      loaded: values.size,
      missing: refs.filter(
        (r) => !secretPathSchema.safeParse(r.path).success || !values.has(r.path),
      ),
      error,
    }
    if (error) o.logger?.warn('密钥解析失败', error)
    try {
      o.onChange?.(current)
    } catch (err) {
      o.logger?.warn('密钥变更回调失败', String(err))
    }
    return current
  }

  const reload = () => {
    chain = chain.then(doReload, doReload)
    return chain
  }

  return {
    redactor,
    reload,
    status: () => ({ ...current, missing: [...current.missing] }),
    resolve: (value) => resolveSecretRefs(value, values),
    watch() {
      if (watcher || closed) return () => {}
      try {
        watcher = watch(flowPaths(o.home).config, (_event, name) => {
          if (closed || (name && !/\.ya?ml$/.test(String(name)))) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            if (!closed) void reload()
          }, o.debounceMs ?? 300)
        })
        watcher.on('error', (err) => o.logger?.warn('监听配置目录失败', String(err)))
      } catch (err) {
        o.logger?.warn('无法监听配置目录', String(err))
      }
      return () => {
        watcher?.close()
        watcher = undefined
      }
    },
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
      watcher = undefined
      values = new Map()
    },
  }
}
