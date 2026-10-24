import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Bench, bench, fake } from './harness.ts'

/**
 * 合同是结构化、会被执行的内容：入账时只做已知值的名单替换，不跑正则（PR #23 复核）。
 * 低置信度规则会误伤的写法必须原样保留，验收命令照原样执行。
 */

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function waitFor(b: Bench, pred: () => boolean) {
  const deadline = Date.now() + 5000
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('等待任务结束超时')
    await b.clock.advance(0)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('合同中的 tokenizer:、sk-learn-…、--token= 原样入账，验收命令照原样执行', async () => {
  const b = await bench()
  current = b
  const work = join(b.home, 'work')
  mkdirSync(work, { recursive: true })
  const out = join(work, 'argv.txt')
  const goal = '微调分类器 tokenizer: bert-base-uncased'
  const model = 'sk-learn-classifier-pipeline-v2'
  const flag = '--token=localtest123'
  const cmd = ['sh', '-c', 'printf %s "$1" > "$2"', 'sh', flag, out]
  const id = await b.create({
    ...fake({ delay_ms: 0 }),
    goal,
    inputs: { fake: { delay_ms: 0 }, model },
    cwd: work,
    verify: [{ cmd }],
  })
  await waitFor(b, () => ['done', 'failed'].includes(b.task(id).status))
  const t = b.task(id)
  expect(t.status).toBe('done')
  expect(t.contract.goal).toBe(goal)
  expect(t.contract.inputs).toMatchObject({ model })
  expect(t.contract.verify?.[0]?.cmd).toEqual(cmd)
  // 验收命令收到的参数没有被改写。
  expect(readFileSync(out, 'utf8')).toBe(flag)
  // 验收结果中的 argv 也是结构化字段，原样记录。
  expect(t.result?.verify[0]?.cmd).toEqual(cmd)
  const created = b.events(id).find((e) => e.type === 'task.created')
  expect(JSON.stringify(created?.payload)).toContain(flag)
})
