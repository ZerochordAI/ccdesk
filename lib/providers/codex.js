import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { CodexAppServerClient } from './codex-client.js'

const client = new CodexAppServerClient()
const runsByThread = new Map()
const SNAPSHOT_TTL_MS = 3000
const HISTORY_TTL_MS = 3000
let sessionSnapshot = null
let sessionScan = null
const historyCache = new Map()

function iso(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString()
  if (typeof value === 'string' && value) return value
  return null
}

function textOfInput(input) {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  return input.map((x) => x?.text || '').filter(Boolean).join('\n')
}

function sessionOf(thread) {
  return {
    provider: 'codex',
    id: thread.id,
    cwd: thread.cwd || null,
    title: thread.name || thread.preview || '(제목 없음)',
    preview: thread.preview || '',
    startedAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt || thread.recencyAt || thread.createdAt) || new Date(0).toISOString(),
    gitBranch: thread.gitInfo?.branch || null,
    bytes: null,
    model: thread.model || null,
    recentlyActive: thread.status?.type === 'active',
  }
}

function itemType(item) {
  return String(item?.type || '')
}

function historyMessages(thread) {
  const messages = []
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      const type = itemType(item)
      if (type === 'userMessage' || type === 'user_message') {
        const text = textOfInput(item.content || item.input)
        if (text) messages.push({ id: item.id || `codex-user-${messages.length}`, role: 'human', ts: iso(turn.startedAt), blocks: [{ type: 'text', text }] })
      } else if (type === 'agentMessage' || type === 'agent_message') {
        const text = item.text || item.content || ''
        if (text) messages.push({ id: item.id || `codex-agent-${messages.length}`, role: 'assistant', ts: iso(turn.completedAt || turn.startedAt), blocks: [{ type: 'text', text: typeof text === 'string' ? text : textOfInput(text) }], model: thread.model || null })
      } else if (/commandExecution|fileChange|mcpToolCall|dynamicToolCall/i.test(type)) {
        let msg = [...messages].reverse().find((m) => m.role === 'assistant')
        if (!msg) {
          msg = { id: `codex-tools-${turn.id || messages.length}`, role: 'assistant', ts: iso(turn.startedAt), blocks: [], model: thread.model || null }
          messages.push(msg)
        }
        msg.blocks.push({
          type: 'tool', id: item.id || `tool-${msg.blocks.length}`, name: item.command || item.server || type,
          input: item.command || item.changes || item.arguments || item.input || {},
          result: item.aggregatedOutput || item.output || item.result || '',
          isError: item.status === 'failed', state: item.status === 'inProgress' ? 'running' : 'done',
        })
      }
    }
  }
  return messages
}

async function allCodexSessions() {
  if (sessionSnapshot && Date.now() - sessionSnapshot.at < SNAPSHOT_TTL_MS) return sessionSnapshot.sessions
  if (sessionScan) return sessionScan
  sessionScan = (async () => {
    const sessions = []
    let cursor = null
    do {
      const params = {
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
      }
      if (cursor) params.cursor = cursor
      const result = await client.request('thread/list', params)
      sessions.push(...(result.data || []).map(sessionOf))
      cursor = result.nextCursor || null
    } while (cursor && sessions.length < 1000)
    sessionSnapshot = { at: Date.now(), sessions }
    return sessions
  })().finally(() => { sessionScan = null })
  return sessionScan
}

function matches(session, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [session.title, session.preview, session.cwd, session.gitBranch].filter(Boolean).join(' ').toLowerCase()
  return words.every((word) => hay.includes(word))
}

client.on('notification', ({ method, params }) => {
  const run = runsByThread.get(params?.threadId)
  if (run) run.handleNotification(method, params)
})
client.on('request', (message) => {
  const run = runsByThread.get(message.params?.threadId)
  if (run) run.handleRequest(message)
  else client.respond(message.id, { decision: 'decline' })
})
client.on('exit', (error) => {
  for (const run of runsByThread.values()) run.handleExit(error)
  runsByThread.clear()
})

