// Claude Code 가 남긴 세션 기록(~/.claude/projects/**/*.jsonl)의 **목록**을 읽는다.
// 본문은 lib/transcript.js 가 따로 읽는다.
//
// 설계 메모:
//  - R1: 폴더명은 경로를 인코딩한 것이지만 역해독하지 않는다. 드라이브 문자 대소문자,
//    점(.)→하이픈 치환, 하위 폴더 때문에 역해독은 어긋난다.
//    대신 세션 파일 안에 기록된 `cwd` 를 읽는다. 이게 언제나 진짜 경로다.
//  - R2: 세션 파일은 9만 줄이 넘기도 한다(실측 374MB). 목록을 만들자고 전부 파싱하지 않는다.
//    앞부분만 읽어 cwd·첫 질문을, 뒷부분만 읽어 최신 제목(ai-title)과 마지막 활동 시각을 얻는다.
//  - 디렉토리는 **한 번만** 훑는다. 프로젝트 묶음과 평면 목록을 같은 스캔에서 만든다.

import { readdir, stat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 256 * 1024

// 스크래치패드 세션은 사용자의 프로젝트가 아니다. 기본으로 감춘다.
const SCRATCHPAD_RE = /[\u005C/]AppData[\u005C/]Local[\u005C/]Temp[\u005C/]claude[\u005C/]/i

/** 파일 앞/뒤 일부만 읽는다. 통째로 읽지 않는 것이 요점이다. */
async function readEdges(file, size) {
  const fh = await open(file, 'r')
  try {
    const headLen = Math.min(HEAD_BYTES, size)
    const head = Buffer.alloc(headLen)
    await fh.read(head, 0, headLen, 0)

    let tail = Buffer.alloc(0)
    let tailStart = 0
    if (size > HEAD_BYTES) {
      const tailLen = Math.min(TAIL_BYTES, size)
      tailStart = size - tailLen
      tail = Buffer.alloc(tailLen)
      await fh.read(tail, 0, tailLen, tailStart)
    }
    return { head: head.toString('utf8'), tail: tail.toString('utf8'), tailStart }
  } finally {
    await fh.close()
  }
}

/** 잘린 첫 줄은 파싱할 수 없으므로 조용히 버린다. */
function* parseLines(chunk, { dropFirst = false } = {}) {
  const lines = chunk.split('\n')
  for (let i = dropFirst ? 1 : 0; i < lines.length; i++) {
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
  let titles = []
  let lastActivity = null

  for (const h of parseLines(edges.head)) {
    if (!cwd && typeof h.cwd === 'string') cwd = h.cwd
    if (!gitBranch && typeof h.gitBranch === 'string') gitBranch = h.gitBranch
    if (!version && typeof h.version === 'string') version = h.version
    if (!startedAt && typeof h.timestamp === 'string') startedAt = h.timestamp
    if (typeof h.timestamp === 'string') lastActivity = h.timestamp
    if (h.type === 'ai-title' && typeof h.aiTitle === 'string' && h.aiTitle.trim()) titles.push(h.aiTitle)
    if (!firstUser && h.type === 'user' && h.isSidechain !== true) {
      const t = textOf(h.message?.content)
      // 압축 이어받기 문구는 제목으로 쓸모가 없다.
      if (t && !/^This session is being continued/.test(t.trim())) firstUser = t
    }
  }

  // 뒤쪽이 있으면 제목과 마지막 활동 시각은 그쪽이 최신이다.
  if (edges.tail) {
    const tailTitles = []
    let tailLast = null
    for (const h of parseLines(edges.tail, { dropFirst: edges.tailStart > 0 })) {
      if (h.type === 'ai-title' && typeof h.aiTitle === 'string' && h.aiTitle.trim()) tailTitles.push(h.aiTitle)
      if (typeof h.timestamp === 'string') tailLast = h.timestamp
      if (!cwd && typeof h.cwd === 'string') cwd = h.cwd
    }
    if (tailTitles.length) titles = tailTitles
    if (tailLast) lastActivity = tailLast
  }

  const title = titles.length ? titles[titles.length - 1] : null
  const id = file.split(/[\u005C/]/).pop().replace(/\.jsonl$/, '')

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
    // 주의: mtime 은 대화가 없어도 갱신된다(실측: 마지막 대화보다 4일 늦은 세션이 있었다).
    //       화면에 쓰는 시각은 기록 안의 마지막 timestamp 다.
    lastActivity,
    mtime: st.mtime.toISOString(),
    updatedAt: lastActivity || st.mtime.toISOString(),
    isScratchpad: Boolean(cwd && SCRATCHPAD_RE.test(cwd)),
  }
}

/**
 * ~/.claude/projects 전체를 한 번 훑는다. 평면 세션 목록과 프로젝트 묶음을 같이 만든다.
 * 하위 폴더(subagents/)는 readdir 이 비재귀라 자연히 빠진다 — 서브에이전트 대화는 목록에 넣지 않는다.
 */
export async function scanAll({ includeScratchpad = false } = {}) {
  let dirs
  try {
    dirs = await readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return { projectsDir: PROJECTS_DIR, sessions: [], projects: [], error: 'projects 디렉토리를 찾을 수 없습니다' }
  }

  const sessions = []
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
    for (const m of metas) {
      m.encodedDir = d.name
      if (!includeScratchpad && m.isScratchpad) continue
      sessions.push(m)
    }
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const byPath = new Map()
  for (const m of sessions) {
    // cwd 를 못 읽은 세션은 폴더명으로 묶는다(표시는 폴더명 그대로).
    const key = m.cwd || `?${m.encodedDir}`
    if (!byPath.has(key)) byPath.set(key, [])
    byPath.get(key).push(m)
  }

  const projects = [...byPath.values()].map((list) => ({
    path: list[0].cwd,
    encodedDir: list[0].encodedDir,
    resolved: Boolean(list[0].cwd),
    sessionCount: list.length,
    lastActive: list[0].updatedAt,
    gitBranch: list[0].gitBranch || null,
  }))
  projects.sort((a, b) => b.lastActive.localeCompare(a.lastActive))

  return { projectsDir: PROJECTS_DIR, sessions, projects }
}

export async function listProjects(opts) {
  const { projectsDir, projects, error } = await scanAll(opts)
  return error ? { projectsDir, projects, error } : { projectsDir, projects }
}

/** 특정 경로(또는 인코딩된 폴더명)의 세션 목록. */
export async function listSessions(targetPath, opts) {
  const { sessions } = await scanAll(opts)
  const hit = sessions.filter((s) => s.cwd === targetPath || s.encodedDir === targetPath)
  return { path: hit.length ? hit[0].cwd || hit[0].encodedDir : targetPath, sessions: hit }
}

/** 루트 아래 전부. 경로 구분자를 맞춰 접두사로 거른다. */
export async function listUnderRoot(root, opts) {
  const { sessions } = await scanAll(opts)
  const norm = (p) => p.replace(/[\u005C/]+/g, '\u005C').replace(/\u005C+$/, '').toLowerCase()
  const r = norm(root)
  return { root, sessions: sessions.filter((s) => s.cwd && (norm(s.cwd) === r || norm(s.cwd).startsWith(r + '\u005C'))) }
}
