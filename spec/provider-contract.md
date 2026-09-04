# Provider 계약

## 목적

Claude와 Codex의 저장 포맷, 실행 방식, 권한 체계를 서버 내부 adapter 뒤에 격리한다. 브라우저와 HTTP 계층은 provider-independent domain model만 사용한다.

## 구성

```text
Browser UI
   │ HTTP + one SSE connection
server.js
   │ provider registry
   ├── ClaudeProvider ── JSONL readers + ClaudeRun ── claude CLI
   └── CodexProvider  ── CodexAppServerClient ────── codex app-server
```

`server.js`는 provider를 선택하고 인증·입력 제한·run ownership을 관리한다. provider adapter는 세션 조회와 agent protocol 해석을 책임진다. UI는 공통 session/message/event만 렌더한다.

## 식별자

```js
function sessionKey(provider, sessionId) {
  return `${provider}:${sessionId}`
}
```

- `provider`: registry가 허용한 소문자 식별자. 초기 값은 `claude`, `codex`다.
- `sessionId`: provider가 발급한 opaque string이다. UUID라고 가정하지 않는다.
- `runId`: ccdesk 서버가 발급한 UUID이며 실행 중인 adapter run 하나를 가리킨다.
- 중복 실행, 열린 탭, title override는 `sessionKey`로 비교한다.
- provider id나 session id를 파일 경로에 직접 보간하지 않는다.

## 공통 세션 모델

```js
{
  provider: 'claude' | 'codex',
  id: string,
  cwd: string | null,
  title: string,
  preview: string,
  startedAt: string | null,
  updatedAt: string,
  gitBranch: string | null,
  bytes: number | null,
  capabilities: string[]
}
```

- 시각은 API에서 ISO 8601 문자열로 반환한다.
- `title`은 ccdesk override, provider title, 첫 사용자 메시지, `(제목 없음)` 순서로 결정한다.
- provider가 제공하지 않는 필드는 `null`이다. 가짜 기본값을 만들지 않는다.
- 목록 정렬은 전체 provider를 합친 뒤 `updatedAt` 내림차순으로 한다.

## 공통 화면 메시지 모델

```js
{
  id: string,
  role: 'human' | 'assistant' | 'notice',
  ts: string | null,
  model?: string,
  streaming?: boolean,
  blocks: Array<
    | { type: 'text', text: string }
    | { type: 'thinking', text: string }
    | { type: 'image', mediaType: string, data?: string, url?: string }
    | { type: 'tool', id: string, name: string, input: unknown,
        result: unknown, isError: boolean, state: 'running' | 'done' }
    | { type: 'notice', level: string, text: string }
  >
}
```

- HTML은 model에 저장하지 않는다. 렌더 단계에서 escape 후 markdown subset을 적용한다.
- message와 tool id는 provider 원본 id를 유지해 history/live 중복을 upsert할 수 있게 한다.
- 공개 model에 provider raw event 전체를 넣지 않는다.

## 공통 실행 이벤트

SSE envelope:

```js
{ runId: string, provider: string, ev: ProviderEvent }
```

초기 event subset:

```text
message.started       {message}
message.delta         {messageId, block, delta}
message.completed     {message}
tool.started          {messageId, tool}
tool.delta            {messageId, toolId, delta}
tool.completed        {messageId, tool}
approval.requested    {requestId, kind, title, detail, choices, expiresAt?}
approval.resolved     {requestId, choice}
usage.updated         {inputTokens?, outputTokens?, cachedTokens?, cost?}
turn.completed        {status, usage?, durationMs?, error?}
run.notice            {level, text, code?}
```

### 불변 조건

- `turn.completed`는 시작된 turn마다 최대 한 번 emit한다.
- adapter crash는 `run.notice(error)` 후 진행 중 turn을 실패 상태로 닫는다.
- 알 수 없는 provider event는 사용자 메시지로 위장하지 않는다. 진단 로그 또는 `run.notice(debug)`로 보낸다.
- 승인 요청에는 provider가 발급한 request id를 그대로 쓰되, 응답 시 run ownership을 다시 확인한다.

## Provider interface

```js
class Provider {
  id
  capabilities

  async health()
  async listSessions({ scope, path, query, cursor, limit })
  async readMessages(sessionId, { cursor, limit })
  async searchSessions({ scope, path, query, limit })
  async createRun({ cwd, sessionId, settings })
  async shutdown()
}

class ProviderRun extends EventEmitter {
  provider
  sessionId
  busy

  async send({ text, images })
  async interrupt()
  async answer(requestId, answer)
  async stop()
}
```

- 지원하지 않는 capability는 빈 결과가 아니라 명시적 `UNSUPPORTED_CAPABILITY` 오류를 반환한다.
- `send()`는 busy일 때 `RUN_BUSY`를 반환한다. 브라우저 queue는 기존처럼 ccdesk가 관리한다.
- `stop()`은 idempotent해야 한다.
- `shutdown()`은 서버 종료 시 shared process와 pending request를 정리한다.

## Capability 모델

```js
{
  history: true,
  resume: true,
  bodySearch: false,
  images: false,
  addDirs: true,
  approvals: true,
  userQuestions: true,
  settings: {
    model: { type: 'string', optional: true },
    access: { values: ['readOnly', 'workspaceWrite', 'fullAccess'] }
  }
}
```

UI는 provider 이름을 검사해 분기하지 않고 capability에 따라 컨트롤을 표시한다. 위험 경고 문구처럼 provider 고유 의미가 필요한 경우 provider가 display metadata를 제공한다.

## HTTP 계약

```text
GET  /api/providers
GET  /api/sessions?provider=all|claude|codex&scope=&path=&q=&cursor=
GET  /api/providers/:provider/sessions/:id/messages?cursor=&limit=
POST /api/providers/:provider/sessions/:id/title
POST /api/runs                    {provider,cwd,sessionId?,settings}
POST /api/runs/:runId/send        {text,images}
POST /api/runs/:runId/interrupt
POST /api/runs/:runId/answers/:requestId {answer}
DELETE /api/runs/:runId
GET  /api/stream
```

목록은 여러 provider를 함께 볼 필요가 있어 top-level `/api/sessions` aggregate endpoint를 사용한다. 본문과 title 변경은 provider를 URL에 명시한다. 기존 Claude URL은 전환 기간 동안 `provider=claude`로 위임한다.

## 오류 계약

```js
{ error: { code, message, provider?, retryable: boolean, detail? } }
```

초기 코드: `UNKNOWN_PROVIDER`, `CLI_NOT_FOUND`, `NOT_AUTHENTICATED`, `SESSION_NOT_FOUND`, `SESSION_ALREADY_RUNNING`, `RUN_BUSY`, `UNSUPPORTED_CAPABILITY`, `PROVIDER_UNAVAILABLE`, `PROTOCOL_MISMATCH`, `INVALID_SETTINGS`.

`detail`에 auth token, prompt 전문, 환경 변수 전체, 원본 stack trace를 넣지 않는다.

## 제목 저장 호환성

- 새 키는 `claude:<id>`와 `codex:<id>`다.
- 조회 시 `claude:<id>`가 없고 기존 `<id>` 키가 있으면 기존 값을 사용한다.
- 다음 저장 시 namespaced key를 쓰되, 자동으로 기존 key를 삭제하지 않는다. 이전 버전과의 양방향 호환을 보존한다.

