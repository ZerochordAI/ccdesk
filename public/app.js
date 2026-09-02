// ccdesk 화면.
//
// DESIGN.md 의 규칙:
//  R5 같은 세션을 두 탭에 열지 않는다 — 이미 열려 있으면 그 탭으로 포커스만 옮긴다.
//  R6 SSE 는 하나. 이벤트의 runId 로 어느 탭인지 가른다.
//  R7 모델 출력은 신뢰 입력이 아니다 — 렌더 전에 반드시 이스케이프한다.

import { applyEvent, appendHistory } from '/normalize.js'

const TOKEN = new URL(location.href).searchParams.get('t') || ''
const $ = (id) => document.getElementById(id)

// 경로 구분자. 리터럴 역슬래시를 소스에 두지 않으려고 이렇게 만든다(GOTCHAS 참고).
const SEP_RE = new RegExp('[' + String.fromCharCode(92, 92) + '/]')
const baseName = (p) => p.split(SEP_RE).filter(Boolean).pop() || p

const state = {
  scope: 'all',
  path: '',
  q: '',
  sessions: [],
  roots: [],
  expanded: new Set(), // 펼쳐둔 프로젝트 경로. 기본은 전부 접힘 — 처음엔 경로만 보인다.
  tabs: [], // { id, sessionId, cwd, title, runId, messages, cursor, hasMore, follow, draft, unread, busy, el }
  active: null,
}

// ── 서버 ──────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-ccdesk-token': TOKEN, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.status + ' 오류')
  return data
}

function connect() {
  const es = new EventSource('/api/stream?t=' + encodeURIComponent(TOKEN))
  es.onopen = () => $('conn').classList.add('on')
  es.onerror = () => $('conn').classList.remove('on')
  es.onmessage = (e) => {
    let payload
    try {
      payload = JSON.parse(e.data)
    } catch {
      return
    }
    const tab = state.tabs.find((t) => t.runId === payload.runId)
    if (!tab) return

    // 도구 승인 물음. 대화 흐름이 아니라 지금 답해야 하는 것이라 따로 띄운다.
    if (payload.ev.type === 'ccdesk' && payload.ev.level === 'ask' && payload.ev.ask) {
      tab.asks.push(payload.ev.ask)
      if (tab === state.active) renderAsks()
      else {
        tab.unread = true
        renderTabs()
      }
      return
    }
    if (payload.ev.type === 'ccdesk' && payload.ev.level === 'ask-done') {
      tab.asks = tab.asks.filter((a) => a.id !== payload.ev.askId)
      if (tab === state.active) renderAsks()
      return
    }

    // 구독 한도는 메시지가 아니라 탭 상태다. 구독을 쓰면 이 숫자가 비용보다 중요하다.
    if (payload.ev.type === 'rate_limit_event' && payload.ev.rate_limit_info) {
      tab.limits = payload.ev.rate_limit_info
      if (tab === state.active) renderRunInfo()
      return
    }
    if (payload.ev.type === 'system' && payload.ev.subtype === 'init') {
      tab.apiKeySource = payload.ev.apiKeySource || null
      if (tab === state.active) renderRunInfo()
    }

    applyEvent(tab.messages, payload.ev)
    if (payload.ev.type === 'result') {
      tab.busy = false
      tab.startedAt = 0
      addStats(tab, payload.ev)
      if (tab === state.active) renderRunInfo()
      // 사용자가 끊은 것이면 줄 서 있던 것을 자동으로 내보내지 않는다.
      // 끊었는데 다음 것이 곧바로 나가면 끊은 의미가 없다.
      if (tab.interrupted) tab.interrupted = false
      else flushQueue(tab)
    }
    if (tab !== state.active) {
      tab.unread = true
      renderTabs()
    }
    scheduleRender(tab)
  }
}

// ── 목록 ──────────────────────────────────────────────────────────

async function refresh() {
  const p = new URLSearchParams({ scope: state.scope, path: state.path, q: state.q })
  try {
    const data = await api('/api/scan?' + p)
    state.sessions = data.sessions
    state.roots = data.roots
  } catch (e) {
    state.sessions = []
    $('count').textContent = e.message
    return
  }
  renderRoots()
  renderList()
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const p = (n) => String(n).padStart(2, '0')
  return sameDay ? p(d.getHours()) + ':' + p(d.getMinutes()) : d.getMonth() + 1 + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB'
}

function renderRoots() {
  const box = $('roots')
  box.replaceChildren()
  for (const r of state.roots) {
    const b = document.createElement('button')
    b.textContent = baseName(r.path) + ' (' + r.sessionCount + ')'
    b.title = r.path
    b.onclick = () => {
      $('path').value = r.path
      state.path = r.path
      refresh()
    }
    box.append(b)
  }
}

