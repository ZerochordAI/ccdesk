# ccdesk 효율성 검토

## 결론

현재 구조는 대화 수가 적을 때 충분히 가볍지만, 목록 갱신과 대형 Codex thread에서 작업량이 사용자 데이터 크기에 비례해 빠르게 늘어난다. 다음 순서로 개선하는 것이 효과가 크다.

## 적용 상태

- ✅ provider별 3초 session snapshot과 single-flight
- ✅ 브라우저의 이전 scan 취소 및 stale response 차단
- ✅ Codex 최근 40턴 정규화와 3초 history cache
- ✅ 탭 종료 시 진행 중 Codex turn 중단 및 `thread/unsubscribe`
- 실측: Codex session 첫 조회 632ms → cache 조회 0ms, 본문 첫 조회 73ms → cache 조회 0ms
- 아래 P1·P2 항목은 후속 개선 후보다.

## P0 — 먼저 수정

### 1. provider별 세션 목록 cache와 single-flight

- 현재 `GET /api/scan`마다 Claude의 `scanAll()`과 Codex의 paginated `thread/list`를 다시 수행한다.
- Claude는 같은 요청 안에서도 provider 조회와 root 추천을 위해 별도 scan 경로를 지난다.
- 브라우저 검색 입력은 180ms debounce라 입력 중 여러 scan이 겹칠 수 있고 이전 응답이 새 응답 뒤에 도착할 수도 있다.

수정안:

- provider별 전체 session snapshot을 2~5초 TTL로 cache한다.
- 동일 provider scan은 in-flight Promise를 공유한다.
- scope/path/query는 snapshot 위에서 메모리 필터링한다.
- 브라우저는 `AbortController`와 request sequence를 사용해 오래된 응답을 폐기한다.
- 외부 session 변경 감지는 짧은 TTL 또는 provider notification으로 cache를 무효화한다.

### 2. Codex 본문 전체 read 반복 제거

- 현재 Codex 본문 요청은 `thread/read(includeTurns:true)`로 thread 전체를 가져온 뒤 정규화한다.
- UI의 `limit=40`이 Codex에서는 적용되지 않는다. 큰 thread를 다시 열 때 전체 history와 tool payload를 반복 전송한다.

수정안:

- 우선 `(threadId, updatedAt)` 기준 정규화 결과 cache를 추가하고 마지막 40턴만 HTTP로 반환한다.
- stable turn pagination이 제공되면 provider cursor로 교체한다.
- 대형 thread benchmark에서 임계치를 넘을 때만 rollout tail reader fallback을 검토한다.

### 3. Codex thread 구독 해제

- 탭을 닫을 때 `CodexRun.stop()`은 로컬 Map만 지우며 App Server의 `thread/unsubscribe`를 호출하지 않는다.
- App Server는 마지막 subscriber가 사라져도 유휴 thread를 일정 시간 메모리에 유지하므로 탭을 많이 열고 닫으면 메모리가 늦게 회수된다.

수정안:

- stop을 async/idempotent하게 만들고 `thread/unsubscribe`를 best-effort로 호출한다.
- 서버 shutdown은 unsubscribe 완료를 짧은 timeout 안에서 기다린 뒤 child process를 종료한다.

## P1 — 사용량이 늘기 전에 수정

### 4. 검색 I/O 동시성 제한

- Claude 본문 검색은 최대 25개 파일의 512KB tail을 `Promise.all`로 동시에 읽어 최대 약 12.5MB를 한꺼번에 할당한다.

수정안: worker 4개 정도의 작은 concurrency pool을 사용하고 검색 취소 신호를 전달한다.

### 5. 이미지 base64 복사 감소

- 브라우저 FileReader, JSON stringify, HTTP body parse, Codex data URL 구성 과정에서 5MB 이미지가 여러 문자열 복사본으로 존재한다.

수정안: 이미지 전용 upload endpoint로 OS temp에 저장한 뒤 provider에는 local path를 전달하고 turn 종료 시 정리한다. 업로드 token, MIME signature, 크기, 소유 run을 검증한다.

### 6. App Server request backpressure

- JSON-RPC pending request 수와 stdout buffer 크기에 상한이 없다.

수정안: pending request와 line/buffer 최대 크기를 제한하고 초과 시 해당 provider만 재시작한다. 사용자 prompt를 포함할 수 있는 raw protocol line은 로그에 남기지 않는다.

## P2 — 유지보수 효율

### 7. `server.js` route 분리

- HTTP 인증, Claude MCP 승인, provider routing, static serving이 한 파일에 있어 변경 영향 범위가 넓다.

수정안: `lib/http/api.js`, `lib/runs.js`, `lib/approvals.js`로 책임을 분리하되 외부 API 계약은 유지한다.

### 8. provider contract test 확대

- 현재 테스트는 식별자와 핵심 normalization만 보호한다.

수정안: 가짜 stdio child로 initialize, request timeout, malformed JSON, process crash, approval response, unsubscribe를 검증한다. HTTP aggregate scan의 stale response도 테스트한다.

### 9. 브라우저 렌더링 계측

- 메시지 DOM은 id별 재사용을 하지만 긴 대화에서 markdown 변환과 높이 측정 비용을 수치로 기록하지 않는다.

수정안: 40/100/500 message fixture로 render 시간을 측정하고, 필요할 때만 viewport virtualization을 도입한다.

## 권장 실행 순서

1. scan cache + stale request 방지
2. Codex thread cache/최근 40턴 반환
3. thread unsubscribe
4. JSON-RPC mock tests
5. 검색 concurrency pool
6. 이미지 temp upload
7. route 분리와 렌더 benchmark
