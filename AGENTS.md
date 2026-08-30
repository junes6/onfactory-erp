# AGENTS.md — 작업 수칙

이 저장소에서 자동화 에이전트(Claude Code 등)가 작업할 때 지켜야 하는 규칙이다. PRODUCT.md가 "무엇이 맞는가", DECISIONS.md가 "무엇을 이미 정했는가"라면 이 문서는 "어떻게 일하는가"다.

**모든 세션은 AGENTS.md · PRODUCT.md · DECISIONS.md 세 문서를 먼저 읽고 시작한다.**

## 진행 방식
1. **절(節) 단위 구현 → 스모크 → 커밋.** 한 절(P0, P1 …)을 끝낼 때마다 타입체크·토큰 검증·아키텍처 검증·테스트·빌드를 돌리고 녹색일 때만 커밋한다. 여러 절을 한 커밋에 섞지 않는다.
2. **셀프 스크린샷(또는 DOM) 판정.** UI 변경은 실제 브라우저에서 흐름을 끝까지 타 보고 결과(스크린샷 또는 DOM 확인)를 보고서에 남긴다. "될 것이다"는 판정이 아니다.
3. **불변 영역 보존.** 결재 상태머신(`업무요청 → 수행중 → 결재대기 → 결재완료`), 권한 계층(`requireAuth/requireTenantAdmin/requirePlatformOperator/requireMatchingWorkspaceIdentity`), 디자인 토큰 계약, 저장소 키 allowlist는 바꾸기 전에 사유와 대안을 먼저 보고한다.
4. **서버 변경 = 재시작.** `server/*.mjs`를 바꾸면 실행 중인 서버를 재시작하고 보고서에 명시한다.
5. **환경.** 이 PC의 Node는 `C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe`다. 테스트는 `--experimental-strip-types --test`로 돌린다. 검증 명령: `tsc -p tsconfig.app.json`, `pnpm verify`(아키텍처·디자인 토큰·버튼 톤·브랜드), `vite build`.

## 금지
- 고정 샘플 값을 실데이터처럼 화면에 두는 것. 데이터가 없으면 "아직 데이터 없음".
- 입력 onChange에서 입력값을 변형하는 것(한글 IME가 끊긴다).
- `tokens.css` 외부에서 색상 hex/별칭 재정의. 다크 모드를 컴포넌트별로 땜질하는 것.
- 비밀키·실데이터·고객 식별정보 커밋. 테스트가 실데이터 디렉터리를 건드리는 것.
- 권한·결재 상태머신의 무단 변경.

## 보고서 형식
`[절별 반영 내용 / 스모크 결과 / 스크린샷·DOM 판정 / 제안 3개 / 커밋 해시]` 순서로 쓴다. 완료 후 `origin/main`에 푸시한다.

## 매 태스크 종료 시 — 능동 대조 의무
**PRODUCT.md·DECISIONS.md의 기대치와 현재 구현을 대조해, 지시받지 않았지만 어긋나 있는 항목 3개를 찾아 보고서 말미에 "제안" 섹션으로 제출한다.** 각 제안은 (어긋난 기대치 번호 · 현재 상태 · 고치는 방법 · 예상 규모)를 한 줄씩 적는다. 발견 즉시 고칠 수 있는 작은 것은 고치고 "고침"으로 표시한다.
