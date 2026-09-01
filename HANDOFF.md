# ccdesk — 인계 문서

> 이 문서를 먼저 읽고 이어서 작업할 것.
> 여기 적힌 "실측" 항목은 전부 **이 머신에서 직접 돌려 확인한 것**이다. 추측이 아니다.
> 반대로 "미확인"이라고 적힌 것은 확인하지 않았다는 뜻이다 — 사실로 가정하지 말 것.
>
> 작성: 2026-09-02 · 환경: Windows 11, Node v22.18.0, npm 11.12.1, claude 2.1.251

---

## 1. 무엇을 만드는가

터미널에서 Claude Code 를 쓰는 게 불편해서 만드는 **작은 로컬 UI** 다.

사용자가 정의한 동작은 이 셋이 전부다.

1. 실행하면 **경로를 고르게** 한다
2. 그 경로의 **대화 목록**을 띄운다
3. 하나를 고르면 **그 대화를 이어간다**

### 만들지 않는 것

- IDE 확장이나 웹앱의 재구현 — 이미 공식으로 있다. 탭 전환 없는 **전용 창**이 존재 이유다
- 터미널 에뮬레이터 — 우리는 대화 UI 만 만든다
- Electron — 무겁다. 아래 4절의 방식으로 창을 띄운다

---

## 2. 결정된 것 (사용자 승인)

| 항목 | 결정 | 이유 |
|---|---|---|
| Claude 연결 방식 | **CLI 자식 프로세스** (`claude -p`) | 의존성 0, 오늘 바로 도는 v1 |
| 권한 처리 | **세션 시작 시 한 번 선택** | 헤드리스에는 도구별 승인 왕복이 없다 (3절) |
| 별도 repo | **예** — 블로그 repo 와 분리 | 이 폴더가 그 repo 다 |
| 라이선스 | MIT | |

권한 모드는 UI 에서 이렇게 고르게 하기로 했다.

```
권한 모드
  ( ) 읽기전용    - plan             계획만, 파일 안 건드림
  (•) 편집허용    - acceptEdits      파일 편집 자동 승인
  ( ) 전체허용    - bypassPermissions  Bash 포함 전부 (주의)
  ( ) 화이트리스트 - --allowedTools    Read,Grep,Edit ...
```

> **Agent SDK 로 갈아타면** `canUseTool` 콜백이 있어 터미널처럼 도구마다 승인/거부를
> 물어볼 수 있다. 사용자는 "우선 CLI 로 만들고, 써보고 아쉬우면 그때" 로 정했다.
> 즉 이건 **버려진 선택지가 아니라 v2 후보**다.

---

## 3. 실측한 사실 — 이게 이 문서의 핵심이다

전부 직접 돌려 확인했다. 다시 확인하느라 시간 쓰지 말 것.

### 3.1 stream-json 입출력

```bash
claude -p --output-format stream-json --input-format stream-json \
       --include-partial-messages --verbose --permission-mode acceptEdits
```

