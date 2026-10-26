// "需要我的"页面的少量原生脚本（add-m1-inbox 6.1，design D5）：
// 按钮调用 /ui/items/:id/act，成功后重新获取 /ui/items 片段做局部刷新。
// 只用 textContent 写入文字；片段由服务端渲染并已转义。
;(() => {
  const board = document.getElementById('board')
  if (!board) return
  const sync = document.getElementById('sync')
  const refreshButton = document.getElementById('refresh')

  const DONE = {
    approve: '已批准',
    deny: '已驳回',
    reply: '已回复',
    accept: '已接受',
    reject: '已拒绝',
    dismiss: '已忽略',
  }
  const AUTO_REFRESH_MS = 30_000

  let inflight = 0
  let refreshQueued = false
  let refreshTimer = 0
  let refreshing = false

  const setSync = (text, isError) => {
    if (!sync) return
    sync.textContent = text
    sync.classList.toggle('is-error', Boolean(isError))
  }

  const cardOf = (el) => el.closest('.card[data-id]')
  const buttonsOf = (card) => card.querySelectorAll('button')
  const statusOf = (card) => card.querySelector('.status')

  function setBusy(card, button, busy) {
    card.classList.toggle('is-busy', busy)
    for (const b of buttonsOf(card)) b.disabled = busy
    if (button) {
      button.classList.toggle('is-busy', busy)
      button.setAttribute('aria-busy', busy ? 'true' : 'false')
    }
  }

  function setStatus(card, text, kind) {
    card.classList.toggle('is-error', kind === 'error')
    card.classList.toggle('is-done', kind === 'done')
    const status = statusOf(card)
    if (status) status.textContent = text
  }

  /** 正在输入回复时不打断：刷新推迟到焦点离开输入框。 */
  const typing = () => {
    const el = document.activeElement
    return Boolean(el && el.tagName === 'TEXTAREA' && board.contains(el))
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      void refresh()
    }, delay)
  }

  /** 用新片段替换看板；正在编辑、出错或展开输出的卡片保留原节点，不丢失输入。 */
  function reconcile(markup) {
    const template = document.createElement('template')
    template.innerHTML = markup
    const next = template.content
    for (const fresh of next.querySelectorAll('.card[data-id]')) {
      const old = board.querySelector(`.card[data-id="${CSS.escape(fresh.dataset.id)}"]`)
      if (!old || old.dataset.state !== fresh.dataset.state) continue
      if (old.dataset.updated !== fresh.dataset.updated) continue
      const keep =
        old.classList.contains('is-replying') ||
        old.classList.contains('is-error') ||
        old.classList.contains('is-busy') ||
        old.querySelector('details[open]')
      if (keep) fresh.replaceWith(old)
    }
    // 已完成且不在新片段中的卡片先淡出。
    const ids = new Set([...next.querySelectorAll('.card[data-id]')].map((c) => c.dataset.id))
    const leaving = [...board.querySelectorAll('.card.is-done[data-id]')].filter(
      (c) => !ids.has(c.dataset.id),
    )
    for (const c of leaving) c.classList.add('is-leaving')
    const swap = () => {
      board.replaceChildren(next)
      updateTitle()
    }
    if (leaving.length > 0) window.setTimeout(swap, 180)
    else swap()
  }

  function updateTitle() {
    const chip = board.querySelector('.chip.lvl-interrupt b')
    const n = chip ? Number(chip.textContent) : 0
    document.title = n > 0 ? `(${n}) 需要我的 · Flow` : '需要我的 · Flow'
  }

  async function refresh() {
    if (inflight > 0 || refreshing) {
      refreshQueued = true
      return
    }
    if (typing()) {
      refreshQueued = true
      return
    }
    refreshing = true
    refreshQueued = false
    try {
      const res = await fetch('/ui/items', {
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
        cache: 'no-store',
      })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      reconcile(await res.text())
      const t = new Date()
      setSync(
        `已更新 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`,
      )
    } catch {
      setSync('刷新失败，稍后重试', true)
    } finally {
      refreshing = false
      if (refreshQueued) scheduleRefresh(300)
    }
  }

  async function act(card, button, action, text) {
    const id = card.dataset.id
    // 任务提案：接受时若改过目标，带上修改后的目标（D11）。
    const goalArea = action === 'accept' ? card.querySelector('textarea[data-goal]') : null
    const goal =
      goalArea && goalArea.value.trim() !== goalArea.defaultValue.trim()
        ? goalArea.value.trim()
        : ''
    setBusy(card, button, true)
    setStatus(card, '正在提交…')
    inflight++
    try {
      const res = await fetch(`/ui/items/${encodeURIComponent(id)}/act`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action, ...(text ? { text } : {}), ...(goal ? { goal } : {}) }),
      })
      let doc = null
      try {
        doc = await res.json()
      } catch {
        doc = null
      }
      if (res.ok && doc?.ok) {
        const open = doc.data?.item?.state === 'open'
        setBusy(card, button, false)
        card.classList.remove('is-replying')
        setStatus(card, open ? `${DONE[action]}，等待任务恢复` : DONE[action], 'done')
      } else {
        const message =
          res.status === 401
            ? '会话已失效，请在终端运行 flow ui 重新登录'
            : doc?.error?.message || `操作失败（HTTP ${res.status}）`
        setBusy(card, button, false)
        setStatus(card, message, 'error')
        // 条目已关闭等情况：刷新以反映最新状态。
        if (doc?.error?.code === 'item_closed') card.classList.add('is-done')
      }
    } catch {
      setBusy(card, button, false)
      setStatus(card, '网络错误，未能提交，请重试', 'error')
    } finally {
      inflight--
      // 合并连续操作：最后一个请求结束后再刷新。
      scheduleRefresh(500)
    }
  }

  function openReply(card) {
    const box = card.querySelector('.reply')
    if (!box) return
    box.hidden = false
    card.classList.add('is-replying')
    const area = box.querySelector('textarea')
    if (area) area.focus()
  }

  function closeReply(card) {
    const box = card.querySelector('.reply')
    if (!box) return
    box.hidden = true
    card.classList.remove('is-replying')
    if (refreshQueued) scheduleRefresh(100)
  }

  function sendReply(card) {
    const area = card.querySelector('.reply textarea')
    const text = area ? area.value.trim() : ''
    if (!text) {
      setStatus(card, '回复内容不能为空', 'error')
      if (area) area.focus()
      return
    }
    if (area) area.blur()
    void act(card, card.querySelector('[data-send]'), 'reply', text)
  }

  board.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (!target || target.disabled) return
    const card = cardOf(target)
    if (!card) return
    if (target.dataset.option) return void act(card, target, 'reply', target.dataset.option)
    if (target.dataset.act === 'reply') return openReply(card)
    if (target.hasAttribute('data-cancel')) return closeReply(card)
    if (target.hasAttribute('data-send')) return sendReply(card)
    if (target.dataset.act) void act(card, target, target.dataset.act)
  })

  board.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return
    const card = cardOf(event.target)
    if (!card) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      sendReply(card)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeReply(card)
    }
  })

  board.addEventListener('focusout', () => {
    if (refreshQueued) scheduleRefresh(200)
  })

  if (refreshButton) refreshButton.addEventListener('click', () => void refresh())

  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, AUTO_REFRESH_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
})()
