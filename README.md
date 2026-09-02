# ccdesk

터미널 대신 쓰는 **Claude Code 전용 창**. 경로를 고르고, 지난 대화를 찾아, 이어간다.

> A tiny local UI for the Claude Code CLI — pick a project, browse past sessions, continue one in a
> dedicated window. No Electron, no dependencies. Korean UI.

```
┌──────────────┬─────────────────────────────────┐
│ 범위         │ [대화1] [대화2*] [+]            │
│  ○ 전체      ├─────────────────────────────────┤
│  ● 루트      │                                 │
│  ○ 프로젝트  │  대화 본문 (마지막 40턴)        │
│ [경로_____]  │   ↑ 위로 더 불러오기            │
│ [검색_____]  │                                 │
├──────────────┼─────────────────────────────────┤
│ 세션 목록    │  입력창  [설정][전송][중단]     │
└──────────────┴─────────────────────────────────┘
```

## 무엇인가

Claude Code 는 이미 대화를 `~/.claude/projects/**/*.jsonl` 에 남긴다. ccdesk 는 그 기록을 읽어
목록으로 보여주고, 고른 대화를 `claude --resume` 으로 이어간다. **CLI 를 감싸는 얇은 창일 뿐**이고,
모델 호출도 인증도 전부 CLI 가 한다.

- **의존성 0** — `package.json` 에 `dependencies` 가 없다. Node 표준 모듈만 쓴다
- **Electron 없음** — 크롬/엣지의 앱 모드(`--app=`)로 탭·주소창 없는 창을 띄운다
- **로컬 전용** — `127.0.0.1` 에만 바인딩한다

## 필요한 것

- **Node.js 20 이상**
- **Claude Code CLI** 가 설치되어 있고 `claude` 가 PATH 에 있을 것
- 그 CLI 로 **로그인이 끝나 있을 것** (아래 참고)

## 로그인은 어떻게 하나

**ccdesk 에는 로그인이 없다.** 있을 필요가 없다.

ccdesk 는 자기 컴퓨터에서 `claude` 를 자식 프로세스로 띄우고, 그 프로세스는 **이미 그 컴퓨터에
저장된 자격 증명**을 쓴다. 그래서 각자 자기 컴퓨터에서 한 번 로그인해 두면 끝이다.

```bash
claude          # 처음이면 로그인 절차가 뜬다 (구독 계정 또는 API 키)
```

- 구독(Pro/Max)으로 로그인했다면 ccdesk 도 그 계정으로 돈다
- API 키를 쓴다면 `ANTHROPIC_API_KEY` 를 환경변수로 두면 된다. ccdesk 는 자기 환경변수를
  자식 프로세스에 그대로 물려준다
- 터미널에서 `claude` 가 잘 뜨면 ccdesk 도 뜬다. 안 뜨면 먼저 CLI 부터 고쳐야 한다

### ⚠️ 여러 사람이 한 서버에 붙이는 용도가 아니다

ccdesk 를 서버에 올려놓고 여러 명이 접속하게 만들면, **모두가 그 서버 계정의 권한으로 명령을
실행하고 그 서버에 저장된 하나의 Claude 계정을 공유하게 된다.** 사용자 구분이 없다.
그렇게 쓰지 마라. 각자 자기 컴퓨터에서 띄우는 도구다.

## 실행

```bash
git clone https://github.com/ZerochordAI/ccdesk.git
cd ccdesk
node server.js
```

전용 창이 열리고, 터미널에 주소가 찍힌다.

```
ccdesk  http://127.0.0.1:4317/?t=<토큰>
```

**주소의 토큰이 곧 열쇠다.** 창을 닫았으면 이 주소를 다시 열면 된다.
포트가 이미 쓰이고 있으면 다음 포트로 알아서 넘어간다. `CCDESK_PORT` 로 직접 정할 수도 있다.

| 환경변수 | 뜻 |
|---|---|
| `CCDESK_PORT` | 시작 포트 (기본 4317) |
| `CCDESK_NO_WINDOW` | 값이 있으면 창을 안 띄우고 주소만 찍는다 |

## 쓰는 법

**왼쪽 — 찾기**

