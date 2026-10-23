import { createProposal } from '../../src/proposals/index.ts'
import { renderEntry } from '../../src/write/api.ts'

const [, , home, name] = process.argv
if (!home || !name) process.exit(2)
const target = `notes/${name}`
const r = await createProposal(
  home,
  {
    target,
    reason: '并发保存',
    content: renderEntry(
      { type: 'note', title: target, summary: '并发提案', scope: 'work' },
      `${target}\n`,
    ),
  },
  { actor: 'codex' },
)
if (!r.ok) {
  console.error(r.error.code)
  process.exit(1)
}
