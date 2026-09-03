// 대화 본문에서 찾기 — 색인 없이, 얕게.
//
// 왜 얕은가: 전문 검색을 제대로 하려면 색인이 필요하고 그건 별건이다(DESIGN 8절).
// 그런데 실제로 찾고 싶은 것은 대개 "그때 그 얘기" — 최근 것이다. 그래서
//  - 최근 세션 몇 개만 본다
//  - 파일 **뒤쪽만** 읽는다. 374MB 짜리를 통째로 파싱하지 않는다(R2 와 같은 이유)
//  - JSON.parse 하기 전에 문자열로 먼저 걸러낸다. 안 걸리는 줄이 대부분이다
//
// 색인이 없으므로 오래된 대화의 앞부분은 못 찾는다. 그 한계를 화면에도 적어둔다.

import { open, stat } from 'node:fs/promises'

const TAIL_BYTES = 512 * 1024
const MAX_SESSIONS = 25
const MAX_HITS_PER_SESSION = 3
const SNIPPET_PAD = 60

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

/** 첫 일치 자리를 앞뒤로 조금 잘라 보여준다. */
function snippet(text, needle) {
  const at = text.toLowerCase().indexOf(needle)
  if (at === -1) return text.slice(0, SNIPPET_PAD * 2)
  const from = Math.max(0, at - SNIPPET_PAD)
  const to = Math.min(text.length, at + needle.length + SNIPPET_PAD)
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '')
}

async function searchOne(session, words) {
  let st
  try {
    st = await stat(session.file)
  } catch {
    return null
  }
  if (!st.isFile() || !st.size) return null

  const len = Math.min(TAIL_BYTES, st.size)
  const from = st.size - len
  const fh = await open(session.file, 'r')
  let chunk
  try {
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, from)
    chunk = buf.toString('utf8')
  } catch {
    return null
  } finally {
    await fh.close()
  }

  const lines = chunk.split('\n')
  // 앞이 잘린 첫 줄은 못 쓴다.
  if (from > 0) lines.shift()

  const hits = []
  for (const line of lines) {
    if (hits.length >= MAX_HITS_PER_SESSION) break
    if (!line) continue
    // 값싼 1차 거르기 — 여기서 대부분이 걸러진다.
    const low = line.toLowerCase()
    if (!words.every((w) => low.includes(w))) continue

    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!r || r.isSidechain === true) continue
    if (r.type !== 'user' && r.type !== 'assistant') continue

    const c = r.message && r.message.content
    // 도구 결과는 사람이 읽을 대화가 아니다.
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue

    const text = textOf(c)
    if (!text) continue
    const lowText = text.toLowerCase()
    if (!words.every((w) => lowText.includes(w))) continue

    hits.push({
      role: r.type === 'user' ? 'human' : 'assistant',
      ts: r.timestamp || null,
      snippet: snippet(text, words[0]),
    })
  }

  if (!hits.length) return null
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    hits,
  }
}

/**
 * 최근 세션들의 뒤쪽에서 찾는다.
 * @returns {{results:Array, scanned:number, total:number, partial:boolean}}
 */
export async function searchBodies(sessions, q, { limit = MAX_SESSIONS } = {}) {
  const words = String(q || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return { results: [], scanned: 0, total: sessions.length, partial: false }

  const targets = sessions.slice(0, limit)
  const found = (await Promise.all(targets.map((s) => searchOne(s, words)))).filter(Boolean)
  return {
    results: found,
    scanned: targets.length,
    total: sessions.length,
    // 다 못 봤으면 화면이 그렇게 말해야 한다. 없는 걸 없다고 단정하면 안 된다.
    partial: sessions.length > targets.length,
  }
}
