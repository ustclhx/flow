import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

export interface DoctorSdk {
  version: string
  /** SDK 默认实际使用的 CLI；不是 PATH 上另行安装的 claude。 */
  cliPath: string | null
}

/** 只 import SDK、读包版本和检查原生 CLI 文件，不调用 query 或启动 Claude。 */
export async function inspectClaudeSdk(): Promise<DoctorSdk> {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
  const sdk = await import(pathToFileURL(entry).href)
  if (typeof sdk.query !== 'function') throw new Error('SDK 未导出 query')
  const { version } = z
    .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/) })
    .parse(JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')))

  // 与固定的 SDK 0.3.310 一致：Linux 优先匹配 libc，再尝试另一种包。
  const report = (process.platform === 'linux' ? process.report?.getReport() : undefined) as
    | { header: { glibcVersionRuntime?: string } }
    | undefined
  const musl = report !== undefined && !report.header.glibcVersionRuntime
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const packages =
    process.platform === 'linux' ? (musl ? [`${base}-musl`, base] : [base, `${base}-musl`]) : [base]
  const sdkRequire = createRequire(entry)
  for (const pkg of packages) {
    try {
      const cliPath = sdkRequire.resolve(
        `${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`,
      )
      if (!statSync(cliPath).isFile()) continue
      accessSync(cliPath, constants.X_OK)
      return { version, cliPath }
    } catch {
      // 可选的原生包未安装，继续查找 SDK 支持的另一种 libc 包。
    }
  }
  return { version, cliPath: null }
}