/** 프로젝트(루트)별로 묶어서 그린다. 쭉 이어붙이면 어느 프로젝트 것인지 분간이 안 된다. */
function renderList() {
  const list = $('list')
  list.replaceChildren()

  const groups = new Map()
  for (const s of state.sessions) {
    const key = s.cwd || s.encodedDir
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }

  for (const [path, items] of groups) {
    // 검색 중에는 결과가 보여야 하므로 자동으로 펼친다.
    const open = state.expanded.has(path) || Boolean(state.q)
    const closed = !open
    const g = document.createElement('div')
    g.className = 'group' + (closed ? ' closed' : '')

    const head = document.createElement('div')
    head.className = 'head'
    head.title = path
    const caret = document.createElement('span')
    caret.className = 'caret'
    caret.textContent = closed ? '▸' : '▾'
    const parts = path.split(SEP_RE).filter(Boolean)
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = parts[parts.length - 1] || path
    // 마지막 조각만으론 모호한 경우가 있다(myapp\web -> "web"). 상위 폴더를 옆에 붙인다.
    const par = document.createElement('span')
    par.className = 'par'
    par.textContent = parts.length > 1 ? parts[parts.length - 2] : ''
    const n = document.createElement('span')
    n.className = 'n'
    n.textContent = items.length
    head.append(caret, nm, par, n)
    head.onclick = () => {
      if (open) state.expanded.delete(path)
      else state.expanded.add(path)
      renderList()
    }
    g.append(head)

    const box = document.createElement('div')
    box.className = 'items'
    for (const s of items) {
      const el = document.createElement('div')
      el.className = 'item' + (state.tabs.some((t) => t.sessionId === s.id) ? ' open' : '')
      const t = document.createElement('div')
      t.className = 't'
      t.textContent = s.title
      const m = document.createElement('div')
      m.className = 'm'
      m.textContent = fmtTime(s.updatedAt) + '  ·  ' + fmtSize(s.bytes) + (s.gitBranch ? '  ·  ' + s.gitBranch : '')
      if (s.recentlyActive) {
        const live = document.createElement('span')
        live.className = 'live'
        live.textContent = '● 진행 중'
        live.title = '방금 갱신된 세션입니다. 터미널 등 다른 곳에서 쓰고 있을 수 있습니다.'
        m.append(' ', live)
      }
      const pen = document.createElement('button')
      pen.className = 'pen'
      pen.textContent = '✎'
      pen.title = s.renamed ? '이름 바꾸기 (원래: ' + s.originalTitle + ')' : '이름 바꾸기'
      pen.onclick = (e) => {
        e.stopPropagation()
        renameSession(s.id, s.title)
      }
      t.append(pen)

      el.append(t, m)
      el.title = s.preview || s.title
      el.onclick = () => openSession(s)
      box.append(el)
    }
    g.append(box)
    list.append(g)
  }

  $('count').textContent = groups.size + '개 프로젝트 · ' + state.sessions.length + '개 세션'
}

/**
 * 대화 이름 바꾸기.
 * 기록 파일에는 쓰지 않는다 — CLI 가 쥐고 있는 파일이라 끼어들면 위험하다.
 * 바꾼 이름은 ccdesk 가 따로 보관하므로 터미널 쪽 목록에는 원래 제목이 그대로 남는다.
 */
async function renameSession(sessionId, current) {
  if (!sessionId) {
    alert('아직 시작하지 않은 대화입니다. 한 번 보내고 나서 이름을 붙일 수 있습니다.')
    return
  }
  const next = prompt('대화 이름 (비우면 원래 제목으로 돌아갑니다)', current || '')
  if (next === null) return
  try {
    const data = await api('/api/sessions/' + encodeURIComponent(sessionId) + '/title', {
      method: 'PUT',
      body: JSON.stringify({ title: next }),
    })
    for (const t of state.tabs) {
      if (t.sessionId === sessionId && data.title) t.title = data.title
    }
    renderTabs()
    await refresh()
  } catch (e) {
    alert('이름을 바꾸지 못했습니다: ' + e.message)
  }
}

// ── 탭 ────────────────────────────────────────────────────────────

function renderTabs() {
  const bar = $('tabs')
  bar.replaceChildren()
  for (const tab of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (tab === state.active ? ' active' : '')
    if (tab.unread && tab !== state.active) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      el.append(dot)
    }
    const label = document.createElement('span')
    label.textContent = tab.title
    label.style.overflow = 'hidden'
    label.style.textOverflow = 'ellipsis'
    el.append(label)
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '×'
    x.onclick = (e) => {
      e.stopPropagation()
      closeTab(tab)
    }
    el.append(x)
    el.onclick = () => activate(tab)
    el.ondblclick = (e) => {
      e.preventDefault()
      renameSession(tab.sessionId, tab.title)
    }
    el.title = (tab.cwd || '') + '\n두 번 누르면 이름을 바꿉니다'
    bar.append(el)
  }
}

function activate(tab) {
  if (state.active) state.active.draft = $('input').value
  state.active = tab
  for (const t of state.tabs) t.el.hidden = t !== tab
  $('empty').hidden = Boolean(tab)
  $('composer').hidden = !tab || tab.readonly === true
  $('sheet').hidden = true
  renderReadonlyBar(tab)
  renderRunInfo()
  if (!tab) {
    $('queue').hidden = true
    $('askbar').hidden = true
  }
  if (tab) {
    tab.unread = false
    $('input').value = tab.draft || ''
    renderAttach()
    renderQueue()
    renderAsks()
    autosize()
    if (!tab.readonly) $('input').focus()
    markClamped(tab)
  }
  renderTabs()
  renderList()
}

/** 입력칸을 내용에 맞춰 늘린다. 고정 높이면 긴 프롬프트의 위쪽이 잘려 보인다. */
function autosize() {
  const ta = $('input')
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 340) + 'px'
}

/** 5줄을 넘는 내 프롬프트만 접힌 표시를 준다. 화면에 붙은 뒤라야 높이를 잴 수 있다. */
function markClamped(tab) {
  if (!tab || tab.el.hidden) return
  for (const b of tab.el.querySelectorAll('.msg.human .body')) {
    if (b.classList.contains('expanded')) continue
    b.classList.toggle('more', b.scrollHeight > b.clientHeight + 2)
  }
}

function closeTab(tab) {
  stopTail(tab)
  if (tab.runId) api('/api/runs/' + tab.runId, { method: 'DELETE' }).catch(() => {})
  tab.el.remove()
  state.tabs = state.tabs.filter((t) => t !== tab)
  activate(state.tabs[state.tabs.length - 1] || null)
  renderList()
}

