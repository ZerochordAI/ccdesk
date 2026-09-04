# Codex App Server 통합

## 검증 기준

- 공식 OpenAI App Server 문서와 로컬 `codex-cli 0.153.0`의 stable v2 generated JSON Schema를 기준으로 한다.
- schema 생성은 설계 검증용 임시 디렉터리에서 수행했다. 생성물을 런타임 의존성으로 배포하지 않는다.
- 로컬 schema에서 `thread/list`, `thread/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, item/turn notification과 승인 server request가 존재함을 확인했다.

## 프로세스 모델

ccdesk 서버당 `codex app-server --stdio` 프로세스 하나를 lazy singleton으로 둔다.

```text
first Codex request
  → spawn app-server
  → initialize(clientInfo)
  → initialized notification
  → ready

ready
  → concurrent JSON-RPC requests
  → thread-scoped notifications routed to CodexRun

unexpected exit
  → reject every pending request
  → fail every active turn
  → discard connection generation
  → restart on next explicit request
```

자동 재시작 후 진행 중 turn을 자동 재전송하지 않는다. 중복 수정 가능성이 있기 때문이다.

## Client 상태

```js
{
  state: 'stopped' | 'starting' | 'ready' | 'failed' | 'stopping',
  generation: number,
  process: ChildProcess | null,
  nextRequestId: number,
  pending: Map<requestId, {resolve,reject,timer,generation}>,
  runsByThread: Map<threadId, CodexRun>,
  buffer: string,
  version: string | null
}
```

- 한 줄에 JSON 객체 하나를 읽고 쓴다.
- malformed JSON은 해당 줄만 격리하고 protocol diagnostic을 남긴다.
- response는 `id`, notification은 `method`, server request는 `method`와 `id`로 구분한다.
- 요청 timeout은 method별로 둔다. turn 수행은 request timeout이 아니라 `turn/completed`로 닫는다.
- process generation이 다른 늦은 response는 버린다.

## 초기화

```json
{"method":"initialize","id":1,"params":{"clientInfo":{"name":"ccdesk","title":"ccdesk","version":"<package version>"}}}
{"method":"initialized","params":{}}
```

초기 구현은 experimental capability를 켜지 않는다. 필요한 동작이 stable API에 없을 때 별도 설계 결정으로 추가한다.

## 세션 목록

`thread/list`의 stable fields 중 다음만 공통 session model에 사용한다.

| Codex thread | ccdesk session |
|---|---|
| `id` | `id` |
| `cwd` | `cwd` |
| `name` 또는 `preview` | `title` |
| `preview` | `preview` |
| `createdAt` | `startedAt` |
| `updatedAt` | `updatedAt` |
| `gitInfo.branch` | `gitBranch` |
| `model` | provider metadata |

`thread/list` params에는 `cwd`, `cursor`, `limit`, `searchTerm`, `sortDirection`, `sortKey`가 있음을 확인했다. 전체 목록은 cursor를 따라 읽고, 화면 요청 단위 pagination은 provider cursor를 opaque하게 감싼다.

root/project scope는 가능한 경우 `cwd` 필터를 provider에 전달하고, 하위 root 포함 필터는 반환된 canonical cwd를 ccdesk가 검사한다. Windows path 비교는 case-insensitive normalization을 사용한다.

## 본문 조회

첫 구현은 `thread/read {threadId, includeTurns:true}`를 사용한다. 반환된 `thread.turns[].items[]`를 공통 message model로 변환한다.

- 사용자 입력 item → human message
- agent message item → assistant text blocks
- command execution item → tool block
- file change item → tool block
- MCP/tool item → tool block
- reasoning item → 기본적으로 접힌 thinking block 또는 capability 설정에 따라 생략
- 오류/경고 → notice block

대형 thread 성능을 실측한 뒤 다음 중 하나를 선택한다.

1. 충분히 빠르면 전체 read 후 마지막 N turn을 반환한다.
2. stable pagination API가 이용 가능하면 provider cursor 방식으로 전환한다.
3. 둘 다 불가능할 때만 rollout JSONL tail reader를 보조 구현한다.

세션 파일 직접 파싱은 최후 fallback이며 Codex protocol의 source of truth가 아니다.

## 새 thread와 resume

새 대화:

```json
{"method":"thread/start","id":10,"params":{"cwd":"C:\\repo","model":"...","approvalPolicy":"...","sandbox":{"type":"workspaceWrite"}}}
```

기존 대화:

```json
{"method":"thread/resume","id":11,"params":{"threadId":"<id>","cwd":"C:\\repo","approvalPolicy":"...","sandbox":{"type":"workspaceWrite"}}}
```

- request 성공 응답의 `thread.id`를 run의 canonical session id로 사용한다.
- resume 후에도 turn을 시작하기 전까지 busy가 아니다.
- 같은 Codex thread에 둘 이상의 ccdesk run을 허용하지 않는다.
- 외부 Codex UI가 이미 active 상태인 thread의 resume 정책은 실측 후 결정한다. 안전한 기본은 보기 전용과 명시적 takeover 확인이다.

## turn 실행

```json
{"method":"turn/start","id":20,"params":{"threadId":"<id>","input":[{"type":"text","text":"..."}]}}
```

성공 response에서 `turn.id`를 저장한다. 이후 notification을 `(threadId, turnId)`로 검증한다.

주요 notification mapping:

| App Server | Provider event |
|---|---|
| `turn/started` | run busy 시작 |
| `item/started` | message/tool started |
| `item/agentMessage/delta` | `message.delta` |
| command output delta | `tool.delta` |
| `item/completed` | message/tool completed |
| token usage update | `usage.updated` |
| `turn/completed` | `turn.completed` |

`item/completed`가 이미 완성된 text를 포함하더라도 delta 뒤에 append하지 않고 동일 item id를 replace/upsert한다.

## 중단과 추가 입력

- 중단은 `turn/interrupt {threadId, turnId}`를 호출한다.
- `turn/completed`의 최종 status가 올 때까지 run을 busy로 유지한다.
- 기존 ccdesk queue는 중단 시 자동 flush하지 않는다.
- App Server의 `turn/steer`가 존재하지만 첫 구현에서는 사용하지 않는다. 대기열 의미를 유지하고 앞 turn 완료 후 새 `turn/start`로 전송한다.

## 승인과 사용자 질문

stable generated schema에서 다음 server request를 확인했다.

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

App Server가 ccdesk에 request를 보내면:

1. client가 request id와 thread/turn ownership을 검증한다.
2. CodexRun이 공통 `approval.requested`를 emit한다.
3. 브라우저가 기존 승인 카드 영역에 provider별 choice를 표시한다.
4. 답을 받으면 원래 JSON-RPC request id에 response를 보낸다.
5. timeout, 탭 종료, turn 종료 시 fail-closed 답을 보낸다.

Claude의 MCP approval bridge와 Codex JSON-RPC server request는 UI event만 공유한다. transport 코드는 공유하지 않는다.

## 권한 preset

정확한 `approvalPolicy` 값과 sandbox object shape는 generated schema fixture로 고정한다. 사용자에게는 다음 의미를 노출한다.

| preset | sandbox | 의도 |
|---|---|---|
| `readOnly` | read-only 계열 | 파일 변경 차단 |
| `workspaceWrite` | workspace-write 계열 | 프로젝트 범위 편집 |
| `fullAccess` | danger-full-access 계열 | 명시적 위험 승인 후 전체 접근 |

관리형 permission profile이 있는 환경은 profile discovery를 별도 후속 기능으로 취급한다. 첫 구현은 stable legacy sandbox/approval fields를 사용한다.

## 이미지

로컬 schema의 `UserInput`은 `image`와 `localImage`를 포함한다. 브라우저는 현재 base64 이미지를 보내므로 adapter에는 변환 단계가 필요하다.

- data URL input이 schema와 실측에서 허용되면 메모리 내 변환을 사용한다.
- local path만 안정적이면 ccdesk 전용 임시 디렉터리에 파일을 만들고 turn 완료/실패/stop 때 삭제한다.
- 형식과 크기 제한은 현재 png/jpeg/gif/webp, 5MB 이하를 유지한다.
- 임시 파일 경로는 workspace가 아니라 OS temp 아래의 ccdesk 전용 절대 경로로 제한한다.

## 오류와 진단

사용자에게 보여줄 상태:

- Codex CLI 없음
- App Server 시작/initialize 실패
- 인증 필요
- protocol/schema 불일치
- thread 없음 또는 archive 상태
- approval timeout/거부
- provider process 종료

진단에는 ccdesk build, Codex CLI version, App Server connection state를 포함한다. `auth.json`, access token, 전체 environment, 원본 사용자 prompt는 표시하거나 기록하지 않는다.

## 실측이 남은 항목

- 실제 `thread/list`와 `thread/read` latency 및 대형 thread 크기
- active thread를 다른 Codex client에서 resume할 때 동작
- approval response choice의 정확한 값과 timeout 동작
- `turn/completed`의 interrupted/error status 종류
- base64/data URL 이미지 입력 가능 여부
- App Server crash 후 같은 thread resume 안정성

이 항목은 구현 전에 disposable test thread 또는 mock protocol fixture로 확인한다. 기존 사용자 thread에는 test turn을 보내지 않는다.
