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
    applyEvent(tab.messages, payload.ev)
    if (payload.ev.type === 'result') tab.busy = false
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
    el.title = tab.cwd || ''
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
  if (tab) {
    tab.unread = false
    $('input').value = tab.draft || ''
    renderAttach()
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
  }
  el.addEventListener('scroll', () => {
    tab.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 60
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

/** R7: 이스케이프가 먼저다. 그 다음에만 우리가 만든 태그를 넣는다. */
function inline(t) {
  const s = esc(t)
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return '<p>' + s.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
}

function mdToHtml(text) {
  const parts = String(text).split('```')
  let html = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf('\n')
      const code = nl === -1 ? parts[i] : parts[i].slice(nl + 1)
      html += '<pre class="code">' + esc(code.replace(/\n+$/, '')) + '</pre>'
    } else if (parts[i]) {
      html += inline(parts[i])
    }
  }
  return html
}

function toolEl(b) {
  const d = document.createElement('details')
  d.className = 'tool'
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

function msgEl(m) {
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
      body.append(toolEl(b))
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
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = '$' + Number(m.meta.costUsd).toFixed(4) + ' · ' + Math.round((m.meta.durationMs || 0) / 100) / 10 + 's' + (m.meta.numTurns ? ' · ' + m.meta.numTurns + '턴' : '')
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

function render(tab, keepScroll) {
  const el = tab.el
  const prevH = el.scrollHeight
  const prevTop = el.scrollTop
  el.replaceChildren()

  if (tab.hasMore) {
    const b = document.createElement('button')
    b.className = 'more'
    b.textContent = '위로 더 불러오기'
    b.onclick = () => loadMessages(tab, tab.cursor)
    el.append(b)
  }
  for (const m of tab.messages) el.append(msgEl(m))

  if (keepScroll) el.scrollTop = prevTop + (el.scrollHeight - prevH)
  else if (tab.follow) el.scrollTop = el.scrollHeight
  else el.scrollTop = prevTop

  markClamped(tab)
}

// ── 보내기 ────────────────────────────────────────────────────────

async function ensureRun(tab) {
  if (tab.runId) return tab.runId
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
  }
  renderRunInfo()
  return tab.runId
}

// ── 설정 ──────────────────────────────────────────────────────────

const DEFAULTS_KEY = 'ccdesk.defaults'
const BLANK_SETTINGS = { model: '', permissionMode: 'acceptEdits', allowedTools: [], addDirs: [] }

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
function renderRunInfo() {
  const el = $('runinfo')
  const tab = state.active
  el.hidden = !tab || tab.readonly
  if (el.hidden) return
  el.replaceChildren()

  const dot = document.createElement('span')
  dot.className = tab.runId ? 'on' : 'off'
  dot.textContent = tab.runId ? '● 붙어 있음' : '○ 아직 안 붙음'
  el.append(dot)

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
  $('setState').textContent = tab.runId
    ? '이미 붙어 있습니다 — 적용하면 프로세스를 다시 띄웁니다 (맥락은 이어집니다)'
    : '아직 안 붙었습니다 — 첫 전송 때 이 설정으로 뜹니다'
  $('setNote').textContent = ''
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
  const text = $('input').value
  const imgs = tab ? tab.images.slice() : []
  if (!tab || tab.readonly || tab.busy) return
  if (!text.trim() && !imgs.length) return
  $('input').value = ''
  autosize()
  tab.draft = ''
  tab.images = []
  renderAttach()
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
  render(tab)
  try {
    await ensureRun(tab)
    await api('/api/runs/' + tab.runId + '/send', { method: 'POST', body: JSON.stringify({ text, images: imgs }) })
  } catch (e) {
    tab.busy = false
    tab.messages.push({ id: 'e' + Date.now(), role: 'notice', blocks: [{ type: 'notice', level: 'error', text: e.message }] })
    render(tab)
  }
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
$('setModel').onchange = () => {
  $('setModelCustom').hidden = $('setModel').value !== '__custom'
  if (!$('setModelCustom').hidden) $('setModelCustom').focus()
}

$('send').onclick = send
$('stop').onclick = () => {
  const tab = state.active
  if (tab && tab.runId) api('/api/runs/' + tab.runId + '/interrupt', { method: 'POST' }).catch(() => {})
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

connect()
refresh()
autosize()
