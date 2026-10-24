import { execFile } from 'node:child_process'
import { fail, ok, type Result } from '@flow/core'
import { z } from 'zod'

/**
 * Orca CLI 与 gh CLI 的封装（add-m1-executors 2.1；design D2）。
 *
 * - 只调用本机已安装的 `orca` 命令，不依赖 `~/.claude/scripts` 中的个人脚本；
 * - 每条命令都带 `--json`，输出先按 Orca 的信封 `{ ok, result | error }` 校验，再按命令校验 `result`；
 * - 二进制路径和执行方式（`run`）都可以注入：测试用假 `orca`、假 `gh`，绝不调用真实命令。
 *
 * 错误码：
 * - `orca_not_found`：找不到 orca 可执行文件；
 * - `orca_error`：Orca 返回 `ok: false`（details.code 为 Orca 自己的错误码，例如 `terminal_handle_stale`）；
 * - `orca_bad_output`：输出不是预期的 JSON；
 * - `orca_failed`：进程以非零退出码结束且没有可解析的错误信封；
 * - gh 同理：`gh_not_found`、`gh_failed`、`gh_bad_output`。
 */

export interface CommandOutput {
  /** 退出码；被信号终止时为 null。 */
  code: number | null
  stdout: string
  stderr: string
}

/** 执行一个外部命令（argv，不经 shell）。找不到可执行文件时以 ENOENT 拒绝。 */
export type CommandRunner = (
  bin: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandOutput>

/** 默认的命令执行：`node:child_process.execFile`，输出上限 16MB。 */
export const execRunner: CommandRunner = (bin, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err)
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

// ---------------------------------------------------------------------------
// 输出 schema（字段以 Orca 1.4.218 的实际输出为准，见 test/fixtures/orca/）
// ---------------------------------------------------------------------------

const envelope = z.discriminatedUnion('ok', [
  z.looseObject({ ok: z.literal(true), result: z.unknown() }),
  z.looseObject({
    ok: z.literal(false),
    error: z.looseObject({ code: z.string(), message: z.string().optional() }),
  }),
])

export const orcaWorktreeResult = z.looseObject({
  worktree: z.looseObject({
    path: z.string().min(1),
    /** 形如 `refs/heads/<账号>/<name>`：Orca 会给分支名加前缀，PR 检查必须用这里的分支。 */
    branch: z.string().min(1).optional(),
    id: z.string().optional(),
    baseRef: z.string().optional(),
  }),
})
export type OrcaWorktree = z.infer<typeof orcaWorktreeResult>['worktree']

export const orcaTerminalCreateResult = z.looseObject({
  terminal: z.looseObject({
    handle: z.string().min(1),
    /** 终端进程的身份：Orca 重启后 handle 会变，这两个字段用于确认接管的是同一个终端。 */
    ptyId: z.string().optional(),
    incarnationId: z.string().optional(),
  }),
})

/** 新建终端的 handle 与进程身份。 */
export interface OrcaTerminalIdentity {
  handle: string
  ptyId?: string
  incarnationId?: string
}

export const orcaTerminalReadResult = z.looseObject({
  terminal: z.looseObject({
    handle: z.string(),
    /** running / exited；未来的值按字符串保留。 */
    status: z.string(),
    tail: z.array(z.string()),
    /** stream：累积输出；screen：渲染后的屏幕。 */
    source: z.string().optional(),
  }),
})
export type OrcaTerminalRead = z.infer<typeof orcaTerminalReadResult>['terminal']

export const orcaTerminalListResult = z.looseObject({
  terminals: z.array(
    z.looseObject({
      handle: z.string().min(1),
      worktreePath: z.string().optional(),
      title: z.string().optional(),
      agentIdentity: z.string().optional(),
      connected: z.boolean().optional(),
      orphaned: z.boolean().optional(),
      ptyId: z.string().optional(),
      incarnationId: z.string().optional(),
    }),
  ),
})
export type OrcaTerminalInfo = z.infer<typeof orcaTerminalListResult>['terminals'][number]

export const orcaTerminalSendResult = z.looseObject({
  send: z.looseObject({
    accepted: z.boolean(),
    /** 只有"文字 + 回车"的提示词才有；只发回车时没有这个字段。 */
    prompt: z
      .looseObject({ requestId: z.string().min(1), stages: z.array(z.string()).default([]) })
      .optional(),
  }),
  mutation: z.looseObject({ requestId: z.string(), replayed: z.boolean() }).optional(),
  warnings: z.array(z.string()).optional(),
})
export type OrcaSendResult = z.infer<typeof orcaTerminalSendResult>

const anyResult = z.unknown()

export const ghPrList = z.array(
  z.looseObject({ url: z.string().min(1), number: z.number().int(), state: z.string() }),
)
export type GhPr = z.infer<typeof ghPrList>[number]

// ---------------------------------------------------------------------------
// Orca
// ---------------------------------------------------------------------------

export interface OrcaCliOptions {
  /** orca 可执行文件，默认 `orca`（按 PATH 查找）。 */
  bin?: string
  run?: CommandRunner
  env?: NodeJS.ProcessEnv
  /** 单条命令的超时，默认 120 秒（`--setup run` 的 worktree create 可能较慢）。 */
  timeoutMs?: number
}

export interface WorktreeCreateInput {
  /** 仓库的本地路径（`--repo path:<repo>`）。 */
  repo: string
  name: string
  /** 例如 `origin/main`。 */
  baseBranch: string
  /** 仓库定义的 setup 钩子：默认 run。 */
  setup?: 'run' | 'skip' | 'inherit'
  comment?: string
}

export interface TerminalSendInput {
  handle: string
  /** 不给 text 时只发回车（信任提示只接受这种形式）。 */
  text?: string
  enter?: boolean
  /** 等待 Codex 开始这一轮的秒数（`--wait-submit`）。 */
  waitSubmitS?: number
  /** 复核上一次发送：同一个 request id 只回放回执，不会再发一次。 */
  retryRequest?: string
}

export interface OrcaCli {
  worktreeCreate(input: WorktreeCreateInput): Promise<Result<OrcaWorktree>>
  worktreeRm(input: { path: string; force?: boolean }): Promise<Result<void>>
  terminalCreate(input: {
    worktreePath: string
    command: string
    title?: string
  }): Promise<Result<OrcaTerminalIdentity>>
  terminalRead(input: { handle: string; limit?: number }): Promise<Result<OrcaTerminalRead>>
  terminalSend(input: TerminalSendInput): Promise<Result<OrcaSendResult>>
  /** `terminal list --worktree path:<wt>`：这个 worktree 中仍在运行的终端。 */
  terminalList(input: { worktreePath: string }): Promise<Result<OrcaTerminalInfo[]>>
  terminalClose(input: { handle: string }): Promise<Result<void>>
}

/** 解析 Orca 的 JSON 输出：先校验信封，再校验 result。 */
export function parseOrcaOutput<T>(
  out: CommandOutput,
  schema: z.ZodType<T>,
  what: string,
): Result<T> {
  let json: unknown
  try {
    json = JSON.parse(out.stdout)
  } catch {
    const detail = (out.stderr || out.stdout).trim().slice(0, 500)
    if (out.code !== 0) {
      return fail('failure', 'orca_failed', `orca ${what} 失败（退出码 ${out.code}）：${detail}`)
    }
    return fail('failure', 'orca_bad_output', `orca ${what} 的输出不是 JSON：${detail}`)
  }
  const env = envelope.safeParse(json)
  if (!env.success) {
    return fail('failure', 'orca_bad_output', `orca ${what} 的输出格式不符：${env.error.message}`)
  }
  if (!env.data.ok) {
    const { code, message } = env.data.error
    return fail('failure', 'orca_error', `orca ${what} 返回错误 ${code}：${message ?? code}`, {
      code,
    })
  }
  const parsed = schema.safeParse(env.data.result)
  if (!parsed.success) {
    return fail(
      'failure',
      'orca_bad_output',
      `orca ${what} 的 result 格式不符：${parsed.error.message}`,
    )
  }
  return ok(parsed.data)
}

/** Orca 错误信封中的错误码（`orca_error` 时），否则 undefined。 */
export function orcaErrorCode(r: Result<unknown>): string | undefined {
  if (r.ok || r.error.code !== 'orca_error') return undefined
  const d = r.error.details as { code?: unknown } | undefined
  return typeof d?.code === 'string' ? d.code : undefined
}

export function createOrcaCli(options: OrcaCliOptions = {}): OrcaCli {
  const bin = options.bin ?? 'orca'
  const run = options.run ?? execRunner
  const timeoutMs = options.timeoutMs ?? 120_000
  async function call<T>(args: string[], schema: z.ZodType<T>, what: string): Promise<Result<T>> {
    let out: CommandOutput
    try {
      out = await run(bin, [...args, '--json'], {
        timeoutMs,
        ...(options.env ? { env: options.env } : {}),
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return fail('failure', 'orca_not_found', `找不到 orca 可执行文件：${bin}`)
      }
      return fail('failure', 'orca_failed', `orca ${what} 无法执行：${(err as Error).message}`)
    }
    return parseOrcaOutput(out, schema, what)
  }
  return {
    async worktreeCreate(input) {
      const args = [
        'worktree',
        'create',
        '--repo',
        `path:${input.repo}`,
        '--name',
        input.name,
        '--base-branch',
        input.baseBranch,
        '--setup',
        input.setup ?? 'run',
        '--no-parent',
        ...(input.comment ? ['--comment', input.comment] : []),
      ]
      const r = await call(args, orcaWorktreeResult, 'worktree create')
      return r.ok ? ok(r.data.worktree) : r
    },
    async worktreeRm(input) {
      const args = ['worktree', 'rm', '--worktree', `path:${input.path}`]
      if (input.force) args.push('--force')
      const r = await call(args, anyResult, 'worktree rm')
      return r.ok ? ok(undefined) : r
    },
    async terminalCreate(input) {
      const args = ['terminal', 'create', '--worktree', `path:${input.worktreePath}`]
      if (input.title) args.push('--title', input.title)
      args.push('--command', input.command)
      const r = await call(args, orcaTerminalCreateResult, 'terminal create')
      if (!r.ok) return r
      const t = r.data.terminal
      return ok({
        handle: t.handle,
        ...(t.ptyId ? { ptyId: t.ptyId } : {}),
        ...(t.incarnationId ? { incarnationId: t.incarnationId } : {}),
      })
    },
    async terminalRead(input) {
      const args = ['terminal', 'read', '--terminal', input.handle]
      if (input.limit) args.push('--limit', String(input.limit))
      const r = await call(args, orcaTerminalReadResult, 'terminal read')
      return r.ok ? ok(r.data.terminal) : r
    },
    async terminalSend(input) {
      const args = ['terminal', 'send', '--terminal', input.handle]
      if (input.text !== undefined) args.push('--text', input.text)
      if (input.enter) args.push('--enter')
      if (input.retryRequest) args.push('--retry-request', input.retryRequest)
      if (input.waitSubmitS !== undefined) args.push('--wait-submit', String(input.waitSubmitS))
      return call(args, orcaTerminalSendResult, 'terminal send')
    },
    async terminalList(input) {
      const r = await call(
        ['terminal', 'list', '--worktree', `path:${input.worktreePath}`],
        orcaTerminalListResult,
        'terminal list',
      )
      return r.ok ? ok(r.data.terminals) : r
    },
    async terminalClose(input) {
      const r = await call(
        ['terminal', 'close', '--terminal', input.handle],
        anyResult,
        'terminal close',
      )
      return r.ok ? ok(undefined) : r
    },
  }
}

// ---------------------------------------------------------------------------
// gh：查本任务分支上的 PR（design D4 第 2 步）
// ---------------------------------------------------------------------------

export interface GhCliOptions {
  bin?: string
  run?: CommandRunner
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface GhCli {
  /** `gh pr list --head <branch> --state all --json url,number,state`，在仓库目录中执行。 */
  prList(input: { cwd: string; branch: string }): Promise<Result<GhPr[]>>
}

export function createGhCli(options: GhCliOptions = {}): GhCli {
  const bin = options.bin ?? 'gh'
  const run = options.run ?? execRunner
  return {
    async prList({ cwd, branch }) {
      let out: CommandOutput
      try {
        out = await run(
          bin,
          ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,number,state'],
          {
            cwd,
            timeoutMs: options.timeoutMs ?? 60_000,
            ...(options.env ? { env: options.env } : {}),
          },
        )
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail('failure', 'gh_not_found', `找不到 gh 可执行文件：${bin}`)
        }
        return fail('failure', 'gh_failed', `gh pr list 无法执行：${(err as Error).message}`)
      }
      if (out.code !== 0) {
        const detail = (out.stderr || out.stdout).trim().slice(0, 500)
        return fail('failure', 'gh_failed', `gh pr list 失败（退出码 ${out.code}）：${detail}`)
      }
      let json: unknown
      try {
        json = JSON.parse(out.stdout)
      } catch {
        return fail('failure', 'gh_bad_output', 'gh pr list 的输出不是 JSON')
      }
      const parsed = ghPrList.safeParse(json)
      if (!parsed.success) {
        return fail(
          'failure',
          'gh_bad_output',
          `gh pr list 的输出格式不符：${parsed.error.message}`,
        )
      }
      return ok(parsed.data)
    },
  }
}
