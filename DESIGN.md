# ccdesk — v1 설계 (계약)

> `README.md` 의 "CLI 를 어떻게 다루는가" 를 먼저 읽을 것. 이 문서는 그 위에 얹는 **v1 의 고정 계약**이다.
> 여기 적힌 **규칙(R1~R10)** 은 구현하다 편해 보인다고 깨지 말 것.
> 깨야 할 이유가 생기면 코드보다 **이 문서를 먼저 고친다.**
>
> 작성: 2026-09-02 · 승인: 사용자 (범위 셋 + 탭 + 마지막 40턴 + 본문검색 v1 제외)

---

## 0. v1 완료 조건

**"내일부터 터미널 대신 이걸로 쓴다."**

기능 목록을 채우는 게 아니라 도그푸딩 가능 시점을 기준으로 순서를 정한다.

---

## 1. 확정된 요구

1. **범위 셋** — 전체 / 루트 지정 / 프로젝트별, 모두 된다
2. **검색** — 제목·경로·브랜치. **본문 전문검색은 v1 제외**
3. **이어가기** — 이전 대화가 **화면에 보인다**. 마지막 40턴 + "위로 더 불러오기"
4. **탭** — 한 창에서 여러 대화를 동시에 띄운다

---

## 2. 불변 규칙

| | 규칙 | 왜 |
|---|---|---|
| **R1** | 폴더명을 역해독하지 않는다. `cwd` 필드를 읽는다 | `...-myapp-web` 은 `myapp\web` 이었다 (README: 세션 기록) |
| **R2** | 목록을 만들자고 파일을 통째로 파싱하지 않는다. 앞 128KB / 뒤 256KB | 374MB 파일이 실재한다 |
| **R3** | 사용자 입력은 **stdin 으로만** 간다. argv 로 보내지 않는다 | `shell:true` 라 셸 인용 사고가 난다 |
| **R4** | claude 프로세스는 **첫 `send()` 에서만** 뜬다 | 탭 10개를 열어도 보기만 하면 프로세스 0 |
| **R5** | 같은 `sessionId` 를 두 run/두 탭에 열지 않는다 | 한 jsonl 에 두 프로세스 = 파일 손상 위험(미확인) |
| **R6** | SSE 는 **연결 하나**. 모든 이벤트에 `runId` 를 붙인다 | 브라우저 동시 연결 6개 제한 |
| **R7** | 모델 출력은 신뢰 입력이 아니다. 렌더 전 **반드시 이스케이프** | |
| **R8** | 서버는 `127.0.0.1` + **토큰 + Origin 검사** | 아무 웹페이지나 `POST /api/runs` 를 쏠 수 있다. 그 끝은 임의 경로에서 `bypassPermissions` 실행이다 |
| **R9** | `permission_denied` 를 조용히 삼키지 않는다 | 헤드리스엔 승인 왕복이 없다 (README: 권한) |
| **R10** | `public/normalize.js` 는 **브라우저와 서버가 함께 쓴다**. `node:` 모듈을 import 하지 않는다 | 과거/실시간 렌더러가 갈라지지 않게 |

---

## 3. 메시지 모델 — 이 설계의 축

**실측(2026-09-02):** jsonl 의 `assistant` 라인은 `message` 안에 **Anthropic API 메시지 객체 그대로**를 담는다.
`content` 는 `text` / `tool_use` 블록 배열이고, `tool_result` 는 **다음 `user` 라인**에 붙는다.
stream-json 의 `assistant` 이벤트도 같은 `message` 를 싣는다.

→ **과거와 실시간이 같은 모양이다. 그래서 렌더러는 하나다.**

### 정규화 결과

```js
message = {
  id,                       // message.id (없으면 uuid)
  role,                     // 'human' | 'assistant' | 'notice'
  ts,                       // ISO 문자열
  blocks: [ ... ],
  meta,                     // 선택: { model, usage, costUsd, durationMs, numTurns }
  streaming,                // 선택: 아직 흘러오는 중
}
```

