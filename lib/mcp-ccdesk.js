#!/usr/bin/env node
// ccdesk 가 CLI 에 붙여주는 MCP 서버. 도구 두 개를 낸다.
//
//  approve      — CLI 의 --permission-prompt-tool 이 부른다. 도구 실행을 사람에게 묻는다.
//  ask_choice   — 모델이 부른다. 사용자에게 선택지를 내밀고 고른 것을 돌려준다.
//
// 왜 ask_choice 를 우리가 만드나: 헤드리스 CLI 의 도구 목록에 AskUserQuestion 이 없다
// (2026-09-03 실측, 69개 중 없음). 그래서 같은 일을 하는 도구를 직접 만든다.
// 답을 CLI 가 아니라 우리가 만들므로 불확실성이 없다.
//
// 왜 별도 프로세스인가: MCP 서버는 CLI 가 stdio 로 직접 띄운다. ccdesk 서버와는
// 다른 프로세스이고, HTTP 로 다시 이어 붙인다(주소·열쇠·runId 는 환경변수로 받는다).
//
// 의존성은 없다. MCP 는 stdio 위의 JSON-RPC 2.0 일 뿐이라 직접 말한다.
//
// ⚠️ stdout 은 프로토콜 전용이다. 여기에 아무것도 찍지 마라 — 찍는 순간 CLI 가 못 읽는다.

const URL_BASE = process.env.CCDESK_URL || ''
// 마스터 토큰이 아니라 이 run 의 물음만 통과시키는 좁은 열쇠다.
const ASK_SECRET = process.env.CCDESK_ASK_SECRET || ''
const RUN_ID = process.env.CCDESK_RUN || ''
const WAIT_MS = Number(process.env.CCDESK_ASK_TIMEOUT_MS || 10 * 60 * 1000)
const WANT_APPROVE = process.env.CCDESK_TOOL_APPROVE === '1'
const WANT_CHOICE = process.env.CCDESK_TOOL_CHOICE === '1'

const TOOL_APPROVE = {
  name: 'approve',
  description:
    'Ask the ccdesk user whether a tool call may proceed. Returns a JSON decision with behavior "allow" or "deny".',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Tool being requested' },
      input: { type: 'object', description: 'Arguments the tool would run with', additionalProperties: true },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name'],
    additionalProperties: true,
  },
}

const TOOL_CHOICE = {
  name: 'ask_choice',
  description:
    'Ask the human a question and let them pick from options you provide. Use this whenever you need the ' +
    'user to make a decision you cannot make yourself — choosing between approaches, confirming an ' +
    'assumption, or picking a direction. The user sees a card with buttons and clicks one. ' +
    'Returns the label they chose. Prefer this over asking in plain prose when the answer is one of a ' +
    'small set of choices.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show. Keep it to one clear sentence.' },
      options: {
        type: 'array',
        description: '2 to 5 choices.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short button text (1-5 words)' },
            description: { type: 'string', description: 'One line explaining what this choice means' },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
}

function tools() {
  const list = []
  if (WANT_APPROVE) list.push(TOOL_APPROVE)
  if (WANT_CHOICE) list.push(TOOL_CHOICE)
  return list
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  if (id === undefined || id === null) return
  write({ jsonrpc: '2.0', id, result })
}

/** 도구 결과는 글 하나로 돌려준다. approve 는 그 글 안의 JSON 을 CLI 가 읽는다. */
function text(id, s) {
  reply(id, { content: [{ type: 'text', text: s }] })
}

// 아주 큰 인자는 보여주기용으로만 줄인다. 우리는 인자를 고쳐 돌려주지 않으므로
// 줄여도 실행에는 영향이 없다 — 다만 화면에는 줄였다고 알린다.
const MAX_SHOW = 4 * 1024 * 1024

function forDisplay(input) {
  try {
    const raw = JSON.stringify(input ?? {})
    if (raw.length <= MAX_SHOW) return { input: input ?? {}, truncated: false }
    const short = {}
    for (const [k, v] of Object.entries(input || {})) {
      short[k] = typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + '\n… (줄임)' : v
    }
    return { input: short, truncated: true }
  } catch {
    return { input: {}, truncated: true }
  }
}

/** ccdesk 서버에 물어보고 사용자가 누를 때까지 기다린다. */
async function ask(body) {
  if (!URL_BASE || !ASK_SECRET) throw new Error('ccdesk 주소를 모릅니다')
  const res = await fetch(URL_BASE + '/api/asks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccdesk-ask': ASK_SECRET },
    body: JSON.stringify({ runId: RUN_ID, waitMs: WAIT_MS, ...body }),
  })
  if (!res.ok) throw new Error('ccdesk 가 ' + res.status + ' 로 답했습니다')
  return await res.json()
}

async function handleApprove(id, args) {
  try {
    const shown = forDisplay(args.input)
    const ans = await ask({
      kind: 'permission',
      toolName: args.tool_name || '(이름 없음)',
      input: shown.input,
      inputTruncated: shown.truncated,
      toolUseId: args.tool_use_id || null,
    })
    if (ans && ans.behavior === 'allow') {
      const out = { behavior: 'allow' }
      if (ans.updatedInput && Object.keys(ans.updatedInput).length) out.updatedInput = ans.updatedInput
      return text(id, JSON.stringify(out))
    }
    return text(id, JSON.stringify({ behavior: 'deny', message: (ans && ans.message) || '사용자가 거부했습니다' }))
  } catch (e) {
    // 물어볼 수 없으면 거부한다. 조용히 허용하는 것보다 낫다.
    return text(id, JSON.stringify({ behavior: 'deny', message: '승인을 물어보지 못했습니다: ' + e.message }))
  }
}

async function handleChoice(id, args) {
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  const options = (Array.isArray(args.options) ? args.options : [])
    .filter((o) => o && typeof o.label === 'string' && o.label.trim())
    .slice(0, 5)
    .map((o) => ({ label: String(o.label).slice(0, 80), description: o.description ? String(o.description).slice(0, 300) : '' }))

  if (!question || options.length < 2) {
    return text(id, '선택지를 만들지 못했습니다. question 과 2개 이상의 options 가 필요합니다.')
  }
  try {
    const ans = await ask({ kind: 'choice', question, options })
    if (ans && typeof ans.choice === 'string' && ans.choice) {
      return text(id, '사용자가 고른 것: ' + ans.choice + (ans.note ? '\n덧붙인 말: ' + ans.note : ''))
    }
    return text(id, '사용자가 고르지 않았습니다: ' + ((ans && ans.message) || '취소'))
  } catch (e) {
    return text(id, '물어보지 못했습니다: ' + e.message)
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) handle(line)
  }
})

async function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ccdesk', version: '0.1.0' },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'tools/list') return reply(id, { tools: tools() })
  if (method === 'ping') return reply(id, {})

  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'approve') return handleApprove(id, args)
    if (name === 'ask_choice') return handleChoice(id, args)
    return text(id, '모르는 도구입니다: ' + name)
  }

  if (id !== undefined && id !== null) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
}

process.stdin.on('end', () => process.exit(0))