- **범위**: `전체` / `루트`(경로 하나 아래 전부) / `프로젝트`(그 경로만)
- 검색은 **제목·경로·브랜치**에 걸린다. 띄어쓰면 AND. 본문 검색은 아직 없다
- 프로젝트별로 접혀 있고, 검색하면 자동으로 펼쳐진다
- 브라우저는 폴더 선택 다이얼로그로 절대경로를 주지 않는다. 그래서 경로는 직접 입력하거나,
  기존 기록에서 뽑아 제시하는 칩을 누른다

**오른쪽 — 대화**

- 고르면 **탭으로 열리고 마지막 40턴이 바로 보인다.** 위로 더 불러올 수 있다
- 여러 개를 열어 오갈 수 있다. 전환해도 스크롤 위치와 쓰다 만 입력이 남는다
- `Enter` 전송 / `Shift+Enter` 줄바꿈. 입력칸은 내용에 맞춰 늘어난다
- **이미지는 붙여넣기(Ctrl+V)나 끌어다 놓기.** 경로를 적을 필요 없다 (5MB, png/jpeg/gif/webp)
- 내 프롬프트는 5줄까지만 보이고, 누르면 10줄까지 펼쳐진다
- 도구 호출은 접혀서 나온다. **실패하면 사유의 첫 줄이 접힌 채로도 보인다**
- **대화 이름을 바꿀 수 있다.** 목록 항목의 ✎ 또는 탭을 두 번 누른다. 비우면 원래 제목으로 돌아간다
- **답을 기다리는 동안에도 계속 칠 수 있다.** 줄을 서고, 앞 턴이 끝나면 차례로 나간다.
  줄 선 것을 누르면 입력칸으로 되돌아와 고칠 수 있다
- 입력칸 위에 **구동 시간과 토큰**이 나온다 — 응답 중에는 시간이 흐르고,
  옆에 이 대화의 누계(턴·시간·토큰·비용)가 붙는다. 마우스를 올리면 입력/출력/캐시로 나눠 보여준다
- **중단**은 지금 턴만 끊는다. 프로세스는 살아 있어 대화가 그대로 이어진다
- 설정에서 켜면 **도구 승인을 물어본다.** 대화 위에 카드가 떠서 허용/거부를 고른다

**설정** (입력창 옆)

모델 · 권한 · 허용 도구 · 추가 폴더를 정한다. 이 값들은 **프로세스가 뜰 때 박히므로**,
바꾸면 붙어 있던 프로세스를 떼어내고 다음 전송 때 새로 붙는다. 대화 내용은 그대로 이어진다.

## 권한 — 먼저 읽을 것

Claude Code 의 헤드리스 모드에는 **도구마다 승인을 묻는 왕복이 없다.** 되묻지 않고 그냥 거부한다.
그래서 권한은 프로세스를 띄울 때 정해야 한다.

| 모드 | 뜻 |
|---|---|
| `plan` | 계획만. 파일을 건드리지 않는다 |
| `default` | 기본 |
| `acceptEdits` | 파일 편집을 자동 승인 |
| `bypassPermissions` | Bash 포함 전부 허용 (**주의**) |

⚠️ **`acceptEdits` 는 복합 명령을 거부한다.** 단일 `echo` 는 통과하지만
`A && B` 처럼 승인이 필요한 조각이 섞이면 전체가 막힌다. 실제로 이런 문구가 돌아온다:

```
This Bash command contains multiple operations.
The following part requires approval: node --check public/app.js
```

명령을 자유롭게 쓰게 하려면 `bypassPermissions` 를 골라야 한다. 그게 무슨 뜻인지 알고 고르면 된다.

CLI 2.1.258 기준 모드는 `acceptEdits` `auto` `bypassPermissions` `manual` `dontAsk` `plan` 이고,
`default` 도 (목록에 없지만) 받아들여진다. **`manual` 로 띄워도 우리에게 물어오지 않는다** —
`system/init` 은 `permissionMode: default` 로 보고하고 그냥 거부한다.
그래서 ccdesk 는 **승인 창구를 따로 붙인다** — 아래 참고.

### 도구 승인 물어보기

설정에서 **"승인이 필요하면 화면에서 물어보기"** 를 켜면, 승인이 필요한 순간 대화 위에
카드가 뜬다 — 도구 이름·인자 전문·`허용`/`거부`.

