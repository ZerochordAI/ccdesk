// 세션 본문을 **뒤에서부터** 읽는다. 목록용 메타는 lib/sessions.js 가 따로 한다.
//
// 설계 메모:
//  - 374MB 세션이 실재한다. 앞에서부터 읽으면 끝난다. 마지막 N턴만 필요하므로
//    파일 끝에서 256KB 씩 거슬러 올라가며 사람이 친 메시지를 세다가 멈춘다.
//  - 커서는 **바이트 오프셋**이다. "위로 더 불러오기"는 이 값을 그대로 물려주면 된다.
//  - 줄바꿈(0x0A)은 UTF-8 멀티바이트 시퀀스 안에 나타날 수 없다. 그래서 바이트로
//    줄을 가른 뒤에 디코드해도 글자가 깨지지 않는다.

import { open, stat } from 'node:fs/promises'

const CHUNK = 256 * 1024
const NL = 0x0a

/** 사람이 친 메시지인가 (도구 결과는 아니다). */
function isHumanTurn(r) {
  if (!r || r.type !== 'user' || r.isSidechain === true) return false
  const c = r.message?.content
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return false
  if (typeof c === 'string') return Boolean(c.trim())
  return Array.isArray(c) && c.some((b) => b?.type === 'text' && b.text?.trim())
}

function keep(r) {
  return r && (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true
}

/**
 * 마지막 `limit` 턴을 읽는다.
 * @returns {{records:Array, cursor:number|null, hasMore:boolean, humanTurns:number}}
 *          records 는 오래된 것부터. cursor 는 다음 `before` 로 넘길 값.
 */
export async function readMessages(file, { before = null, limit = 40 } = {}) {
  const st = await stat(file)
  let end = before == null ? st.size : Math.min(before, st.size)
  if (end <= 0) return { records: [], cursor: null, hasMore: false, humanTurns: 0 }

  const fh = await open(file, 'r')
  try {
    let carry = Buffer.alloc(0) // 앞쪽이 잘린 줄. 더 거슬러 올라가야 완성된다.
    let firstPass = true
    const collected = [] // 새 것 → 오래된 것 순으로 쌓인다
    let humanTurns = 0
    let cursor = 0
    let pos = end

    while (pos > 0 && humanTurns < limit) {
      const start = Math.max(0, pos - CHUNK)
      const buf = Buffer.alloc(pos - start)
      await fh.read(buf, 0, buf.length, start)
      const merged = carry.length ? Buffer.concat([buf, carry]) : buf

      const nl = merged.indexOf(NL)
      let regionStart, region
      if (start === 0) {
        // 파일 첫 줄까지 왔다. 잘린 줄이 없다.
        regionStart = 0
        region = merged
        carry = Buffer.alloc(0)
      } else if (nl === -1) {
        // 이 청크 안에 줄바꿈이 없다. 통째로 다음 회차로 넘긴다.
        carry = merged
        pos = start
        firstPass = false
        continue
      } else {
        carry = merged.subarray(0, nl)
        regionStart = start + nl + 1
        region = merged.subarray(nl + 1)
      }

      const lines = region.toString('utf8').split('\n')
      // 파일 끝이 개행으로 안 끝나면 마지막 조각은 쓰다 만 줄이다.
      if (firstPass && lines.length && lines[lines.length - 1] !== '') lines.pop()

      // 각 줄의 바이트 시작 위치를 미리 계산해 둔다(커서용).
      const offsets = new Array(lines.length)
      let acc = regionStart
      for (let i = 0; i < lines.length; i++) {
        offsets[i] = acc
        acc += Buffer.byteLength(lines[i], 'utf8') + 1
      }

      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim()
        if (!l) continue
        let r
        try {
          r = JSON.parse(l)
        } catch {
          continue
        }
        if (!keep(r)) continue
        collected.push(r)
        cursor = offsets[i]
        if (isHumanTurn(r)) {
          humanTurns++
          if (humanTurns >= limit) break
        }
      }

      pos = start
      firstPass = false
    }

    collected.reverse()
    // size 는 "여기까지 읽었다"는 표시다. 뒤에 붙는 줄을 따라 읽을 때 시작점이 된다.
    return { records: collected, cursor, hasMore: cursor > 0, humanTurns, size: st.size }
  } finally {
    await fh.close()
  }
}

/**
 * offset 부터 파일 끝까지 앞으로 읽는다. 다른 곳(터미널)에서 진행 중인 대화를 따라 읽을 때 쓴다.
 * 쓰다 만 마지막 줄은 넘기지 않고 다음 회차로 미룬다 — 그래서 offset 이 파일 크기보다 작을 수 있다.
 */
export async function readSince(file, offset) {
  const st = await stat(file)
  const from = Math.max(0, Math.min(Number(offset) || 0, st.size))
  if (from >= st.size) return { records: [], offset: st.size }

  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(st.size - from)
    await fh.read(buf, 0, buf.length, from)
    const lines = buf.toString('utf8').split('\n')

    let consumed = st.size
    const last = lines[lines.length - 1]
    if (last !== '') {
      consumed = st.size - Buffer.byteLength(last, 'utf8')
      lines.pop()
    }

    const records = []
    for (const l of lines) {
      const t = l.trim()
      if (!t) continue
      try {
        const r = JSON.parse(t)
        if (keep(r)) records.push(r)
      } catch {
        /* 깨진 줄은 버린다 */
      }
    }
    return { records, offset: consumed }
  } finally {
    await fh.close()
  }
}
