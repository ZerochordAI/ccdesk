# Codex provider 확장 계획

## 의도

현재 ccdesk의 Claude Code 전용 기능을 보존하면서, 같은 로컬 UI에서 Claude Code와 Codex 대화를 조회하고 새로 시작하고 이어갈 수 있게 한다. 첫 구현은 기능 수를 늘리는 것보다 provider 경계를 명확히 세우는 데 초점을 둔다.

완료 기준은 다음과 같다.

- 좌측 목록에서 Claude와 Codex 세션을 함께 보되 provider를 구분할 수 있다.
- 새 대화를 만들 때 provider를 선택할 수 있다.
- 각 provider의 기존 세션을 열고, 최근 대화를 보고, 이어서 한 턴 이상 실행하고, 진행 중인 턴을 중단할 수 있다.
- Claude 전용 권한/모델 설정이 Codex에 잘못 노출되지 않고, Codex 설정은 Codex 용어와 값으로 표시된다.
- 한 provider의 장애나 이벤트 형식 변경이 다른 provider의 실행 경로를 깨뜨리지 않는다.
- 로컬 바인딩, API 토큰, Origin 검사 등 기존 보안 경계는 유지한다.

## 확인한 현재 동작

### 서버와 실행

- `server.js`가 세션 조회, transcript 조회, run 생성/전송/중단, 단일 SSE 연결을 모두 담당한다.
- `lib/runner.js`의 `Run`은 Claude Code CLI 규약에 직접 결합되어 있다. `claude -p`, stream-json 입출력, Claude permission mode, `--allowedTools`, `--resume`, `--session-id`, `--permission-prompt-tool`을 직접 조립한다.
- run은 생성 시 프로세스를 띄우지 않고 첫 `send()`에서 시작한다. Claude 프로세스가 종료되면 다음 전송 때 같은 session id로 다시 resume한다.
- 활성 run의 중복 방지는 현재 `sessionId`만 비교한다. provider가 추가되면 `(provider, sessionId)` 복합 키가 필요하다.
- SSE는 이미 `runId`로 이벤트를 분배하므로 transport 자체는 provider 추가에도 재사용할 수 있다.

### 세션과 대화 기록

- `lib/sessions.js`, `lib/transcript.js`, `lib/search.js`는 `~/.claude/projects/**/*.jsonl`과 Anthropic message/tool block 형식을 직접 해석한다.
- 목록용 세션 객체의 사실상 계약은 `id`, `cwd`, `title`, `preview`, `updatedAt`, `gitBranch`, `bytes` 등이다.
- `public/normalize.js`는 Claude history record와 Claude live event를 화면용 `message.blocks`로 변환한다.
- API와 탭 상태에서 provider 식별자가 없다. 세션 URL도 `/api/sessions/:id/...`라 서로 다른 provider에서 같은 id가 생기면 충돌할 수 있다.
- 사용자 지정 제목은 `~/.ccdesk/titles.json`에서 session id 하나만 키로 사용한다.

### 화면과 설정

- `public/app.js`의 탭, 세션, run 생성 payload는 Claude 전용 설정(`permissionMode`, `allowedTools`, `askUser`, `askChoice`)을 전제로 한다.
- `public/index.html`의 모델 목록과 권한 선택지도 Claude 전용이다.
- `public/normalize.js`가 history와 live event를 한 화면 모델로 합치는 단일 경계 역할을 하고 있어, provider별 adapter가 공통 UI 이벤트를 만들도록 확장하기 좋다.

### Codex에서 확인한 인터페이스

- 로컬 설치는 `codex-cli 0.153.0`이다.
- `codex exec --json`은 JSONL 이벤트와 session resume을 제공하지만 기본적으로 한 턴 실행에 적합하다.
- Codex App Server는 stdio JSON-RPC 연결에서 `thread/start`, `thread/resume`, `thread/read`, `thread/list`, `turn/start`, `turn/interrupt`와 item/turn 스트리밍 알림을 제공한다.
- App Server는 연결별 initialize handshake가 필요하며 CLI 버전에 맞는 TypeScript/JSON Schema를 생성할 수 있다.
- 로컬 Codex 기록은 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`에 저장되며 Claude 기록과 구조가 다르다. 확인한 record 종류에는 `session_meta`, `turn_context`, `response_item`, `event_msg`, `token_usage_record` 등이 있다.

따라서 v1 Codex 통합은 rollout JSONL을 직접 주 계약으로 삼거나 매 턴 `codex exec`를 재실행하기보다, **Codex App Server를 공식 adapter 경계로 사용**하는 것을 권장한다. 저장 파일 직접 읽기는 App Server가 제공하지 못하는 성능/페이지네이션 요구가 실제로 확인될 때만 fallback으로 검토한다.

## 설계 결정

### 1. 공통 도메인 계약을 먼저 만든다

provider별 원본 형식을 브라우저까지 전달하지 않는다. 서버 내부에서 다음 공통 형식으로 정규화한다.

```js
// session ref
{ provider: 'claude' | 'codex', id, cwd, title, preview, updatedAt, gitBranch?, bytes? }