function newTab({ sessionId, cwd, title }) {
  const el = document.createElement('div')
  el.className = 'pane'
  el.hidden = true
  $('panes').append(el)
  const tab = {
    id: Math.random().toString(36).slice(2),
    sessionId, cwd, title,
    runId: null, messages: [], cursor: null, hasMore: false,
    follow: true, draft: '', unread: false, busy: false, el,
    images: [], // 보낼 때 함께 실을 그림
    offset: 0, // 기록 파일에서 여기까지 읽었다
    readonly: false, // 다른 곳에서 쓰는 중이면 읽기만 한다
    timer: null,
    settings: loadDefaults(), // 모델·권한·허용도구·추가폴더. 프로세스가 뜰 때 박힌다
    nodes: new Map(), // 메시지 id -> 그려둔 DOM. 바뀐 것만 다시 그리려고 들고 있다
    openTools: new Set(), // 펼쳐둔 도구 블록 id
    queue: [], // 답을 기다리는 동안 미리 쳐둔 것
    interrupted: false, // 사용자가 끊었으면 대기줄을 자동으로 내보내지 않는다
    startedAt: 0, // 지금 턴을 언제 보냈나 (구동 시간 표시용)
    stats: { turns: 0, costUsd: 0, durationMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    asks: [], // 답을 기다리는 도구 승인 물음
    limits: null, // 구독 한도 (rate_limit_event)
    apiKeySource: null, // "none" 이면 구독으로 도는 중이다
  }
  // 위로 굴리면 따라가기를 멈춘다. 이건 사용자가 한 것이 확실하다.
  el.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) tab.follow = false
  })
  // 바닥에 닿으면 다시 따라간다. 우리가 내린 스크롤도 여기로 떨어지므로 그대로 유지된다.
  el.addEventListener('scroll', () => {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) tab.follow = true
  })
  state.tabs.push(tab)
  activate(tab)
  return tab
}

async function openSession(s) {
  // R5: 이미 열려 있으면 그 탭으로.
  const open = state.tabs.find((t) => t.sessionId === s.id)
  if (open) return activate(open)
  const tab = newTab({ sessionId: s.id, cwd: s.cwd, title: s.title })
  await loadMessages(tab, null)
}

async function loadMessages(tab, before) {
  try {
    const p = new URLSearchParams({ limit: '40' })
    if (before != null) p.set('before', String(before))
    const data = await api('/api/sessions/' + encodeURIComponent(tab.sessionId) + '/messages?' + p)
    tab.messages = before == null ? data.messages : data.messages.concat(tab.messages)
    tab.cursor = data.cursor
    tab.hasMore = data.hasMore
    if (before == null) {
      tab.follow = true
      tab.offset = data.size
      // 다른 곳에서 쓰고 있는 것 같으면 보기 전용으로 연다.
      // 한 기록 파일에 두 프로세스가 붙으면 서로의 작업을 덮는다(DESIGN 9.3).
      tab.readonly = Boolean(data.recentlyActive)
      if (tab === state.active) {
        $('composer').hidden = tab.readonly
        renderReadonlyBar(tab)
      }
      // 따라 읽기는 **항상** 켠다. "열 때 마침 활동 중이었나"로 정하면,
      // 조용한 틈에 연 탭은 영영 갱신되지 않는다.
      startTail(tab)
    }
    render(tab, before != null)
  } catch (e) {
    tab.messages.push({ id: 'e', role: 'notice', blocks: [{ type: 'notice', level: 'error', text: e.message }] })
    render(tab)
  }
}

/**
 * 도구 승인 카드. 답하기 전에는 대화가 멈춰 있으므로 눈에 띄는 자리에 둔다.
 * 답을 보내면 서버가 붙들고 있던 MCP 쪽 응답을 그제야 돌려준다.
 */
function renderAsks() {
  const box = $('askbar')
  const tab = state.active
  const list = tab ? tab.asks : []
  box.replaceChildren()
  box.hidden = !list.length
  if (box.hidden) return

  for (const ask of list) {
    const card = document.createElement('div')
    card.className = 'ask'

    const head = document.createElement('div')
    head.className = 'ask-head'
    head.textContent = '승인이 필요합니다 — ' + ask.toolName
    card.append(head)

    const pre = document.createElement('pre')
    pre.className = 'code'
    pre.textContent = JSON.stringify(ask.input, null, 2)
    card.append(pre)

    const foot = document.createElement('div')
    foot.className = 'ask-foot'
    const allow = document.createElement('button')
    allow.className = 'ok'
    allow.textContent = '허용'
    allow.onclick = () => answerAsk(tab, ask, 'allow')
    const deny = document.createElement('button')
    deny.textContent = '거부'
    deny.onclick = () => answerAsk(tab, ask, 'deny')
    foot.append(allow, deny)
    card.append(foot)

    box.append(card)
  }
}

async function answerAsk(tab, ask, behavior) {
  tab.asks = tab.asks.filter((a) => a.id !== ask.id)
  renderAsks()
  try {
    await api('/api/asks/' + encodeURIComponent(ask.id) + '/answer', {
      method: 'POST',
      body: JSON.stringify({ behavior, message: behavior === 'deny' ? '사용자가 거부했습니다' : undefined }),
    })
  } catch (e) {
    tab.messages.push({ id: 'e' + Date.now(), role: 'notice', blocks: [{ type: 'notice', level: 'error', text: '답을 보내지 못했습니다: ' + e.message }] })
    render(tab)
  }
}

/** 보기 전용 안내는 입력창 자리에 둔다. 본문 맨 위에 두면 스크롤 아래에선 안 보인다. */
function renderReadonlyBar(tab) {
  const bar = $('robar')
  bar.replaceChildren()
  bar.hidden = !tab || !tab.readonly
  if (bar.hidden) return
  const txt = document.createElement('span')
  txt.textContent = '다른 곳에서 쓰고 있는 대화입니다. 새 내용을 따라 읽기만 합니다.'
  const btn = document.createElement('button')
  btn.textContent = '그래도 이어가기'
  btn.title = '한 기록 파일에 두 프로세스가 붙습니다.'
  btn.onclick = () => {
    if (confirm('터미널 등 다른 곳에서 같은 대화를 쓰고 있을 수 있습니다.\n동시에 붙으면 서로의 작업을 덮어쓸 수 있습니다.\n그래도 이어가시겠습니까?')) {
      allowWriting(tab)
    }
  }
  bar.append(txt, btn)
}

