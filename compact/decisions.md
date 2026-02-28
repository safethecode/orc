# All Decisions Made (Cumulative)

This file contains ALL architectural, technical, and design decisions made across all sessions.

Last updated: 2026-02-27 02:44

---

## Session 2026-02-27: Orchestrator Implementation

### Decision 1: Binary Command Name - `orc`
- **Date**: 2026-02-27 (Phase 1)
- **Context**: Need CLI command name for the orchestrator tool
- **Options**: `orch`, `orc`, `orchestrator`
- **Choice**: `orc`
- **Rationale**: Shorter command (3 chars vs 4), easier to type, distinctive, user preference
- **Impact**: package.json bin entry, all documentation, user commands
- **Trade-offs**: Less descriptive than full name, but speed > clarity for frequently-used commands
- **Reversible**: Yes (simple rename of bin entry)

### Decision 2: Runtime - Bun over Node.js
- **Date**: 2026-02-27 (Phase 1)
- **Context**: Choose TypeScript runtime for the application
- **Options**: Node.js, Bun, Deno
- **Choice**: Bun 1.2.11
- **Rationale**:
  - Native TypeScript support (no build step, no transpilation)
  - Built-in SQLite (bun:sqlite) - no external dependencies
  - Significantly faster than Node.js
  - Great developer experience
  - Growing ecosystem
- **Impact**: All tooling, package.json scripts, DB implementation
- **Trade-offs**: Newer ecosystem (less mature than Node), but benefits outweigh risks for this use case
- **Reversible**: Partially (SQLite layer would need rewrite, but most code is runtime-agnostic)

### Decision 3: Session Isolation - tmux
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Need to run multiple AI agents concurrently without interference
- **Options**: Docker containers, screen, tmux, native child processes
- **Choice**: tmux 3.6a
- **Rationale**:
  - Lightweight (no container overhead like Docker)
  - Easy to inspect/debug sessions (`tmux attach -t <session>`)
  - Standard on Unix systems (widely available)
  - Good terminal multiplexing
  - Persistent sessions (survive network disconnects)
  - Simple API (create, kill, send-keys, capture-pane)
- **Impact**: Requires tmux installation, session/terminal.ts wrapper implementation
- **Trade-offs**: Unix-only (no Windows support), but target audience uses Unix
- **Reversible**: Yes (could swap for screen or containerization)

