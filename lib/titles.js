// 사용자가 붙인 대화 이름을 따로 보관한다.
//
// 왜 따로 두는가: 제목은 원래 세션 기록(jsonl)의 `ai-title` 줄에서 온다. 거기에 직접 쓰면
// CLI 가 같은 파일에 쓰는 중일 수 있어 줄이 섞일 위험이 있다(DESIGN 9.3 참고).
// 그래서 ccdesk 는 CLI 의 파일을 **읽기만** 하고, 바꾼 이름은 우리 파일에 담는다.
// 대신 그 이름은 ccdesk 안에서만 보인다 — 터미널 목록에는 원래 제목이 그대로 나온다.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const FILE = join(homedir(), '.ccdesk', 'titles.json')

let cache = null

async function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'))
    if (!cache || typeof cache !== 'object') cache = {}
  } catch {
    cache = {}
  }
  return cache
}

/** 통째로 덮되, 쓰다 만 파일이 남지 않게 임시 파일을 거쳐 바꿔치기한다. */
async function save(data) {
  await mkdir(dirname(FILE), { recursive: true })
  const tmp = FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, FILE)
}

/** { sessionId: "붙인 이름" } */
export async function getTitles() {
  return { ...(await load()) }
}

// 쓰기를 한 줄로 세운다. 두 요청이 겹치면 각자 읽고 각자 덮어써서 먼저 것이 사라진다.
let writing = Promise.resolve()

async function doSet(sessionId, title) {
  const data = await load()
  const clean = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
  if (clean) data[sessionId] = clean
  else delete data[sessionId]
  cache = data
  await save(data)
  return clean
}

/** 빈 값을 주면 지운다(원래 제목으로 되돌아간다). */
export async function setTitle(sessionId, title) {
  const next = writing.then(
    () => doSet(sessionId, title),
    () => doSet(sessionId, title)
  )
  // 실패가 줄을 끊지 않게 한다 — 다음 쓰기는 계속 이어져야 한다.
  writing = next.catch(() => {})
  return next
}

/** 목록에 붙인 이름을 입힌다. 바꾼 것에는 renamed 표시를 남긴다. */
export function applyTitles(sessions, titles) {
  return sessions.map((s) => {
    const t = titles[`${s.provider || 'claude'}:${s.id}`] || (s.provider && s.provider !== 'claude' ? null : titles[s.id])
    return t ? { ...s, title: t, originalTitle: s.title, renamed: true } : s
  })
}

/** provider가 추가된 뒤에는 같은 session id가 충돌하지 않도록 이름을 구분한다. */
export function titleKey(provider, sessionId) {
  return `${provider || 'claude'}:${sessionId}`
}

export const TITLES_FILE = FILE
