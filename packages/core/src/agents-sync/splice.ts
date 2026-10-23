import { fail, ok, type Result } from '../result.ts'
import { BEGIN_MARKER, END_MARKER } from './render.ts'

export function spliceManagedBlock(
  existing: string | null,
  block: string,
): Result<{ content: string; changed: boolean }> {
  if (existing === null) return ok({ content: `${block}\n`, changed: true })

  const beginCount = existing.split(BEGIN_MARKER).length - 1
  const endCount = existing.split(END_MARKER).length - 1
  if (beginCount > 1 || endCount > 1) {
    return fail('failure', 'managed_block_corrupt', '受管区块标记重复，必须恰好有一对 BEGIN 和 END')
  }
  if (beginCount !== endCount) {
    return fail(
      'failure',
      'managed_block_corrupt',
      beginCount === 0 ? '受管区块缺少 BEGIN 标记' : '受管区块缺少 END 标记',
    )
  }

  let content: string
  if (beginCount === 0) {
    const prefix = existing.endsWith('\n') ? existing : `${existing}\n`
    content = `${prefix}\n${block}\n`
  } else {
    const begin = existing.indexOf(BEGIN_MARKER)
    const end = existing.indexOf(END_MARKER)
    if (end < begin) {
      return fail('failure', 'managed_block_corrupt', '受管区块 END 标记出现在 BEGIN 标记之前')
    }
    content = existing.slice(0, begin) + block + existing.slice(end + END_MARKER.length)
  }
  return ok({ content, changed: content !== existing })
}
