import { existsSync } from 'node:fs'
import { execCommand } from '../git.ts'
import { fail, ok, type Result } from '../result.ts'
import { GITLEAKS_TOML } from '../templates.ts'

/**
 * 写入前的密钥扫描（design D7、secret-hygiene）：把待写内容经 stdin 交给
 * `gitleaks stdin --redact`，以 JSON 报告读取结果。返回值与错误信息都只含规则 ID 与位置，
 * 绝不包含密钥原文（gitleaks 的 Match/Secret 字段即使已脱敏也一律丢弃）。
 * gitleaks 缺失或运行失败时返回错误，绝不静默放行。
 */

export interface SecretFinding {
  /** gitleaks 规则 ID，例如 `stripe-access-token`。 */
  ruleId: string
  /** 规则说明（来自 gitleaks，不含密钥内容）。 */
  description: string
  /** 所在行（从 1 开始，相对被扫描的文本）。 */
  line: number
  /** 所在列（从 1 开始）。 */
  column: number
}

export interface ScanOptions {
  /** gitleaks 配置文件；不存在或省略时使用 Flow 的默认配置（放行 `secret://` 引用）。 */
  configPath?: string
  /** gitleaks 可执行文件，默认 `gitleaks`；测试中可指向不存在的路径。 */
  gitleaksBin?: string
}

interface GitleaksReportItem {
  RuleID?: unknown
  Description?: unknown
  StartLine?: unknown
  StartColumn?: unknown
}

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string) =>
  s
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, '')))
    .join('')

/** 扫描一段文本，返回疑似密钥的位置与规则（可能为空数组）。 */
export async function scanForSecrets(
  text: string,
  opts: ScanOptions = {},
): Promise<Result<{ findings: SecretFinding[] }>> {
  const bin = opts.gitleaksBin ?? 'gitleaks'
  const args = ['stdin', '--redact', '--no-banner', '--no-color', '-l', 'error']
  args.push('--report-format', 'json', '--report-path', '-')
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GITLEAKS_CONFIG
  if (opts.configPath && existsSync(opts.configPath)) {
    args.push('-c', opts.configPath)
    delete env.GITLEAKS_CONFIG_TOML
  } else {
    env.GITLEAKS_CONFIG_TOML = GITLEAKS_TOML
  }
  const r = await execCommand(bin, args, { input: text, env })
  if (r.code === 127) {
    return fail(
      'failure',
      'gitleaks_missing',
      `未找到 gitleaks（${bin}），无法做写入前的密钥扫描，写入已拒绝。安装：brew install gitleaks`,
    )
  }
  let report: unknown
  try {
    report = JSON.parse(r.stdout)
  } catch {
    report = undefined
  }
  if (!Array.isArray(report) || (r.code !== 0 && r.code !== 1)) {
    // stderr 只含 gitleaks 自身的日志（例如配置错误），--redact 下不会回显扫描内容。
    const detail = stripAnsi(r.stderr).trim().split('\n').slice(-3).join(' ')
    return fail(
      'failure',
      'secret_scan_failed',
      `密钥扫描失败（gitleaks 退出码 ${r.code}），写入已拒绝${detail ? `：${detail}` : ''}`,
    )
  }
  const findings = (report as GitleaksReportItem[]).map((item) => ({
    ruleId: typeof item.RuleID === 'string' ? item.RuleID : 'unknown',
    description: typeof item.Description === 'string' ? item.Description : '',
    line: typeof item.StartLine === 'number' ? item.StartLine : 0,
    column: typeof item.StartColumn === 'number' ? item.StartColumn : 0,
  }))
  findings.sort((a, b) => a.line - b.line || a.column - b.column)
  return ok({ findings })
}
