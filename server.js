#!/usr/bin/env node
// ccdesk 로컬 서버 — 정적 파일 + API + SSE 하나.
//
// DESIGN.md 의 규칙:
//  R4 claude 프로세스는 첫 send() 에서만 뜬다. run 을 만들어도 아직 안 뜬다.
//  R5 같은 sessionId 를 두 run 에 열지 않는다.
//  R6 SSE 는 연결 하나. 모든 이벤트에 runId 를 붙인다.
//  R8 127.0.0.1 + 토큰 + Origin 검사. 아무 웹페이지나 POST /api/runs 를 쏠 수 있고,
//     그 끝은 임의 경로에서 bypassPermissions 실행이다. 응답을 못 읽어도 실행은 된다.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { scanAll, listUnderRoot, listSessions } from './lib/sessions.js'
import { readMessages, readSince } from './lib/transcript.js'
import { getTitles, setTitle, applyTitles } from './lib/titles.js'
import { normalizeHistory } from './public/normalize.js'

// 이 시간 안에 파일이 갱신됐으면 어딘가에서 쓰고 있는 중일 수 있다고 본다.
// 확실히 아는 방법은 없다 — 어디까지나 "최근 활동" 표시다.
const LIVE_WINDOW_MS = 90 * 1000
import { Run, PERMISSION_MODES, safeDir } from './lib/runner.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = resolve(ROOT, 'public')
const TOKEN = randomUUID()
const HOST = '127.0.0.1'

const runs = new Map() // runId -> { run, cwd, sessionId }
const clients = new Set() // SSE 응답들
// 도구 승인 대기소. MCP 창구(lib/mcp-ccdesk.js)가 물어오면 여기 담아두고,
// 사용자가 화면에서 누를 때까지 그 HTTP 응답을 붙들고 있는다.
const asks = new Map() // askId -> { runId, res, timer, ... }
let port = Number(process.env.CCDESK_PORT || 4317)

// ── 유틸 ──────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((ok, fail) => {
    let n = 0
    const parts = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) {
        fail(new Error('본문이 너무 큽니다'))
        req.destroy()
        return
      }
      parts.push(c)
    })
    req.on('end', () => {
      try {
        ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {})
      } catch (e) {
        fail(e)
      }
    })
    req.on('error', fail)
  })
}

/**
 * 승인 창구(lib/mcp-ccdesk.js)만 통과시키는 좁은 열쇠.
 * 마스터 토큰을 주지 않으므로, 설정 파일이 새더라도 할 수 있는 일은
 * "그 run 에 승인 물음을 띄우는 것" 하나뿐이다.
 */
function askAuthorized(req) {
  const k = req.headers['x-ccdesk-ask']
  if (!k) return null
  for (const [id, rec] of runs) if (rec.askSecret && rec.askSecret === k) return id
  return null
}

/** R8: 토큰과 Origin 을 함께 본다. 토큰은 URL 에만 있으므로 남의 페이지는 못 읽는다. */
function authorized(req, url) {
  const t = req.headers['x-ccdesk-token'] || url.searchParams.get('t')
  if (t !== TOKEN) return false
  const origin = req.headers.origin
  if (origin && origin !== 'http://' + HOST + ':' + port && origin !== 'http://localhost:' + port) return false
  return true
}

/** R6: 모든 이벤트에 runId 를 붙여 하나의 SSE 로 흘린다. */
function broadcast(runId, ev) {
  const data = 'data: ' + JSON.stringify({ runId, ev }) + '\n\n'
  for (const res of clients) {
    try {
      res.write(data)
    } catch {
      /* 끊긴 클라이언트는 close 에서 정리된다 */
    }
  }
}

/** 기다리던 승인 물음 하나를 끝낸다. 붙들고 있던 MCP 쪽 응답을 그제야 돌려준다. */
function finishAsk(askId, answer) {
  const rec = asks.get(askId)
  if (!rec) return false
  asks.delete(askId)
  clearTimeout(rec.timer)
  try {
    sendJson(rec.res, 200, answer)
  } catch {
    /* MCP 쪽이 이미 갔으면 그만이다 */
  }
  broadcast(rec.runId, { type: 'ccdesk', level: 'ask-done', askId })
  return true
}

