import { redactSecrets } from '@flow/core'
import type { StuckSnapshot, StuckVerdict } from '../executor.ts'

/**
 * codex-orca 的终端识别规则（add-m1-executors 2.3；design D4）。
 *
 * 只看 `orca terminal read` 返回的末尾文本，不解析完整的 TUI 状态。规则集中在这一个文件里，
 * 每条规则都有 `test/fixtures/codex-tui/` 下的真实终端片段（Codex 0.164.0 / Orca 1.4.218），
 * TUI 文本随版本变化时只改这里并补 fixture。
 *
 * 判定顺序（`analyzeTail`）：
 * 1. 空：没有任何非空行；
 * 2. 忙碌：末尾 15 行内出现 `Working (` 或 `esc to interrupt`；
 * 3. 授权请求：末尾 12 行内出现 `Would you like to run the following command?`、
 *    `Would you like to make the following edits?`、`Yes, proceed (y)` 等，**并且**弹窗还在屏幕最底部
 *    （最后一行是 `Press enter to confirm or esc to cancel`，或最后两行是 `1. Yes` / `3. No` 这样的选项行且其后没有输入框）；
 *    说明中带上 `$ <命令>` 那一行；
 * 4. 信任提示：末尾 8 行是完整的信任弹窗布局（`Folder access`、`Trust this folder?`、`1. Trust and continue`、
 *    `2. Quit`，最后一行是 `enter continue · esc quit`），并且没有命中任何授权规则。授权判断排在信任提示之前
 *    （PR #24 审查第 1 条：历史输出或 Reason 里的信任文字，不能让执行器在授权弹窗上按回车）；
 * 5. 提问：保留最后一行以问号结尾或全文命中原有关键词的基础判定；另识别含选择信号的
 *    问句段落后接 2–8 个同类编号选项（可带缩进续行和一行回复指令）；
 * 6. PR 链接：最后一条消息中出现 GitHub PR 链接。只用于说明，是否 done 只看 `gh pr list`；
 * 7. 其他。
 *
 * 文本识别终究是启发式的；执行器另外只在新终端出现第一个忙碌标记之前才自动确认信任提示。
 *
 * "最后一条消息"：去掉底部的输入框（最后一个以 `›` 开头的行及其下方的状态行）、
 * `Worked for …`、提示与空行之后，从最后一个以 `•` 开头的行到末尾。
 */

export type TailKind =
  | 'empty'
  | 'working'
  | 'trust_prompt'
  | 'awaiting_approval'
  | 'pr_opened'
  | 'question'
  | 'other'

export interface TailAnalysis {
  kind: TailKind
  /** 一句话说明（已脱敏）。 */
  message: string
  /** 授权请求中的命令。 */
  command?: string
  /** 最后一条消息中的 PR 链接。 */
  pr_url?: string
  /** 最后一条消息（去掉 TUI 装饰后的行）。 */
  last_message: string[]
}

