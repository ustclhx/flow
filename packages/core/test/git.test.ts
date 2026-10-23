import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  execCommand,
  flowAuthor,
  git,
  gitCommit,
  gitInit,
  hasCommits,
  hookPath,
  isRepoRoot,
} from '../src/git.ts'
import { tempHome, writeText } from './helpers.ts'

test('gitInit / gitCommit：作者为 Flow (<actor>)，只提交指定路径', async () => {
  const dir = tempHome('flow-git-')
  mkdirSync(dir, { recursive: true })
  expect(isRepoRoot(dir)).toBe(false)
  expect((await gitInit(dir)).ok).toBe(true)
  expect(isRepoRoot(dir)).toBe(true)
  expect(await hasCommits(dir)).toBe(false)
  writeText(join(dir, 'a.md'), 'a\n')
  writeText(join(dir, 'b.md'), 'b\n')
  const r = await gitCommit(dir, {
    message: 'journal: codex 追加',
    author: flowAuthor('codex'),
    paths: ['a.md'],
  })
  expect(r.ok && r.data.sha).toMatch(/^[0-9a-f]{40}$/)
  expect(await hasCommits(dir)).toBe(true)
  const log = await git(dir, ['log', '--format=%an <%ae>|%s'])
  expect(log.stdout.trim()).toBe('Flow (codex) <flow@localhost>|journal: codex 追加')
  expect((await git(dir, ['status', '--porcelain'])).stdout.trim()).toBe('?? b.md')
  expect(await hookPath(dir, 'pre-commit')).toBe(join(dir, '.git', 'hooks', 'pre-commit'))
})

test('gitCommit 失败时返回 git_commit_failed', async () => {
  const dir = tempHome('flow-git-')
  mkdirSync(dir, { recursive: true })
  await gitInit(dir)
  const r = await gitCommit(dir, { message: 'empty', author: flowAuthor('user') })
  expect(!r.ok && r.error.code).toBe('git_commit_failed')
})

test('execCommand：命令不存在时返回 127', async () => {
  const r = await execCommand('flow-definitely-missing-binary', [])
  expect(r.code).toBe(127)
  const echo = await execCommand('cat', [], { input: '你好' })
  expect(echo).toEqual({ code: 0, stdout: '你好', stderr: '' })
})
