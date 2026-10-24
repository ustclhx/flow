import {
  fail,
  flowPaths,
  type HubConfig,
  type HubStatusData,
  inboxActRequest,
  loadHubConfig,
  loadPoliciesConfig,
  type Result,
  redactSecrets,
  registerKnownSecrets,
  VERSION,
} from '@flow/core'
import { Hono } from 'hono'
import type { ChannelSpec } from '../channels/types.ts'
import {
  actOnInbox,
  createInboxRoutes,
  type InboxActionDeps,
  type InboxService,
  startInbox,
} from '../inbox/index.ts'
import { createTaskRoutes } from '../ledger/routes.ts'
import { type LedgerStore, openLedger } from '../ledger/store.ts'
import { createTaskService, workspaceCheckFromHome } from '../ledger/tasks.ts'
import { createNodeProtocol, type NodeProtocol } from '../nodes/protocol.ts'
import { createPolicyRoutes } from '../policy/routes.ts'
import { createScheduler, type Scheduler } from '../scheduler/index.ts'
import { redactingLogger } from '../secrets/logger.ts'
import { SecretRedactor } from '../secrets/redactor.ts'
import { createHubSecrets, type HubSecretsOptions } from '../secrets/service.ts'
import { currentRuntime } from '../serve.ts'
import { createUiApp, createUiLoginCodeRoutes } from '../ui/app.tsx'
import { createUiSessions } from '../ui/sessions.ts'
import { systemClock } from './clock.ts'
import { consoleLogger } from './maintenance.ts'
import { type RunningHub, type StartHubOptions, startHub } from './start.ts'
import { ensureHubToken } from './token.ts'

export interface RunHubOptions
  extends Omit<StartHubOptions, 'ledger' | 'openLedger' | 'routes' | 'onStop' | 'leaseHolders'> {
  /** 密钥解析的注入点（测试用）；默认用 sops 解密 `config/secrets.sops.yaml`。 */
  secrets?: Pick<HubSecretsOptions, 'load' | 'debounceMs' | 'onChange'> & {
    /** 是否监听 config/ 的变化，默认 true。 */
    watch?: boolean
  }
  /** 收件箱的注入点（测试用）。 */
  inbox?: {
    /** 是否监听 config/inbox.yaml 与提案目录，默认 true。 */
    watch?: boolean
    proposalIntervalMs?: number
    /** 推送渠道（Telegram 由 5.x 注册；测试注入假渠道）。 */
    channels?: readonly ChannelSpec[]
    backoff?: { baseMs?: number; maxMs?: number }
  }
}

/**
 * 生产用的中枢组合：取得锁后打开 `state/flow.db`，挂载任务路由与节点协议路由，
 * 启动租约过期扫描、睡眠检测与定时调度，把每日备份写成 `hub.backup_done`，启动成功后写入 `hub.started`，
 * 然后启动收件箱（反应器、提案目录监听、推送节奏与渠道管理器）。
 * 注入的 clock 同时用于账本的事件时间戳，保证租约到期时间与扫描用同一个时钟。
 */
