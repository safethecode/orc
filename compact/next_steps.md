# Next Steps (Always Current)

Last updated: 2026-02-27 08:00

---

## Context

**Current State**: Interactive REPL 구현 완료. 기본 오케스트레이션 인프라 + 대화형 인터페이스 + UX 마무리까지 완성.

**완료된 것**:
- 코어 오케스트레이터 (27 소스 파일, 8 서브시스템)
- Interactive REPL (readline, 자연어→라우팅→스트리밍)
- Claude Code 스타일 UI (색상 배지, ❯ 프롬프트, ora 스피너)
- 티어별 색상 박스 (╭│╰) + 마크다운 렌더링 + word wrap
- /status, /stop, /clear, /help, /quit 명령어
- 대화 컨텍스트 누적, 비용/토큰 표시

---

## Immediate (Do Now)

### 1. 실제 에이전트 실행 테스트
**Priority**: High
**Duration**: ~1-2 hours

현재 REPL은 Claude CLI를 `-p` 모드로 실행하는데, 실제 다양한 시나리오에서 동작 검증 필요:
- 긴 응답 스트리밍 안정성
- 에러 발생 시 적절한 표시
- 한국어/영어 혼합 응답 처리
- 코드 블록이 포함된 응답 렌더링

### 2. 다중 턴 대화 컨텍스트 검증
**Priority**: High
**Duration**: ~30 min

`conversation.buildPrompt()`이 이전 대화를 올바르게 포함하는지 확인.
- 후속 질문이 이전 맥락을 유지하는지
- 대화가 길어질 때 프롬프트 크기 관리

### 3. 라우팅 로직 개선
**Priority**: Medium
**Duration**: ~1 hour

현재 키워드 기반 라우팅이 기본 동작하지만, 자연어에 더 적합한 방식 필요:
- 기본 tier를 haiku로 설정 (완료)
- 키워드 매칭 정확도 향상
- 사용자가 명시적으로 에이전트/모델 지정하는 기능 (e.g., `@architect`, `--opus`)

---

## Short Term (Next 1-2 Days)

### 4. Integration Tests
**Priority**: High
**Duration**: ~3-4 hours

테스트 커버리지 필요:
- Orchestrator initialization
- Agent lifecycle (spawn, stop)
- Task routing
- REPL commands
- Markdown rendering
- Word wrapping

### 5. TypeScript 타입체크 설정
**Priority**: Low
**Duration**: ~10 min

`bun add -d typescript` 후 `bun run typecheck` 동작 확인.

### 6. 에이전트 핸드오프 구현
**Priority**: Medium
**Duration**: ~2-3 hours

복잡한 작업 시 에이전트 간 핸드오프:
- architect → coder (설계 후 구현)
- coder → reviewer (구현 후 리뷰)
- `renderer.handoff(from, to)` 이미 구현됨

---

## Long Term (Next Week+)

### 7. 멀티 에이전트 동시 실행
- 여러 에이전트 출력을 REPL에서 동시 표시
- 에이전트별 박스 구분

### 8. Decision Registry (Layer 5)
- 아키텍처 결정 추적

### 9. File Watcher (Layer 4)
- 파일 변경 감지, 충돌 방지

### 10. Checkpoint System
- 체크포인트 생성/복원

### 11. CI/CD Pipeline
- GitHub Actions 워크플로우

---

**Last updated**: 2026-02-27 08:00
