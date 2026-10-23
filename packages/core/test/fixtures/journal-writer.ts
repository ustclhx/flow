/**
 * 并发写锁测试用的子进程：等到约定时刻后调用 appendJournal，把结果以 JSON 打印到 stdout。
 * 用法：bun journal-writer.ts <home> <actor> <startAtMs> <lines>
 */
import { appendJournal } from '../../src/write/api.ts'

const [home, actor, startAt, lines] = process.argv.slice(2)
if (!home || !actor || !startAt || !lines) {
  console.error('usage: journal-writer.ts <home> <actor> <startAtMs> <lines>')
  process.exit(2)
}
const wait = Number(startAt) - Date.now()
if (wait > 0) await new Promise((r) => setTimeout(r, wait))
// 较长的多行正文：如果两个写入者交错，内容会明显错乱。
const text = Array.from({ length: Number(lines) }, (_, i) => `${actor} 第 ${i + 1} 行`).join('\n')
const r = await appendJournal(home, { workspace: 'ws/product-res', text }, { actor })
console.log(JSON.stringify(r))
