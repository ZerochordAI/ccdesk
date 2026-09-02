// 기록(jsonl)과 실시간(stream-json)을 같은 메시지 모양으로 접는다.
//
// ⚠️ R10: 이 파일은 브라우저와 서버가 함께 쓴다. node: 모듈을 import 하지 말 것.
//
// 왜 하나로 접는가: jsonl 의 assistant 라인과 stream-json 의 assistant 이벤트는
// 둘 다 `message` 안에 Anthropic API 메시지 객체를 그대로 담는다(2026-09-02 실측).
// 그래서 렌더러를 하나만 만들면 된다. 이 성질을 깨지 말 것.

const TOOL_RESULT = 'tool_result'

function textFrom(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 사람이 보낸 것에서 글과 이미지만 추린다. 붙인 이미지가 대화에 남아야 나중에 봐도 맥락이 있다. */
function humanBlocks(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const out = []
  for (const b of content) {
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ type: 'text', text: b.text })
    else if (b.type === 'image' && b.source) out.push({ type: 'image', mediaType: b.source.media_type || 'image/png', data: b.source.data })
  }
  return out
}

function toolResultsIn(content) {
  if (!Array.isArray(content)) return []
  return content.filter((b) => b && b.type === TOOL_RESULT)
}

function resultText(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('')
  return c == null ? '' : String(c)
}

/** tool_use 블록을 찾아 결과를 붙인다. 못 찾으면 false — 호출부가 알아서 버린다. */
function attachToolResult(list, tr) {
  for (let i = list.length - 1; i >= 0; i--) {
    for (const b of list[i].blocks) {
      if (b.type === 'tool' && b.id === tr.tool_use_id) {
        b.result = resultText(tr.content)
        b.isError = Boolean(tr.is_error)
        b.state = 'done'
        return true
      }
    }
  }
  return false
}

function blocksFromContent(content) {
  const out = []
  if (typeof content === 'string') {
    if (content) out.push({ type: 'text', text: content })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
    else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push({ type: 'thinking', text: b.thinking })
    else if (b.type === 'tool_use')
      out.push({ type: 'tool', id: b.id, name: b.name, input: b.input, result: null, isError: false, state: 'running' })
  }
  return out
}

/** 같은 message.id 는 한 메시지로 합친다. jsonl 은 한 턴을 여러 줄로 쪼개 적는다. */
function upsertAssistant(list, { id, ts, content, model }) {
  const blocks = blocksFromContent(content)
  const existing = id ? list.find((m) => m.role === 'assistant' && m.id === id) : null
  if (existing) {
    // 스트리밍으로 쌓아둔 부분 텍스트가 있으면 완성본으로 갈아끼운다.
    if (existing.streaming) {
      existing.blocks = existing.blocks.filter((b) => b.type === 'tool' && b.state === 'done')
      existing.streaming = false
    }
    for (const b of blocks) {
      if (b.type === 'tool' && existing.blocks.some((x) => x.type === 'tool' && x.id === b.id)) continue
      existing.blocks.push(b)
    }
    return existing
  }
  const msg = { id: id || `a${list.length}`, role: 'assistant', ts, blocks, model }
  list.push(msg)
  return msg
}

function pushNotice(list, level, text) {
  if (!text) return
  list.push({ id: `n${list.length}`, role: 'notice', ts: new Date().toISOString(), blocks: [{ type: 'notice', level, text }] })
}

/** 기록 라인 배열 → 메시지 배열. 오래된 것부터 들어온다고 가정한다. */
export function normalizeHistory(records) {
  return appendHistory([], records)
}

/**
 * 이미 만들어둔 목록 뒤에 기록 라인을 이어붙인다.
 * 따라 읽기(tail)에서 쓴다 — 앞 덩어리에 있던 tool_use 에 결과가 제대로 붙으려면 같은 목록에 이어야 한다.
 */
