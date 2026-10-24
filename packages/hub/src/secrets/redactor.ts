/**
 * 中枢内存中的脱敏名单（design D7、secret-hygiene "已知密钥值的脱敏"）。
 *
 * - 名单是"密钥值 → 路径"，替换结果为 `[secret:<路径>]`；
 * - 长度小于 8 的值不入名单，避免把常见短词误替换；
 * - 多行的值除了整体，还把每一行（≥ 8 字符）单独入名单：活动片段和末尾输出是逐行的；
 * - 密钥轮换或删除后，旧值仍留在名单中直到进程退出（宁可多替换，不让旧值外泄）；
 * - 值只在内存中，不写入任何文件；名单本身也不提供枚举值的接口。
 */

export const SECRET_MIN_LENGTH = 8

export const secretLabel = (path: string) => `[secret:${path}]`

export class SecretRedactor {
  /** 值 → 路径。 */
  private readonly labels = new Map<string, string>()
  /** 按值长度从长到短排序，较长的值先替换（一个值是另一个值的子串时不会只替换一半）。 */
  private ordered: Array<[string, string]> = []

  /** 加入（或更新路径）一个值；过短的值被忽略。 */
  add(path: string, value: string): void {
    const candidates = [value, ...(value.includes('\n') ? value.split(/\r?\n/) : [])]
    // 两端有空白的值，去掉空白后的主体也入名单。
    for (const v of candidates.flatMap((raw) => [raw, raw.trim()])) {
      if (v.length >= SECRET_MIN_LENGTH) this.labels.set(v, path)
    }
    this.ordered = [...this.labels].sort((a, b) => b[0].length - a[0].length)
  }

  /** 用一次解析结果更新名单；不删除旧值。 */
  addAll(values: ReadonlyMap<string, string>): void {
    for (const [path, value] of [...values].sort((a, b) => a[0].localeCompare(b[0]))) {
      this.add(path, value)
    }
  }

  /** 名单中值的个数（只用于诊断，不暴露值）。 */
  get size(): number {
    return this.labels.size
  }

  redact = (text: string): string => {
    if (this.ordered.length === 0 || text.length < SECRET_MIN_LENGTH) return text
    let out = text
    for (const [value, path] of this.ordered) {
      if (out.includes(value)) out = out.split(value).join(secretLabel(path))
    }
    return out
  }
}

/** 对任意 JSON 形态的值中所有字符串做替换（对象的键不变）。 */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact)
    return out as T
  }
  return value
}