export async function runHub(input: RunHubOptions): Promise<Result<RunningHub>> {
  const clock = input.clock ?? systemClock
  // 脱敏名单在任何事件写入之前就绪：取得锁后、打开账本时先解析一次密钥。
  // 名单注册进 core 的 redactSecrets，使正则兜底之前先替换已知值（名单优先）。
  const redactor = new SecretRedactor()
  const unregister = registerKnownSecrets(redactor.redact)
  const logger = redactingLogger(input.logger ?? consoleLogger, redactSecrets)
  const options: RunHubOptions = { ...input, logger }
  const secrets = createHubSecrets({
    home: options.home,
    redactor,
    logger,
    ...(options.secrets?.load ? { load: options.secrets.load } : {}),
    ...(options.secrets?.debounceMs !== undefined
      ? { debounceMs: options.secrets.debounceMs }
      : {}),
    onChange: (status) => {
      options.secrets?.onChange?.(status)
      // 密钥补上后，之前因缺少密钥未启动的渠道重试启动。
      void inbox?.channels.refresh()
    },
  })
  let stopWatch: (() => void) | undefined
  const startedAt = clock.now()
  let scheduler: Scheduler | undefined
  let inbox: InboxService | undefined
  /** 收件箱操作的依赖：HTTP 路由与中枢内渠道共用同一个实现（actOnInbox）。 */
  let inboxActions: InboxActionDeps | undefined
  let ledger: LedgerStore | undefined
  let config: HubConfig | undefined
  let protocol: NodeProtocol | undefined
  // Web 页面（6.1）：会话只在内存中；Host 校验需要实际监听的端口，启动成功后才填入。
  const uiSessions = createUiSessions({ now: () => clock.now() })
  let uiPort: number | undefined
  const leaseHolders = (taskId: string) => {
    const lease = ledger?.activeLease(taskId)
    return lease && Date.parse(lease.expires_at) > clock.now() ? [lease.node_id] : []
  }
  const started = await startHub({
    ...options,
    leaseHolders,
    openLedger: async () => {
      // startHub 在打开账本之前已校验过 hub.yaml，这里再读一次取租约参数。
      const loaded = await loadHubConfig(options.home)
      if (!loaded.ok) throw new Error(loaded.error.message)
      config = loaded.data
      const token = await ensureHubToken(options.home)
      if (token.ok) redactor.add('state/hub.token', token.data)
      await secrets.reload()
      ledger = await openLedger(flowPaths(options.home).ledgerDb, {
        now: () => clock.now(),
        redact: redactor.redact,
      })
      // 中枢停机期间节点无法续约：重启后给每个活动租约至少一个 TTL 的宽限，
      // 让仍在运行的节点有机会续上，而不是在第一次扫描时被误判为 node_lost（hub-daemon "崩溃后自动恢复"）。
      const graceUntil = new Date(clock.now() + config.lease_ttl_s * 1000).toISOString()
      for (const lease of ledger.activeLeases()) {
        if (lease.expires_at < graceUntil) ledger.renewLease(lease.lease_id, graceUntil)
      }
      return ledger
    },
    routes: () => {
      if (!ledger || !config) return []
      const tasks = createTaskService({
        ledger,
        workspaceExists: workspaceCheckFromHome(options.home),
        now: () => clock.now(),
      })
      protocol = createNodeProtocol({
        ledger,
        clock,
        leaseTtlS: config.lease_ttl_s,
        leaseWaitMaxS: config.lease_wait_max_s,
        onResume: () => scheduler?.resume(),
        ...(options.logger ? { logger: options.logger } : {}),
      })
      // HTTP 路由、/ui 与中枢内渠道共用同一个收件箱操作实现（actOnInbox）。
      const inboxDeps: InboxActionDeps = {
        ledger,
        tasks,
        home: options.home,
        scanProposals: async () => {
          await inbox?.proposals.scan()
        },
      }
      inboxActions = inboxDeps
      const status = new Hono()
      status.get('/v1/hub/status', async (c) => {
        const policies = await loadPoliciesConfig(options.home)
        const backup = ledger?.latestEvent(undefined, 'hub.backup_done')
        const scheduleErrors = scheduler?.errors() ?? []
        const data: HubStatusData = {
          version: options.version ?? VERSION,
          pid: process.pid,
          started_at: new Date(startedAt).toISOString(),
          runtime: options.runtime ?? currentRuntime(),
          uptime: Math.max(0, (clock.now() - startedAt) / 1000),
          ledger_seq: ledger?.seq() ?? 0,
          schedules: { loaded: scheduler?.loaded() ?? 0, errors: scheduleErrors },
          schedule_errors: scheduleErrors,
          last_backup:
            backup?.type === 'hub.backup_done'
              ? { path: backup.payload.path, at: backup.ts }
              : null,
          secrets: secrets.status(),
          policies: policies.ok
            ? { loaded: policies.data.rules.length, errors: policies.data.errors }
            : {
                loaded: 0,
                errors: [
                  {
                    file: 'config/policies.yaml',
                    code: policies.error.code,
                    message: redactSecrets(policies.error.message),
                  },
                ],
              },
          channels: inbox?.channels.status() ?? [],
        }
        return c.json({ ok: true as const, data })
      })
      return [
        { path: '/', app: status },
        { path: '/', app: createTaskRoutes({ ledger, tasks }) },
        { path: '/', app: createInboxRoutes(inboxDeps) },
        { path: '/', app: createUiLoginCodeRoutes(uiSessions) },
        {
          path: '/',
          app: createUiApp({
            sessions: uiSessions,
            inbox: inboxDeps,
            port: () => uiPort,
            settle: async () => {
              await inbox?.idle()
            },
            now: () => clock.now(),
          }),
        },
        { path: '/', app: createPolicyRoutes({ home: options.home, ledger, leaseHolders }) },
        { path: '/', app: protocol.routes },
      ]
    },
    onStop: async () => {
      await inbox?.stop()
      scheduler?.stop()
      protocol?.stop()
      stopWatch?.()
      secrets.close()
      // 账本写入端的 redact 仍直接持有名单；这里只撤下 core 正则之前的全局名单。
      unregister()
    },
    onBackupDone: (info) => {
      options.onBackupDone?.(info)
      ledger?.append(
        {
          type: 'hub.backup_done',
          payload: {
            path: info.path,
            size_bytes: info.size_bytes,
            duration_ms: info.duration_ms,
            removed: info.removed,
          },
        },
        { actor: 'hub' },
      )
    },
  })
  if (!started.ok || !ledger) {
    secrets.close()
    unregister()
    return started
  }
  uiPort = started.data.port
  const marker = ledger.append(
    {
      type: 'hub.started',
      payload: {
        version: options.version ?? VERSION,
        pid: process.pid,
        runtime: options.runtime ?? currentRuntime(),
        port: started.data.port,
      },
    },
    { actor: 'hub' },
  )
  if (!marker.ok) {
    await started.data.stop()
    return marker
  }
  scheduler = await createScheduler({
    ledger,
    clock,
    home: options.home,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  // 收件箱（add-m1-inbox 3.1）：hub.started 之后补处理停机期间的事件，再开始监听。
  inbox = await startInbox({
    ledger,
    home: options.home,
    clock,
    logger,
    scheduler,
    resolve: (value) => secrets.resolve(value),
    ...(options.inbox?.channels ? { channels: options.inbox.channels } : {}),
    // 渠道在中枢进程内运行，不经过 HTTP 鉴权，直接以 user 身份执行并记录 via（design D9）。
    act: async (id, action, text, via) => {
      if (!inboxActions) return fail('retryable', 'hub_starting', '中枢尚未就绪')
      const input = inboxActRequest.safeParse({ action, ...(text ? { text } : {}), via })
      if (!input.success) return fail('usage', 'invalid_arguments', '条目操作参数不合法')
      return actOnInbox(inboxActions, id, input.data, 'user')
    },
    ...(options.inbox?.backoff ? { backoff: options.inbox.backoff } : {}),
    ...(options.inbox?.watch !== undefined ? { watch: options.inbox.watch } : {}),
    ...(options.inbox?.proposalIntervalMs !== undefined
      ? { proposalIntervalMs: options.inbox.proposalIntervalMs }
      : {}),
  })
  protocol?.start()
  if (options.secrets?.watch !== false) stopWatch = secrets.watch()
  return started
}
