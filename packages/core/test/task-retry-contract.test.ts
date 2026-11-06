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

test('两份升级说明覆盖任何任务重试及通知对旧中枢和旧客户端的回滚限制', async () => {
  for (const file of ['daemon.md', 'supervisor.md']) {
    const docs = await readFile(new URL(`../../../docs/${file}`, import.meta.url), 'utf8')
    expect(docs).toMatch(/任何一次任务重试（包括它生成的收件箱通知）之后[^。]*旧中枢与旧客户端/)
    expect(docs).toMatch(/task\.requeued[^。]*strictObject[^。]*requested_by[^。]*retry_reason/)
    expect(docs).toMatch(
      /inbox\.item_created[^。]*source[^。]*task_retry[^。]*旧 CLI[^。]*收件箱[^。]*失败/,
    )
    expect(docs).toMatch(/failed → queued[^。]*task\.started[^。]*ledger_inconsistent/)
    expect(docs).toContain('使用升级前的备份')
  }
})

test('supervisor 权限说明按创建者逐级约束重试，继承 origin 不授予用户任务重试权限', async () => {
  const docs = await readFile(new URL('../../../docs/supervisor.md', import.meta.url), 'utf8')
  const permissions = docs.split('## 3. 权限与硬性上限')[1]?.split('## 4.')[0] ?? ''
  expect(permissions).toMatch(/created_by[^。]*每一级[^。]*supervisor[^。]*hub/)
  expect(permissions).toMatch(
    /用户手工创建[^。]*接受提案后以 `user` 创建[^。]*继承 origin[^。]*user[^。]*重试/,
  )
})
