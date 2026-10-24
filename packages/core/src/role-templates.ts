/** 默认角色（design D3、D5、D9）。只由 init 在文件缺失时写入。 */
export const DEFAULT_ROLE_FILES: Record<string, string> = {
  'dev.yaml': `name: dev
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
    - Edit
    - Write
    - NotebookEdit
`,
  'reviewer.md': `只读检查 PR 的正确性、需求符合度和回归风险，不修改文件。
给出有证据、可操作的审查意见，可以用 gh pr comment 和 gh pr review 评论 PR。
写明检查结果与尚未确认的问题，不合并 PR。
`,
  'triage.yaml': `name: triage
executor: codex-exec
prompt: triage.md
permissions:
  sandbox: read-only
`,
  'triage.md': `只读收集任务相关证据，判断问题的影响与可能原因。
给出简短结论和建议的下一步，不修改文件。
信息不足时提出明确问题，等待回复后继续。
`,
}