원리는 이렇다. CLI 의 `--permission-prompt-tool` 은 승인 판단을 MCP 도구 하나에 맡긴다.
ccdesk 는 그 도구를 직접 구현해 두고(`lib/mcp-approve.js`, 의존성 없이 JSON-RPC 를 직접 말한다),
물음이 오면 화면에 띄우고 사람이 누를 때까지 기다렸다가 답을 돌려준다.

- 물어볼 수 없는 상황이면 **거부**한다. 조용히 허용하는 것보다 낫다
- 10분 안에 답이 없어도 거부된다
- 꺼두면 예전과 똑같이 동작한다

## 같은 대화를 두 곳에서 열면

터미널과 ccdesk 가 **같은 세션에 동시에 붙으면 서로의 작업을 덮는다.** 실제로 겪었다 —
두 프로세스가 같은 파일을 고쳐 한쪽 편집이 사라지고 대화가 갈라졌다(기록 파일 자체는 안 깨졌다).

그래서 ccdesk 는:

- 최근 갱신된 세션에 `● 진행 중` 을 붙인다
- 그런 세션을 열면 **보기 전용**으로 시작한다. 새 내용을 3초마다 따라 읽기만 하고 아무것도 쓰지 않는다
- 이어가려면 경고를 확인하고 `그래도 이어가기` 를 눌러야 한다

넓은 화면으로 **터미널 작업을 지켜보는 용도**로도 쓸 만하다.

## 보안

- 서버는 `127.0.0.1` 에만 바인딩한다
- 시작할 때 토큰을 만들고 모든 `/api/*` 에서 요구한다. `Origin` 도 검사한다
- 이게 없으면 사용자가 열어둔 **아무 웹페이지나** `POST /api/runs` 를 쏠 수 있고,
  그 끝은 임의 경로에서 `bypassPermissions` 로 명령을 실행하는 것이다. 응답을 못 읽어도 실행은 된다
- 설정의 "추가 폴더"처럼 사용자가 적는 값이 `argv` 로 가는 자리는 절대경로만 받고
  셸 메타문자가 있으면 버린다

## 아직 아닌 것

- **Windows 에서만 확인했다.** macOS·Linux 는 안 돌려봤다
- 모델이 선택지를 주는 `AskUserQuestion` 은 헤드리스 도구 목록에 없다. 도구 승인과는 별개 문제다
- 바꾼 대화 이름은 **ccdesk 안에서만** 보인다. 터미널 목록에는 원래 제목이 남는다
- 본문 전문 검색 없음 (색인이 필요하다)
- 설정의 **추가 폴더(`--add-dir`)는 효과를 실측하지 못했다.** 자세한 건 `DESIGN.md` 9.2b

## CLI 를 어떻게 다루는가 — 실측 기록

ccdesk 를 만들며 직접 돌려 확인한 것들이다. 비슷한 걸 만들 사람이 같은 걸 다시 재느라
시간 쓰지 않도록 적어둔다. 환경은 Windows 11 · Node v22 · claude 2.1.x.

### stream-json 으로 주고받기

```bash
claude -p --output-format stream-json --input-format stream-json \
       --include-partial-messages --verbose --permission-mode acceptEdits
```

- `--verbose` 는 `-p` + stream-json 조합에서 **필수**다. 없으면 안 된다
- **stdin 은 한 줄에 하나**, 개행으로 끝낸다:
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
  ```
- **프로세스가 턴을 넘어 살아 있다.** stdin 을 열어두면 한 프로세스로 여러 턴을 처리하고
  맥락도 이어진다. 죽었으면 다음 전송 때 `--resume` 으로 되살리면 된다 —
  기록은 CLI 가 파일에 남기므로 맥락은 유지된다
- 관측된 이벤트: `system/init` · `system/status` · `system/hook_started` · `system/hook_response` ·
  `stream_event`(부분 출력) · `assistant` · `rate_limit_event` · `result/success`.
  **모든 이벤트에 `session_id` 가 붙는다**
- `system/init` 에 들어 있는 것: `session_id` `cwd` `tools[]` `mcp_servers[]` `model`
  `permissionMode` `slash_commands[]` `skills[]` `claude_code_version`
- `result` 에 들어 있는 것: `result`(최종 텍스트) `usage` `total_cost_usd` `duration_ms`
  `num_turns` `permission_denials[]` `is_error`

### 이미지도 stdin 으로 들어간다

`content` 에 API 형식 그대로 실으면 받는다. **이미지 먼저, 글 나중** 순서로 넣는다.

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}},
  {"type":"text","text":"..."}]}}
```