// run config
{ provider, cwd, sessionId?, model?, access, addDirs? }

// UI event
{ type: 'message.delta' | 'message.completed' | 'tool.started' | 'tool.completed' |
        'turn.completed' | 'run.error' | 'usage' | 'approval.requested', ... }
```

외부 식별자는 항상 `provider`와 `id`를 함께 받는다. 내부 Map 키와 제목 저장 키는 `${provider}:${id}`를 사용한다. URL은 provider를 명시하는 `/api/providers/:provider/sessions/...` 형태로 바꾼다. 전환 기간에는 기존 Claude URL을 얇은 호환 라우트로 남길 수 있다.

### 2. provider registry와 adapter를 둔다

새 `lib/providers/index.js`가 provider lookup과 capability를 제공한다.

```js
{
  id,
  capabilities: { history, resume, images, approvals, bodySearch, addDirs },
  listSessions(query),
  readMessages(sessionId, page),
  searchSessions(query),
  createRun(config)
}
```

run 객체의 최소 계약은 기존과 유사하게 `send(input)`, `interrupt()`, `stop()`, `sessionId`, `busy`, `'event'`로 유지하되, adapter가 공통 UI event만 emit한다.

### 3. Claude 코드는 동작을 바꾸지 않고 adapter 뒤로 이동한다

- 현재 `sessions.js`, `transcript.js`, `search.js`, `runner.js`의 검증된 로직을 Claude provider에서 감싼다.
- 첫 단계에는 대규모 rename보다 wrapper를 우선해 회귀 범위를 줄인다.
- Claude raw event 정규화는 현재 `public/normalize.js` 로직을 서버 측 provider normalizer로 옮기거나 동일 fixture로 양쪽 구현의 결과가 같은지 확인한다.
- Claude MCP 승인 창구는 Claude capability로 남기고 Codex에 일반화하지 않는다.

### 4. Codex는 하나의 장기 실행 App Server client로 연결한다

새 `lib/providers/codex/client.js`가 `codex app-server` 프로세스 한 개를 관리한다.

- 시작 후 `initialize` → `initialized` handshake를 수행한다.
- JSON-RPC request id와 pending promise를 관리한다.
- notification을 thread id 기준으로 해당 run에 라우팅한다.
- 프로세스 종료 시 모든 pending request와 활성 run에 명시적 오류를 전달하고, 다음 안전한 요청에서 재기동한다.
- `thread/list`/`thread/read(includeTurns)`로 목록과 본문을 가져온다.
- 새 대화는 `thread/start`, 기존 대화는 `thread/resume`, 전송은 `turn/start`, 중단은 `turn/interrupt`로 처리한다.
- provider adapter가 Codex item/turn notification을 공통 UI event로 변환한다.
- App Server schema는 현재 Codex CLI에서 생성하되 저장소에는 필요한 안정 subset 또는 fixture만 버전과 함께 고정한다. CLI 업그레이드 시 contract test로 차이를 탐지한다.

### 5. 권한 설정은 공통 enum으로 억지 통합하지 않는다

공통 UI에는 의미 기반 preset만 둔다.

| UI preset | Claude | Codex |
|---|---|---|
| 읽기 전용 | `plan` 중심 설정 | `sandbox: readOnly`와 승인 정책 |
| 작업공간 편집 | `acceptEdits` | `sandbox: workspaceWrite` |
| 전체 접근 | `bypassPermissions` | 명시적 위험 확인 후 full-access 계열 설정 |

실제 CLI 값은 provider adapter가 변환한다. Claude의 `allowedTools`/MCP 승인 질문과 Codex의 sandbox/approval profile은 각각 provider 전용 고급 설정에 둔다. 정확한 Codex approval 요청 왕복은 App Server contract spike에서 확인한 뒤 지원하며, 첫 slice에서 확인되지 않으면 명시적 preset만 지원하고 capability를 `approvals: false`로 표시한다.

### 6. UI는 provider와 capability에 따라 렌더한다

- 새 대화 버튼 근처에 Claude/Codex 선택기를 둔다. 마지막 선택을 localStorage에 저장하되 기본값은 기존 동작 보존을 위해 Claude로 둔다.
- 세션 목록과 탭에 작은 provider badge를 표시한다.
- 설정 sheet의 모델/권한/고급 항목을 선택 provider의 schema로 렌더한다.
- Codex 모델 목록은 코드에 시점별 모델명을 고정하지 않고 기본값 + 직접 입력을 우선한다. 향후 App Server model listing이 안정적으로 필요하면 별도 capability로 추가한다.
- 본문 검색은 provider capability로 분기한다. 첫 Codex slice에서 효율적인 server-side 검색을 제공하지 못하면 Codex에는 제목/경로 검색만 제공하고 UI에서 제한을 명시한다.

## 예상 파일과 심볼

### 새 파일

- `lib/providers/index.js`: registry, provider id 검증, capability 조회
- `lib/providers/claude.js`: 기존 Claude session/run/search adapter
- `lib/providers/codex/client.js`: App Server lifecycle과 JSON-RPC
- `lib/providers/codex/index.js`: Codex session/run adapter와 event normalization
- `lib/events.js`: provider-independent UI event와 message shape helper
- `test/providers/*.test.js`: fixture 기반 contract/normalization/run lifecycle 테스트
- `test/fixtures/claude/*.jsonl`, `test/fixtures/codex/*.jsonl`: 개인정보 없는 최소 fixture

### 변경 파일

- `server.js`: 직접 Claude 모듈 import를 registry로 교체, provider-aware API와 run key 적용, capabilities endpoint 추가
- `lib/runner.js`: Claude adapter가 재사용하도록 유지하거나 `ClaudeRun`으로 명확화
- `lib/sessions.js`, `lib/transcript.js`, `lib/search.js`: 첫 구현에서는 내부 동작 유지; export를 Claude adapter가 소비
- `lib/titles.js`: `${provider}:${sessionId}` 키 지원과 기존 Claude title key의 lazy migration
- `public/normalize.js`: 공통 UI event 소비기로 축소; 기존 Claude raw normalization과 결과 호환 유지
- `public/app.js`: state/tab/API payload에 `provider` 추가, provider별 설정/capability/UI event 처리
- `public/index.html`, `public/style.css`: provider 선택, badge, 동적 설정 필드
- `package.json`: `node --test` 기반 테스트 스크립트와 Codex 관련 설명/keyword 보강
- `README.md`, `DESIGN.md`: 지원 provider, 설치/로그인 조건, 보안/권한 차이, adapter 계약 기록

## API 초안

```text
GET  /api/providers
GET  /api/providers/:provider/sessions?scope=&path=&q=
GET  /api/providers/:provider/sessions/:id/messages?cursor=&limit=
POST /api/providers/:provider/sessions/:id/title
POST /api/runs
     { provider, cwd, sessionId?, settings }
POST /api/runs/:runId/send
POST /api/runs/:runId/interrupt
DELETE /api/runs/:runId
GET  /api/stream
```

`POST /api/runs` 이후 run endpoint에는 provider를 다시 받지 않는다. 서버가 run 생성 시 확정한 provider를 신뢰한다. SSE envelope은 `{runId, provider, ev}`로 확장한다.

## 위험과 대응

- **App Server API/CLI 버전 변화:** 시작 시 버전을 진단 정보로 노출하고, generated schema/fixture contract test로 빠르게 실패하게 한다. raw notification의 unknown type은 버리지 않고 debug event로 보존한다.
- **프로세스 lifecycle 차이:** Claude는 run별 프로세스, Codex는 공유 App Server 연결이다. 공통 인터페이스에서 프로세스 자체가 아니라 thread/run lifecycle만 약속한다.
- **session id 충돌:** 모든 저장/검색/중복 방지/탭 비교를 provider 복합 키로 바꾼다.
- **이벤트 중복:** history load와 live notification이 겹칠 수 있으므로 provider event에서 안정적인 message/item id를 유지하고 UI upsert를 idempotent하게 만든다.
- **권한 의미 불일치:** provider별 원시 값을 공유 enum으로 노출하지 않는다. 위험한 전체 접근은 기존 경고보다 약해지지 않게 한다.
- **Codex transcript 크기:** `thread/read(includeTurns)`의 대형 세션 성능을 spike에서 측정한다. 필요하면 App Server의 turn pagination 안정화 여부를 확인하거나 rollout reader를 제한된 fallback으로 추가한다.
- **이미지 입력:** App Server의 local image input shape와 재개 턴 지원을 fixture/실측으로 확인하기 전에는 Codex capability를 false로 둔다.
- **제로 의존성:** Node 표준 모듈과 stdio JSON-RPC로 구현 가능하므로 유지한다.
- **기존 Claude 회귀:** Claude fixture를 먼저 만들고 현재 정규화 결과를 golden test로 고정한 다음 adapter 이동을 시작한다.

## 결정이 필요한 항목

1. 제품 이름 `ccdesk`는 그대로 유지하는 것으로 가정한다. README 설명은 “Claude Code와 Codex를 위한 로컬 UI”로 확장한다.
2. 첫 릴리스의 기본 provider는 기존 사용자 호환을 위해 Claude로 가정한다.
3. Codex와 Claude 세션 사이의 교차 이어가기/변환은 범위 밖으로 둔다. 각 대화는 생성 provider에서만 resume한다.
4. Codex 본문 전문검색, 승인 요청 UI, 이미지 입력은 contract spike 결과에 따라 첫 릴리스 또는 후속 릴리스로 나눈다.
5. macOS/Linux 동작은 코드 경로를 막지 않되, 현재 프로젝트 관례대로 Windows에서 먼저 검증한다.

## 검증 계획

- 단위 테스트
  - provider registry와 잘못된 provider 거부
  - provider 복합 session key와 기존 Claude title migration
  - Claude fixture의 목록/본문/live event 정규화 회귀
  - Codex JSON-RPC request/response/notification routing
  - Codex item/turn notification → 공통 UI event 변환
  - 두 provider에 동일 session id가 있어도 run/tab/title이 충돌하지 않음
- 통합 테스트
  - 가짜 Claude/Codex child process로 lazy start, send, completion, interrupt, crash/restart 검증
  - HTTP API에서 provider 누락/오류, path 검증, duplicate run 방지 검증
  - 단일 SSE 연결에서 Claude와 Codex run 이벤트가 올바른 탭으로 분리됨
- 로컬 실측
  - `codex app-server` initialize, thread list/read/start/resume, turn start/interrupt
  - Codex 대형 thread의 list/read 시간과 응답 크기
  - workspace-write/read-only/full-access preset의 실제 적용
  - Codex CLI 미설치/미로그인/버전 불일치 안내
  - Windows에서 Claude와 Codex 동시 한 턴 실행
- 정적 검사
  - `node --check` 대상 JS 전체
  - `node --test`
  - 기존 Claude 브라우저 smoke test

## 실행 순서

1. **Codex contract spike:** App Server schema를 임시 위치에 생성하고 list/read/start/resume/turn/interrupt, 이벤트 종류, 권한, 이미지, 대형 history를 실측한다. 결과를 `DESIGN.md`에 기록한다.
2. **회귀 안전망:** 현재 Claude session/transcript/normalizer/run 동작을 fixture와 `node:test`로 고정한다.
3. **공통 계약:** provider registry, capability, provider-aware session/run key, 공통 UI event shape를 추가한다.
4. **Claude adapter:** 기존 로직을 adapter 뒤로 연결하고 기존 UI/API smoke test가 그대로 통과하게 한다.
5. **Codex read path:** App Server client와 thread list/read를 붙여 Codex 세션 목록/본문을 읽기 전용으로 먼저 연다.
6. **Codex run path:** thread start/resume, turn start, streaming, completion, interrupt를 연결한다.
7. **provider-aware UI:** 선택기, badge, 동적 설정, capability별 제한 안내를 추가한다.
8. **보안/오류 처리:** 위험 preset, CLI 없음/로그인 실패, App Server crash, unknown event를 사용자에게 명확히 노출한다.
9. **문서와 최종 검증:** README/DESIGN/package metadata를 갱신하고 두 provider 동시 smoke test를 수행한다.

## 이번 계획에서 하지 않는 구현

이 문서는 승인 전 설계 단계다. 현재 애플리케이션 코드는 변경하지 않는다. 승인 후에도 1단계 contract spike 결과가 위 가정을 뒤집으면, adapter 계약과 단계 구성을 먼저 수정해 다시 확인받는다.
