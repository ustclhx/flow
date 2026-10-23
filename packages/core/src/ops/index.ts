import { captureOp, kbJournalOp } from './journal.ts'
import type { Operation } from './operation.ts'
import { kbGetOp, kbQueryOp, kbSearchOp } from './search.ts'

export * from './journal.ts'
export * from './operation.ts'
export * from './search.ts'

/**
 * 全部知识访问操作。CLI 与 MCP 都遍历这个列表生成命令与工具；
 * 新增操作时在 `ops/` 下新建文件并在此追加。
 */
export const operations = [kbJournalOp, captureOp, kbSearchOp, kbGetOp, kbQueryOp] as Operation<
  never,
  unknown
>[]
