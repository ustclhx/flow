/**
 * 由 zod 定义生成仓库根 `schemas/` 下的 JSON Schema（design D12）。
 * - `bun run schemas:gen`：重新生成并写入；
 * - `bun run schemas:check`：重新生成并与已提交的文件比较，有差异（含多余或缺失文件）则非零退出。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsonSchemas } from '../packages/core/src/schema/index.ts'

const root = fileURLToPath(new URL('../schemas', import.meta.url))
const check = process.argv.includes('--check')

const expected = new Map(
  Object.entries(jsonSchemas()).map(([file, schema]) => [
    file,
    `${JSON.stringify(schema, null, 2)}\n`,
  ]),
)

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return listJson(p)
    return d.name.endsWith('.json') ? [relative(root, p).split('\\').join('/')] : []
  })
}

const existing = new Set(listJson(root))

if (check) {
  const problems: string[] = []
  for (const [file, content] of expected) {
    const p = join(root, file)
    if (!existsSync(p)) problems.push(`缺少 schemas/${file}`)
    else if (readFileSync(p, 'utf8') !== content) problems.push(`schemas/${file} 与定义不一致`)
  }
  for (const file of existing) {
    if (!expected.has(file)) problems.push(`schemas/${file} 是多余的文件`)
  }
  if (problems.length > 0) {
    console.error(`${problems.join('\n')}\n请运行 bun run schemas:gen 并提交结果。`)
    process.exit(1)
  }
  console.log(`schemas/ 与定义一致（${expected.size} 个文件）`)
} else {
  for (const file of existing) {
    if (!expected.has(file)) rmSync(join(root, file))
  }
  for (const [file, content] of expected) {
    const p = join(root, file)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  console.log(`已生成 ${expected.size} 个 JSON Schema 到 schemas/`)
}
