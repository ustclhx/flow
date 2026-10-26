/** 美元金额的展示（两位小数，0 与 0.01 之间时三位），用于 supervisor 花费（add-m1-supervisor D13）。 */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

/** JSON 中的金额：四舍五入到 6 位小数，避免浮点累加的长尾（例如 0.30000000000000004）。 */
export const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6
