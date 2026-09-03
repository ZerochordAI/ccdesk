#!/usr/bin/env node
// 도구 승인 창구.
//
// claude CLI 가 `--permission-prompt-tool` 로 이 도구를 부르면, 우리는 그 물음을
// ccdesk 서버에 넘기고 사용자가 화면에서 누를 때까지 기다렸다가 답을 돌려준다.
//
// 왜 별도 프로세스인가: MCP 서버는 CLI 가 stdio 로 직접 띄운다. 그래서 ccdesk 서버와는
// 다른 프로세스이고, HTTP 로 다시 이어 붙인다(주소·토큰·runId 는 환경변수로 받는다).
//
// 의존성은 없다. MCP 는 stdio 위의 JSON-RPC 2.0 일 뿐이라 직접 말한다.

const URL_BASE = process.env.CCDESK_URL || ''
// 마스터 토큰이 아니라 이 run 의 승인 물음만 통과시키는 좁은 열쇠다.
// 이 값이 새더라도 할 수 있는 일은 "그 대화에 승인 카드를 띄우는 것" 하나뿐이다.
const ASK_SECRET = process.env.CCDESK_ASK_SECRET || ''
const RUN_ID = process.env.CCDESK_RUN || ''
const WAIT_MS = Number(process.env.CCDESK_ASK_TIMEOUT_MS || 10 * 60 * 1000)

const TOOL = {
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

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  if (id === undefined || id === null) return
  write({ jsonrpc: '2.0', id, result })
}

/** 결정은 도구 결과의 글 안에 JSON 으로 실어 보낸다. CLI 가 그걸 읽는다. */
function decision(id, obj) {
  reply(id, { content: [{ type: 'text', text: JSON.stringify(obj) }] })
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

async function askUser(args) {
  if (!URL_BASE || !ASK_SECRET) throw new Error('ccdesk 주소를 모릅니다')
  const shown = forDisplay(args.input)
  const res = await fetch(URL_BASE + '/api/asks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccdesk-ask': ASK_SECRET },
    body: JSON.stringify({
      runId: RUN_ID,
      toolName: args.tool_name || '(이름 없음)',
      input: shown.input,
      inputTruncated: shown.truncated,
      toolUseId: args.tool_use_id || null,
      waitMs: WAIT_MS,
    }),
  })
  if (!res.ok) throw new Error('ccdesk 가 ' + res.status + ' 로 답했습니다')
  return await res.json()
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
  if (method === 'tools/list') return reply(id, { tools: [TOOL] })
  if (method === 'ping') return reply(id, {})

  if (method === 'tools/call') {
    const args = (params && params.arguments) || {}
    if (!params || params.name !== TOOL.name) {
      return decision(id, { behavior: 'deny', message: '모르는 도구입니다' })
    }
    try {
      const ans = await askUser(args)
      if (ans && ans.behavior === 'allow') {
        const out = { behavior: 'allow' }
        // 사용자가 인자를 고쳤으면 그대로 실어 보낸다.
        if (ans.updatedInput && Object.keys(ans.updatedInput).length) out.updatedInput = ans.updatedInput
        return decision(id, out)
      }
      return decision(id, { behavior: 'deny', message: (ans && ans.message) || '사용자가 거부했습니다' })
    } catch (e) {
      // 물어볼 수 없으면 거부한다. 조용히 허용하는 것보다 낫다.
      return decision(id, { behavior: 'deny', message: '승인을 물어보지 못했습니다: ' + e.message })
    }
  }

  if (id !== undefined && id !== null) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
}

process.stdin.on('end', () => process.exit(0))