### Decision 4: State Persistence - SQLite with WAL
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Need persistent storage for agents, tasks, messages, ownership
- **Options**: PostgreSQL, SQLite, JSON files, in-memory, Redis
- **Choice**: SQLite with WAL (Write-Ahead Logging) mode
- **Rationale**:
  - No external dependencies (embedded database)
  - Built into Bun runtime (bun:sqlite)
  - WAL mode provides good concurrency (readers don't block writers)
  - File-based (easy backup, restore, copy)
  - Sufficient for orchestrator's scale (< 100 concurrent agents)
  - Simple schema migrations
- **Impact**: db/schema.ts (6 tables), db/store.ts (data access layer)
- **Trade-offs**: Not suitable for distributed systems, but orchestrator runs on single machine
- **Reversible**: Partially (would need migration scripts to move to PostgreSQL)

### Decision 5: TUI Framework - Ink (React for CLI)
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Need visual dashboard to monitor agents and tasks
- **Options**: ncurses, blessed, ink, raw ANSI codes
- **Choice**: Ink 5.1.0 (React 18.3.1)
- **Rationale**:
  - Component-based architecture (familiar React patterns)
  - Declarative UI (easier to reason about than imperative)
  - Good terminal rendering engine
  - State management with React hooks (useState, useEffect)
  - Active maintenance and community
  - Type-safe with TypeScript
- **Impact**: tui/*.tsx files (5 components), React dependency
- **Trade-offs**: Heavier than ncurses, but developer experience is significantly better
- **Reversible**: Yes (could rewrite with different framework, UI is isolated)

### Decision 6: Agent Communication - MCP (Model Context Protocol)
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Need standard protocol for agents to query orchestrator state
- **Options**: Custom JSON protocol, MCP, gRPC, REST API
- **Choice**: MCP (Model Context Protocol) with stdio transport
- **Rationale**:
  - Designed specifically for AI agent communication (from Anthropic)
  - Standard protocol (interoperability with other tools)
  - stdio transport (simple, no network setup)
  - Tool-based interface (declarative capability exposure)
  - Native support in Claude CLI
- **Impact**: messaging/mcp-server.ts, @modelcontextprotocol/sdk dependency
- **Trade-offs**: Newer protocol (less mature), but designed for exactly this use case
- **Reversible**: Yes (protocol layer is abstracted, can swap implementation)

### Decision 7: Conflict Prevention - Ownership Declaration
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Multiple agents might try to modify same files concurrently
- **Options**: File locks (exclusive access), ownership declaration, no prevention, manual coordination
- **Choice**: Ownership declaration with conflict checking
- **Rationale**:
  - Proactive (prevent conflicts before they happen)
  - Explicit (agents declare intent upfront)
  - Flexible (ownership can be transferred)
  - Non-blocking (doesn't prevent reads)
  - User insight: "소유권 선언 + git worktree + 체크포인트" covers 80-90% of real scenarios
- **Impact**: core/ownership.ts (OwnershipManager), file_ownership table in DB
- **Trade-offs**: Requires agent cooperation (not enforced), but sufficient for AI agents
- **Reversible**: Yes (optional feature, can be disabled)

### Decision 8: Physical Isolation - Git Worktree per Agent
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Agents working on same repo might cause git conflicts
- **Options**: Separate full clones, git worktree, shared working directory
- **Choice**: git worktree per agent
- **Rationale**:
  - Shares .git directory (saves disk space, keeps history in sync)
  - Complete isolation (separate working directories)
  - Easy cleanup (remove worktree when agent stops)
  - Supports concurrent branches (each agent can work on different branch)
  - Native git feature (no external tools)
- **Impact**: session/worktree.ts (WorktreeManager class)
- **Trade-offs**: Requires git 2.5+ (widely available), more complex than shared directory
- **Reversible**: Yes (can use shared directory, worktree is optional)

### Decision 9: Implementation Strategy - Parallel Sub-Agents
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Need to build 27 files across 8 subsystems (config, session, agents, db, core, messaging, logging, tui)
- **Options**: Sequential implementation (one file at a time), batched implementation (one subsystem at a time), parallel sub-agents
- **Choice**: 9 sub-agents in parallel (orchestrator-impl team)
- **Rationale**:
  - Much faster (2-3 hours vs 8-10 hours sequential)
  - Modular (each agent owns a subsystem, clear boundaries)
  - Reduces context switching (agent focuses on one domain)
  - Tests orchestration concept (dogfooding)
  - Better parallelism (utilize multiple Claude instances)
- **Impact**: Implementation completed in ~3 hours, all 27 files created
- **Trade-offs**: More coordination overhead, but time savings are significant
- **Reversible**: N/A (implementation already complete)

### Decision 10: Commit Granularity - One File Per Commit
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Commit strategy for 27 files + 4 config files
- **Options**: Single large commit, commits per subsystem, one file per commit
- **Choice**: One file per commit (45 commits total)
- **Rationale**:
  - User preference (explicit request)
  - Clear history (easy to see when each file was added)
  - Easy to review (small diffs)
  - Easy to revert specific files (surgical rollback)
  - Git bisect friendly (pinpoint issues)
- **Impact**: 45 commits in git history
- **Trade-offs**: Verbose history, but clarity > conciseness for this project
- **Reversible**: Could squash commits later (but defeats the purpose)

### Decision 11: Commit Message Format - English Karma Convention
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Commit message style and language
- **Options**: Korean messages, English messages, conventional commits, free-form
- **Choice**: English with Karma convention (feat:, fix:, refactor:, etc.)
- **Rationale**:
  - User preference
  - Standard in open source (wider audience)
  - Good tooling support (changelog generators, semantic versioning)
  - Clear semantic meaning (feat vs fix vs refactor)
- **Impact**: All 45 commit messages follow this format
- **Trade-offs**: None (standard practice)
- **Reversible**: N/A (git history is immutable)

### Decision 12: Co-Author Attribution - Skip
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Whether to add "Co-Authored-By: Claude" to commit messages
- **Options**: Add co-author tag, skip co-author tag
- **Choice**: Skip co-author tag
- **Rationale**: User preference (wanted clean commit history without AI attribution)
- **Impact**: All commits authored solely by user
- **Trade-offs**: Less transparency about AI involvement, but cleaner history
- **Reversible**: Could add via git commit --amend (but tedious)

### Decision 13: Log Format - JSONL (Newline-Delimited JSON)
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Log format for agent activity tracking
- **Options**: Plain text, JSON (array), JSONL, syslog format
- **Choice**: JSONL (newline-delimited JSON)
- **Rationale**:
  - Easy to parse programmatically (one JSON object per line)
  - Stream-friendly (can tail -f and parse incrementally)
  - Structured data (queryable with jq, grep, etc.)
  - Standard format (many tools support it)
  - Append-only (no need to rewrite entire file)
- **Impact**: logging/logger.ts implementation
- **Trade-offs**: Less human-readable than plain text, but tooling compensates
- **Reversible**: Yes (just change logger implementation)

### Decision 14: Type Safety - Typed Arrays for SQLite
- **Date**: 2026-02-27 (Phase 2, fixes)
- **Context**: TypeScript type errors with `unknown[]` in SQLite prepared statement bindings
- **Options**: Keep unknown[] (with type assertions), use typed arrays, use any (disable type checking)
- **Choice**: Typed arrays (e.g., `[agentId] as [string]`)
- **Rationale**:
  - Full type safety (catches bugs at compile time)
  - Better IDE support (autocomplete, type hints)
  - No runtime overhead (type assertions are compile-time only)
  - Explicit about expected types
- **Impact**: 4 fix commits (db/store.ts, messaging/inbox.ts)
- **Trade-offs**: More verbose, but safety > conciseness
- **Reversible**: Yes (could revert to unknown[] with suppressions)

### Decision 15: TypeScript Config - Bun Compatibility Flags
- **Date**: 2026-02-27 (Phase 2, fixes)
- **Context**: TypeScript errors about importing .ts files directly
- **Options**: Use .js extensions (fake), allowImportingTsExtensions flag, disable type checking
- **Choice**: Enable `allowImportingTsExtensions: true` in tsconfig.json
- **Rationale**:
  - Bun requirement (allows direct .ts imports)
  - Cleaner imports (use .ts extensions, matches actual files)
  - Type-safe (no workarounds)
- **Impact**: tsconfig.json modification
- **Trade-offs**: Bun-specific (not compatible with tsc bundling), but we use Bun
- **Reversible**: Yes (but would break imports)

### Decision 16: Push Strategy - Push After Every Commit
- **Date**: 2026-02-27 (Phase 2)
- **Context**: When to push commits to remote
- **Options**: Push at end of session, push after each subsystem, push after every commit
- **Choice**: Push after every commit (45 pushes)
- **Rationale**:
  - User preference
  - Immediate backup (no data loss risk)
  - Allows for collaboration (others can pull at any time)
  - Clear progress tracking (remote reflects current state)
- **Impact**: All 45 commits pushed to origin/main
- **Trade-offs**: More network overhead, but negligible
- **Reversible**: N/A (already pushed)

### Decision 17: Model Tiering - Opus/Sonnet/Haiku
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Route tasks to appropriate model tier based on complexity
- **Options**: Single tier (all opus), manual routing, keyword-based automatic routing
- **Choice**: Keyword-based routing to 3 tiers (Opus, Sonnet, Haiku)
- **Rationale**:
  - Cost optimization (use cheaper models for simple tasks)
  - Performance optimization (faster responses for simple tasks)
  - Quality optimization (use best models for complex tasks)
  - Keywords provide simple but effective heuristic
- **Impact**: core/router.ts implementation
- **Trade-offs**: Keyword-based is imperfect, but good enough (can enhance later)
- **Reversible**: Yes (routing logic is isolated)

### Decision 18: Budget Control - Circuit Breaker Pattern
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Prevent runaway token usage
- **Options**: Hard limits (kill agents), circuit breaker (pause), no limits
- **Choice**: Circuit breaker pattern (pause when threshold exceeded)
- **Rationale**:
  - Prevents runaway costs (protects budget)
  - Graceful degradation (pause, not kill)
  - Configurable thresholds (can adjust per tier)
  - User notification (aware of budget issues)
- **Impact**: core/budget.ts implementation
- **Trade-offs**: Adds complexity, but safety is critical
- **Reversible**: Yes (can disable budget checks)

### Decision 19: Concurrency Control - Max 3 Concurrent Agents
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Limit concurrent agent execution to prevent resource exhaustion
- **Options**: No limit, hard limit (3), dynamic limit (based on system resources)
- **Choice**: Hard limit of 3 concurrent agents (configurable in config.yml)
- **Rationale**:
  - Prevents resource exhaustion (CPU, memory, API rate limits)
  - Reasonable default (3 is enough for most workflows)
  - Configurable (can adjust based on hardware)
  - Simple queue-based scheduler
- **Impact**: core/scheduler.ts implementation
- **Trade-offs**: May bottleneck for large teams, but can be configured
- **Reversible**: Yes (change config value)

### Decision 20: Message Queue - Per-Agent Inbox with EventEmitter
- **Date**: 2026-02-27 (Phase 2)
- **Context**: Inter-agent messaging system
- **Options**: Shared queue, per-agent inbox, pub/sub system
- **Choice**: Per-agent inbox using Node EventEmitter
- **Rationale**:
  - Simple (built-in EventEmitter)
  - Isolated (each agent has own inbox)
  - Event-driven (agents can react to new messages)
  - Type-safe (TypeScript generics)
- **Impact**: messaging/inbox.ts implementation
- **Trade-offs**: In-memory only (lost on restart), but acceptable for session-based messaging
- **Reversible**: Yes (can swap for persistent queue)

---

## Decision Categories

### Architecture (5 decisions)
- Runtime: Bun
- Session Isolation: tmux
- State Persistence: SQLite with WAL
- Agent Communication: MCP
- Conflict Prevention: Ownership + Worktree

### Implementation Strategy (3 decisions)
- Parallel Sub-Agents
- One File Per Commit
- Push After Every Commit

### User Preferences (3 decisions)
- Binary Name: `orc`
- Commit Messages: English Karma Convention
- No Co-Author Tags

### Technical Details (9 decisions)
- TUI Framework: Ink
- Log Format: JSONL
- Type Safety: Typed Arrays
- TypeScript Config: Bun Compatibility
- Model Tiering: Opus/Sonnet/Haiku
- Budget Control: Circuit Breaker
- Concurrency: Max 3
- Message Queue: Per-Agent Inbox
- Physical Isolation: Git Worktree

---

## Reversal History
None yet. All decisions still in effect.

---

## Future Decisions Needed

### For Interactive REPL (Next Phase)
1. REPL interface: readline vs Ink vs custom?
2. Natural language parsing: Local LLM vs API vs keyword-based?
3. Output streaming: Plain text vs structured vs mixed?
4. Session state: In-memory vs SQLite vs Redis?
5. Error handling: Retry vs fail vs ask user?

### For Production
1. Deployment strategy: Single binary vs Docker vs systemd service?
2. Monitoring: Prometheus vs custom vs none?
3. Multi-tenancy: Support multiple users?
4. Security: API keys, rate limiting, sandboxing?

---

## Session 2026-02-27 08:00: REPL UX Enhancement

### Decision 21: Markdown 라인 버퍼링 방식
- **Date**: 2026-02-27
- **Context**: 스트리밍 텍스트에서 마크다운을 ANSI로 변환하는 방법
- **Options**: 문자 단위 처리, 라인 단위 버퍼링, 전체 텍스트 후처리
- **Choice**: 라인 단위 버퍼링 후 마크다운 변환
- **Rationale**: 마크다운 패턴(`**bold**`)이 완성된 라인에서만 정확히 파싱됨. 라인 단위 지연은 스트리밍에서 체감 불가. 전체 후처리는 실시간성 상실.
- **Impact**: renderer.ts의 text() 함수 구조 변경 (lineBuffer + flushLineBuffer)
- **Reversible**: Yes

### Decision 22: Word Wrap은 raw 텍스트 기준
- **Date**: 2026-02-27
- **Context**: 마크다운 렌더링된 텍스트의 폭 계산 복잡도
- **Options**: ANSI 코드 제외한 visible length 계산, raw 텍스트 길이 기준
- **Choice**: raw 텍스트 길이 기준으로 wrap 후 마크다운 렌더링
- **Rationale**: 보수적 접근 — 마크다운 마커(`**`, `` ` ``)가 렌더링 시 제거되므로 실제 출력은 항상 더 짧음. ANSI 코드 파싱 없이 단순.
- **Impact**: wrapText() → renderMarkdownLine() 순서
- **Reversible**: Yes

### Decision 23: ora 스트림을 stdout로 통일
- **Date**: 2026-02-27
- **Context**: ora 스피너와 박스 렌더링 간 커서 위치 불일치
- **Options**: stderr 유지 + 커서 보정, stdout로 통일
- **Choice**: ora에 `stream: process.stdout` 명시
- **Rationale**: 박스 렌더링도 stdout 사용. 같은 스트림으로 커서 위치 일관성 확보. 파이프 시 스피너 출력 포함되지만 REPL은 항상 TTY.
- **Impact**: startSpinner()에 stream 옵션 추가
- **Reversible**: Yes

---

**Last updated**: 2026-02-27 08:00
**Total decisions**: 23
