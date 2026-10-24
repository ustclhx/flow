/** @jsxImportSource hono/jsx */
import { INBOX_LEVELS, type InboxAction, type InboxItemView, type InboxLevel } from '@flow/core'
import type { Child, FC } from 'hono/jsx'

/**
 * "需要我的"页面的服务端渲染（add-m1-inbox 6.1，design D5）。
 *
 * 只用 Hono JSX 的默认转义输出动态文本，不使用 raw 或 dangerouslySetInnerHTML；
 * 不写内联脚本和内联样式（CSP 只允许 'self'），脚本与样式由 `/ui/static/` 提供。
 */

/** 页面上的一个条目：正文与输出片段已在路由中脱敏。 */
export interface UiItem {
  item: InboxItemView
  title: string
  body: string
  /** 任务最近的输出（末尾若干字符）；非任务条目或没有输出时为 null。 */
  snippet: string | null
  /** 已提交、等待送达执行器的回复；有值时条目放进"已提交"一栏。 */
  pending: { kind: string } | null
}

export interface BoardModel {
  levels: Record<InboxLevel, UiItem[]>
  waiting: UiItem[]
  now: number
}

const LEVEL_META: Record<InboxLevel, { name: string; hint: string }> = {
  interrupt: { name: '立即处理', hint: 'Interrupt' },
  decide: { name: '待决定', hint: 'Decide' },
  digest: { name: '摘要', hint: 'Digest' },
}

const REASON_LABEL: Record<string, string> = {
  awaiting_approval: '等待批准',
  question: '提问',
  no_progress: '无进展',
  crashed: '执行器崩溃',
  node_lost: '节点掉线',
  other: '已卡住',
}
const SOURCE_LABEL: Record<string, string> = {
  task: '任务',
  proposal: '修改提案',
  policy: '自动放行记录',
  supervisor: 'supervisor 提问',
  digest: '每日摘要',
}

export const ACTION_LABEL: Record<InboxAction, string> = {
  approve: '批准',
  deny: '驳回',
  reply: '回复',
  accept: '接受',
  reject: '拒绝',
  dismiss: '忽略',
}
const PENDING_LABEL: Record<string, string> = {
  approve: '已批准',
  deny: '已驳回',
  text: '已回复',
}
/** 按钮的视觉层级：主要操作、需要谨慎的操作、普通操作。 */
const ACTION_TONE: Record<InboxAction, string> = {
  approve: 'primary',
  accept: 'primary',
  deny: 'danger',
  reject: 'danger',
  reply: 'secondary',
  dismiss: 'ghost',
}

const pad = (n: number) => String(n).padStart(2, '0')
function absoluteTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso))
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const d = new Date(iso)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const Time: FC<{ iso: string; now: number }> = ({ iso, now }) => (
  <time datetime={iso} title={absoluteTime(iso)}>
    {relativeTime(iso, now)}
  </time>
)

const Meta: FC<{ entry: UiItem; now: number }> = ({ entry, now }) => {
  const { item } = entry
  const tag =
    item.source === 'task' && item.reason
      ? (REASON_LABEL[item.reason] ?? item.reason)
      : (SOURCE_LABEL[item.source] ?? item.source)
  return (
    <div class="meta">
      {item.workspace ? <span class="ws">{item.workspace}</span> : null}
      <span class="tag">{tag}</span>
      <span class="sid" title={item.id}>
        #{item.short_id}
      </span>
      <Time iso={item.created_at} now={now} />
    </div>
  )
}

const Snippet: FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n').length
  return (
    <details class="snippet">
      <summary>输出片段 · {lines} 行</summary>
      <pre>{text}</pre>
    </details>
  )
}

