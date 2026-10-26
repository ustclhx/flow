/**
 * 决策回看写入能力（design D11："AI 不能写 decision" 的唯一窄例外）。只有 `write/decision.ts` 的
 * `reviewDecision`（由中枢以 hub 身份代 supervisor 调用）在写入上下文里带上它；这个模块不从包入口导出，
 * 其他写入路径拿不到它。带上它时策略只放行"追加回看一节、只改 status 与 last_verified"的整体替换
 * （`checkDecisionReview`），其余一律拒绝。
 */
export const DECISION_REVIEW: unique symbol = Symbol('flow.decisionReview')
