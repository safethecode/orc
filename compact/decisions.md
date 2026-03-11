# All Decisions Made (Cumulative)

This file contains ALL architectural, technical, and design decisions made across all sessions.

**Last updated**: 2026-03-07 19:45
**Total decisions**: 31 (added 8 from session 2026-03-07)

---

## Session 2026-03-07: Design Agent Reference-First Protocol

### Decision 24: Reference-First Protocol as [PRIORITY 0]
- **Date**: 2026-03-07
- **Context**: Design agent was producing generic "AI-looking" designs when no references provided
- **Options**:
  - A) Add more design rules and constraints to profile
  - B) Provide better examples in profile
  - C) Make references MANDATORY via 5-step protocol with verification
- **Choice**: C (Reference-First Protocol)
- **Rationale**: Rules can be ignored, examples can be misunderstood, but a mandatory protocol with verification steps forces the agent to think like a real product designer. Without explicit references, AI defaults to statistical mean of training data (purple gradients, glassmorphism, bento grids). References force opinionated output.
- **Impact**: Every UI generation now requires declared references, making "AI look" impossible. Added [PRIORITY 0] section to design.md with 5-step protocol: IDENTIFY → EXTRACT → DECLARE → GENERATE → VERIFY
- **Trade-offs**: Slightly more verbose process, but eliminates entire class of generic design problems
- **Reversible**: No (this is a fundamental design philosophy)

### Decision 25: Extract Real Design Tokens (not generic guidelines)
- **Date**: 2026-03-07
- **Context**: Needed concrete reference data for agents to follow, not vague prose descriptions
- **Options**:
  - A) Describe design styles in prose (e.g., "Linear uses clean, minimal design")
  - B) Extract actual hex values, font stacks, spacing systems from real products
- **Choice**: B (Real extracted tokens)
- **Rationale**: Prose is ambiguous. `#3182f6` is not. Exact values force precision and eliminate AI interpretation variance. Agents can directly apply constraints rather than guess.
- **Impact**: Reference database is now a constraint system (exact hex, spacing, fonts), not a suggestion list. Each reference includes: primary/text/bg colors, font stacks, density signature, component patterns, anti-patterns.
- **Trade-offs**: Requires more upfront work to extract tokens, but output quality dramatically improves
- **Reversible**: No (exact values are the entire point)

### Decision 26: Anonymize All Service Names
- **Date**: 2026-03-07
- **Context**: User concerned about legal implications of naming real products in agent profiles
- **Options**:
  - A) Keep real names (Toss, Linear, Stripe, etc.)
  - B) Use generic descriptions ("Korean fintech", "PM tool")
  - C) Use anonymous codes (KR-1, GL-1, etc.)
- **Choice**: C (Anonymous codes)
- **Rationale**: Generic descriptions lose specificity ("Korean fintech" doesn't convey Toss's specific warm minimalism). Codes preserve reference structure and specificity while removing legal risk. Can still say "KR-1 uses #3182f6 and spacious whitespace" without trademark issues.
- **Impact**: All references now use KR-/GL- codes. No URLs, no proprietary font brand names, no cultural references to specific Korean portals.
- **Trade-offs**: Less readable for humans who don't know the mapping, but safer and still functional
- **Reversible**: Yes (could add mapping table, but not recommended for legal safety)

### Decision 27: Standardize Korean Fonts to Pretendard Only
- **Date**: 2026-03-07
- **Context**: Profile had inconsistent Korean font recommendations (Pretendard, Noto Sans KR, Noto Serif KR) across different sections
- **Options**:
  - A) Keep multiple options for variety
  - B) Standardize to Pretendard only
  - C) Use system fonts only (no web fonts)
- **Choice**: B (Pretendard only)
- **Rationale**: Modern Korean SaaS has converged on Pretendard (200-900 weights, excellent rendering, wide adoption, actively maintained). Multiple fonts create decision paralysis for agents. System fonts lack Korean-specific optimizations.
- **Impact**: All Korean text uses `Pretendard → -apple-system → BlinkMacSystemFont → system-ui → sans-serif` fallback chain. Removed all Noto Sans KR / Noto Serif KR references.
- **Trade-offs**: Less variety, but more consistency and better agent decision-making
- **Reversible**: Yes (could add Noto back if needed, but not recommended)