/** run 이 사라지면 그 run 의 물음도 거부로 닫는다. 안 그러면 MCP 쪽이 영영 기다린다. */
function cancelAsksOf(runId) {
  for (const [id, rec] of [...asks]) {
    if (rec.runId !== runId) continue
    finishAsk(id, rec.kind === 'choice' ? { choice: '', message: '대화가 닫혔습니다' } : { behavior: 'deny', message: '대화가 닫혔습니다' })
  }
}

// 세션 id → 파일 경로를 찾을 때만 쓰는 짧은 캐시.
let cache = null
async function allSessions() {
  if (cache && Date.now() - cache.at < 3000) return cache.data
  const { sessions } = await scanAll({ includeScratchpad: true })
  cache = { at: Date.now(), data: sessions }
  return sessions
}

function matchQuery(s, q) {
  if (!q) return true
  const hay = (s.title + ' ' + (s.cwd || s.encodedDir) + ' ' + (s.gitBranch || '') + ' ' + s.preview).toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

/** cwd 들의 부모 폴더를 세어 자주 쓰는 루트를 제안한다. 브라우저가 절대경로를 못 주기 때문이다. */
function suggestRoots(sessions) {
  const count = new Map()
  for (const s of sessions) {
    if (!s.cwd || s.isScratchpad) continue
    const parts = s.cwd.split(/[\u005C/]/).filter(Boolean)
    for (let i = 1; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join(sep)
      count.set(p, (count.get(p) || 0) + 1)
    }
  }
  // 같은 세션 수를 담는 조상은 버린다. C:\u005CUsers(14) 와 ...\u005CGitHub(14) 가 함께 뜨는 걸 막는다.
  const kept = []
  for (const [path, n] of [...count.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (n < 2) continue
    if (kept.some((k) => k.path.startsWith(path + sep) && k.sessionCount === n)) continue
    kept.push({ path, sessionCount: n })
  }
  return kept.sort((a, b) => b.sessionCount - a.sessionCount || a.path.length - b.path.length).slice(0, 6)
}

// ── API ───────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const p = url.pathname

  if (p === '/api/scan' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') || 'all'
    const path = url.searchParams.get('path') || ''
    const q = url.searchParams.get('q') || ''
    let sessions
    if (scope === 'root' && path) sessions = (await listUnderRoot(path)).sessions
    else if (scope === 'project' && path) sessions = (await listSessions(path)).sessions
    else sessions = (await scanAll()).sessions
    const now = Date.now()
    const titles = await getTitles()
    // 이름을 먼저 입히고 나서 걸러야, 사용자가 붙인 이름으로도 검색된다.
    const named = applyTitles(sessions, titles)
    return sendJson(res, 200, {
      scope,
      path,
      sessions: named
        .filter((s) => matchQuery(s, q))
        .map((s) => ({ ...s, recentlyActive: now - Date.parse(s.mtime) < LIVE_WINDOW_MS })),
      roots: suggestRoots(await allSessions()),
      openSessionIds: [...runs.values()].map((r) => r.sessionId),
    })
  }

  // MCP 창구가 물어온다. 사용자가 누를 때까지 이 응답을 닫지 않는다.
  if (p === '/api/asks' && req.method === 'POST') {
    // 도구 인자가 클 수 있다(큰 파일을 쓰는 Write 등). 기본 1MB 로 두면
    // 큰 작업이 물어보지도 못한 채 거부된다. send 와 같은 한도로 맞춘다.
    const b = await readBody(req, 24 * 1024 * 1024)
    const askId = randomUUID()
    const wait = Math.min(Math.max(Number(b.waitMs) || 600000, 5000), 30 * 60 * 1000)
    const rec = {
      runId: req.ccdeskAskRunId || b.runId,
      kind: b.kind === 'choice' ? 'choice' : 'permission',
      // 승인용
      toolName: String(b.toolName || '(이름 없음)'),
      input: b.input ?? {},
      toolUseId: b.toolUseId || null,
      inputTruncated: Boolean(b.inputTruncated),
      // 선택용
      question: typeof b.question === 'string' ? b.question : '',
      options: Array.isArray(b.options) ? b.options.slice(0, 5) : [],
      res,
      at: Date.now(),
    }
    // 시간이 다 가면 — 승인은 거부로, 선택은 "안 고름" 으로 닫는다.
    rec.timer = setTimeout(
      () =>
        finishAsk(
          askId,
          rec.kind === 'choice'
            ? { choice: '', message: '시간이 지나 답을 받지 못했습니다' }
            : { behavior: 'deny', message: '시간이 지나 자동으로 거부했습니다' }
        ),
      wait
    )
    asks.set(askId, rec)
    broadcast(rec.runId, {
      type: 'ccdesk',
      level: 'ask',
      ask: {
        id: askId,
        kind: rec.kind,
        toolName: rec.toolName,
        input: rec.input,
        toolUseId: rec.toolUseId,
        inputTruncated: rec.inputTruncated,
        question: rec.question,
        options: rec.options,
      },
    })
    return // 응답은 finishAsk 가 보낸다
  }

  const am = p.match(/^\/api\/asks\/([^/]+)\/answer$/)
  if (am && req.method === 'POST') {
    const b = await readBody(req)
    const answer =
      typeof b.choice === 'string'
        ? { choice: b.choice, note: typeof b.note === 'string' ? b.note : undefined }
        : {
            behavior: b.behavior === 'allow' ? 'allow' : 'deny',
            updatedInput: b.updatedInput && typeof b.updatedInput === 'object' ? b.updatedInput : undefined,
            message: b.message || undefined,
          }
    const ok = finishAsk(decodeURIComponent(am[1]), answer)
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '이미 끝난 물음입니다' })
  }

  const tm = p.match(/^\/api\/sessions\/([^/]+)\/title$/)
  if (tm && req.method === 'PUT') {
    const b = await readBody(req)
    const saved = await setTitle(decodeURIComponent(tm[1]), b.title)
    cache = null // 목록 캐시를 비워 다음 조회에 바로 반영되게
    return sendJson(res, 200, { title: saved, renamed: Boolean(saved) })
  }

  const mm = p.match(/^\/api\/sessions\/([^/]+)\/messages$/)
  if (mm && req.method === 'GET') {
    const id = decodeURIComponent(mm[1])
    const s = (await allSessions()).find((x) => x.id === id)
    if (!s) return sendJson(res, 404, { error: '세션을 찾을 수 없습니다' })
    // 따라 읽기: offset 뒤에 붙은 줄만. 가공하지 않은 기록을 그대로 준다 —
    // 앞 덩어리의 tool_use 에 결과를 붙이려면 클라이언트가 자기 목록에 이어야 하기 때문이다.
    const after = url.searchParams.get('after')
    if (after != null) {
      const tail = await readSince(s.file, Number(after))
      return sendJson(res, 200, { sessionId: id, records: tail.records, offset: tail.offset, tail: true })
    }

    const before = url.searchParams.get('before')
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 40)))
    const out = await readMessages(s.file, { before: before == null ? null : Number(before), limit })
    return sendJson(res, 200, {
      sessionId: id,
      cwd: s.cwd,
      title: s.title,
      messages: normalizeHistory(out.records),
      cursor: out.cursor,
      hasMore: out.hasMore,
      size: out.size,
      recentlyActive: Date.now() - Date.parse(s.mtime) < LIVE_WINDOW_MS,
    })
  }

  if (p === '/api/runs' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.cwd || typeof b.cwd !== 'string') return sendJson(res, 400, { error: 'cwd 가 필요합니다' })
    if (!existsSync(b.cwd)) return sendJson(res, 400, { error: '경로가 없습니다: ' + b.cwd })
    // R5: 이미 열려 있으면 그 run 을 돌려준다. 한 jsonl 에 두 프로세스를 붙이지 않는다.
    if (b.sessionId) {
      for (const [id, r] of runs) {
        if (r.sessionId === b.sessionId) return sendJson(res, 200, { runId: id, sessionId: r.sessionId, existing: true })
      }
    }
    const mode = PERMISSION_MODES.includes(b.permissionMode) ? b.permissionMode : 'acceptEdits'
    // 추가 폴더는 실제로 있는 것만 넘긴다. 없는 경로를 주면 CLI 가 그냥 죽는다.
    const dirs = (Array.isArray(b.addDirs) ? b.addDirs : []).map(safeDir).filter((d) => d && existsSync(d))
    const runId = randomUUID()

    // 도구 승인을 사용자에게 물으려면 창구가 있어야 한다. CLI 는 그 창구를 MCP 도구로 받는다.
    // 창구 없이 띄우면 승인이 필요한 순간 되묻지 않고 그냥 거부된다.
    let mcpConfigPath = null
    let permissionPromptTool = null
    const askSecret = randomUUID()
    if (b.askUser || b.askChoice) {
      const cfg = {
        mcpServers: {
          ccdesk: {
            command: process.execPath,
            args: [join(ROOT, 'lib', 'mcp-ccdesk.js')],
            env: {
              CCDESK_URL: 'http://' + HOST + ':' + port,
              // ⚠️ 마스터 토큰을 넣지 않는다. 이 파일은 디스크에 남고, 토큰이 새면
              //    임의 경로에서 bypassPermissions 실행까지 열린다(R8).
              //    대신 이 run 의 승인 물음만 통과시키는 비밀값을 준다.
              CCDESK_ASK_SECRET: askSecret,
              CCDESK_RUN: runId,
              CCDESK_TOOL_APPROVE: b.askUser ? '1' : '0',
              CCDESK_TOOL_CHOICE: b.askChoice ? '1' : '0',
            },
          },
        },
      }
      mcpConfigPath = join(tmpdir(), 'ccdesk-mcp-' + runId + '.json')
      writeFileSync(mcpConfigPath, JSON.stringify(cfg), 'utf8')
      if (b.askUser) permissionPromptTool = 'mcp__ccdesk__approve'
    }

    const run = new Run({
      cwd: b.cwd,
      sessionId: b.sessionId || null,
      permissionMode: mode,
      allowedTools: Array.isArray(b.allowedTools) ? b.allowedTools : [],
      model: b.model || null,
      addDirs: dirs,
      mcpConfigPath,
      permissionPromptTool,
    })
    run.on('event', (ev) => {
      const rec = runs.get(runId)
      if (rec) rec.sessionId = run.sessionId
      // 턴이 끝났으면 아직 떠 있는 승인 물음은 의미가 없다.
      // 안 닫으면 카드가 화면에 남고 MCP 쪽은 시간이 다 갈 때까지 붙들려 있는다.
      if (ev.type === 'result') cancelAsksOf(runId)
      broadcast(runId, ev)
    })
    // R4: 여기서는 아직 프로세스가 뜨지 않는다. 첫 send() 에서 뜬다.
    runs.set(runId, { run, cwd: b.cwd, sessionId: run.sessionId, askSecret })
    // 실제로 적용된 값을 돌려준다 — 버려진 항목이 있으면 화면이 그대로 보여줄 수 있게.
    return sendJson(res, 200, {
      runId,
      sessionId: run.sessionId,
      permissionMode: run.permissionMode,
      model: run.model,
      allowedTools: run.allowedTools,
      addDirs: run.addDirs,
      askUser: Boolean(permissionPromptTool),
      askChoice: Boolean(b.askChoice),
    })
  }

  const rm = p.match(/^\/api\/runs\/([^/]+)(\/send|\/interrupt)?$/)
  if (rm) {
    const rec = runs.get(rm[1])
    if (!rec) return sendJson(res, 404, { error: 'run 을 찾을 수 없습니다' })
    if (rm[2] === '/send' && req.method === 'POST') {
      const b = await readBody(req, 24 * 1024 * 1024) // 이미지가 붙을 수 있어 넉넉히
      const images = Array.isArray(b.images) ? b.images : []
      if ((!b.text || !String(b.text).trim()) && !images.length) return sendJson(res, 400, { error: '보낼 내용이 없습니다' })
      // R3: 사용자 입력은 stdin 으로만 간다. 이미지도 base64 로 stdin 에 실린다.
      const ok = rec.run.send(String(b.text || ''), images)
      if (!ok) return sendJson(res, 409, { error: '아직 앞 턴이 끝나지 않았습니다' })
      return sendJson(res, 200, { ok: true, sessionId: rec.run.sessionId })
    }
    if (rm[2] === '/interrupt' && req.method === 'POST') {
      // 승인을 기다리느라 멈춰 있을 수 있다. 먼저 풀어줘야 중단이 먹는다.
      cancelAsksOf(rm[1])
      return sendJson(res, 200, { ok: rec.run.interrupt() })
    }
    if (!rm[2] && req.method === 'DELETE') {
      cancelAsksOf(rm[1])
      rec.run.stop()
      runs.delete(rm[1])
      return sendJson(res, 200, { ok: true })
    }
  }

  if (p === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    clients.add(res)
    const beat = setInterval(() => {
      try {
        res.write(': beat\n\n')
      } catch {
        /* 무시 — close 에서 정리된다 */
      }
    }, 15000)
    req.on('close', () => {
      clearInterval(beat)
      clients.delete(res)
    })
    return
  }

  return sendJson(res, 404, { error: '없는 API 입니다' })
}