/** 忙碌标记（与 watch-codex.sh 一致）。 */
export const BUSY_RE = /Working \(|esc to interrupt/
/** 只在末尾这么多行里找忙碌标记：更早的行是历史记录。 */
const BUSY_WINDOW = 15
const TRUST_WINDOW = 8
/**
 * 信任弹窗的完整布局（以 fixture trust-prompt 的真实输出为准）：Folder access 标题、问句、两个选项，
 * 最后一行是 `enter continue · esc quit`。缺任何一段都不算（PR #24 复核：未知弹窗不能冒充）。
 */
const TRUST_LAYOUT = [
  /^\s*Folder access\s*$/,
  /Trust this folder\?/,
  /^\s*(?:›\s*)?1\. Trust and continue\s*$/,
  /^\s*(?:›\s*)?2\. Quit\s*$/,
]
const TRUST_LAST_RE = /^\s*enter continue · esc quit\s*$/
const APPROVAL_RES = [
  /Would you like to run the following command\?/,
  /Would you like to make the following edits\?/,
  /Would you like to (?:grant|allow)\b/i,
  /Press enter to confirm or esc to cancel/,
  /Yes, proceed \(y\)/,
  /Allow command\?/i,
]
const APPROVAL_WINDOW = 12
/** 授权弹窗仍在屏幕底部：页脚或选项行。 */
const APPROVAL_FOOTER_RE = /Press enter to confirm or esc to cancel/
const APPROVAL_OPTION_RE = /^\s*(?:›\s*)?\d+\. (?:Yes|No)\b/
/** 输入框（不是以数字选项开头的 › 行）或快捷键提示。 */
const COMPOSER_RE = /^›\s+(?!\d+\.)|\? for shortcuts/
export const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
const QUESTION_END_RE = /[?？][\s)）"'”」*`]*$/
const QUESTION_WORDS_RE =
  /请确认|是否|要不要|你希望|您希望|需要我|请告诉我|请选择|which\b|should I\b|shall I\b|do you want|would you (?:like|prefer)|let me know|please confirm|can you confirm/i
const CHOICE_SIGNAL_RE =
  /你|您|选择|选哪|哪种|哪一个|哪个|还是|倾向|which|prefer|should I|do you|would you|\bor\b/i
const REPLY_INSTRUCTION_RE = /^\s*(?:请?回复|Reply\b|Answer with\b)/i
/** 数字不接受冒号，标记后须有空白或非 ASCII 内容，避免时间、版本号和 e.g.。 */
const QUESTION_OPTION_RE =
  /^([ \t]*)([A-H][.、)）：:]|[1-9][.、)）]|\([1-9]\)|（[1-9]）|[①-⑧])(?=\s|[\u0080-\uffff])\s*\S.*$/
/** 底部装饰行：快捷键提示、Tip、Worked for、中断提示、分隔线。 */
const CHROME_RE =
  /^\s*(?:\? for shortcuts|└ Tip:|Tip:|Worked for |■ Conversation interrupted|[─━-]{3,}\s*$)/

/** zsh / bash 的默认提示符：`user@host dir %`、`user@host:~/dir$`。 */
const SHELL_PROMPT_RE = /^[\w.-]+@[\w.-]+[ :].{0,200}[%$#]$/

const clean = (lines: readonly string[]) => lines.map((l) => l.replace(/\s+$/, ''))
const nonEmpty = (lines: readonly string[]) => lines.filter((l) => l.trim() !== '')
const oneLine = (s: string, max = 300) => {
  const t = redactSecrets(s.replace(/\s+/g, ' ').trim())
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const matchesApproval = (l: string) => APPROVAL_RES.some((re) => re.test(l))

/** 从问句所在段落开头取上下文，• 是一条消息的起点。 */
function questionParagraph(lines: readonly string[], at: number): string {
  let from = at
  while (from > 0 && lines[from - 1]?.trim() && !/^\s*•\s/.test(lines[from] ?? '')) from--
  return lines
    .slice(from, at + 1)
    .join('\n')
    .replace(/^\s*•\s*/, '')
}

/** 从前面裁掉背景，保留末尾问句；单行过长时也保留末尾。脱敏在截断前执行。 */
function questionSummary(text: string, max: number): string {
  const summary = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return summary.length > max ? `…${summary.slice(1 - max)}` : summary
}

/** 只接受同类的显式编号；更深的无标记行归入上一选项。 */
function questionOptions(lines: readonly string[]): string[] | undefined {
  const body = nonEmpty(lines)
  if (REPLY_INSTRUCTION_RE.test(body.at(-1) ?? '')) body.pop()
  const options: string[] = []
  let style: string | undefined
  let optionIndent = 0
  for (const line of body) {
    const marker = QUESTION_OPTION_RE.exec(line)
    const indent = line.match(/^[ \t]*/)?.[0].replace(/\t/g, '    ').length ?? 0
    if (marker) {
      // 保留标点与括号差异，只归一编号本身：1. 与 2）属于不同类型。
      const nextStyle = marker[2]?.replace(/[A-H]/, 'A').replace(/[1-9]/, '1').replace(/[①-⑧]/, '①')
      if ((style && style !== nextStyle) || options.length === 8) return
      style = nextStyle
      optionIndent = indent
      options.push(line.trim())
    } else if (options.length > 0 && indent > optionIndent) {
      options[options.length - 1] += `\n${line.trim()}`
    } else return
  }
  return options.length >= 2 ? options : undefined
}

/** 两种 Codex 执行器共用的提问识别；输入为完整的最后一条代理消息。 */
export function questionMessage(lines: readonly string[]): string | undefined {
  const lastLine = nonEmpty(lines).at(-1) ?? ''
  // 基础判定与 main 完全一致，选项解析失败不能减少原来识别出的提问。
  const baseQuestion = QUESTION_END_RE.test(lastLine) || QUESTION_WORDS_RE.test(lines.join('\n'))
  for (let at = 0; at < lines.length; at++) {
    if (!QUESTION_END_RE.test(lines[at] ?? '')) continue
    const paragraph = questionParagraph(lines, at)
    if (!CHOICE_SIGNAL_RE.test(paragraph)) continue
    const options = questionOptions(lines.slice(at + 1))
    if (options) {
      const question = questionSummary(paragraph, 300)
      // 先为每个选项分配预算，避免整体截断吃掉末尾选项；每项最多 120 字符。
      const optionBudget = Math.min(
        120,
        Math.floor((1000 - question.length - options.length) / options.length),
      )
      return oneLine(
        [question, ...options.map((option) => oneLine(option, optionBudget))].join(' '),
        1000,
      )
    }
  }
  if (!baseQuestion) return
  const questionAt = lines.findLastIndex((line) => /[?？]/.test(line))
  return questionSummary(questionAt >= 0 ? questionParagraph(lines, questionAt) : lastLine, 600)
}

/** 末尾是否有忙碌标记。 */
export function isBusy(tail: readonly string[]): boolean {
  return nonEmpty(tail)
    .slice(-BUSY_WINDOW)
    .some((l) => BUSY_RE.test(l))
}

/** 去掉底部的输入框与装饰，返回最后一条消息的各行。 */
export function lastMessage(tail: readonly string[]): string[] {
  let lines = clean(tail)
  // 输入框：底部 6 行内最后一个以 › 开头的行（其下是模型与目录状态行）。
  const start = Math.max(0, lines.length - 6)
  for (let i = lines.length - 1; i >= start; i--) {
    if (/^›/.test(lines[i] ?? '')) {
      lines = lines.slice(0, i)
      break
    }
  }
  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? ''
    if (last.trim() === '' || CHROME_RE.test(last)) lines.pop()
    else break
  }
  let from = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^• /.test(lines[i] ?? '')) {
      from = i
      break
    }
  }
  return from >= 0 ? lines.slice(from) : lines.slice(-5)
}

