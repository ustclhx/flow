import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { flowPaths } from '../home.ts'
import type { InboxActRequest, inboxListQuery } from '../inbox/schema.ts'
import {
  type CancelTaskRequest,
  ENDPOINTS,
  type EndpointName,
  errorBody,
  HEADERS,
  type HealthData,
  HUB_UNAVAILABLE,
  type HubStatusData,
  type IssueTokenRequest,
  type listTasksQuery,
  okBody,
  type PolicyCheckRequest,
  type ReplyTaskRequest,
} from '../ledger/protocol.ts'
import type { TaskContractInput } from '../ledger/task.ts'
import { fail, ok, type Result } from '../result.ts'
import { loadHubConfig, resolveHubUrl } from './config.ts'

export interface HubClientOptions {
  home: string
  /** 写入 `X-Flow-Actor`。user token 可以借此降级；绑定 token 必须与绑定身份一致。 */
  actor: string
  /**
   * 显式的中枢 token。缺省时依次取环境变量 `FLOW_HUB_TOKEN`（例如签发给某个 AI 的绑定 token），
   * 最后取 `state/hub.token`（user token）。
   */
  token?: string
  /** 默认 5 秒；覆盖整个 HTTP 请求与响应体读取。 */
  timeoutMs?: number
  fetch?: (request: Request) => Promise<Response>
}

export type HubStatus = HealthData & {
  pid: number | null
  schedules: HubStatusData['schedules']
  last_backup: HubStatusData['last_backup']
  secrets?: HubStatusData['secrets']
  policies?: HubStatusData['policies']
}

type JsonEndpoint = Exclude<EndpointName, 'events'>
type ResponseData<N extends JsonEndpoint> = z.infer<(typeof ENDPOINTS)[N]['response']>
/** 进程以绑定 token 访问中枢时设置的环境变量（design D9）。 */
export const HUB_TOKEN_ENV = 'FLOW_HUB_TOKEN'

const unavailable = () =>
  fail('retryable', HUB_UNAVAILABLE, '无法连接中枢，请运行 flow daemon status 检查')
const invalidResponse = () => fail('failure', 'invalid_hub_response', '中枢响应不符合协议')
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

/** 任务与中枢管理共用的 HTTP 客户端；不打开账本，操作者随每个请求传递。 */
export class HubClient {
  constructor(private readonly options: HubClientOptions) {}

  async request<N extends JsonEndpoint>(
    name: N,
    input?: unknown,
    id?: string,
  ): Promise<Result<ResponseData<N>>> {
    const config = await loadHubConfig(this.options.home)
    if (!config.ok) return config
    const endpoint = ENDPOINTS[name]
    let token: string | undefined
    if (endpoint.auth) {
      token = (this.options.token ?? process.env[HUB_TOKEN_ENV])?.trim() || undefined
      if (token === undefined) {
        try {
          token = (await readFile(flowPaths(this.options.home).hubToken, 'utf8')).trim()
        } catch (err) {
          if (isMissing(err)) return unavailable()
          return fail('failure', 'read_failed', '无法读取中枢 token 文件')
        }
      }
      if (!token) return unavailable()
    }
    const url = new URL(
      endpoint.path.replace(':id', encodeURIComponent(id ?? '')),
      resolveHubUrl(config.data),
    )
    if (endpoint.method === 'GET' && input) {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 5000)
    let text: string
    let response: Response
    try {
      const request = new Request(url.toString(), {
        method: endpoint.method,
        headers: {
          ...(token ? { [HEADERS.authorization]: `Bearer ${token}` } : {}),
          [HEADERS.actor]: this.options.actor,
          'Content-Type': 'application/json',
        },
        ...(endpoint.method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
        signal,
      })
      response = await (this.options.fetch ?? fetch)(request)
      text = await response.text()
    } catch {
      return unavailable()
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return invalidResponse()
    }
    const error = errorBody.safeParse(body)
    if (error.success) {
      const { kind, code, message, details } = error.data.error
      return fail(kind, code, message, details)
    }
    const parsed = okBody(endpoint.response).safeParse(body)
    if (!response.ok || !parsed.success) return invalidResponse()
    return ok(parsed.data.data as ResponseData<N>)
  }

  createTask(input: TaskContractInput) {
    return this.request('tasks-create', input)
  }
  listTasks(input: z.input<typeof listTasksQuery> = {}) {
    return this.request('tasks-list', input)
  }
  showTask(id: string) {
    return this.request('tasks-show', undefined, id)
  }
  cancelTask(id: string, input: CancelTaskRequest = {}) {
    return this.request('tasks-cancel', input, id)
  }
  replyTask(id: string, input: ReplyTaskRequest) {
    return this.request('tasks-reply', input, id)
  }
  listInbox(input: z.input<typeof inboxListQuery> = {}) {
    return this.request('inbox-list', input)
  }
  actInbox(id: string, input: InboxActRequest) {
    return this.request('inbox-act', input, id)
  }
  checkPolicy(input: PolicyCheckRequest) {
    return this.request('policy-check', input)
  }
  health() {
    return this.request('health')
  }
  rebuild() {
    return this.request('hub-rebuild')
  }
  issueToken(input: IssueTokenRequest) {
    return this.request('hub-tokens-issue', input)
  }
  listTokens() {
    return this.request('hub-tokens-list')
  }
  revokeToken(id: string) {
    return this.request('hub-tokens-revoke', {}, id)
  }
  uiLoginCode() {
    return this.request('ui-login-code', {})
  }

  /** 旧中枢没有 status 路由时，用 health 加本地文件补足可观测信息。 */
  async status(): Promise<Result<HubStatus>> {
    const status = await this.request('hub-status')
    if (status.ok || status.error.code !== 'not_found') return status
    const health = await this.health()
    if (!health.ok) return health
    const paths = flowPaths(this.options.home)
    try {
      let pid: number | null = null
      try {
        const lock = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(await readFile(paths.hubPid, 'utf8')))
        pid = lock.pid
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      let names: string[] = []
      try {
        names = await readdir(paths.backups)
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      const backups = await Promise.all(
        names.map(async (name) => {
          const path = join(paths.backups, name)
          const info = await stat(path)
          return info.isFile() ? { path, at: info.mtime.toISOString() } : null
        }),
      )
      const latest = backups.filter((b) => b !== null).sort((a, b) => b.at.localeCompare(a.at))[0]
      return ok({
        ...health.data,
        pid,
        schedules: { loaded: 0, errors: [] },
        last_backup: latest ?? null,
      })
    } catch {
      return fail('failure', 'read_failed', '无法读取中枢状态文件')
    }
  }
}
