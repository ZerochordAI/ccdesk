import { scanAll } from '../sessions.js'
import { readMessages, readSince } from '../transcript.js'
import { searchBodies } from '../search.js'
import { normalizeHistory } from '../../public/normalize.js'
import { Run } from '../runner.js'

const SNAPSHOT_TTL_MS = 3000
let snapshot = null
let scanning = null

async function getSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.sessions
  if (scanning) return scanning
  scanning = scanAll().then(({ sessions }) => {
    snapshot = { at: Date.now(), sessions }
    return sessions
  }).finally(() => { scanning = null })
  return scanning
}

function norm(path) {
  return String(path || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export const claudeProvider = {
  id: 'claude',
  capabilities: { history: true, resume: true, bodySearch: true, images: true, addDirs: true, approvals: true, userQuestions: true },
  async listSessions({ scope = 'all', path = '' } = {}) {
    let sessions = await getSnapshot()
    if (scope === 'root' && path) {
      const root = norm(path)
      sessions = sessions.filter((s) => norm(s.cwd) === root || norm(s.cwd).startsWith(root + '\\'))
    } else if (scope === 'project' && path) {
      sessions = sessions.filter((s) => s.cwd === path || s.encodedDir === path)
    }
    return sessions.map((s) => ({ ...s, provider: 'claude' }))
  },
  async readMessages(session, { before = null, after = null, limit = 40 } = {}) {
    if (after != null) {
      const tail = await readSince(session.file, Number(after))
      return { sessionId: session.id, records: tail.records, offset: tail.offset, tail: true }
    }
    const out = await readMessages(session.file, { before, limit })
    return { sessionId: session.id, cwd: session.cwd, title: session.title, messages: normalizeHistory(out.records), cursor: out.cursor, hasMore: out.hasMore, size: out.size }
  },
  searchSessions(sessions, query) { return searchBodies(sessions, query) },
  createRun(config) { return new Run(config) },
}