function approvalCommand(lines: readonly string[]): { command?: string; reason?: string } {
  let command: string | undefined
  let reason: string | undefined
  for (const l of lines) {
    const c = /^\s*\$ (.+)$/.exec(l)
    if (c?.[1]) command = c[1].trim()
    const r = /^\s*Reason:\s*(.+)$/.exec(l)
    if (r?.[1]) reason = r[1].trim()
  }
  return { ...(command ? { command } : {}), ...(reason ? { reason } : {}) }
}

/** 按上面的顺序分析终端末尾。 */
export function analyzeTail(tail: readonly string[]): TailAnalysis {
  const lines = clean(tail)
  const body = nonEmpty(lines)
  if (body.length === 0) return { kind: 'empty', message: '终端没有任何输出', last_message: [] }
  if (isBusy(lines)) return { kind: 'working', message: 'Codex 正在工作', last_message: [] }

  const bottom = body.slice(-APPROVAL_WINDOW)
  const approvalAt = bottom.findIndex(matchesApproval)
  // 弹窗必须还在屏幕最底部：最后一行是页脚，或最后两行是选项行（其后没有输入框）。
  const lastTwo = body.slice(-2)
  const modalOpen =
    APPROVAL_FOOTER_RE.test(body.at(-1) ?? '') ||
    (lastTwo.some((l) => APPROVAL_OPTION_RE.test(l)) && !lastTwo.some((l) => COMPOSER_RE.test(l)))
  if (approvalAt >= 0 && modalOpen) {
    // 从提示所在消息开始（往前最多再看 6 行，找最近的 • 行），带上命令与理由。
    const at = body.length - bottom.length + approvalAt
    let from = at
    while (from > Math.max(0, at - 6) && !/^• /.test(body[from] ?? '')) from--
    const block = body.slice(from)
    const { command, reason } = approvalCommand(block)
    const what = command ? `执行命令：${command}` : '确认一项操作'
    return {
      kind: 'awaiting_approval',
      message: oneLine(`Codex 请求授权${what}${reason ? `（理由：${reason}）` : ''}`, 600),
      ...(command ? { command: redactSecrets(command) } : {}),
      last_message: block,
    }
  }

  const trustLines = body.slice(-TRUST_WINDOW)
  if (
    approvalAt < 0 &&
    !trustLines.some(matchesApproval) &&
    TRUST_LAYOUT.every((re) => trustLines.some((l) => re.test(l))) &&
    TRUST_LAST_RE.test(body.at(-1) ?? '')
  ) {
    return { kind: 'trust_prompt', message: 'Codex 停在文件夹信任提示上', last_message: trustLines }
  }

  const msg = lastMessage(lines)
  const text = msg.join('\n')
  const lastLine = nonEmpty(msg).at(-1) ?? ''
  const question = questionMessage(msg)
  if (question !== undefined) return { kind: 'question', message: question, last_message: msg }

  const pr = PR_URL_RE.exec(text)?.[0]
  if (pr) {
    return { kind: 'pr_opened', message: `Codex 说已开 PR：${pr}`, pr_url: pr, last_message: msg }
  }

  // 终端回到了 shell 提示符（Codex 已退出，或命令没能启动）。
  const final = body.at(-1) ?? ''
  if (SHELL_PROMPT_RE.test(final)) {
    const before = body.at(-2)
    return {
      kind: 'other',
      message: oneLine(
        `Codex 已不在运行，终端回到了 shell 提示符${before ? `；之前的输出：${before.trim()}` : ''}`,
      ),
      last_message: body.slice(-5),
    }
  }

  return {
    kind: 'other',
    message: oneLine((lastLine || final).replace(/^•\s*/, '')) || 'Codex 已停下',
    last_message: msg,
  }
}