- **stdin 포맷** (한 줄에 하나, 개행으로 끝):
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
  ```
- **프로세스가 턴을 넘어 살아 있다.** stdin 을 열어두면 여러 턴을 한 프로세스로 처리한다.
  2턴 시험에서 맥락도 이어졌다(1턴에 숫자를 외우게 하고 2턴에 물으니 맞혔다).
- `--verbose` 는 `-p` + stream-json 조합에서 **필수**다.
- 관측된 이벤트 타입:
  `system/hook_started`, `system/hook_response`, `system/init`, `system/status`,
  `stream_event`(부분 출력), `assistant`, `rate_limit_event`, `result/success`
- `system/init` 에 들어 있는 것: `session_id`, `cwd`, `tools[]`, `mcp_servers[]`,
  `model`, `permissionMode`, `slash_commands[]`, `skills[]`, `claude_code_version`
- `result` 에 들어 있는 것: `result`(최종 텍스트), `usage`, `total_cost_usd`,
  `duration_ms`, `num_turns`, `permission_denials[]`, `is_error`
- 모든 이벤트에 `session_id` 가 붙는다.

### 3.2 ⚠️ 헤드리스에는 권한 승인 왕복이 없다

가장 중요한 제약이다. 기본 권한 모드에서 `Write` 를 시켜보니:

```
assistant  TOOL:Write
system/permission_denied
user       (거부됐다는 통보)
assistant  "Write permission was denied, so ..."
result/success   permission_denials:[{tool_name:"Write", ...}]
```

**되묻지 않고 그냥 거부한다.** 파일은 만들어지지 않았다.
그래서 권한은 프로세스를 띄울 때 정해야 하고, UI 는 `system/permission_denied` 를
사용자에게 그대로 보여줘야 한다(조용히 삼키면 왜 안 되는지 알 수 없다).

### 3.3 세션 저장 구조

- 위치: `~/.claude/projects/<인코딩된경로>/<sessionId>.jsonl`
- **⚠️ 폴더명을 역해독하지 말 것.** 드라이브 문자 대소문자가 뒤섞이고, `.` 도 `-` 가 되고,
  하위 폴더도 `-` 라서 되돌릴 수 없다.
  실제로 `c--Users-JunHyun-Documents-GitHub-NPLogic-web` 는 `NPLogic-web` 이 아니라
  **`NPLogic\web`** 이었다. 역해독했으면 틀렸을 것이다.
  → **세션 파일 안의 `cwd` 필드를 읽어라.** 이게 언제나 진짜 경로다. (구현돼 있음)
- 한 줄이 하나의 JSON. `type` 값이 여러 가지다:
  `user`, `assistant`, `attachment`, `system`, `mode`, `permission-mode`,
  `file-history-snapshot`, `ai-title`, `last-prompt`, `agent-name`, `atis-latch` 등
- `user`/`assistant`/`system` 라인에 `cwd`, `gitBranch`, `version`, `timestamp`, `sessionId` 가 있다
- **`ai-title` 라인에 사람이 읽을 제목이 있다.** 목록에 이걸 써야 한다:
  ```json
  {"type":"ai-title","aiTitle":"NPLogic desktop 이어작업 컨텍스트 인계","sessionId":"..."}
  ```
  여러 번 갱신되므로 **마지막 것**이 최신이다.
  압축된 세션은 첫 사용자 메시지가 "This session is being continued..." 라 제목으로 못 쓴다.
- **⚠️ 파일이 아주 크다.** 이 머신에 374MB, 22MB 짜리가 있다(9만 줄 이상).
  목록 만들자고 통째로 파싱하면 안 된다.

---

## 4. 아키텍처

```
[전용 창: 크롬 --app]  ──HTTP/SSE──  [Node 로컬 서버]  ──stdin/stdout──  [claude -p]
        public/                          server.js                      자식 프로세스
```

- **의존성 0.** WebSocket 대신 **SSE**(서버→클라) + `fetch POST`(클라→서버)를 쓴다.
  `ws` 를 안 붙이려는 의도적 선택이다.
- 전용 창은 Electron 없이 **브라우저 앱 모드**로 띄운다:
  `chrome --app=http://127.0.0.1:PORT` (없으면 `msedge --app=`, 그것도 없으면 기본 브라우저)
  → 탭·주소창이 없는 독립 창이 된다. 사용자가 원한 게 이거다.
- 서버는 `127.0.0.1` 에만 바인딩한다. 이건 로컬 도구지 서버가 아니다.

---

## 5. 지금까지 만든 것

| 파일 | 상태 |
|---|---|
| `lib/sessions.js` | ✅ **완성·시험 통과** |
| `lib/runner.js` | ✅ **완성·시험 통과** |
| `package.json` | ✅ (`type: module`, bin: ccdesk) |
| `.gitignore` | ✅ |
| `server.js` | ❌ 미작성 |
| `public/index.html` · `app.js` · `style.css` | ❌ 미작성 |
| `README.md` · `LICENSE` | ❌ 미작성 |

### `lib/sessions.js`

`listProjects()` / `listSessions(path)` / `readSessionMeta(file)`.

- 파일 **앞 128KB 와 뒤 256KB 만** 읽는다. 그래서 374MB 가 섞여 있어도
  **9개 프로젝트 전체가 56ms** 에 나온다. 이 전략을 바꾸지 말 것.
- 경계에서 잘린 줄은 조용히 버린다. 손상된 파일 하나가 목록을 막지 않는다.
- 돌려주는 것: `id, cwd, gitBranch, version, title, hasAiTitle, preview, bytes, startedAt, updatedAt`

실측 출력:
```
프로젝트 9 개 — 56 ms
   5개  2026-09-01 15:24  C:\Users\JunHyun\Documents\GitHub\NPLogic-desktop-edit
   ...
  2026-09-01 15:24  22.2MB   [AI] Desktop 프로그램 평가 탭 그래프 축 수정
  2026-08-29 07:53  374.8MB  [AI] NPLogic desktop 이어작업 컨텍스트 인계
```

### `lib/runner.js`

`Run` 클래스 (EventEmitter). `send(text)` / `interrupt()` / `stop()`, `'event'` 를 emit.

- Windows 의 `claude` 는 `.cmd` 셔임이라 `shell: true` 가 필요하다.
  **인자는 전부 우리가 만든 값**(플래그·UUID·열거형)이고
  **사용자 입력은 stdin 으로만** 들어가므로 셸 인용 문제가 없다. 이 성질을 깨지 말 것.
