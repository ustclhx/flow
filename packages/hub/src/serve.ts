import type { AddressInfo } from 'node:net'
import { HUB_HOSTNAME } from '@flow/core'

/**
 * 运行时隔离层（design D3）：全仓库只有这里区分 Bun 与 Node。
 * - Bun：`Bun.serve({ fetch: app.fetch })`；
 * - Node：`@hono/node-server` 的 `serve`。
 * 业务路由只依赖 `fetch(Request) → Response`，不感知运行时。
 * 只监听回环地址 127.0.0.1（hub-daemon "本机 HTTP API"）。
 */

export type Runtime = 'bun' | 'node'

export type FetchHandler = (request: Request) => Response | Promise<Response>

export interface ServeOptions {
  /** 监听端口；0 表示由系统分配随机端口（测试用）。 */
  port: number
  /** 强制使用某个运行时；默认按当前进程判断。 */
  runtime?: Runtime
}

export interface RunningServer {
  runtime: Runtime
  hostname: typeof HUB_HOSTNAME
  /** 实际监听的端口。 */
  port: number
  url: string
  /** 停止监听并断开现有连接。 */
  close(): Promise<void>
}

interface BunServer {
  port: number
  stop(closeActiveConnections?: boolean): Promise<void> | void
}
interface BunGlobal {
  serve(options: {
    fetch: FetchHandler
    port: number
    hostname: string
    idleTimeout?: number
  }): BunServer
}

export const currentRuntime = (): Runtime =>
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node'

export async function serve(fetch: FetchHandler, options: ServeOptions): Promise<RunningServer> {
  const runtime = options.runtime ?? currentRuntime()
  return runtime === 'bun' ? serveBun(fetch, options.port) : serveNode(fetch, options.port)
}

function serveBun(fetch: FetchHandler, port: number): RunningServer {
  const bun = (globalThis as unknown as { Bun?: BunGlobal }).Bun
  if (!bun) throw new Error('当前运行时不是 Bun，不能使用 Bun.serve')
  // idleTimeout=0：关闭空闲超时。Bun 默认 10 秒会切断 long-poll（最长 30 秒）与 SSE 连接。
  const server = bun.serve({ fetch, port, hostname: HUB_HOSTNAME, idleTimeout: 0 })
  return {
    runtime: 'bun',
    hostname: HUB_HOSTNAME,
    port: server.port,
    url: `http://${HUB_HOSTNAME}:${server.port}`,
    close: async () => {
      await server.stop(true)
    },
  }
}

async function serveNode(fetch: FetchHandler, port: number): Promise<RunningServer> {
  const { serve: nodeServe } = await import('@hono/node-server')
  const { server, info } = await new Promise<{
    server: ReturnType<typeof nodeServe>
    info: AddressInfo
  }>((resolve, reject) => {
    // 不替换全局 Request / Response，保持 Bun 和其他嵌入宿主的运行时隔离。
    const s = nodeServe(
      { fetch, port, hostname: HUB_HOSTNAME, overrideGlobalObjects: false },
      (info) => resolve({ server: s, info }),
    )
    s.once('error', reject)
  })
  return {
    runtime: 'node',
    hostname: HUB_HOSTNAME,
    port: info.port,
    url: `http://${HUB_HOSTNAME}:${info.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        // 先停止接受新连接，再断开 keep-alive 与长连接（SSE、long-poll），否则 close 会一直等待。
        ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
      }),
  }
}

/** 出站 HTTP 请求（Telegram Bot API 等）用的 fetch。 */
export type OutboundFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Node 的全局代理开关（新版 Node 的 `http.setGlobalProxyFromEnv`）。 */
type SetGlobalProxy = (env?: Record<string, string | undefined>) => void
let nodeProxyApplied: string | null = null

/**
 * 经代理访问外网的 fetch（design D4："用运行时支持的方式传入代理，保持 Bun 与 Node 兼容"）：
 * - Bun：fetch 的 `proxy` 选项，按请求生效，不影响进程里的其他请求；
 * - Node：内置 fetch（undici）没有按请求的代理选项，用 `http.setGlobalProxyFromEnv` 打开内置代理支持。
 *   这是**进程级**的：对进程内全部出站请求生效（回环地址始终直连，本机节点与中枢之间的请求不受影响）。
 *   所以只有调用方传 `global: true`（配置文件里显式写了代理）时才启用；单独的 HTTPS_PROXY 环境变量
 *   不会触发，此时返回 `note` 提示（Node 自己的 `NODE_USE_ENV_PROXY=1` 也可以让它识别环境变量）。
 *   没有这个接口的旧版 Node 同样返回 `note`。
 * `proxy` 为 null 时直连。
 */
export async function proxiedFetch(
  proxy: string | null,
  options: { runtime?: Runtime; global?: boolean } = {},
): Promise<{ fetch: OutboundFetch; note: string | null }> {
  const runtime = options.runtime ?? currentRuntime()
  const plain: OutboundFetch = (url, init) => fetch(url, init)
  if (!proxy) return { fetch: plain, note: null }
  if (runtime === 'bun') {
    return { fetch: (url, init) => fetch(url, { ...init, proxy } as RequestInit), note: null }
  }
  if (!options.global) {
    return {
      fetch: plain,
      note: 'Node 下只按 config/channels.yaml 的 telegram.proxy 启用代理（进程级）；单独的 HTTPS_PROXY 不生效，可改用 NODE_USE_ENV_PROXY=1 启动',
    }
  }
  const http = (await import('node:http')) as unknown as { setGlobalProxyFromEnv?: SetGlobalProxy }
  if (typeof http.setGlobalProxyFromEnv !== 'function') {
    return {
      fetch: plain,
      note: '当前 Node 版本不支持按配置设置代理，请升级 Node 或用 NODE_USE_ENV_PROXY=1 启动',
    }
  }
  if (nodeProxyApplied !== proxy) {
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, 'localhost,127.0.0.1,::1']
      .filter(Boolean)
      .join(',')
    http.setGlobalProxyFromEnv({ HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: noProxy })
    nodeProxyApplied = proxy
  }
  return { fetch: plain, note: null }
}