export class CodexRun extends EventEmitter {
  constructor({ cwd, sessionId = null, settings = {} }) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId
    this.settings = settings
    this.busy = false
    this.turnId = null
    this.readyPromise = null
    this.stopped = false
    this.pendingApprovals = new Map()
  }

  async ready() {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.#ready()
    return this.readyPromise
  }

  async #ready() {
    const access = this.settings.access || 'workspaceWrite'
    const sandbox = access === 'readOnly' ? 'read-only' : access === 'fullAccess' ? 'danger-full-access' : 'workspace-write'
    const approvalPolicy = this.settings.approvalPolicy || (access === 'fullAccess' || access === 'readOnly' ? 'never' : 'on-request')
    const params = { cwd: this.cwd, sandbox, approvalPolicy }
    if (!this.sessionId && this.settings.ephemeral) params.ephemeral = true
    if (this.settings.model) params.model = this.settings.model
    const result = this.sessionId
      ? await client.request('thread/resume', { ...params, threadId: this.sessionId })
      : await client.request('thread/start', params)
    this.sessionId = result.thread.id
    runsByThread.set(this.sessionId, this)
    return this
  }

  async send(text, images = []) {
    if (this.busy || this.stopped) return false
    await this.ready()
    const input = []
    if (text?.trim()) input.push({ type: 'text', text })
    for (const image of images || []) {
      if (image?.data && image?.media_type) input.push({ type: 'image', url: `data:${image.media_type};base64,${image.data}` })
    }
    if (!input.length) return false
    this.busy = true
    try {
      const result = await client.request('turn/start', { threadId: this.sessionId, input })
      this.turnId = result.turn?.id || null
      return true
    } catch (error) {
      this.busy = false
      this.emit('event', { type: 'ccdesk', level: 'error', text: error.message, provider: 'codex' })
      return false
    }
  }

  handleNotification(method, params) {
    if (method === 'item/agentMessage/delta') {
      this.emit('event', { type: 'codex_delta', id: params.itemId, text: params.delta || '' })
    } else if (method === 'item/started' || method === 'item/completed') {
      this.emit('event', { type: 'codex_item', phase: method.endsWith('started') ? 'started' : 'completed', item: params.item })
    } else if (method === 'thread/tokenUsage/updated') {
      this.emit('event', { type: 'codex_usage', usage: params.tokenUsage || params.usage })
    } else if (method === 'turn/completed') {
      this.busy = false
      this.turnId = null
      const status = params.turn?.status
      this.emit('event', {
        type: 'result', provider: 'codex', subtype: status === 'interrupted' ? 'error_during_execution' : 'success',
        is_error: status === 'failed', result: params.turn?.error?.message || '', duration_ms: params.turn?.durationMs,
      })
    }
  }

  handleRequest(message) {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      const askId = randomUUID()
      this.pendingApprovals.set(askId, message)
      const p = message.params || {}
      this.emit('event', {
        type: 'ccdesk-internal-ask',
        ask: {
          id: askId,
          kind: 'permission',
          toolName: message.method.includes('commandExecution') ? 'Codex 명령 실행' : 'Codex 파일 변경',
          input: p.command ? { command: p.command, cwd: p.cwd, reason: p.reason } : p,
          toolUseId: p.itemId || null,
          provider: 'codex',
        },
      })
      return
    }
    client.respond(message.id, { decision: 'decline' })
    this.emit('event', { type: 'ccdesk', level: 'stderr', text: `지원하지 않는 Codex 요청을 안전하게 거부했습니다: ${message.method}` })
  }

  answer(askId, answer) {
    const message = this.pendingApprovals.get(askId)
    if (!message) return false
    this.pendingApprovals.delete(askId)
    return client.respond(message.id, { decision: answer?.behavior === 'allow' ? 'accept' : 'decline' })
  }

  handleExit(error) {
    if (this.stopped) return
    this.busy = false
    this.emit('event', { type: 'ccdesk', level: 'error', text: error.message, provider: 'codex' })
  }

  async interrupt() {
    if (!this.busy || !this.sessionId || !this.turnId) return false
    await client.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId })
    return true
  }

  async stop() {
    this.stopped = true
    const threadId = this.sessionId
    const turnId = this.turnId
    if (this.busy && threadId && turnId) {
      await client.request('turn/interrupt', { threadId, turnId }).catch(() => {})
    }
    this.busy = false
    this.turnId = null
    if (this.sessionId) runsByThread.delete(this.sessionId)
    for (const message of this.pendingApprovals.values()) client.respond(message.id, { decision: 'decline' })
    this.pendingApprovals.clear()
    if (threadId && client.state === 'ready') await client.request('thread/unsubscribe', { threadId }).catch(() => {})
    this.removeAllListeners()
  }
}

export const codexProvider = {
  id: 'codex',
  capabilities: { history: true, resume: true, bodySearch: false, images: true, addDirs: false, approvals: true, userQuestions: false },
  async listSessions({ scope = 'all', path = '', query = '' } = {}) {
    let sessions = (await allCodexSessions()).filter((s) => matches(s, query))
    if (scope === 'root' && path) {
      const root = path.toLowerCase().replace(/[\\/]+$/, '')
      return sessions.filter((s) => s.cwd && (s.cwd.toLowerCase() === root || s.cwd.toLowerCase().startsWith(root + '\\') || s.cwd.toLowerCase().startsWith(root + '/')))
    }
    if (scope === 'project' && path) sessions = sessions.filter((s) => s.cwd?.toLowerCase() === path.toLowerCase())
    return sessions
  },
  async readMessages(sessionId, { limit = 40 } = {}) {
    const cacheKey = `${sessionId}:${limit}`
    const cached = historyCache.get(cacheKey)
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.value
    const result = await client.request('thread/read', { threadId: sessionId, includeTurns: true })
    const turns = result.thread.turns || []
    const shown = turns.slice(-Math.max(1, Number(limit) || 40))
    const value = { sessionId, cwd: result.thread.cwd, title: result.thread.name || result.thread.preview || '(제목 없음)', messages: historyMessages({ ...result.thread, turns: shown }), cursor: null, hasMore: false, truncated: turns.length > shown.length, size: null, recentlyActive: result.thread.status?.type === 'active' }
    historyCache.set(cacheKey, { at: Date.now(), value })
    return value
  },
  createRun(config) {
    return new CodexRun(config)
  },
  shutdown() { client.stop() },
  _client: client,
}