```js
block =
  | { type:'text',     text }
  | { type:'thinking', text }
  | { type:'tool',     id, name, input, result, isError, state:'running'|'done' }
  | { type:'notice',   level:'denied'|'error'|'exit'|'stderr'|'info', text }
```

### 두 가지 접기

- **`tool_use` + `tool_result` 를 한 블록으로 합친다.** 도구 결과를 담은 `user` 라인은
  사람이 친 말이 아니므로 별도 메시지로 만들지 않고, 앞선 `tool_use` 블록의 `result` 에 넣는다.
  → UI 의 "도구 호출 접기"가 공짜로 나온다. 실시간에서는 `state:'running'` 으로 먼저 보이고 결과가 오면 `'done'`.
- **같은 `message.id` 를 가진 여러 라인은 한 메시지로 합친다.** jsonl 은 한 턴을 여러 줄로 쪼개 적는다.

### 제외

- `isSidechain === true` — 서브에이전트 대화. 목록에도 본문에도 넣지 않는다
- `attachment` / `file-history-*` / `atis-latch` 등 메타 라인

### ✅ stream_event 내부 (2026-09-02 실측)

찍어보니 이렇게 온다:

- 종류: `message_start` · `content_block_start` · `content_block_delta` · `content_block_stop` · `message_delta` · `message_stop`
- 델타: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}`
- **`message_start` 의 `message.id` 는 뒤에 오는 `assistant` 이벤트의 id 와 같다.**

⚠️ 다만 **그 id 를 믿고만 있으면 안 된다.** SSE 가 끊겼다 다시 붙으면(EventSource 는 자동 재연결한다)
`message_start` 를 놓친 채 델타부터 받게 되고, 그러면 조각으로 만든 임시 메시지와 완성본이
따로 남아 **같은 답이 두 번 보인다.** 그래서 `assistant` 이벤트는 id 로 못 찾으면
흘러오던 중이던 마지막 메시지를 그것으로 본다.

또 하나 — `assistant` 이벤트는 완성본을 통째로 싣고 오므로 **갈아끼워야** 하고,
jsonl 은 한 턴을 여러 줄로 쪼개 적으므로 **더해야** 한다. 이 둘을 같은 코드로 처리하면 글이 두 번 쌓인다.

---

## 4. API 계약

### 인증 (R8)

- 기동 시 `token = randomUUID()`. 창은 `http://127.0.0.1:PORT/?t=<token>` 으로 연다
- 클라이언트는 모든 `/api/*` 에 `X-CCDesk-Token` 헤더를 붙인다
- 서버는 **토큰 불일치 또는 낯선 `Origin`** 이면 403. 토큰은 URL 에만 있으므로 남의 페이지는 못 읽는다

### 엔드포인트

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `/api/scan?scope=all\|root\|project&path=&q=` | 세션 목록(평면) + 추천 루트 |
| GET | `/api/sessions/:id/messages?before=&limit=40` | 정규화된 메시지 + `cursor` + `hasMore` |
| POST | `/api/runs` | `{cwd, sessionId?, permissionMode, allowedTools[], model?}` → `{runId, sessionId}` |
| POST | `/api/runs/:id/send` | `{text}` |
| POST | `/api/runs/:id/interrupt` | |
| DELETE | `/api/runs/:id` | |
| GET | `/api/stream` | **SSE 하나.** `data: {runId, ev}` (R6) |

- `before` 는 **바이트 오프셋**이다. 뒤에서부터 읽으므로 "위로 더"는 이 값을 물려주면 된다
- run 은 메모리 `Map`. 서버가 죽어도 된다 — 대화는 CLI 가 파일에 남긴다
- SSE 는 15초마다 주석(`:\n\n`)을 보낸다

---

## 5. 화면