/** 다른 곳에서 진행 중인 대화를 읽기만 하며 따라간다. 우리는 아무것도 쓰지 않는다. */
/**
 * 기록 파일 뒤에 붙는 줄을 따라 읽는다. 읽기만 한다.
 * 우리가 이 탭에서 직접 대화를 시작하면(runId 가 생기면) SSE 가 맡으므로 쉰다 — 안 그러면 두 번 들어온다.
 */
function startTail(tab) {
  if (tab.timer) return
  tab.timer = setInterval(async () => {
    if (tab.runId || !tab.sessionId) return
    try {
      const data = await api('/api/sessions/' + encodeURIComponent(tab.sessionId) + '/messages?after=' + tab.offset)
      if (!data.records || !data.records.length) return
      tab.offset = data.offset
      appendHistory(tab.messages, data.records)
      scheduleRender(tab)
    } catch {
      /* 파일이 사라졌거나 서버가 멎었다. 다음 회차에 다시 시도한다. */
    }
  }, 3000)
}

function stopTail(tab) {
  if (tab.timer) clearInterval(tab.timer)
  tab.timer = null
}

/** 보기 전용을 풀고 입력창을 되살린다. 따라 읽기는 그대로 둔다 — 보낼 때 알아서 쉰다. */
function allowWriting(tab) {
  tab.readonly = false
  if (tab === state.active) {
    $('composer').hidden = false
    renderReadonlyBar(tab)
    renderRunInfo()
    $('input').focus()
  }
}

function newChatCwd() {
  if (state.path) return state.path
  if (state.active && state.active.cwd) return state.active.cwd
  const s = state.sessions.find((x) => x.cwd)
  return s ? s.cwd : ''
}

// ── 렌더 ──────────────────────────────────────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c])

