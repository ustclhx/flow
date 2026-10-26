/**
 * 简报笔记写入能力（design D8）。只有 `write/brief.ts` 的 `writeBrief`（由中枢调用）在写入上下文里
 * 带上它；这个模块不从包入口导出，条目写入、提案合入、journal 等其他写入路径拿不到它，
 * 因此写 `briefs/` 一律被策略拒绝。
 */
export const BRIEF_WRITE: unique symbol = Symbol('flow.briefWrite')