// ── 정적 파일 ──────────────────────────────────────────────────────

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = resolve(PUBLIC, '.' + rel)
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  try {
    const buf = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(buf)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

// ── 창 띄우기 ──────────────────────────────────────────────────────

function browserCandidates() {
  const pf = process.env.ProgramFiles || ''
  const pf86 = process.env['ProgramFiles(x86)'] || ''
  const local = process.env.LOCALAPPDATA || ''
  return [
    pf && join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf86 && join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf && join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf86 && join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
}

function openWindow(target) {
  const exe = browserCandidates().find((f) => existsSync(f))
  try {
    if (exe) {
      spawn(exe, ['--app=' + target, '--window-size=1280,880'], { detached: true, stdio: 'ignore' }).unref()
      return exe
    }
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref()
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* 못 띄우면 아래에서 주소를 찍어준다 */
  }
  return null
}

// ── 시작 ──────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + port)
  try {
    if (url.pathname.startsWith('/api/')) {
      // 승인 창구는 좁은 열쇠로 들어온다. 그 밖에는 전부 마스터 토큰이 있어야 한다.
      const askRunId = url.pathname === '/api/asks' ? askAuthorized(req) : null
      if (!askRunId && !authorized(req, url)) return sendJson(res, 403, { error: '토큰이 필요합니다' })
      if (askRunId) req.ccdeskAskRunId = askRunId
      return await handleApi(req, res, url)
    }
    return await serveStatic(req, res, url)
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e && e.message) })
  }
})

