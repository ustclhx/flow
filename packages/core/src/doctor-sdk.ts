import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

export interface DoctorSdk {
  /** 节点包声明的版本；只从 packages/node/package.json 读取。 */
  expectedVersion: string
  version: string
  /** SDK 默认实际使用的 CLI；不是 PATH 上另行安装的 claude。 */
  cliPath: string | null
}

/** 只 import SDK、读包版本和检查原生 CLI 文件，不调用 query 或启动 Claude。 */
export async function inspectClaudeSdk(
  nodePackageJson: string | URL = new URL('../../node/package.json', import.meta.url),
): Promise<DoctorSdk | null> {
  let nodePackage: unknown
  try {
    nodePackage = JSON.parse(readFileSync(nodePackageJson, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const expectedVersion = z
    .object({ dependencies: z.object({ [SDK_PACKAGE]: z.string().min(1) }) })
    .parse(nodePackage).dependencies[SDK_PACKAGE]
  // SDK 属于节点的可选运行环境；只以节点 package.json 为基准解析，不加载节点代码。
  const require = createRequire(nodePackageJson)
  let entry: string
  try {
    entry = require.resolve(SDK_PACKAGE)
  } catch {
    return null
  }
  const sdk = await import(pathToFileURL(entry).href)
  if (typeof sdk.query !== 'function') throw new Error('SDK 未导出 query')
  const { version } = z
    .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/) })
    .parse(JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')))

  // 与节点 SDK 的默认 CLI 查找一致：Linux 优先匹配 libc，再尝试另一种包。
  const report = (process.platform === 'linux' ? process.report?.getReport() : undefined) as
    | { header: { glibcVersionRuntime?: string } }
    | undefined
  const musl = report !== undefined && !report.header.glibcVersionRuntime
  const base = `${SDK_PACKAGE}-${process.platform}-${process.arch}`
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
      return { version, expectedVersion, cliPath }
    } catch {
      // 可选的原生包未安装，继续查找 SDK 支持的另一种 libc 包。
    }
  }
  return { version, expectedVersion, cliPath: null }
}