- `--allowedTools` 값은 사용자가 적을 수 있어 정규식으로 좁게 검사한다.
- 프로세스가 죽어 있으면 다음 `send()` 에서 `--resume` 으로 되살린다.
  기록은 CLI 가 파일에 남기므로 맥락은 이어진다.

---

## 6. 남은 일

### 6.1 `server.js`

`127.0.0.1` 바인딩, 정적 파일 + 아래 API. 시작하면 앱 모드 창을 띄운다.

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/projects` | `listProjects()` |
| GET | `/api/sessions?path=` | `listSessions()` |
| POST | `/api/runs` | `{path, sessionId?, permissionMode, allowedTools[]}` → `runId` |
| GET | `/api/runs/:id/stream` | **SSE** — runner 의 `'event'` 를 그대로 흘림 |
| POST | `/api/runs/:id/send` | `{text}` |
| POST | `/api/runs/:id/interrupt` | |
| DELETE | `/api/runs/:id` | |

- run 은 메모리 Map 에 담는다. 서버가 죽으면 사라져도 된다 — 대화는 CLI 가 파일에 남긴다.
- SSE 는 주기적으로 주석(`:\n\n`)을 보내 프록시/브라우저가 끊지 않게 한다.

### 6.2 `public/` — 화면 셋

1. **프로젝트 고르기** — 경로·세션 수·마지막 활동·git 브랜치. 직접 입력 칸도 둘 것
2. **대화 목록** — 제목(`ai-title`)·시각·크기·미리보기 + `[새 대화]` + 권한 모드 선택
3. **대화** — 이게 본체. 사용자가 불편해한 게 여기다:
   - 넓고 길게 스크롤되는 본문, 스크롤 위치 유지(따라가기/멈춤 토글)
   - **입력창을 크게.** 여러 줄, `Enter` 전송 / `Shift+Enter` 줄바꿈
   - 마크다운 렌더링(코드펜스·인라인코드·헤딩·목록·링크·표) — **의존성 없이 직접**.
     ⚠️ 반드시 HTML 이스케이프할 것. 모델 출력은 신뢰 입력이 아니다
   - **도구 호출은 접어서** 보여준다(이름 + 인자 요약, 펼치면 전문)
   - `system/permission_denied` 는 눈에 띄게 — 조용히 삼키지 말 것 (3.2절)
   - `stream_event` 로 토큰 단위 표시, `result` 에서 비용·소요시간 표시
   - 중단 버튼

### 6.3 마무리

- `README.md` — 무엇인지, 스크린샷, 설치(`npx ccdesk`), **권한 모드 설명과 그 한계**(3.2절)
- `LICENSE` — MIT
- GitHub repo 생성·공개는 **사용자가 직접** 한다 (아직 안 만들었음)

---

## 7. 미확인 — 사실로 가정하지 말 것

- **다른 OS.** macOS·Linux 에서 안 돌려봤다. `shell:true` 분기와 브라우저 앱 모드 실행이 특히 의심스럽다
- **동시 실행.** 같은 세션에 터미널과 ccdesk 가 동시에 붙으면 어떻게 되는지 모른다. 파일이 깨질 수 있다
- **아주 긴 대화의 렌더링.** 374MB 세션을 화면에 어떻게 올릴지 정하지 않았다. 가상 스크롤이나 뒤에서부터 N개만 불러오는 방식이 필요할 것이다
- **과거 대화 본문 표시.** 지금 `lib/sessions.js` 는 목록용 메타만 뽑는다.
  이어가기 전에 **이전 대화 내용을 화면에 복원**하려면 jsonl 본문을 읽어 오는 함수가 따로 필요하다.
  (CLI 는 `--resume` 으로 맥락을 알아서 잇지만, **화면에는 아무것도 안 보인다.**
  사용자가 "대화를 이어간다" 고 했을 때 기대하는 건 이전 내용이 보이는 것일 가능성이 높다.
  → **이걸 먼저 확인하고 만들 것.** 우선순위가 높다)
- **MCP 서버 초기화 시간.** `system/init` 에서 `status: pending` 인 서버들이 있었다.
  첫 턴이 느릴 수 있는데 얼마나인지 안 쟀다
- **`claude` 가 PATH 에 없는 경우** 의 안내를 안 만들었다

---

## 8. 시험 방법

```bash
# 세션 목록
node -e "import('./lib/sessions.js').then(async m => console.log((await m.listProjects()).projects))"

# 실행기 2턴 (맥락이 이어지는지)
node test_runner.mjs   # 이 문서 작성 시 쓴 스크립트는 scratchpad 에 있었다. 필요하면 다시 만들 것
```
