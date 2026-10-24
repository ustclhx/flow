import { afterEach, expect, test } from 'bun:test'
import { chmodSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspectClaudeSdk } from '../src/doctor-sdk.ts'
import { tempHome, writeText } from './helpers.ts'

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(dirname(home), { recursive: true, force: true })
})

function fixture() {
  const home = tempHome('flow-doctor-sdk-')
  homes.push(home)
  const nodeDir = join(home, 'packages/node')
  const nodePackageJson = join(nodeDir, 'package.json')
  writeText(
    nodePackageJson,
    JSON.stringify({
      name: '@flow/node',
      dependencies: { [SDK_PACKAGE]: '4.5.6' },
    }),
  )
  // core 同名包是干扰项，doctor 必须以 node 的 package.json 为基准。
  installSdk(join(home, 'packages/core'), '9.9.9')
  return { nodeDir, nodePackageJson }
}

function installSdk(dir: string, version = '1.2.3') {
  const sdkDir = join(dir, 'node_modules', SDK_PACKAGE)
  writeText(
    join(sdkDir, 'package.json'),
    JSON.stringify({
      name: SDK_PACKAGE,
      version,
      type: 'module',
      exports: './sdk.mjs',
    }),
  )
  writeText(
    join(sdkDir, 'sdk.mjs'),
    'export function query() { throw new Error("doctor 不应调用 query") }',
  )
  return sdkDir
}

test('从 node 包位置解析 SDK，期望版本来自 node 声明；原生 CLI 只查文件、不执行', async () => {
  const { nodeDir, nodePackageJson } = fixture()
  installSdk(nodeDir)
  const cliPath = join(
    nodeDir,
    'node_modules',
    `${SDK_PACKAGE}-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  writeText(cliPath, '不是可以运行的 CLI，只允许检测存在性')
  chmodSync(cliPath, 0o755)
  expect(await inspectClaudeSdk(nodePackageJson)).toEqual({
    version: '1.2.3',
    expectedVersion: '4.5.6',
    cliPath: realpathSync(cliPath),
  })
})

test('node SDK 解析不到时为未安装，不借用 core 的 SDK；node 包不存在也同样处理', async () => {
  const { nodePackageJson } = fixture()
  expect(await inspectClaudeSdk(nodePackageJson)).toBeNull()
  rmSync(nodePackageJson)
  expect(await inspectClaudeSdk(nodePackageJson)).toBeNull()
})

test('SDK 已解析时区分原生 CLI 缺失与 SDK import 失败', async () => {
  const { nodeDir, nodePackageJson } = fixture()
  installSdk(nodeDir)
  expect(await inspectClaudeSdk(nodePackageJson)).toEqual({
    version: '1.2.3',
    expectedVersion: '4.5.6',
    cliPath: null,
  })
  const broken = fixture()
  const brokenSdk = installSdk(broken.nodeDir)
  writeText(join(brokenSdk, 'sdk.mjs'), 'throw new Error("模拟 SDK 导入失败")')
  await expect(inspectClaudeSdk(broken.nodePackageJson)).rejects.toThrow('模拟 SDK 导入失败')
})