export function appendHistory(list, records) {
  for (const r of records) {
    if (!r || r.isSidechain === true) continue
    if (r.type === 'assistant' && r.message) {
      upsertAssistant(list, { id: r.message.id, ts: r.timestamp, content: r.message.content, model: r.message.model })
    } else if (r.type === 'user' && r.message) {
      const trs = toolResultsIn(r.message.content)
      if (trs.length) {
        for (const tr of trs) attachToolResult(list, tr)
        continue // 도구 결과는 사람이 친 말이 아니다
      }
      const blocks = humanBlocks(r.message.content)
      if (blocks.length) list.push({ id: r.uuid || `h${list.length}`, role: 'human', ts: r.timestamp, blocks })
    }
  }
  return list
}

/** 스트리밍 델타가 쌓일 곳. 없으면 만든다. */
function liveAssistant(list, id) {
  let m = id ? list.find((x) => x.role === 'assistant' && x.id === id) : null
  if (!m) m = [...list].reverse().find((x) => x.role === 'assistant' && x.streaming)
  if (!m) {
    m = { id: id || `live${list.length}`, role: 'assistant', ts: new Date().toISOString(), blocks: [], streaming: true }
    list.push(m)
  }
  if (id && !m.id.startsWith('a') && m.id !== id) m.id = id
  m.streaming = true
  return m
}

function appendText(list, kind, text) {
  const m = liveAssistant(list, null)
  const last = m.blocks[m.blocks.length - 1]
  if (last && last.type === kind) last.text += text
  else m.blocks.push({ type: kind, text })
}

/**
 * 실시간 이벤트 하나를 메시지 배열에 반영한다. 배열을 제자리에서 고친다.
 *
 * ⚠️ stream_event 의 내부 모양은 미확인이다(HANDOFF 는 이벤트 이름까지만 실측).
 *    content_block_delta / text_delta 를 가정하고 방어적으로 짰다.
 *    실제 이벤트를 찍어본 뒤 이 함수와 DESIGN.md 3절을 갱신할 것.
 */
export function applyEvent(list, ev) {
  if (!ev || typeof ev !== 'object') return list

  switch (ev.type) {
    case 'assistant':
      if (ev.message) upsertAssistant(list, { id: ev.message.id, ts: new Date().toISOString(), content: ev.message.content, model: ev.message.model })
      break

    case 'user': {
      const trs = toolResultsIn(ev.message?.content)
      if (trs.length) for (const tr of trs) attachToolResult(list, tr)
      break
    }

    case 'stream_event': {
      const e = ev.event || {}
      if (e.type === 'message_start' && e.message?.id) liveAssistant(list, e.message.id)
      else if (e.type === 'content_block_delta') {
        const d = e.delta || {}
        if (typeof d.text === 'string') appendText(list, 'text', d.text)
        else if (typeof d.thinking === 'string') appendText(list, 'thinking', d.thinking)
      } else if (e.type === 'message_stop') {
        const m = [...list].reverse().find((x) => x.streaming)
        if (m) m.streaming = false
      }
      break
    }

    case 'system':
      // R9: 권한 거부를 삼키지 않는다.
      if (ev.subtype === 'permission_denied' || ev.permission_denial)
        pushNotice(list, 'denied', `권한 거부: ${ev.tool_name || ev.permission_denial?.tool_name || '도구'}`)
      break

    case 'result': {
      const m = [...list].reverse().find((x) => x.role === 'assistant')
      if (m) {
        m.streaming = false
        m.meta = { usage: ev.usage, costUsd: ev.total_cost_usd, durationMs: ev.duration_ms, numTurns: ev.num_turns }
      }
      for (const d of ev.permission_denials || []) pushNotice(list, 'denied', `권한 거부: ${d.tool_name}`)
      if (ev.is_error) pushNotice(list, 'error', ev.result || '실행이 오류로 끝났습니다')
      break
    }

    case 'ccdesk':
      if (ev.level === 'exit') pushNotice(list, 'exit', `claude 프로세스가 종료됐습니다 (코드 ${ev.code})`)
      else pushNotice(list, ev.level === 'error' ? 'error' : 'stderr', ev.text)
      break
  }
  return list
}
