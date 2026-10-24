import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  clipText,
  redactLines,
  sanitizeTail,
  TAIL_LINE_MAX,
  type VerifyOutcome,
  type VerifyStep,
} from '@flow/core'
import type { NodeClock } from './clock.ts'
import { executorEnv } from './env.ts'

const DEFAULT_VERIFY_TIMEOUT_S = 600

/** 顺序验收；取消或第一条失败后不再启动后续命令。 */
export async function verifyTask(
  steps: readonly VerifyStep[],
  cwd: string,
  clock: NodeClock,
  signal: AbortSignal,
): Promise<VerifyOutcome[]> {
  const outcomes: VerifyOutcome[] = []
  for (const step of steps) {
    if (signal.aborted) break
    const outcome = await verifyCommand(step, cwd, clock, signal)
    outcomes.push(outcome)
    if (outcome.exit_code !== 0 || outcome.timed_out) break
  }
  return outcomes
}

function verifyCommand(
  step: VerifyStep,
  taskCwd: string,
  clock: NodeClock,
  signal: AbortSignal,
): Promise<VerifyOutcome> {
  return new Promise((finish) => {
    const cwd = resolve(taskCwd, step.cwd ?? '.')
    const now = () => clock.monotonic?.() ?? clock.now()
    const started = now()
    let timedOut = false
    const lines: string[] = []
    const partials = { stdout: '', stderr: '' }
    let spawnFailed = false
    const line = (text: string) => {
      lines.push(text)
      if (lines.length > 200) lines.shift()
    }
    // 分块到达的长行也有界；保留规则与 sanitizeTail 的单行截断一致。
    const output = (stream: keyof typeof partials, chunk: string) => {
      const parts = chunk.split('\n')
      for (let i = 0; i < parts.length; i++) {
        partials[stream] = clipText(partials[stream] + (parts[i] ?? ''), TAIL_LINE_MAX)
        if (i < parts.length - 1) {
          line(partials[stream])
          partials[stream] = ''
        }
      }
    }
    const complete = (exitCode: number | null) => {
      for (const partial of Object.values(partials)) if (partial) line(partial)
      finish({
        cmd: step.cmd,
        cwd,
        exit_code: timedOut || signal.aborted || spawnFailed ? null : exitCode,
        duration_ms: Math.max(0, Math.round(now() - started)),
        timed_out: timedOut,
        // 先在行缓冲上脱敏，避免 16KB 窗口切掉私钥 BEGIN 后泄漏正文。
        output_tail: sanitizeTail(redactLines(lines)),
      })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(step.cmd[0] ?? '', step.cmd.slice(1), {
        cwd,
        env: executorEnv(),
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      output('stderr', (err as Error).message)
      complete(null)
      return
    }
    // 独立进程组：子孙进程即使忽略 SIGTERM，也不能在超时/取消后继续运行。
    const kill = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
      }
    }
    // 各流先拼成完整行，再合并；stderr 不能把 stdout 中分块到达的密钥从中间切开。
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => output('stdout', chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => output('stderr', chunk))
    child.on('error', (err) => {
      spawnFailed = true
      output('stderr', err.message)
    })
    const cancelTimeout = clock.setTimeout(
      () => {
        timedOut = true
        kill()
      },
      (step.timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S) * 1000,
    )
    signal.addEventListener('abort', kill, { once: true })
    if (signal.aborted) kill()
    child.once('close', (code) => {
      cancelTimeout()
      signal.removeEventListener('abort', kill)
      complete(code)
    })
  })
}
