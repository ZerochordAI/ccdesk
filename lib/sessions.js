// Claude Code 가 남긴 세션 기록(~/.claude/projects/**/*.jsonl)을 읽는다.
//
// 설계 메모:
//  - 폴더명은 경로를 인코딩한 것이지만 역해독하지 않는다. 드라이브 문자 대소문자,
//    점(.)→하이픈 치환, UNC 경로 때문에 역해독은 어긋난다.
//    대신 세션 파일 안에 기록된 `cwd` 를 읽는다. 이게 언제나 진짜 경로다.
//  - 세션 파일은 9만 줄이 넘기도 한다. 목록을 만들자고 전부 파싱하지 않는다.
//    앞부분만 읽어 cwd·첫 질문을, 뒷부분만 읽어 최신 제목(ai-title)을 얻는다.

import { readdir, stat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 256 * 1024

/** 파일 앞/뒤 일부만 읽는다. 통째로 읽지 않는 것이 요점이다. */
async function readEdges(file, size) {
  const fh = await open(file, 'r')
  try {
    const headLen = Math.min(HEAD_BYTES, size)
    const head = Buffer.alloc(headLen)
    await fh.read(head, 0, headLen, 0)

    let tail = Buffer.alloc(0)
    if (size > HEAD_BYTES) {
      const tailLen = Math.min(TAIL_BYTES, size)
      tail = Buffer.alloc(tailLen)
      await fh.read(tail, 0, tailLen, size - tailLen)
    }
    return { head: head.toString('utf8'), tail: tail.toString('utf8') }
  } finally {
    await fh.close()
  }
}

/** 잘린 첫 줄/마지막 줄은 파싱할 수 없으므로 조용히 버린다. */
function* parseLines(chunk, { dropFirst = false } = {}) {
  const lines = chunk.split('\n')
  const start = dropFirst ? 1 : 0
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    try {
      yield JSON.parse(l)
    } catch {
      /* 경계에서 잘린 줄 */
    }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text
  }
  return null
}

/**
 * 세션 파일 하나에서 목록에 필요한 것만 뽑는다.
 * 실패하면 null 을 돌려주고 호출부가 건너뛴다 — 손상된 파일 하나가 목록 전체를 막으면 안 된다.
 */
export async function readSessionMeta(file) {
  let st
  try {
    st = await stat(file)
  } catch {
    return null
  }
  if (!st.isFile() || st.size === 0) return null

  let edges
  try {
    edges = await readEdges(file, st.size)
  } catch {
    return null
  }

  let cwd = null
  let gitBranch = null
  let version = null
  let firstUser = null
  let startedAt = null

  for (const h of parseLines(edges.head)) {
    if (!cwd && typeof h.cwd === 'string') cwd = h.cwd
    if (!gitBranch && typeof h.gitBranch === 'string') gitBranch = h.gitBranch
    if (!version && typeof h.version === 'string') version = h.version
    if (!startedAt && typeof h.timestamp === 'string') startedAt = h.timestamp
    if (!firstUser && h.type === 'user' && h.isSidechain !== true) {
      const t = textOf(h.message?.content)
      // 압축 이어받기 문구는 제목으로 쓸모가 없다.
      if (t && !/^This session is being continued/.test(t.trim())) firstUser = t
    }
    if (cwd && firstUser && gitBranch && version) break
  }

  // 최신 ai-title 은 파일 뒤쪽에 있다. 뒤에서 앞으로 훑는다.
  let title = null
  const tailFirst = edges.tail.length > 0
  const scan = tailFirst ? [edges.tail, edges.head] : [edges.head]
  for (const chunk of scan) {
    const found = []
    for (const h of parseLines(chunk, { dropFirst: chunk === edges.tail && tailFirst })) {
      if (h.type === 'ai-title' && typeof h.aiTitle === 'string' && h.aiTitle.trim()) found.push(h.aiTitle)
      if (!cwd && typeof h.cwd === 'string') cwd = h.cwd
    }
    if (found.length) {
      title = found[found.length - 1]
      break
    }
  }

  const id = file.split(/[\\/]/).pop().replace(/\.jsonl$/, '')
  return {
    id,
    file,
    cwd,
    gitBranch,
    version,
    title: title || (firstUser ? firstUser.replace(/\s+/g, ' ').slice(0, 70) : '(제목 없음)'),
    hasAiTitle: Boolean(title),
    preview: firstUser ? firstUser.replace(/\s+/g, ' ').slice(0, 160) : '',
    bytes: st.size,
    startedAt,
    updatedAt: st.mtime.toISOString(),
  }
}

/** ~/.claude/projects 아래 모든 세션을 훑어 프로젝트(경로)별로 묶는다. */
export async function listProjects() {
  let dirs
  try {
    dirs = await readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return { projectsDir: PROJECTS_DIR, projects: [], error: 'projects 디렉토리를 찾을 수 없습니다' }
  }

  const byPath = new Map()

  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = join(PROJECTS_DIR, d.name)
    let files
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    const metas = (await Promise.all(files.map((f) => readSessionMeta(join(dir, f))))).filter(Boolean)
    if (!metas.length) continue

    for (const m of metas) {
      // cwd 를 못 읽은 세션은 폴더명으로 묶는다(표시는 폴더명 그대로).
      const key = m.cwd || `?${d.name}`
      if (!byPath.has(key)) {
        byPath.set(key, { path: m.cwd, encodedDir: d.name, resolved: Boolean(m.cwd), sessions: [] })
      }
      byPath.get(key).sessions.push(m)
    }
  }

  const projects = [...byPath.values()].map((p) => {
    p.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      path: p.path,
      encodedDir: p.encodedDir,
      resolved: p.resolved,
      sessionCount: p.sessions.length,
      lastActive: p.sessions[0].updatedAt,
      gitBranch: p.sessions[0].gitBranch || null,
    }
  })
  projects.sort((a, b) => b.lastActive.localeCompare(a.lastActive))

  return { projectsDir: PROJECTS_DIR, projects }
}

/** 특정 경로의 세션 목록. */
export async function listSessions(targetPath) {
  const { projects } = await listProjects()
  const hit = projects.find((p) => p.path === targetPath || p.encodedDir === targetPath)
  if (!hit) return { path: targetPath, sessions: [] }

  const dir = join(PROJECTS_DIR, hit.encodedDir)
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  const metas = (await Promise.all(files.map((f) => readSessionMeta(join(dir, f)))))
    .filter(Boolean)
    .filter((m) => !hit.path || m.cwd === hit.path)
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { path: hit.path || hit.encodedDir, sessions: metas }
}
