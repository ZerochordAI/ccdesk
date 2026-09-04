# ccdesk specification

ccdesk는 로컬에 설치된 코딩 에이전트 CLI의 기존 대화를 찾고, 읽고, 이어서 작업하는 의존성 없는 로컬 웹 UI다.

## 제품 원칙

- 인증과 모델 호출은 각 provider CLI에 위임한다.
- 서버는 `127.0.0.1`에만 바인딩하고 모든 API에 실행 시 생성한 토큰을 요구한다.
- provider 원본 이벤트와 저장 포맷은 UI 계약으로 노출하지 않는다.
- 대화는 생성한 provider에서만 이어간다. provider 사이에서 세션을 변환하지 않는다.
- 세션을 보기만 할 때 agent turn을 시작하지 않는다.
- 위험한 권한은 provider 차이를 숨기지 않고 명시적으로 표시한다.
- Claude의 기존 동작을 Codex 추가보다 우선해 보존한다.

## 지원 범위

| 기능 | Claude Code | Codex |
|---|---|---|
| 기존 세션 목록/본문 | 기존 JSONL reader | App Server thread API |
| 새 대화/이어가기 | Claude CLI stream-json | Codex App Server |
| 스트리밍/중단 | 지원 | 지원 예정 |
| 도구 승인/사용자 질문 | ccdesk MCP bridge | App Server server request |
| 이미지 | 지원 | schema 확인, 실측 필요 |
| 본문 검색 | 지원 | 후속 범위 가능 |

## 상세 명세

- [Provider 계약](spec/provider-contract.md)
- [Codex App Server 통합](spec/codex-app-server.md)
- 기존 Claude v1 동작과 근거는 [DESIGN.md](DESIGN.md)를 따른다.

## 현재 결정

- 제품명과 기본 provider는 `ccdesk`, `claude`를 유지한다.
- 서버 내부의 세션 식별자는 `(provider, sessionId)` 복합 키다.
- Codex 통합 경계는 rollout 파일이 아니라 stable Codex App Server v2 API다.
- 화면은 공통 message model을 사용하고 provider adapter가 history와 live event를 정규화한다.
- 권한은 공통 의미 preset과 provider별 고급 설정을 함께 사용한다.

## 미결정 사항

- 첫 Codex 릴리스에 본문 전문검색을 포함할지
- 기존 `/api/sessions` 호환 API의 제거 시점
- Codex model 목록을 CLI에서 동적으로 읽을지 기본값/직접 입력으로 둘지
- Codex 이미지 입력을 브라우저 base64에서 임시 로컬 파일로 변환할지 data URL을 사용할지