/** 策略预检时 Codex 授权请求使用的工具名（与 Claude 的 Bash 区分：这是请求越出沙箱执行）。 */
export const CODEX_ORCA_PRECHECK_TOOL = 'CodexCommand'

/** 可交给策略预检的授权弹窗：原始命令（未脱敏，只发给中枢判定）与弹窗全文（用于前后比对）。 */
export interface ApprovalPrompt {
  command: string
  /** 从 `Would you like to run the following command?` 到页脚的各行。 */
  prompt: string[]
  /** 弹窗中 `Reason:` 一行（Codex 给出的理由）；没有时省略。只用于上报请求文本，不参与判定。 */
  reason?: string
}

const RUN_COMMAND_RE = /^\s*Would you like to run the following command\?\s*$/
const COMMAND_LINE_RE = /^\s*\$ (.+)$/
/** 光标停在第一个选项"Yes, proceed"上：回车只批准这一次。 */
const FIRST_OPTION_SELECTED_RE = /^›\s*1\. Yes, proceed\b/
const FIRST_OPTION_RE = /^\s*(?:›\s*)?1\. Yes\b/
const SECOND_OPTION_RE = /^\s*2\. Yes, and don't ask again\b/
const NO_OPTION_RE = /^\s*3\. No\b/
const ANY_OPTION_RE = /^\s*(?:›\s*)?\d+\./
const FOOTER_ONLY_RE = /^\s*Press enter to confirm or esc to cancel\s*$/
/** 控制字符、格式字符（零宽、双向覆盖等）与非常规空白：显示的命令可能与实际执行的不一致。 */
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u

/**
 * 为策略预检严格解析授权弹窗（add-m1-inbox 2.3）。只认下面这一种完整布局，任何偏差都返回
 * undefined（调用方按需要用户处理）：
 *
 * ```
 *   Would you like to run the following command?
 *   …（Environment / Reason 等）
 *   $ <命令>                     ← 恰好一行 `$ `，且紧接着就是选项 1（命令没有折行或多行）
 * › 1. Yes, proceed (y)          ← 光标在选项 1：回车只批准这一次，不会选中"不再询问"
 *   2. Yes, and don't ask again …（可折行）
 *   3. No, and tell Codex what to do differently (esc)
 *   Press enter to confirm or esc to cancel   ← 最后一行
 * ```
 *
 * 另外：弹窗中只能有一个问句、一个 `›` 行、一个"1. Yes"、一个 `$ ` 行；命令中出现 `…`
 * 视为被截断；出现控制字符或非打印字符时拒绝提取。编辑请求（`make the following edits`）等其他弹窗没有命令，同样返回 undefined。
 */