### Decision 28: Use AG Grid for CRM Demo (not raw HTML table)
- **Date**: 2026-03-07
- **Context**: Initial CRM demo used styled HTML `<table>`, looked "too AI-like" despite following references
- **Options**:
  - A) Style raw HTML table with more sophisticated CSS
  - B) Use production-grade data grid library (AG Grid Community)
- **Choice**: B (AG Grid Community v32.3.3)
- **Rationale**: Real CRM products don't use styled HTML tables. They use libraries like AG Grid, TanStack Table, react-data-grid. Using the same tools produces the same look. HTML tables have fundamental limitations (no virtual scrolling, poor keyboard nav, manual sorting/filtering).
- **Impact**: CRM demo now uses AG Grid with Relate-style dark theme customization. Went from "AI-like" to "production-grade" in user's assessment.
- **Trade-offs**: Added external dependency (CDN), but gained production realism
- **Reversible**: Yes (but would lose production realism)

### Decision 29: Include "Does NOT use" Anti-Patterns in References
- **Date**: 2026-03-07
- **Context**: References needed to show what to avoid, not just what to include
- **Options**:
  - A) Only show positive patterns (what each product does use)
  - B) Also show negative patterns (what each product explicitly does NOT use)
- **Choice**: B (Include anti-patterns)
- **Rationale**: "Linear does NOT use shadows, dark sidebar, or bento grids" is as important as "Linear uses compact nav and unified light interface". Constraints by subtraction. AI defaults often include these overused patterns — explicitly forbidding them prevents regression.
- **Impact**: Each reference now includes "Does NOT use" list. Example: KR-1 does NOT use dense tables, aggressive CTAs, gradient backgrounds, dark sidebar.
- **Trade-offs**: Slightly longer reference entries, but prevents common AI design mistakes
- **Reversible**: No (critical for preventing AI defaults)

### Decision 30: Make Protocol 5 Steps (not 3 or 7)
- **Date**: 2026-03-07
- **Context**: Needed structured process for reference-based design
- **Options**:
  - A) 3 steps (identify, generate, verify)
  - B) 5 steps (identify, extract, declare, generate, verify)
  - C) 7+ steps (add research, iteration, user testing, etc.)
- **Choice**: B (5 steps)
- **Rationale**: 3 steps is too loose (no explicit declaration or extraction, agents skip to generation). 7+ steps is too rigid (slows execution, creates compliance burden). 5 is the minimum viable constraint that forces thoughtful process without bureaucracy.
- **Impact**: Every UI generation now follows IDENTIFY → EXTRACT → DECLARE → GENERATE → VERIFY. Agents must explicitly state what they're borrowing before coding.
- **Trade-offs**: Adds process overhead, but prevents thoughtless generation
- **Reversible**: No (this is the core protocol)

### Decision 31: Co-Author Tag Policy Changed
- **Date**: 2026-03-07
- **Context**: User previously requested "no co-author tags" (Decision 12), now changed preference
- **Old rule**: No `Co-Authored-By` tags on commits
- **New rule**: ALL commits must include `Co-Authored-By: orc-agent <hello@sson.tech>`
- **Rationale**: User wants to track agent-assisted commits for project visibility
- **Impact**: All future commits will include co-author tag. Memory file updated. Overwrites Decision 12.
- **Trade-offs**: Commits are slightly more verbose, but tracking benefit outweighs
- **Reversible**: Yes (user preference, can change again)

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

### Decision 4: Profile Config Format - Frontmatter YAML
- **Date**: 2026-02-27 (Phase 3)
- **Context**: How to specify agent config + instructions in single file
- **Options**: Separate JSON + MD files, TOML frontmatter, YAML frontmatter
- **Choice**: YAML frontmatter (like Hugo, Jekyll)
- **Rationale**:
  - Single file (less clutter than JSON config + MD instructions)
  - Human-readable config (YAML > JSON for readability)
  - Standard pattern (widely used in static site generators)
  - Easy to parse (`gray-matter` library)
