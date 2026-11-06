import { describe, expect, test } from 'bun:test'
import { renderWorkerTaskPrompt, taskContract } from '@raindown/core'
import { renderTaskPrompt } from '../src/claude-sdk.ts'
import { renderTaskSpec } from '../src/codex-orca/spec.ts'

describe('worker 输入适配', () => {
  const contract = taskContract.parse({
    goal: 'supervisor 补充验收条件',
    workspace: 'ws/demo',
    role: 'dev',
    executor: 'claude-sdk',
    origin_instruction: { seq: 12, text: '用户原话：修正文档' },
    context: ['README.md'],
    verify: [{ cmd: ['bun', 'test'] }],
  })

  test('Claude 保留 core 来源模板、工作目录、上下文与验收命令', () => {
    const prompt = renderTaskPrompt(contract, '/test/worktree')
    expect(prompt).toContain(renderWorkerTaskPrompt(contract))
    expect(prompt).toContain('/test/worktree')
    expect(prompt).toContain('README.md')
    expect(prompt).toContain('bun test')
  })

  test('Orca 保留 core 来源模板、角色、范围、上下文与完成标准', () => {
    const prompt = renderTaskSpec({
      taskId: 't-test',
      contract: { ...contract, executor: 'codex-orca' },
      role: { name: 'dev', prompt: '开发角色提示' },
      worktree: { path: '/test/worktree', branch: 'dev/t-test' },
      baseBranch: 'origin/main',
      context: [{ kind: 'file', ref: 'README.md' }],
      scope: ['README.md'],
    })
    expect(prompt).toContain(renderWorkerTaskPrompt(contract))
    expect(prompt).toContain('开发角色提示')
    expect(prompt).toContain('README.md')
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('**不要合并 PR**')
  })
})