### 부분 출력(`stream_event`)의 속

`message_start` · `content_block_start` · `content_block_delta` · `content_block_stop` ·
`message_delta` · `message_stop` 이 온다. 델타는 이렇게 생겼다:

```json
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
```

`message_start` 의 `message.id` 는 뒤에 오는 `assistant` 이벤트의 id 와 **같다.**
다만 그 id 만 믿으면 안 된다 — 중간에 연결이 끊겼다 붙으면 `message_start` 를 놓친 채
델타부터 받게 되고, 그러면 조각으로 만든 임시 메시지와 완성본이 따로 남아 **같은 답이 두 번 보인다.**

그리고 `assistant` 이벤트는 **완성본을 통째로** 싣고 오는 반면
기록 파일은 한 턴을 **여러 줄로 쪼개** 적는다. 앞은 갈아끼워야 하고 뒤는 더해야 한다.
같은 코드로 처리하면 글이 두 번 쌓인다.

### 세션 기록은 어디에 어떻게 남나

- 위치: `~/.claude/projects/<인코딩된경로>/<sessionId>.jsonl`
- ⚠️ **폴더명을 역해독하지 마라.** 드라이브 문자 대소문자가 뒤섞이고, 점(`.`)도 하이픈이 되고,
  하위 폴더 구분자도 하이픈이라 되돌릴 수 없다. 실제로 `...-myapp-web` 은 `myapp-web` 이 아니라
  `myapp\web` 이었다. **파일 안의 `cwd` 필드를 읽어라.** 그게 언제나 진짜 경로다
- 한 줄이 JSON 하나. `type` 이 여럿이다 — `user` `assistant` `attachment` `system` `mode`
  `permission-mode` `file-history-snapshot` `ai-title` `last-prompt` `agent-name` `atis-latch` …
- `user`/`assistant` 라인의 `message` 는 **Anthropic API 메시지 객체 그대로**다.
  `content` 가 `text`/`tool_use` 블록 배열이고, `tool_result` 는 **다음 `user` 라인**에 붙는다
- **`ai-title` 라인에 사람이 읽을 제목이 있다.** 목록에는 이걸 써야 한다.
  여러 번 갱신되므로 **마지막 것**이 최신이다. 압축된 세션은 첫 사용자 메시지가
  "This session is being continued…" 라 제목으로 못 쓴다
- ⚠️ **`mtime` 은 대화가 없어도 갱신된다.** 마지막 대화보다 4일 늦은 파일이 있었다.
  화면에 쓸 시각은 기록 안의 마지막 `timestamp` 다
- ⚠️ **파일이 아주 크다.** 이 머신에 374MB·22MB 짜리가 있었다(9만 줄 이상).
  목록 만들자고 통째로 파싱하면 안 된다. ccdesk 는 앞 128KB·뒤 256KB 만 읽어
  프로젝트 전체를 60~100ms 에 훑고, 본문은 파일 끝에서 거슬러 올라가며 필요한 턴만 읽는다
- 하위 `subagents/` 폴더에 서브에이전트 대화가 따로 있다. `isSidechain: true` 로도 구분된다

### 아직 안 재본 것

- macOS·Linux
- MCP 서버 초기화 시간. `system/init` 에 `status: pending` 인 서버가 있었는데 얼마나 걸리는지 안 쟀다
- `--add-dir` 의 효과. 있으나 없으나 작업 폴더 밖 파일이 읽혔다 (`DESIGN.md` 9.2b)

## 문서

- [`DESIGN.md`](DESIGN.md) — v1 설계 계약. 불변 규칙, 메시지 모델, API, 그리고 실측 기록

## 라이선스

[Apache License 2.0](LICENSE) — 누구나 쓰고, 고치고, 배포할 수 있습니다.
특허 사용 허락이 명시돼 있고, 배포할 때 `NOTICE` 를 함께 실으면 됩니다.

Copyright 2026 [Zerochord AI](https://github.com/ZerochordAI)