// 포트가 물려 있으면 다음 포트로 넘어간다. 앞서 띄운 게 남아 있다고 못 뜨면 곤란하다.
const FIRST_PORT = port
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < FIRST_PORT + 10) {
    port += 1
    server.listen(port, HOST)
    return
  }
  if (e.code === 'EADDRINUSE') {
    console.error('포트 ' + FIRST_PORT + '~' + port + ' 가 전부 쓰이고 있습니다. CCDESK_PORT 로 다른 포트를 주세요.')
    process.exit(1)
  }
  throw e
})

// 지난번에 남은 승인 설정 파일을 치운다. 접속 정보가 담겨 있어 오래 두면 안 된다.
try {
  for (const f of readdirSync(tmpdir())) {
    if (/^ccdesk-mcp-.*\.json$/.test(f)) unlinkSync(join(tmpdir(), f))
  }
} catch {
  /* 못 지워도 계속 간다 */
}

server.listen(port, HOST, () => {
  port = server.address().port
  const target = 'http://' + HOST + ':' + port + '/?t=' + TOKEN
  const exe = process.env.CCDESK_NO_WINDOW ? null : openWindow(target)
  console.log('ccdesk  ' + target)
  console.log(exe ? '창: ' + exe : '전용 창 없이 시작했습니다 (주소를 직접 여세요)')
})

// 대화 하나에서 난 사고가 서버를 내려서는 안 된다. 다른 탭까지 통째로 끝나기 때문이다.
// 로컬 도구이므로 살아 있는 쪽이 낫다 — 다만 무슨 일이 있었는지는 남긴다.
process.on('uncaughtException', (e) => console.error('예기치 못한 오류 (계속 돕니다):', (e && e.stack) || e))
process.on('unhandledRejection', (e) => console.error('처리되지 않은 거부 (계속 돕니다):', (e && e.stack) || e))

function shutdown() {
  for (const id of [...asks.keys()]) finishAsk(id, { behavior: 'deny', message: 'ccdesk 가 종료됩니다' })
  for (const [, r] of runs) r.run.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
