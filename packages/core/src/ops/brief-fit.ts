/**
 * 简报的预算分配（design D8、knowledge-access "Workspace 简报"）：
 *
 * 1. supervisor 笔记放在最前面，最多占预算的 40%，超出时截断；
 * 2. 其余各节按固定顺序排列，**分享剩余预算**：按"注水"方式分配，短的节完整保留，
 *    放不下的节各得相同份额、在行边界截断并标注"本节已截断"，避免一节挤掉其他节；
 * 3. 份额小到连标题加少量内容都放不下时，从最低优先级（最后一节）开始整节省略，
 *    末尾注明"已省略"哪些节；省略说明包含在预算内。
 */

export interface BriefSection {
  label: string
  text: string
}

export interface FittedBrief {
  text: string
  /** 整节省略的部分（按出现顺序）。 */
  omitted: string[]
  /** 保留了标题但内容被截断的部分。 */
  truncated: string[]
}

const SEP = '\n\n'
export const TRUNCATED_MARK = '\n…（本节已截断）'
/** 笔记最多占预算的比例。 */
export const NOTE_SHARE = 0.4
/** 一节被截断时，标题之外至少保留的字符数；放不下就整节省略。 */
const MIN_BODY = 24

/** 截取前 n 个 UTF-16 码元，不在代理对中间切断。 */
function clip(text: string, n: number): string {
  let out = text.slice(0, Math.max(0, n))
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

const headerOf = (text: string) => {
  const i = text.indexOf('\n')
  return i < 0 ? text : text.slice(0, i)
}

/** 一节在被截断时至少需要的长度；更短的节只能完整保留。 */
const minSize = (text: string) =>
  Math.min(text.length, headerOf(text).length + MIN_BODY + TRUNCATED_MARK.length)

/** 把一节截到 cap 以内（尽量在行边界）；cap 放不下标题加少量内容时返回 null。 */
export function truncateSection(text: string, cap: number): string | null {
  if (text.length <= cap) return text
  const header = headerOf(text)
  const room = cap - TRUNCATED_MARK.length
  if (room < header.length + MIN_BODY) return null
  let cut = clip(text, room)
  const nl = cut.lastIndexOf('\n')
  // 标题后是空行（位置 header.length + 1）；后面还有完整行时才退到行边界。
  if (nl > header.length + 1) cut = cut.slice(0, nl)
  return `${cut.trimEnd()}${TRUNCATED_MARK}`
}

/** 注水分配：总量不超过 pool，放得下的完整给，其余平分剩下的。 */
function allocate(lengths: number[], pool: number): number[] {
  const caps = lengths.map(() => 0)
  let left = Math.max(0, pool)
  let pending = lengths.map((_, i) => i)
  while (pending.length > 0) {
    const share = Math.floor(left / pending.length)
    const fits = pending.filter((i) => (lengths[i] ?? 0) <= share)
    if (fits.length === 0) {
      for (const i of pending) caps[i] = share
      break
    }
    for (const i of fits) {
      caps[i] = lengths[i] ?? 0
      left -= lengths[i] ?? 0
    }
    pending = pending.filter((i) => !fits.includes(i))
  }
  return caps
}

const footerOf = (omitted: string[], hasBody: boolean) =>
  omitted.length === 0 ? '' : `${hasBody ? SEP : ''}> 已省略：${omitted.join('、')}`

export function fitBrief(
  note: BriefSection | null,
  sections: BriefSection[],
  budget: number,
): FittedBrief {
  const omittedNote: string[] = []
  let noteText = ''
  if (note) {
    const fitted = truncateSection(note.text, Math.floor(budget * NOTE_SHARE))
    if (fitted === null) omittedNote.push(note.label)
    else noteText = fitted
  }
  const included = [...sections]
  const dropped: string[] = []
  let caps: number[] = []
  for (;;) {
    const omitted = [...omittedNote, ...dropped]
    const pieces = (noteText ? 1 : 0) + included.length
    const footer = footerOf(omitted, pieces > 0)
    const pool = budget - noteText.length - SEP.length * Math.max(0, pieces - 1) - footer.length
    if (included.length === 0) break
    caps = allocate(
      included.map((s) => s.text.length),
      pool,
    )
    if (included.every((s, i) => (caps[i] ?? 0) >= minSize(s.text))) break
    const last = included.pop()
    if (last) dropped.unshift(last.label)
  }
  const truncated: string[] = []
  if (note && noteText !== note.text && noteText !== '') truncated.push(note.label)
  const parts = [
    ...(noteText ? [noteText] : []),
    ...included.map((s, i) => {
      const cap = caps[i] ?? 0
      if (s.text.length <= cap) return s.text
      truncated.push(s.label)
      return truncateSection(s.text, cap) ?? ''
    }),
  ]
  const omitted = [...omittedNote, ...dropped]
  const text = `${parts.join(SEP)}${footerOf(omitted, parts.length > 0)}`
  if (text.length <= budget) return { text, omitted, truncated }
  // 预算小到连省略说明都放不下：只给出一句说明。
  const all = [...(note ? [note.label] : []), ...sections.map((s) => s.label)]
  return { text: clip('> 已省略：全部内容（预算过小）', budget), omitted: all, truncated: [] }
}