export function approvalForPrecheck(tail: readonly string[]): ApprovalPrompt | undefined {
  if (analyzeTail(tail).kind !== 'awaiting_approval') return undefined
  const body = nonEmpty(clean(tail))
  if (!FOOTER_ONLY_RE.test(body.at(-1) ?? '')) return undefined
  const bottom = body.slice(-(APPROVAL_WINDOW + 8))
  let header = -1
  for (let i = bottom.length - 1; i >= 0; i--) {
    if (RUN_COMMAND_RE.test(bottom[i] ?? '')) {
      header = i
      break
    }
  }
  if (header < 0) return undefined
  const block = bottom.slice(header)
  const count = (re: RegExp) => block.filter((l) => re.test(l)).length
  if (
    count(RUN_COMMAND_RE) !== 1 ||
    count(COMMAND_LINE_RE) !== 1 ||
    count(/^›/) !== 1 ||
    count(FIRST_OPTION_RE) !== 1
  ) {
    return undefined
  }
  const at = block.findIndex((l) => COMMAND_LINE_RE.test(l))
  const rest = block.slice(at + 1)
  // $ 行之后：选项 1（被选中）、选项 2（可折行）、选项 3、页脚，别无他物。
  if (!FIRST_OPTION_SELECTED_RE.test(rest[0] ?? '')) return undefined
  if (!SECOND_OPTION_RE.test(rest[1] ?? '')) return undefined
  const noAt = rest.findIndex((l) => NO_OPTION_RE.test(l))
  if (noAt < 2 || noAt !== rest.length - 2) return undefined
  if (rest.slice(2, noAt).some((l) => ANY_OPTION_RE.test(l))) return undefined
  const command = COMMAND_LINE_RE.exec(block[at] ?? '')?.[1]?.trim()
  if (!command || command.includes('…') || UNPRINTABLE_RE.test(command)) return undefined
  const reason = approvalCommand(block.slice(0, at)).reason
  return { command, prompt: block, ...(reason ? { reason } : {}) }
}

/** 从 idle 信号的 hint 中取终端末尾；没有时用节点累积的末尾输出。 */
function snapshotTail(snapshot: StuckSnapshot): readonly string[] {
  const t = snapshot.hint?.tail
  if (Array.isArray(t) && t.every((l) => typeof l === 'string')) return t as string[]
  return snapshot.tail
}

/**
 * 节点调用的 classify：把末尾分析映射为卡住原因。
 * - 执行器在 hint 中给出 `gh_error`（gh 不可用，无法判断 PR）：other，说明 gh 不可用；
 * - 授权请求、信任提示（没有自动确认）→ awaiting_approval；
 * - 提问 → question；
 * - 其他：idle 触发时为 other（说明取最后一行），no_progress 触发时返回 null，交给节点归为 no_progress。
 */
export function classifyCodexOrca(snapshot: StuckSnapshot): StuckVerdict | null {
  const ghError = snapshot.hint?.gh_error
  if (typeof ghError === 'string' && ghError) {
    return {
      reason: 'other',
      message: oneLine(
        `Codex 已停下，但 gh 不可用，无法确认本任务分支上是否有 PR：${ghError}`,
        600,
      ),
    }
  }
  const a = analyzeTail(snapshotTail(snapshot))
  switch (a.kind) {
    case 'awaiting_approval':
      return { reason: 'awaiting_approval', message: a.message }
    case 'trust_prompt':
      return {
        reason: 'awaiting_approval',
        message: 'Codex 停在文件夹信任提示上，执行器没有自动确认，需要人工确认',
      }
    case 'question':
      return { reason: 'question', message: a.message }
    case 'pr_opened':
      return {
        reason: 'other',
        message: `终端显示已开 PR（${a.pr_url}），但本任务分支上没有查到 PR`,
      }
    case 'working':
      return null
    case 'empty':
    case 'other':
      if (snapshot.trigger === 'no_progress') return null
      return { reason: 'other', message: a.message }
  }
}
