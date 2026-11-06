import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { BLOCKED_REASONS, RETRYABLE_BLOCKED_REASONS } from '../src/ledger/task.ts'
import { taskRetryOp } from '../src/ops/tasks.ts'
import { DEFAULT_ROLE_FILES } from '../src/role-templates.ts'

test('重试原因从 core 统一导出，工具说明与 supervisor 提示使用同一列表', () => {
  const reasons = RETRYABLE_BLOCKED_REASONS
  expect(reasons).toEqual(['crashed', 'workdir_missing', 'node_lost', 'other'])
  for (const reason of reasons) expect(BLOCKED_REASONS).toContain(reason)
  const states = `blocked(${reasons.join('/')})`
  expect(taskRetryOp.summary).toContain(states)
  expect(DEFAULT_ROLE_FILES['supervisor.md']).toContain(states)
})

test('工具说明与 supervisor 提示说明租约、取消、唤醒与自主写类重试边界', () => {
  for (const text of [taskRetryOp.summary, DEFAULT_ROLE_FILES['supervisor.md'] ?? '']) {
    expect(text).toContain('租约必须已释放')
    expect(text).toContain('取消请求')
    expect(text).toContain('唤醒任务本身不可重试')
    expect(text).toContain('每一级均由 supervisor 或 hub 创建')
    expect(text).toContain('merge/supervisor')
    expect(text).toContain('自主唤醒')
    expect(text).toContain('写类任务只能提案')
    expect(text).toContain('supervisor 必须提供非空 reason')
  }
})

test('升级说明明确 failed 重试是不能直接回滚的单向迁移', async () => {
  const docs = await readFile(new URL('../../../docs/daemon.md', import.meta.url), 'utf8')
  expect(docs).toContain('出现重试过的 failed 任务后不能回滚到本版本之前的中枢')
  expect(docs).toContain('单向迁移')
  expect(docs).toContain('task.requeued')
  expect(docs).toContain('task.started')
  expect(docs).toContain('ledger_inconsistent')
  expect(docs).toContain('使用升级前的备份')
})
