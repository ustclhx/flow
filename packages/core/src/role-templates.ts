/**
 * 默认角色（design D3、D5、D9）。只由 init 在文件缺失时写入。
 * `creatable_by`：dev 不写（只有 user 能创建）；reviewer、triage 为 `*`（任何非 user 身份都可以创建，
 * 例如 claude-sdk 执行器经 `flow mcp --actor reviewer` 拆子任务）。
 */
export const DEFAULT_ROLE_FILES: Record<string, string> = {
  'dev.yaml': `# 没有 creatable_by：只有 user 可以创建 dev 任务（AI 与节点不能借 dev 提权）。
name: dev
executor: codex-orca
model: gpt-6.1-sol
effort: high
prompt: dev.md
permissions:
  approval: never
  sandbox: danger-full-access
`,
  'dev.md': `按任务合同在指定仓库中完成开发，只修改授权范围内的内容。
运行相关检查，提交、推送并创建 PR，不合并。
遇到无法判断的问题时，写明问题并停下等待回复。
`,
  'reviewer.yaml': `name: reviewer
executor: claude-sdk
model: claude-opus-5-5
prompt: reviewer.md
creatable_by:
  - "*"
permissions:
  permissionMode: default
  setting_sources: []
  allowedTools:
    - Read
    - Glob
    - Grep
    - "Bash(gh pr comment:*)"
    - "Bash(gh pr review:*)"
  disallowedTools:
    - NotebookEdit
  writable_paths:
    - "docs/**"
    - "**/*.md"
    - "**/*.mdx"
`,
  'reviewer.md': `检查 PR 的正确性、需求符合度和回归风险，可以新建或修改文档文件，不改代码。
文档写入仅限仓库内 docs/**、任意 *.md 和 *.mdx；不要通过 Bash 或其他工具绕过路径限制。
给出有证据、可操作的审查意见，可以用 gh pr comment 和 gh pr review 评论 PR。
除非合同明确要求，否则不提交、不推送；不合并 PR。
结论写在最终回复里，说明检查结果、尚未确认的问题，并列出本次写过的文件。
`,
  'triage.yaml': `name: triage
executor: codex-exec
prompt: triage.md
creatable_by:
  - "*"
permissions:
  sandbox: read-only
`,
  'triage.md': `只读收集任务相关证据，判断问题的影响与可能原因。
给出简短结论和建议的下一步，不修改文件。
信息不足时提出明确问题，等待回复后继续。
`,
}