// 이 셋으로 시작하면 문단이 아니라 블록이다.
const FENCE_RE = /^\s*```/
const HEAD_RE = /^\s*(#{1,6})\s+(.*)$/
const QUOTE_RE = /^\s*>\s?/
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const ROW_RE = /^\s*\|.*\|\s*$/
const DIV_RE = /^\s*\|[\s:|-]+\|\s*$/

function isBlockStart(l) {
  return FENCE_RE.test(l) || HEAD_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || HR_RE.test(l) || ROW_RE.test(l)
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
}

/** 링크는 우리가 아는 것만 연다. javascript: 같은 것을 막는다. */
function safeHref(h) {
  return /^(https?:\/\/|mailto:|#|\/)/i.test(h.trim())
}

/**
 * R7: 이스케이프가 먼저다. 그 다음에만 우리가 만든 태그를 넣는다.
 * 인라인 코드는 먼저 빼내 둔다 — 그 안의 별표나 대괄호를 문법으로 오해하면 안 된다.
 */
function inline(t) {
  let s = esc(t)
  const codes = []
  const MARK = String.fromCharCode(0xe000)
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return MARK + (codes.length - 1) + MARK
  })
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, href) =>
      safeHref(href) ? '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + (txt || href) + '</a>' : m
    )
  s = s.replace(new RegExp(MARK + '([0-9]+)' + MARK, 'g'), (_, n) => '<code class="inline">' + codes[n] + '</code>')
  return s.replace(/\n/g, '<br>')
}

/** 의존성 없이 직접 쓴 마크다운. 헤딩·목록·표·인용·코드·수평선·링크까지. */
function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (FENCE_RE.test(line)) {
      const body = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) body.push(lines[i++])
      i++ // 닫는 펜스
      out.push('<pre class="code">' + esc(body.join('\n')) + '</pre>')
      continue
    }

    // 표: 머리줄 다음에 구분줄이 와야 표로 본다
    if (ROW_RE.test(line) && i + 1 < lines.length && DIV_RE.test(lines[i + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim()
        if (/^:-+:$/.test(t)) return ' style="text-align:center"'
        if (/-+:$/.test(t)) return ' style="text-align:right"'
        return ''
      })
      i += 2
      const rows = []
      while (i < lines.length && ROW_RE.test(lines[i])) rows.push(splitRow(lines[i++]))
      let h = '<table><thead><tr>'
      head.forEach((c, k) => (h += '<th' + (align[k] || '') + '>' + inline(c.trim()) + '</th>'))
      h += '</tr></thead><tbody>'
      for (const r of rows) {
        h += '<tr>'
        r.forEach((c, k) => (h += '<td' + (align[k] || '') + '>' + inline(c.trim()) + '</td>'))
        h += '</tr>'
      }
      out.push(h + '</tbody></table>')
      continue
    }

    if (HR_RE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    const h = line.match(HEAD_RE)
    if (h) {
      const n = h[1].length
      out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>')
      i++
      continue
    }

    if (QUOTE_RE.test(line)) {
      const body = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(lines[i++].replace(QUOTE_RE, ''))
      out.push('<blockquote>' + mdToHtml(body.join('\n')) + '</blockquote>')
      continue
    }

    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items = []
      while (i < lines.length && LIST_RE.test(lines[i])) {
        let item = lines[i++].replace(LIST_RE, '')
        // 들여쓴 다음 줄은 같은 항목으로 본다
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) item += '\n' + lines[i++].trim()
        items.push('<li>' + inline(item) + '</li>')
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'))
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const para = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++])
    out.push('<p>' + inline(para.join('\n')) + '</p>')
  }

  return out.join('')
}

function toolEl(b, tab) {
  const d = document.createElement('details')
  d.className = 'tool'
  // 펼쳐둔 것은 다시 그려도 펼쳐진 채로 둔다. 탭이 기억한다.
  if (tab && tab.openTools.has(b.id)) d.open = true
  d.ontoggle = () => {
    if (!tab) return
    if (d.open) tab.openTools.add(b.id)
    else tab.openTools.delete(b.id)
  }
  const sum = document.createElement('summary')
  const arg = b.input ? JSON.stringify(b.input) : ''
  // 오류는 사유의 첫 줄까지 접힌 채로 보여준다. 접어두면 왜 막혔는지 알 수가 없다.
  const why = b.isError ? String(b.result || '').split('\n')[0].slice(0, 150) : ''
  sum.innerHTML =
    '<span class="name">' +
    esc(b.name || '도구') +
    '</span> ' +
    (b.state === 'running' ? '<span class="running">실행 중…</span>' : b.isError ? '<span class="err">오류</span>' : '') +
    ' <span>' +
    esc(why || (arg.length > 90 ? arg.slice(0, 90) + '…' : arg)) +
    '</span>'
  if (why) sum.querySelector('span:last-child').className = 'why'
  d.append(sum)
  const pre = document.createElement('pre')
  pre.className = 'code'
  pre.textContent = JSON.stringify(b.input, null, 2)
  d.append(pre)
  if (b.result != null) {
    const r = document.createElement('pre')
    r.className = 'code'
    r.textContent = String(b.result).slice(0, 20000)
    d.append(r)
  }
  return d
}

function msgEl(m, tab) {
  const wrap = document.createElement('div')
  wrap.className = 'msg ' + m.role
  if (m.role !== 'notice') {
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = m.role === 'human' ? '나' : 'Claude' + (m.streaming ? ' · 응답 중' : '')
    wrap.append(who)
  }
  const body = document.createElement('div')
  body.className = 'body'
  for (const b of m.blocks) {
    if (b.type === 'text') {
      const d = document.createElement('div')
      if (m.role === 'human') d.textContent = b.text
      else d.innerHTML = mdToHtml(b.text)
      body.append(d)
    } else if (b.type === 'thinking') {
      const d = document.createElement('div')
      d.className = 'think'
      d.textContent = b.text
      body.append(d)
    } else if (b.type === 'tool') {
      body.append(toolEl(b, tab))
    } else if (b.type === 'image') {
      const img = document.createElement('img')
      img.className = 'shot'
      img.src = 'data:' + (b.mediaType || 'image/png') + ';base64,' + b.data
      img.onclick = (e) => {
        e.stopPropagation()
        img.classList.toggle('big')
      }
      body.append(img)
    } else if (b.type === 'notice') {
      const d = document.createElement('div')
      d.className = 'notice ' + b.level
      d.textContent = b.text
      body.append(d)
    }
  }
  if (m.role === 'human') {
    body.title = '누르면 펼쳐집니다'
    body.onclick = () => {
      body.classList.toggle('expanded')
      body.classList.remove('more')
    }
  }
  wrap.append(body)
  if (m.meta && m.meta.costUsd != null) {
    const u = m.meta.usage || {}
    const bits = ['$' + Number(m.meta.costUsd).toFixed(4), fmtDur(m.meta.durationMs)]
    if (m.meta.numTurns) bits.push(m.meta.numTurns + '턴')
    if (u.input_tokens != null) bits.push('입력 ' + fmtTok(u.input_tokens))
    if (u.output_tokens != null) bits.push('출력 ' + fmtTok(u.output_tokens))
    const cache = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    if (cache) bits.push('캐시 ' + fmtTok(cache))
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = bits.join(' · ')
    meta.title = usageDetail(u)
    wrap.append(meta)
  }
  return wrap
}

const pending = new Set()
function scheduleRender(tab) {
  if (pending.has(tab)) return
  pending.add(tab)
  requestAnimationFrame(() => {
    pending.delete(tab)
    render(tab)
  })
}

/**
 * 메시지가 바뀌었는지 싸게 알아보는 값.
 * 흘러오는 중에는 글이 길어지고, 끝나면 streaming 이 꺼지므로 둘 다 여기서 잡힌다.
 */
function msgVersion(m) {
  let s = m.role + (m.streaming ? '~' : '') + (m.meta ? 'M' : '') + m.blocks.length
  for (const b of m.blocks) {
    if (b.type === 'text' || b.type === 'thinking' || b.type === 'notice') s += '|' + b.type + (b.text || '').length
    else if (b.type === 'tool') s += '|t' + b.id + b.state + (b.isError ? 'E' : '') + (b.result ? b.result.length : -1)
    else if (b.type === 'image') s += '|i' + (b.data ? b.data.length : 0)
  }
  return s
}

/**
 * 바뀐 메시지만 다시 그린다.
 *
 * 예전에는 이벤트가 올 때마다 전체를 지웠다 다시 그렸는데, 그러면
 *  - 펼쳐둔 도구 블록이 도로 닫히고
 *  - 스크롤 위치가 조금씩 어긋나다 결국 맨 위로 올라간다.
 * 그래서 id 로 대응시켜 놔두고, 달라진 것만 갈아끼운다.
 */
function render(tab, keepScroll) {
  const el = tab.el
  const prevH = el.scrollHeight
  const prevTop = el.scrollTop

  if (!tab.nodes) tab.nodes = new Map()

  // 맨 위 "더 불러오기" 버튼
  let head = el.firstElementChild && el.firstElementChild.classList.contains('more') ? el.firstElementChild : null
  if (tab.hasMore && !head) {
    head = document.createElement('button')
    head.className = 'more'
    head.textContent = '위로 더 불러오기'
    head.onclick = () => {
      tab.follow = false
      loadMessages(tab, tab.cursor)
    }
    el.prepend(head)
  } else if (!tab.hasMore && head) {
    head.remove()
    head = null
  }

  const seen = new Set()
  let anchor = head // 이 노드 다음에 순서대로 놓는다
  for (const m of tab.messages) {
    seen.add(m.id)
    const ver = msgVersion(m)
    let rec = tab.nodes.get(m.id)
    if (!rec || rec.ver !== ver) {
      const node = msgEl(m, tab)
      if (rec) rec.node.replaceWith(node)
      rec = { node, ver }
      tab.nodes.set(m.id, rec)
    }
    // 순서가 어긋난 것만 옮긴다(대개는 그대로다).
    const want = anchor ? anchor.nextSibling : el.firstChild
    if (rec.node !== want) el.insertBefore(rec.node, want)
    anchor = rec.node
  }
  for (const [id, rec] of tab.nodes) {
    if (!seen.has(id)) {
      rec.node.remove()
      tab.nodes.delete(id)
    }
  }

  if (keepScroll) {
    el.scrollTop = prevTop + (el.scrollHeight - prevH)
  } else if (tab.follow) {
    el.scrollTop = el.scrollHeight
  }
  // 그 밖에는 건드리지 않는다. 안 건드리는 게 안 어긋나는 유일한 방법이다.

  markClamped(tab)
}

// ── 보내기 ────────────────────────────────────────────────────────

async function ensureRun(tab) {
  if (tab.runId) return tab.runId
  // 따라 읽기 지점을 파일 끝으로 당겨둔다. 안 그러면 SSE 로 받은 턴을
  // 나중에 기록에서 또 읽어와 같은 말이 두 번 쌓인다.
  if (tab.sessionId) {
    try {
      const t = await api('/api/sessions/' + encodeURIComponent(tab.sessionId) + '/messages?after=' + tab.offset)
      tab.offset = t.offset
    } catch {
      /* 못 당겨도 정규화 쪽에서 걸러진다 */
    }
  }
  const s = tab.settings
  const data = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      cwd: tab.cwd,
      sessionId: tab.sessionId,
      permissionMode: s.permissionMode,
      model: s.model || null,
      allowedTools: s.allowedTools,
      addDirs: s.addDirs,
      askUser: Boolean(s.askUser),
    }),
  })
  tab.runId = data.runId
  tab.sessionId = data.sessionId
  // 서버가 걸러낸 뒤의 실제 값으로 맞춘다. 버려진 폴더가 있으면 화면에도 반영된다.
  tab.settings = {
    model: data.model || '',
    permissionMode: data.permissionMode,
    allowedTools: data.allowedTools || [],
    addDirs: data.addDirs || [],
    askUser: Boolean(data.askUser),
  }
  renderRunInfo()
  return tab.runId
}

// ── 설정 ──────────────────────────────────────────────────────────

const DEFAULTS_KEY = 'ccdesk.defaults'
const BLANK_SETTINGS = { model: '', permissionMode: 'acceptEdits', allowedTools: [], addDirs: [], askUser: false }

function loadDefaults() {
  try {
    return { ...BLANK_SETTINGS, ...JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}') }
  } catch {
    return { ...BLANK_SETTINGS }
  }
}

function saveDefaults(s) {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(s))
  } catch {
    /* 저장 못 해도 이번 판은 돌아간다 */
  }
}

const MODEL_NAMES = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
}

/** 지금 어떤 설정으로 붙어 있는지 입력창 위에 한 줄로. */
/** 1234 -> 1.2k, 45678 -> 45.7k. 자릿수를 세지 않아도 크기가 보이게. */
function fmtTok(n) {
  const v = Number(n) || 0
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
  return String(v)
}

function fmtDur(ms) {
  const s = (Number(ms) || 0) / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  return m + '분 ' + Math.round(s - m * 60) + '초'
}

function usageDetail(u) {
  if (!u) return ''
  return [
    '입력 ' + (u.input_tokens || 0).toLocaleString(),
    '출력 ' + (u.output_tokens || 0).toLocaleString(),
    '캐시 생성 ' + (u.cache_creation_input_tokens || 0).toLocaleString(),
    '캐시 읽기 ' + (u.cache_read_input_tokens || 0).toLocaleString(),
  ].join('\n')
}

/** 턴이 끝날 때마다 이 탭의 누계에 더한다. */
function addStats(tab, ev) {
  const st = tab.stats
  const u = ev.usage || {}
  st.turns += 1
  st.costUsd += Number(ev.total_cost_usd) || 0
  st.durationMs += Number(ev.duration_ms) || 0
  st.input += u.input_tokens || 0
  st.output += u.output_tokens || 0
  st.cacheRead += u.cache_read_input_tokens || 0
  st.cacheWrite += u.cache_creation_input_tokens || 0
}

function renderRunInfo() {
  const el = $('runinfo')
  const tab = state.active
  el.hidden = !tab || tab.readonly
  if (el.hidden) return
  el.replaceChildren()

  const dot = document.createElement('span')
  if (tab.busy && tab.startedAt) {
    dot.className = 'run'
    dot.textContent = '● 응답 중 ' + fmtDur(Date.now() - tab.startedAt)
  } else {
    dot.className = tab.runId ? 'on' : 'off'
    dot.textContent = tab.runId ? '● 붙어 있음' : '○ 아직 안 붙음'
  }
  el.append(dot)

  // 이 탭에서 지금까지 쓴 것
  const st = tab.stats
  if (st.turns) {
    const tot = document.createElement('span')
    const tokens = st.input + st.output + st.cacheWrite
    tot.textContent = '· ' + st.turns + '턴 · ' + fmtDur(st.durationMs) + ' · 토큰 ' + fmtTok(tokens)
    tot.title = [
      '이 창에서 이 대화에 쓴 누계',
      '입력 ' + st.input.toLocaleString(),
      '출력 ' + st.output.toLocaleString(),
      '캐시 생성 ' + st.cacheWrite.toLocaleString(),
      '캐시 읽기 ' + st.cacheRead.toLocaleString() + ' (값이 싸서 합계에서 뺐습니다)',
    ].join('\n')
    el.append(tot)

    // 비용 표시. 구독이면 청구되는 돈이 아니라 API 환산값이다 — 그렇게 적는다.
    const sub = tab.apiKeySource === 'none'
    const cost = document.createElement('span')
    cost.className = sub ? 'est' : ''
    cost.textContent = '· ' + (sub ? 'API 환산 ' : '') + '$' + st.costUsd.toFixed(4)
    cost.title = sub
      ? '구독으로 쓰고 있어 실제로 청구되는 금액이 아닙니다.\n같은 사용량을 API 로 했을 때의 값입니다.\n구독에서 실제로 닳는 것은 아래 한도입니다.'
      : 'API 키로 쓰고 있어 실제 청구에 가깝습니다.'
    el.append(cost)
  }

  // 구독 한도 — 구독 사용자에게는 이게 진짜 잔량이다
  const rl = tab.limits && tab.limits.unifiedWindows
  if (rl) {
    const pct = (w) => (w && w.utilization != null ? Math.round(w.utilization * 100) + '%' : '?')
    const when = (w) => (w && w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : '?')
    const lim = document.createElement('span')
    const five = rl.five_hour
    const week = rl.seven_day
    lim.className = Math.max(five?.utilization || 0, week?.utilization || 0) > 0.8 ? 'risk' : ''
    lim.textContent = '· 한도 5시간 ' + pct(five) + ' · 7일 ' + pct(week)
    lim.title = ['5시간 창 초기화: ' + when(five), '7일 창 초기화: ' + when(week), '상태: ' + (tab.limits.status || '?')].join('\n')
    el.append(lim)
  }

  const s = tab.settings
  const mode = document.createElement('span')
  mode.className = s.permissionMode === 'bypassPermissions' ? 'risk' : ''
  mode.textContent = '· ' + s.permissionMode
  el.append(mode)

  const model = document.createElement('span')
  model.textContent = '· ' + (s.model ? MODEL_NAMES[s.model] || s.model : '기본 모델')
  el.append(model)

  if (s.addDirs.length) {
    const d = document.createElement('span')
    d.textContent = '· 추가 폴더 ' + s.addDirs.length
    d.title = s.addDirs.join('\n')
    el.append(d)
  }
}

/** 서로 무효로 만드는 설정 조합을 그 자리에서 알려준다. 안 그러면 켜놓고 안 된다고 여긴다. */
function updateSheetNote() {
  const asking = $('setAsk').checked
  const mode = $('setMode').value
  const el = $('setNote')
  if (asking && mode === 'bypassPermissions') {
    el.textContent = '전체허용은 전부 미리 허용하는 모드라 물어볼 일이 없습니다. 물어보게 하려면 기본이나 편집허용을 고르세요.'
  } else if (asking && mode === 'plan') {
    el.textContent = '읽기전용은 편집·실행을 아예 안 하므로 물어볼 일이 거의 없습니다.'
  } else if (!asking && mode !== 'bypassPermissions') {
    el.textContent = '승인을 안 물어보므로, 승인이 필요한 도구는 되묻지 않고 거부됩니다.'
  } else {
    el.textContent = ''
  }
}

function openSheet() {
  const tab = state.active
  if (!tab) return
  const s = tab.settings
  const known = Object.prototype.hasOwnProperty.call(MODEL_NAMES, s.model)
  $('setModel').value = s.model === '' ? '' : known ? s.model : '__custom'
  $('setModelCustom').hidden = $('setModel').value !== '__custom'
  $('setModelCustom').value = known ? '' : s.model
  $('setMode').value = s.permissionMode
  $('setTools').value = s.allowedTools.join(',')
  $('setDirs').value = s.addDirs.join('\n')
  $('setAsk').checked = Boolean(s.askUser)
  $('setState').textContent = tab.runId
    ? '이미 붙어 있습니다 — 적용하면 프로세스를 다시 띄웁니다 (맥락은 이어집니다)'
    : '아직 안 붙었습니다 — 첫 전송 때 이 설정으로 뜹니다'
  updateSheetNote()
  $('sheet').hidden = false
}

async function applySheet() {
  const tab = state.active
  if (!tab) return
  const pick = $('setModel').value
  const model = pick === '__custom' ? $('setModelCustom').value.trim() : pick

  tab.settings = {
    model,
    permissionMode: $('setMode').value,
    allowedTools: $('setTools').value.split(',').map((x) => x.trim()).filter(Boolean),
    addDirs: $('setDirs').value.split('\n').map((x) => x.trim()).filter(Boolean),
    askUser: $('setAsk').checked,
  }
  if ($('setDefault').checked) saveDefaults(tab.settings)

  // 권한·모델은 프로세스가 뜰 때 박힌다. 붙어 있으면 떼어내고, 다음 전송 때 새 설정으로 붙는다.
  if (tab.runId) {
    const old = tab.runId
    tab.runId = null
    try {
      await api('/api/runs/' + old, { method: 'DELETE' })
    } catch {
      /* 이미 없어졌으면 그만이다 */
    }
    tab.messages.push({
      id: 'n' + Date.now(),
      role: 'notice',
      blocks: [{ type: 'notice', level: 'info', text: '설정을 바꿨습니다. 다음 전송 때 새 설정으로 다시 붙습니다 — 대화는 이어집니다.' }],
    })
    render(tab)
  }
  renderRunInfo()
  $('sheet').hidden = true
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 붙인 그림의 미리보기. 탭마다 따로 들고 있다. */
function renderAttach() {
  const box = $('attach')
  const tab = state.active
  const pics = tab ? tab.images : []
  box.replaceChildren()
  box.hidden = !pics.length
  pics.forEach((im, i) => {
    const d = document.createElement('div')
    d.className = 'thumb'
    const img = document.createElement('img')
    img.src = 'data:' + im.media_type + ';base64,' + im.data
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = '떼어내기'
    x.onclick = () => {
      tab.images.splice(i, 1)
      renderAttach()
    }
    d.append(img, x)
    box.append(d)
  })
}

async function addFiles(files) {
  const tab = state.active
  if (!tab || tab.readonly) return
  for (const f of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) continue
    if (f.size > MAX_IMAGE_BYTES) {
      alert((f.name || '그림') + ' 은 5MB 를 넘어 붙이지 않았습니다.')
      continue
    }
    const data = await new Promise((ok) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result).split(',')[1])
      r.readAsDataURL(f)
    })
    tab.images.push({ media_type: f.type, data })
  }
  renderAttach()
}

async function send() {
  const tab = state.active
  if (!tab || tab.readonly) return
  const text = $('input').value
  const imgs = tab.images.slice()
  if (!text.trim() && !imgs.length) return

  const clearInput = () => {
    $('input').value = ''
    tab.draft = ''
    tab.images = []
    renderAttach()
    autosize()
  }

  // 답을 기다리는 중이면 줄을 세운다. 지금 것이 끝나면 차례로 나간다.
  if (tab.busy) {
    tab.queue.push({ text, images: imgs })
    clearInput()
    renderQueue()
    return
  }

  clearInput()
  deliver(tab, text, imgs)
}

async function deliver(tab, text, imgs) {
  tab.messages.push({
    id: 'u' + Date.now(),
    role: 'human',
    ts: new Date().toISOString(),
    blocks: [
      ...imgs.map((im) => ({ type: 'image', mediaType: im.media_type, data: im.data })),
      ...(text.trim() ? [{ type: 'text', text }] : []),
    ],
  })
  tab.follow = true
  tab.busy = true
  tab.startedAt = Date.now()
  render(tab)
  try {
    await ensureRun(tab)
    await api('/api/runs/' + tab.runId + '/send', { method: 'POST', body: JSON.stringify({ text, images: imgs }) })
  } catch (e) {
    tab.busy = false
    tab.messages.push({ id: 'e' + Date.now(), role: 'notice', blocks: [{ type: 'notice', level: 'error', text: e.message }] })
    render(tab)
    // 줄 서 있던 것은 그대로 둔다. 같은 이유로 또 실패할 테니 사용자가 보고 정하게 한다.
    renderQueue()
  }
}

/** 앞 턴이 끝나면 줄 선 것 하나를 내보낸다. */
function flushQueue(tab) {
  if (tab.busy || !tab.queue.length) return
  const next = tab.queue.shift()
  renderQueue()
  deliver(tab, next.text, next.images)
}

/** 대기 중인 것들. 누르면 입력칸으로 되돌려 고칠 수 있다. */
function renderQueue() {
  const box = $('queue')
  const tab = state.active
  const q = tab ? tab.queue : []
  box.replaceChildren()
  box.hidden = !q.length || Boolean(tab && tab.readonly)
  if (box.hidden) return

  const head = document.createElement('div')
  head.className = 'qhead'
  head.textContent = '대기 중 ' + q.length + '개 · 누르면 다시 고칠 수 있습니다'
  box.append(head)

  q.forEach((item, i) => {
    const d = document.createElement('div')
    d.className = 'qitem'
    const t = document.createElement('span')
    t.className = 'qtext'
    t.textContent = (item.images.length ? '[그림 ' + item.images.length + '] ' : '') + item.text
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = '빼기'
    x.onclick = (e) => {
      e.stopPropagation()
      tab.queue.splice(i, 1)
      renderQueue()
    }
    d.append(t, x)
    d.title = item.text
    d.onclick = () => editQueued(tab, i)
    box.append(d)
  })
}

function editQueued(tab, i) {
  const item = tab.queue.splice(i, 1)[0]
  if (!item) return
  const cur = $('input').value
  $('input').value = cur ? cur + '\n' + item.text : item.text
  tab.images = tab.images.concat(item.images)
  renderAttach()
  renderQueue()
  autosize()
  $('input').focus()
}

// ── 배선 ──────────────────────────────────────────────────────────

for (const r of document.querySelectorAll('input[name=scope]')) {
  r.onchange = () => {
    state.scope = r.value
    $('pathField').hidden = r.value === 'all'
    refresh()
  }
}

let qTimer
$('q').oninput = (e) => {
  clearTimeout(qTimer)
  state.q = e.target.value
  qTimer = setTimeout(refresh, 180)
}

let pTimer
$('path').oninput = (e) => {
  clearTimeout(pTimer)
  state.path = e.target.value.trim()
  pTimer = setTimeout(refresh, 300)
}

$('newChat').onclick = () => {
  const cwd = newChatCwd()
  if (!cwd) {
    alert('먼저 경로를 지정하세요.')
    return
  }
  newTab({ sessionId: null, cwd, title: '새 대화' })
}

$('settingsBtn').onclick = () => {
  if ($('sheet').hidden) openSheet()
  else $('sheet').hidden = true
}
$('setClose').onclick = () => ($('sheet').hidden = true)
$('setApply').onclick = applySheet
$('setAsk').onchange = updateSheetNote
$('setMode').onchange = updateSheetNote
$('setModel').onchange = () => {
  $('setModelCustom').hidden = $('setModel').value !== '__custom'
  if (!$('setModelCustom').hidden) $('setModelCustom').focus()
}

$('send').onclick = send
$('stop').onclick = () => {
  const tab = state.active
  if (!tab || !tab.runId || !tab.busy) return
  tab.interrupted = true
  api('/api/runs/' + tab.runId + '/interrupt', { method: 'POST' }).catch((e) => {
    tab.interrupted = false
    tab.messages.push({ id: 'e' + Date.now(), role: 'notice', blocks: [{ type: 'notice', level: 'error', text: '중단하지 못했습니다: ' + e.message }] })
    render(tab)
  })
}
$('input').oninput = autosize

// 이미지 붙이기 — 붙여넣기와 끌어다 놓기. 경로를 적을 필요가 없다.
$('input').addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])]
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault()
    addFiles(files)
  }
})
const composerEl = $('composer')
composerEl.addEventListener('dragover', (e) => {
  e.preventDefault()
  composerEl.classList.add('drop')
})
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drop'))
composerEl.addEventListener('drop', (e) => {
  e.preventDefault()
  composerEl.classList.remove('drop')
  addFiles([...((e.dataTransfer && e.dataTransfer.files) || [])])
})
$('input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
window.addEventListener('resize', autosize)

// 사이드바의 권한 선택은 "새 대화 기본값"이다. 여기서 바꾸면 기본값으로 저장된다.
{
  const d = loadDefaults()
  if ([...$('mode').options].some((o) => o.value === d.permissionMode)) $('mode').value = d.permissionMode
  $('mode').onchange = () => saveDefaults({ ...loadDefaults(), permissionMode: $('mode').value })
}

// 응답 중에는 구동 시간이 흘러야 한다. 0.5초마다 그 줄만 다시 그린다.
setInterval(() => {
  const t = state.active
  if (t && t.busy && !t.readonly) renderRunInfo()
}, 500)

connect()
refresh()
autosize()