- **Impact**: profiles/*.md format standardized
- **Trade-offs**: Slightly more parsing overhead, but negligible
- **Reversible**: Yes (could migrate to separate files or different format)

### Decision 5: Profile Storage - `profiles/` Directory
- **Date**: 2026-02-27 (Phase 3)
- **Context**: Where to store agent profile files
- **Options**: `~/.orchestrator/profiles/`, local `profiles/`, both
- **Choice**: Both — local first, then fallback to user dir
- **Rationale**:
  - Project-specific profiles (local) for customization
  - Global profiles (user dir) for reusable agents
  - Flexibility for both use cases
- **Impact**: Profile loader checks local first, then user dir
- **Trade-offs**: Slight complexity in loader, but better UX
- **Reversible**: Yes (could enforce single location)

### Decision 6: Task Queue - FIFO with Priority
- **Date**: 2026-02-27 (Phase 4)
- **Context**: How to order tasks when multiple are submitted
- **Options**: Pure FIFO, priority-based, deadline-based
- **Choice**: FIFO with optional priority override
- **Rationale**:
  - FIFO is intuitive and predictable
  - Priority allows urgent tasks (but rarely needed)
  - Simpler than deadline-based scheduling
- **Impact**: scheduler.ts implements PriorityQueue
- **Trade-offs**: No deadline support, but not needed for initial version
- **Reversible**: Yes (could add deadline scheduling later)

### Decision 7: Worker Pool - Dynamic Sizing
- **Date**: 2026-02-27 (Phase 5)
- **Context**: How many agents to run concurrently
- **Options**: Fixed pool (e.g., 4 workers), dynamic (scale to demand), unlimited
- **Choice**: Dynamic with max limit (default 4, configurable)
- **Rationale**:
  - Fixed pool wastes resources when idle
  - Unlimited risks resource exhaustion (API rate limits, memory)
  - Dynamic with cap balances efficiency and safety
- **Impact**: worker-pool.ts scales workers 0 to maxWorkers
- **Trade-offs**: Slightly more complex than fixed pool, but better resource usage
- **Reversible**: Yes (could simplify to fixed pool)

### Decision 8: Agent Output Capture - tmux capture-pane
- **Date**: 2026-02-27 (Phase 6)
- **Context**: How to get agent output from tmux sessions
- **Options**: Log files, tmux capture-pane, pipe stdout
- **Choice**: tmux capture-pane with incremental diffs
- **Rationale**:
  - No file I/O overhead (capture from memory)
  - Preserves ANSI colors and formatting
  - Works with any CLI tool (not just ones that support piping)
  - Incremental = only process new lines (efficient)
- **Impact**: terminal.ts implements capture() with diff tracking
- **Trade-offs**: Requires parsing pane content, but worth it for flexibility
- **Reversible**: Yes (could switch to log files)

### Decision 9: CLI Router - Claude CLI with Profiles
- **Date**: 2026-02-27 (Phase 7)
- **Context**: How to invoke different AI models/agents
- **Options**: Direct API calls, CLI wrappers, unified router
- **Choice**: Claude CLI with profile system (`-p <profile>`)
- **Rationale**:
  - Claude CLI already handles auth, streaming, retries
  - Profile system allows per-agent model selection
  - Less code than direct API integration
  - Easy to swap providers (just change profile)
- **Impact**: router.ts executes `claude -p <name> <message>`
- **Trade-offs**: Dependency on external CLI, but it's official and maintained
- **Reversible**: Yes (could switch to direct API)

### Decision 10: State Management - SQLite
- **Date**: 2026-02-27 (Phase 8)
- **Context**: How to persist tasks, agents, decisions
- **Options**: In-memory (no persistence), JSON files, SQLite, PostgreSQL
- **Choice**: SQLite via bun:sqlite
- **Rationale**:
  - Built into Bun (zero dependencies)
  - ACID transactions (data integrity)
  - Fast for local queries
  - No server overhead like PostgreSQL
  - Better than JSON for concurrent access
- **Impact**: db.ts implements SQLite schema and queries
- **Trade-offs**: Single-process (no distributed), but fine for local tool
- **Reversible**: Partially (could migrate to PostgreSQL, but loses Bun integration benefit)

### Decision 11: REPL Interface - readline over Ink
- **Date**: 2026-02-27 (Phase 9)
- **Context**: How to build interactive REPL
- **Options**: Native readline, Ink (React for CLI), custom TUI
- **Choice**: Native readline with custom rendering
- **Rationale**:
  - readline is standard library (no dependencies)
  - Ink adds React overhead (overkill for simple REPL)
  - Custom rendering gives full control over output
  - Simpler mental model (no React lifecycle)
- **Impact**: repl.ts uses readline + custom renderer
- **Trade-offs**: More manual rendering code, but better performance and control
- **Reversible**: Yes (could migrate to Ink if needed)

### Decision 12: Commit Message Format - Karma Convention
- **Date**: 2026-02-27
- **Context**: Need consistent commit message style
- **Options**: Conventional Commits, Karma, freeform
- **Choice**: Karma convention
- **Rationale**: Simple, clear, widely used in open source
- **Format**: `<type>: <subject>` (e.g., `feat: add repl`, `fix: cursor bug`)
- **Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **Impact**: All commits follow this format
- **Reversible**: Yes
- **OVERRIDDEN**: Decision 31 changed co-author policy (was "no tags", now required)

### Decision 13: Terminal Clear Strategy - Full Scrollback
- **Date**: 2026-02-27
- **Context**: How to clear terminal in REPL
- **Options**: `\x1b[2J` (screen only), `\x1b[2J\x1b[3J\x1b[H` (screen + scrollback)
- **Choice**: Full clear with scrollback (`\x1b[2J\x1b[3J\x1b[H`)
- **Rationale**: Users expect `/clear` to actually clear everything, not leave history in scrollback
- **Impact**: repl.ts uses full clear sequence
- **Reversible**: Yes
- **Trade-offs**: Loses scrollback history, but that's the intent

### Decision 14: Keypress Hints - Inline Same-Line
- **Date**: 2026-02-27
- **Context**: How to show hints during input without corrupting readline
- **Options**: Newline `\n` + escape, inline same-line with `\x1b[{col}G` + `\x1b[K`
- **Choice**: Inline same-line
- **Rationale**: Newline escape sequences cause terminal scroll corruption during readline. Inline approach uses column positioning to write hint, then return cursor to input.
- **Impact**: Keypress hint rendering uses `\x1b[{col}G` + `\x1b[K`
- **Reversible**: Yes
- **Trade-offs**: More complex escape sequence math, but no corruption

### Decision 15: CJK Input Handling - Skip Custom Escapes
- **Date**: 2026-02-27
- **Context**: Korean/Japanese/Chinese input was corrupted by custom escape codes
- **Options**: Fix escape sequences for wide chars, skip custom rendering for CJK
- **Choice**: Skip all custom escape code writing when CJK input detected, let readline handle it
- **Rationale**: `line.length` ≠ display width for wide characters. Readline already handles wide chars correctly. Custom escapes break this.
- **Impact**: CJK input now renders correctly
- **Reversible**: Yes
- **Trade-offs**: Lose keypress hints for CJK input, but input correctness is more important

### Decision 16: Streamer Events - Buffer Deltas, Emit on Block Complete
- **Date**: 2026-02-27
- **Context**: How to handle streaming events from Claude CLI
- **Options**: Emit per-delta `text` events, buffer and emit `text_complete`
- **Choice**: Buffer deltas, emit `text_complete` on block completion
- **Rationale**: Per-delta rendering is too chatty, causes flicker. Buffering allows smooth rendering of complete text blocks.
- **Impact**: Streamer uses `content_block_start/stop` pattern
- **Reversible**: Yes
- **Trade-offs**: Slight latency (wait for block complete), but better UX

### Decision 17: ora Spinner Stream - stdout
- **Date**: 2026-02-27
- **Context**: ora spinner and box rendering had cursor mismatch
- **Options**: Keep ora on stderr + cursor correction, move ora to stdout
- **Choice**: `stream: process.stdout` on ora
- **Rationale**: Box rendering uses stdout. Same stream = consistent cursor position. REPL is always TTY, so spinner output is fine.
- **Impact**: `startSpinner()` includes `stream: process.stdout`
- **Reversible**: Yes
- **Trade-offs**: Spinner output included in piped stdout, but REPL is never piped

### Decision 18: Cursor Cleanup - `\r\x1b[K` After spinner.stop()
- **Date**: 2026-02-27
- **Context**: Cursor position mismatch after stopping spinner
- **Options**: Rely on ora cleanup, manual `\r\x1b[K`
- **Choice**: Always write `\r\x1b[K` after `spinner.stop()`
- **Rationale**: Ensures clean cursor position regardless of ora's internal cleanup
- **Impact**: All `spinner.stop()` calls followed by `\r\x1b[K`
- **Reversible**: Yes
- **Trade-offs**: Slightly redundant, but guarantees clean state

### Decision 19: Markdown Rendering - Line Buffering
- **Date**: 2026-02-27
- **Context**: How to render markdown in streaming text
- **Options**: Character-by-character, line buffering + render, full text post-process
- **Choice**: Line buffering + render
- **Rationale**: Markdown patterns (`**bold**`) only parse correctly on complete lines. Line delay is imperceptible in streaming. Full post-process loses real-time feel.
- **Impact**: renderer.ts uses lineBuffer + flushLineBuffer
- **Reversible**: Yes
- **Trade-offs**: Slight latency per line, but necessary for correct markdown rendering

### Decision 20: Word Wrap - Raw Text Basis
- **Date**: 2026-02-27
- **Context**: How to calculate text width for wrapping with markdown
- **Options**: Strip ANSI codes and calculate visible length, use raw text length
- **Choice**: Raw text length basis, then render markdown
- **Rationale**: Conservative approach. Markdown markers (`**`, `` ` ``) are removed during rendering, so actual output is always shorter than raw text. Avoids ANSI parsing complexity.
- **Impact**: `wrapText()` → `renderMarkdownLine()` sequence
- **Reversible**: Yes
- **Trade-offs**: Slightly conservative wrapping, but simpler and always safe

### Decision 21: Markdown Line Buffering Method
- **Date**: 2026-02-27
- **Context**: How to process streaming text for markdown rendering
- **Options**: Character-level processing, line buffering, full text post-processing
- **Choice**: Line buffering + flush on complete
- **Rationale**: Markdown patterns (`**bold**`) only parse correctly on complete lines. Line-level delay is imperceptible in streaming context. Full post-processing loses real-time streaming feel.
- **Impact**: renderer.ts text() function structure (lineBuffer + flushLineBuffer)
- **Reversible**: Yes

### Decision 22: Word Wrap Basis - Raw Text
- **Date**: 2026-02-27
- **Context**: How to calculate text width for wrapping when markdown is involved
- **Options**: Calculate visible length excluding ANSI codes, use raw text length
- **Choice**: Raw text length basis, wrap first, then render markdown
- **Rationale**: Conservative approach. Markdown markers (`**`, `` ` ``) are removed during rendering, so actual output is always shorter than raw input. Avoids complex ANSI code parsing.
- **Impact**: wrapText() → renderMarkdownLine() sequence
- **Reversible**: Yes

### Decision 23: ora Stream - stdout Unification
- **Date**: 2026-02-27
- **Context**: Cursor position mismatch between ora spinner and box rendering
- **Options**: Keep ora on stderr + cursor correction, move to stdout
- **Choice**: Explicit `stream: process.stdout` on ora
- **Rationale**: Box rendering uses stdout. Same stream = consistent cursor position. REPL is always TTY environment, so spinner output is acceptable.
- **Impact**: startSpinner() includes stream option
- **Reversible**: Yes

---

## Decisions Reversed

### Decision 12 (Partially Reversed by Decision 31)
- **Original**: No co-author tags on commits
- **Reversed**: 2026-03-07 (Decision 31)
- **New policy**: ALL commits include `Co-Authored-By: orc-agent <hello@sson.tech>`
- **Reason**: User preference changed

---

## Future Decisions Needed

### For Design Agent (Short Term)
1. Should reference database include mobile app designs?
2. How many references is optimal? (20-30 total vs 20-30 per category)
3. Should component-level library be separate profile?
4. Build visual comparison tool (AI default vs Reference-based)?

### For Interactive REPL (Medium Term)
1. REPL interface: readline vs Ink vs custom?
2. Natural language parsing: Local LLM vs API vs keyword-based?
3. Output streaming: Plain text vs structured vs mixed?
4. Session state: In-memory vs SQLite vs Redis?
5. Error handling: Retry vs fail vs ask user?

### For Production (Long Term)
1. Deployment strategy: Single binary vs Docker vs systemd service?
2. Monitoring: Prometheus vs custom vs none?
3. Multi-tenancy: Support multiple users?
4. Security: API keys, rate limiting, sandboxing?

---

**Last updated**: 2026-03-07 19:45
**Total decisions**: 31