export const Card: FC<{ entry: UiItem; now: number }> = ({ entry, now }) => {
  const { item } = entry
  const actions: InboxAction[] = [...item.actions, 'dismiss']
  const replyable = item.actions.includes('reply')
  return (
    <article
      class={`card lvl-${item.level}`}
      id={`item-${item.id}`}
      data-id={item.id}
      data-updated={item.updated_at}
      data-state="open"
    >
      <Meta entry={entry} now={now} />
      <h3 class="title">{entry.title}</h3>
      {entry.body ? <div class="body">{entry.body}</div> : null}
      {entry.snippet ? <Snippet text={entry.snippet} /> : null}
      <div class={item.actions.length === 0 ? 'actions only-dismiss' : 'actions'}>
        {actions.map((a) => (
          <button
            type="button"
            class={`btn ${ACTION_TONE[a]}${a === 'dismiss' ? ' push' : ''}`}
            data-act={a}
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {replyable ? (
        <div class="reply" hidden>
          <label class="sr" for={`reply-${item.id}`}>
            回复内容
          </label>
          <textarea
            id={`reply-${item.id}`}
            rows={3}
            maxlength={16384}
            placeholder="写下回复，⌘/Ctrl + Enter 发送，Esc 取消"
          />
          <div class="reply-actions">
            <button type="button" class="btn primary" data-send>
              发送回复
            </button>
            <button type="button" class="btn ghost" data-cancel>
              取消
            </button>
          </div>
        </div>
      ) : null}
      <p class="status" role="status" aria-live="polite" />
    </article>
  )
}

const WaitingRow: FC<{ entry: UiItem; now: number }> = ({ entry, now }) => (
  <article
    class={`card waiting lvl-${entry.item.level}`}
    data-id={entry.item.id}
    data-updated={entry.item.updated_at}
    data-state="waiting"
  >
    <Meta entry={entry} now={now} />
    <h3 class="title">{entry.title}</h3>
    <p class="note">
      {PENDING_LABEL[entry.pending?.kind ?? ''] ?? '已提交'}，等待执行器收到回复后恢复任务
    </p>
  </article>
)

/** 局部刷新的片段：级别导航、三个分组、已提交一栏。`/ui` 与 `/ui/items` 共用。 */
export const Board: FC<{ model: BoardModel }> = ({ model }) => {
  const total = INBOX_LEVELS.reduce((n, l) => n + model.levels[l].length, 0)
  return (
    <>
      <nav class="levels" aria-label="按级别跳转">
        {INBOX_LEVELS.map((l) => (
          <a
            class={`chip lvl-${l}${model.levels[l].length === 0 ? ' zero' : ''}`}
            href={`#lvl-${l}`}
          >
            <span class="dot" />
            {LEVEL_META[l].name}
            <b>{model.levels[l].length}</b>
          </a>
        ))}
      </nav>
      {total === 0 ? (
        <div class="empty">
          <p class="empty-title">没有需要你处理的事项</p>
          <p>新条目出现时，页面会自动刷新。</p>
        </div>
      ) : null}
      {INBOX_LEVELS.map((l) =>
        model.levels[l].length === 0 ? null : (
          <section class={`group lvl-${l}`} id={`lvl-${l}`}>
            <h2>
              {LEVEL_META[l].name}
              <span class="hint">{LEVEL_META[l].hint}</span>
              <span class="count">{model.levels[l].length}</span>
            </h2>
            {model.levels[l].map((entry) => (
              <Card entry={entry} now={model.now} />
            ))}
          </section>
        ),
      )}
      {model.waiting.length === 0 ? null : (
        <section class="group waiting-group" id="waiting">
          <h2>
            已提交<span class="hint">等待任务恢复</span>
            <span class="count">{model.waiting.length}</span>
          </h2>
          {model.waiting.map((entry) => (
            <WaitingRow entry={entry} now={model.now} />
          ))}
        </section>
      )}
    </>
  )
}

const Shell: FC<{ title: string; children?: Child }> = ({ title, children }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="color-scheme" content="light dark" />
      <meta name="referrer" content="no-referrer" />
      <title>{title}</title>
      <link rel="icon" href="/ui/static/icon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href="/ui/static/app.css" />
    </head>
    {children}
  </html>
)

export const BoardPage: FC<{ model: BoardModel }> = ({ model }) => {
  const urgent = model.levels.interrupt.length
  return (
    <Shell title={urgent > 0 ? `(${urgent}) 需要我的 · Flow` : '需要我的 · Flow'}>
      <body>
        <header class="top">
          <div class="brand">
            <span class="logo" aria-hidden="true" />
            <h1>需要我的</h1>
          </div>
          <div class="tools">
            <span class="sync" id="sync" aria-live="polite" />
            <button type="button" class="btn ghost small" id="refresh">
              刷新
            </button>
            <form method="post" action="/ui/logout">
              <button type="submit" class="btn ghost small">
                退出
              </button>
            </form>
          </div>
        </header>
        <main id="board" class="board">
          <Board model={model} />
        </main>
        <script src="/ui/static/app.js" defer />
      </body>
    </Shell>
  )
}

/** 没有有效会话时的页面：只提示登录，不包含任何条目。 */
export const LoginPage: FC<{ reason: 'missing' | 'invalid' }> = ({ reason }) => (
  <Shell title="登录 · Flow">
    <body class="center">
      <main class="login">
        <span class="logo big" aria-hidden="true" />
        <h1>{reason === 'invalid' ? '登录链接无效或已过期' : '请运行 flow ui 登录'}</h1>
        <p>
          {reason === 'invalid'
            ? '登录链接只能使用一次，并在 60 秒后失效。'
            : '这个页面只对本机已登录的浏览器开放。'}
        </p>
        <p>在终端中运行下面的命令，它会生成一次性登录链接并在浏览器中打开：</p>
        <pre class="cmd">flow ui</pre>
        <p class="fine">中枢重启后需要重新登录。</p>
      </main>
    </body>
  </Shell>
)