3화면 순차 이동은 탭과 맞지 않는다(대화가 여럿인데 "돌아갈" 목록이 없다). **패널형**으로 간다.

```
┌──────────────┬─────────────────────────────────┐
│ 범위         │ [대화1] [대화2*] [+]            │
│  ○ 전체      ├─────────────────────────────────┤
│  ● 루트      │                                 │
│  ○ 프로젝트  │  대화 본문 (마지막 40턴)        │
│ [경로_____]  │   ↑ 위로 더 불러오기            │
│ [검색_____]  │                                 │
├──────────────┼─────────────────────────────────┤
│ 세션 목록    │  입력창 (크게, 여러 줄)         │
└──────────────┴─────────────────────────────────┘
```

- ⚠️ **브라우저 폴더 선택 다이얼로그는 절대경로를 주지 않는다.**
  루트 지정은 **경로 직접 입력 + 최근 목록 + 기존 `cwd` 들에서 뽑은 공통 상위** 제시로 한다
- 탭 상태: `{tabId, sessionId, cwd, title, runId, messages, scroll, draft, unread}`
- 탭 전환은 **숨김/표시**다. 스크롤 위치·입력 중이던 글·스트리밍이 유지된다
- 백그라운드 탭에서 `result` 가 오면 배지
- 이미 열린 세션을 다시 고르면 **그 탭으로 포커스** (R5)
- `Enter` 전송 / `Shift+Enter` 줄바꿈
- **그릴 때 바뀐 메시지만 갈아끼운다.** 이벤트마다 전체를 다시 그리면 펼쳐둔 도구 블록이 닫히고
  스크롤이 조금씩 어긋나다 맨 위로 올라간다. 메시지 id 로 DOM 을 들고 있다가 달라진 것만 새로 만든다.
  펼침 상태는 도구 id 로 탭이 따로 기억한다
- **답을 기다리는 중에도 계속 칠 수 있다.** 줄을 세워 입력칸 위에 보여주고, 앞 턴이 끝나면 차례로 나간다.
  누르면 입력칸으로 되돌아와 고칠 수 있다
- 마크다운은 의존성 없이 직접. 코드펜스·인라인코드·헤딩·목록·링크·표. **이스케이프 먼저**(R7)

---

## 6. 파일 배치

| 파일 | 역할 | 상태 |
|---|---|---|
| `lib/sessions.js` | 목록용 메타 (앞/뒤만 읽음) | ✅ 있음 — **건드리지 않는다** |
| `lib/transcript.js` | **본문을 뒤에서부터 N턴** 읽기 | ✅ 실측 통과 (374.8MB 마지막 10턴 28ms) |
| `lib/runner.js` | claude 자식 프로세스 | ✅ 있음 |
| `public/normalize.js` | 정규화 — **양쪽이 함께 씀** (R10) | ✅ |
| `server.js` | HTTP + SSE + 인증 | ✅ 실측 통과 (토큰·Origin 403 포함) |
| `public/*` | 화면 | ✅ 1턴 왕복·탭 전환 확인 |

---

## 7. 순서

- **0단계** 계약 확정 — 이 문서 + `normalize.js` + `transcript.js`
- ~~**1단계** 뼈대 관통~~ **완료 (2026-09-02)** — 목록·범위·검색·본문복원·탭·1턴 왕복까지 브라우저에서 확인. 남은 것: 마크다운 전체·중단 실측·동시 실행 방어
- **2단계** 탭 다중화 + 과거 대화 복원
- **3단계** 대화 화면 품질 — 마크다운·도구 접기·`permission_denied`·스트리밍·비용·중단
- **4단계** README·LICENSE·PATH 안내·동시 실행 경고

1단계에 값싼 수정 셋을 동봉한다: `updatedAt` 을 mtime → tail 의 마지막 `timestamp`,
스크래치패드 프로젝트 필터, `readEdges` 의 `dropFirst` 오프바이원.

---

## 8. v1 에 넣지 않는 것

- 본문 전문검색 (색인이 필요하다 — 별건)
- macOS·Linux 지원 (미확인)
- 가상 스크롤 (40턴이면 필요 없다)
- Agent SDK / `canUseTool` — **v2 후보.** `runner.js` 의 인터페이스(`send`/`interrupt`/`'event'`)를
  그대로 두고 속만 갈아끼울 수 있게 유지한다. 전환 트리거는 "권한 거부가 답답해지는 순간"

---

## 9. 2026-09-02 추가 실측

### 9.1 이미지는 stdin 으로 들어간다 ✅

stream-json stdin 의 `content` 에 API 형식 그대로 실으면 CLI 가 받는다. 순서는 **이미지 먼저, 글 나중**.

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}},
  {"type":"text","text":"..."}]}}
```

1×1 PNG 두 장으로 확인했다. 모델이 "안보임"이 아니라 색 이름을 답했다 —
**받았다는 것까지가 확인된 것**이고, 1픽셀 그림의 색 이름 자체는 믿을 근거가 못 된다.
서버 → `runner` → CLI 전 구간도 통과했다(`POST /api/runs/:id/send` 에 `images` 를 실어 200).

붙임 제한: **5MB**, `png` / `jpeg` / `gif` / `webp`. 그 밖은 조용히 버린다.

### 9.2 ⚠️ acceptEdits 가 막는 것은 "복합 명령"이다

권한이 도구 단위로만 걸린다고 생각하면 틀린다. `acceptEdits` 에서 단일 `echo` 는 통과했지만,
`A && B` 처럼 승인이 필요한 조각이 섞이면 거부된다. 실제로 돌아온 문구:

> This Bash command contains multiple operations. The following part requires approval: `node --check public/app.js`

- 이건 `system/permission_denied` 가 **아니라** `tool_result` 의 `is_error` 로 온다. R9 의 알림 경로로는 안 잡힌다
- 그래서 UI 는 **오류 사유의 첫 줄을 접힌 채로도** 보여준다. 안 그러면 화면엔 "오류" 두 글자뿐이다
- 풀려면 `bypassPermissions` 를 고르거나, 명령을 쪼개 보내야 한다

### 9.2c ✅ 승인 왕복은 만들 수 있다 — `--permission-prompt-tool`

"헤드리스엔 승인 왕복이 없다"(R9 의 근거)는 **절반만 맞았다.** 창구가 없을 때만 그렇다.
CLI 안에 이렇게 적혀 있다:

> With a permission prompt surface (stdio/SDK canUseTool), the 'ask' path surfaces via a
> can_use_tool control_request. Without one (bare `-p`), 'ask' decisions are terminal.

시도한 것과 결과:

| 방법 | 결과 |
|---|---|
| `--permission-mode manual` 만 | ❌ 안 물어온다. `system/init` 은 `permissionMode: default` 로 보고하고 거부 |
| stdin 으로 `initialize` 제어 요청 | ❌ 응답 없음. `system/init` 의 capabilities 에도 권한 관련이 없다 |
| **`--permission-prompt-tool` + MCP 도구** | ✅ **된다.** Write 를 물어왔고, allow 로 답하니 파일이 생겼다 |

그래서 `lib/mcp-ccdesk.js` 를 뒀다. MCP 는 stdio 위의 JSON-RPC 라 패키지 없이 직접 말한다.
CLI 가 그 서버를 띄우므로 ccdesk 서버와는 다른 프로세스이고, HTTP 로 다시 이어 붙인다.

- 서버는 물음이 오면 **그 HTTP 응답을 닫지 않고 붙들고 있다가** 사용자가 누르면 돌려준다
- 물어볼 수 없으면 거부한다. 10분 지나도 거부한다
- 대화를 닫거나 서버가 내려가면 대기 중인 물음을 전부 거부로 닫는다 — 안 그러면 MCP 쪽이 영영 기다린다

### 9.2d ✅ 모델이 주는 선택지도 만들 수 있다 — 우리가 도구를 만든다

`AskUserQuestion` 은 헤드리스 도구 목록에 **없다**(69개 중 없음. `--brief` 를 켜도 같다).
그래서 기다리지 않고 같은 일을 하는 도구를 직접 만들었다 — `mcp__ccdesk__ask_choice`.

승인 창구를 만들며 이미 MCP 서버가 돌고 있으므로 도구 하나를 더 얹는 것으로 끝난다.
답을 CLI 가 만드는 게 아니라 **우리가 만들어 돌려주므로** 불확실성이 없다.

실측: 모델이 질문과 선택지 3개로 호출 → 카드가 뜸 → 고른 값이 도구 결과로 돌아감 →
모델이 그 값을 알고 이어감("일식 돈카츠를 고르셨습니다").

⚠️ 여기서 하나 데었다. `runner` 가 `mcpConfigPath && permissionPromptTool` **둘 다 있을 때만**
`--mcp-config` 를 넘기고 있었다. 그래서 "승인은 끄고 선택지만" 을 고르면 MCP 서버가
아예 안 붙었다(`system/init` 의 `mcp_servers` 에 ccdesk 가 없었다). 두 조건을 갈랐다.
**`--mcp-config` 는 기존 MCP 설정을 덮지 않고 더한다** — 사용자의 다른 서버는 그대로 살아 있다.

### 9.2b `--add-dir` 은 효과를 확인하지 못했다

ccdesk 안에서 작업 폴더 밖을 못 읽는 일이 있어 "`--add-dir` 을 안 넘겨서"라고 판단했는데, **틀렸다.**

`--permission-mode plan` + `--allowedTools Read` 로 작업 폴더 밖 파일을 읽게 해보니
**`--add-dir` 이 있으나 없으나 똑같이 읽혔다.** 둘 다 `Read` 를 썼고 결과가 같았다.

실제로 막혔던 것은 **Bash** 였다(`ls ... was blocked`). 그건 권한 모드가 빡빡해서 생긴 일이고,
`bypassPermissions` 로 바꾸니 사라졌다. 즉 그때의 원인은 권한이지 작업 폴더 목록이 아니었다.

→ 설정의 "추가 폴더" 칸은 남겨두되, **효과가 실측되지 않았다**고 적어둔다.
값 검사(절대경로·셸 메타문자·실재 여부)는 어차피 필요하므로 그대로 둔다.

### 9.3 ⚠️ 동시 실행이 실제로 일어났다 — 더 이상 미확인이 아니다

사용자가 ccdesk 에서 **터미널이 쓰고 있던 바로 그 세션**을 열어 대화했다.
ccdesk 가 `--resume <같은 id>` 로 붙어 **한 jsonl 에 두 프로세스**가 물렸다.

관측된 결과:

- 두 쪽이 같은 파일(`public/app.js`)을 고쳐 **서로의 편집을 덮었다.** 한쪽에는 정의되지 않은
  함수 호출(`autoGrow()`)이 남아 모듈 로드가 실패했고 화면이 통째로 비었다
- 대화가 갈라졌다. 한쪽에서 한 말이 다른 쪽에 안 보인다
- 기록 파일 자체는 깨지지 않았다 — 줄 단위 append 라 서로 다른 줄로 남았다

→ **R5 를 넓힌다.** ccdesk 안의 중복만 막는 걸로는 부족하다.

- 최근 갱신된 세션은 목록에 `● 진행 중` 으로 표시한다 (판단 근거는 mtime 90초. 확실히 아는 방법은 없다)
- 그런 세션을 열면 **보기 전용**으로 시작한다. 뒤에 붙는 줄을 3초마다 따라 읽어 보여주되 **아무것도 쓰지 않는다**
- 이어가려면 사용자가 경고를 확인하고 명시적으로 눌러야 한다
