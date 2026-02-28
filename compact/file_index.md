# File Index (Cumulative)

Complete catalog of all files created, modified, or deleted across all sessions.

Last updated: 2026-02-27 02:44

---

## Session 2026-02-27: Orchestrator Implementation

### Project Configuration Files (4 files)

#### package.json
- **Created**: Phase 1 (~00:00)
- **Modified**: Phase 1 (bin rename: orch -> orc), Phase 2 (zod dependency)
- **Purpose**: Project manifest, dependencies, scripts, bin entry for `orc` command
- **Location**: `/Users/aaron-son/Documents/orchestrator/package.json`
- **Size**: ~400 bytes
- **Commits**:
  - f2f2253 - feat: initialize package.json with dependencies
  - 95e478d - fix: rename bin command from orch to orc
  - 36dc544 - feat: add zod dependency for MCP server schema validation

**Key contents**:
```json
{
  "name": "orchestrator",
  "version": "0.1.0",
  "bin": { "orc": "./src/index.ts" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "ink": "^5.1.0",
    "react": "^18.3.1",
    "yaml": "^2.7.0",
    "zod": "^4.3.6"
  }
}
```

---

#### tsconfig.json
- **Created**: Phase 1 (~00:00)
- **Modified**: Phase 2 (allowImportingTsExtensions)
- **Purpose**: TypeScript compiler configuration for Bun runtime
- **Location**: `/Users/aaron-son/Documents/orchestrator/tsconfig.json`
- **Size**: ~300 bytes
- **Commits**:
  - 7a80633 - feat: add TypeScript config with JSX support for Ink
  - f4414c0 - fix: enable allowImportingTsExtensions for Bun compatibility

**Key settings**:
- strict: true
- jsx: react
- module: ESNext
- allowImportingTsExtensions: true (Bun-specific)
- noEmit: true

---

#### bunfig.toml
- **Created**: Phase 1 (~00:00)
- **Purpose**: Bun runtime configuration
- **Location**: `/Users/aaron-son/Documents/orchestrator/bunfig.toml`
- **Size**: ~100 bytes
- **Commit**: 22758f8 - feat: add bunfig.toml for Bun runtime config

---

#### .gitignore
- **Created**: Phase 1 (~00:00)
- **Purpose**: Git ignore rules
- **Location**: `/Users/aaron-son/Documents/orchestrator/.gitignore`
- **Size**: ~150 bytes
- **Commit**: 39822af - feat: add .gitignore for node_modules, db, and logs

**Ignores**:
- node_modules/
- db/
- logs/
- worktrees/
- .DS_Store
- *.log

---

### Source Code - Config Layer (2 files)

#### src/config/types.ts
- **Created**: Phase 2 (~00:15)
- **Modified**: Phase 2 (file ownership types)
- **Purpose**: All TypeScript type definitions for the project
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/config/types.ts`
- **Size**: ~300 lines
- **Commits**:
  - 19703a0 - feat: define core type definitions for all modules
  - d1ab11d - feat(config): add file ownership types for conflict prevention

**Key types defined**:
- ModelTier (enum: opus, sonnet, haiku)
- AgentStatus (enum: idle, busy, error, stopped)
- TaskStatus (enum: pending, running, completed, failed)
- AgentProfile (interface)
- Task (interface)
- SessionInfo (interface)
- HandoffOptions (interface)
- FileOwnership (interface)
- OwnershipDeclaration (interface)
- ConflictCheckResult (interface)
- OrchestratorConfig (interface)

---

#### src/config/loader.ts
- **Created**: Phase 2 (~00:50)
- **Modified**: Phase 2 (deep merge type fix)
- **Purpose**: YAML configuration loader with deep merge and path expansion
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/config/loader.ts`
- **Size**: ~150 lines
- **Commits**:
  - fcedf0e - feat(config): add YAML config loader with deep merge support
  - 0d81756 - fix: resolve deep merge type compatibility with OrchestratorConfig

**Key functions**:
- loadConfig(path?: string): OrchestratorConfig
- deepMerge<T>(target, source): T
- expandPath(path: string): string (handles ~ expansion)

---

### Source Code - Session Layer (3 files)

#### src/session/terminal.ts
- **Created**: Phase 2 (~00:15)
- **Purpose**: tmux command wrapper for session management
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/session/terminal.ts`
- **Size**: ~200 lines
- **Commit**: c0f99c3 - feat: add tmux command wrapper for session management

**Key functions** (7 total):
- createSession(name: string, startDir?: string, command?: string): void
- killSession(name: string): void
- hasSession(name: string): boolean
- sendKeys(name: string, keys: string): void
- capturePane(name: string): string
- listSessions(): string[]
- (internal) execTmux(args: string[]): string

---

#### src/session/manager.ts
- **Created**: Phase 2 (~00:30)
- **Purpose**: Session lifecycle manager for agent tmux sessions
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/session/manager.ts`
- **Size**: ~150 lines
- **Commit**: a330cf4 - feat: add session lifecycle manager for agent tmux sessions

**Key class**: SessionManager
**Methods**:
- spawnSession(agentId: string, profile: AgentProfile, workDir: string): void
- destroySession(agentId: string): void
- isAlive(agentId: string): boolean
- captureOutput(agentId: string): string
- sendInput(agentId: string, text: string): void

---

#### src/session/worktree.ts
- **Created**: Phase 2 (~00:35)
- **Purpose**: Git worktree manager for agent isolation
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/session/worktree.ts`
- **Size**: ~120 lines
- **Commit**: d1f80b1 - feat(session): add git worktree manager for agent isolation

**Key class**: WorktreeManager
**Methods**:
- create(agentId: string, baseBranch?: string): string
- remove(agentId: string): void
- cleanup(): void

---

### Source Code - Agent Layer (3 files)

#### src/agents/provider.ts
- **Created**: Phase 2 (~00:15)
- **Purpose**: CLI provider abstraction for agent command construction
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/agents/provider.ts`
- **Size**: ~100 lines
- **Commit**: 640f52a - feat: add CLI provider abstraction for agent commands

**Key function**:
- buildCommand(profile: AgentProfile, sessionId: string, task?: Task): string[]

**Supports**: Claude CLI, Codex CLI (future: custom CLIs)

---

#### src/agents/registry.ts
- **Created**: Phase 2 (~00:25)
- **Purpose**: Agent registry with profile loading and YAML parsing
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/agents/registry.ts`
- **Size**: ~150 lines
- **Commit**: 992e434 - feat: add agent registry with profile loading and YAML parsing

**Key class**: AgentRegistry
**Methods**:
- loadProfiles(dir: string): void
- getProfile(agentId: string): AgentProfile | undefined
- listProfiles(): AgentProfile[]

**Features**: Parses .md files with YAML frontmatter

---

#### src/agents/preflight.ts
- **Created**: Phase 2 (~00:45)
- **Purpose**: Environment pre-flight checker for agent requirements
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/agents/preflight.ts`
- **Size**: ~80 lines
- **Commit**: 0b1e72f - feat: add environment pre-flight checker for agent requirements

**Key function**:
- checkRequirements(): { passed: boolean; errors: string[] }

**Checks**:
- tmux installed
- git installed
- claude/codex CLI available
- Required directories exist

---

### Source Code - Database Layer (2 files)

#### src/db/schema.ts
- **Created**: Phase 2 (~00:15)
- **Modified**: Phase 2 (file_ownership table)
- **Purpose**: SQLite schema with WAL mode and table definitions
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/db/schema.ts`
- **Size**: ~200 lines
- **Commits**:
  - 176445d - feat: add SQLite schema with WAL mode and table definitions
  - fe77eaa - feat(db): add file_ownership table with indexes

**Key function**: initDb(dbPath: string): Database

**Tables** (6 total):
1. agents (id, profile, status, session_id, started_at, stopped_at)
2. tasks (id, description, status, tier, assigned_to, created_at, completed_at)
3. messages (id, from_agent, to_agent, content, timestamp, read)
4. file_locks (file_path, agent_id, locked_at)
5. token_usage (agent_id, tier, tokens_used, timestamp)
6. file_ownership (id, file_path, owner_agent, description, declared_at, released_at)

**Features**: WAL mode, indexes on foreign keys

---

#### src/db/store.ts
- **Created**: Phase 2 (~00:30)
- **Modified**: Phase 2 (ownership CRUD, typed arrays fix)
- **Purpose**: Store data-access layer with prepared statements
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/db/store.ts`
- **Size**: ~400 lines
- **Commits**:
  - 80ea673 - feat: add Store data-access layer with prepared statements
  - ae3cd4d - feat(db): add ownership CRUD methods to Store class
  - e6d323c - fix: use typed arrays instead of unknown[] for SQLite bindings

**Key class**: Store
**Method categories**:
- Agent CRUD: createAgent, getAgent, updateAgent, deleteAgent
- Task CRUD: createTask, getTask, updateTask, assignTask, completeTask
- Message CRUD: createMessage, getMessages, markRead
- File locks: lockFile, unlockFile, getFileLocks
- Token tracking: trackTokens, getTierUsage, getAgentUsage
- Ownership: declareOwnership, releaseOwnership, checkOwnership, getOwner

---

### Source Code - Core Orchestration (5 files)

#### src/core/orchestrator.ts
- **Created**: Phase 2 (~01:00)
- **Purpose**: Main orchestrator engine (central controller)
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/core/orchestrator.ts`
- **Size**: ~500 lines (largest file)
- **Commit**: 08eb1dc - feat: add main orchestrator engine

**Key class**: Orchestrator
**Methods**:
- initialize(): void
- spawnAgent(agentId: string, task?: Task): void
- stopAgent(agentId: string): void
- handoff(fromAgent: string, toAgent: string, context: any): void
- assign(taskId: number, agentId: string): void
- sendMessage(from: string, to: string, content: string): void
- shutdown(): void

**Dependencies**: All other subsystems (config, db, session, agents, logging, etc.)

---

#### src/core/router.ts
- **Created**: Phase 2 (~00:30)
- **Purpose**: Task router with model tiering
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/core/router.ts`
- **Size**: ~120 lines
- **Commit**: 5106e81 - feat: add task router with model tiering

**Key functions**:
- routeTask(task: Task): ModelTier
- suggestAgent(task: Task, tier: ModelTier): string

**Routing logic**: Keyword-based tier assignment
- Opus: design, architecture, complex, research
- Sonnet: implement, refactor, optimize, review
- Haiku: simple, quick, basic, minor

---

#### src/core/scheduler.ts
- **Created**: Phase 2 (~00:45)
- **Purpose**: Concurrency scheduler with task queue
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/core/scheduler.ts`
- **Size**: ~150 lines
- **Commit**: af17165 - feat: add concurrency scheduler with task queue

**Key class**: Scheduler
**Methods**:
- schedule(task: Task): void
- complete(taskId: number): void
- getQueueSize(): number

**Features**: Max concurrency (default: 3), FIFO queue

---

#### src/core/budget.ts
- **Created**: Phase 2 (~00:15)
- **Purpose**: Budget controller with circuit breaker
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/core/budget.ts`
- **Size**: ~100 lines
- **Commit**: 86ecb17 - feat: add budget controller with circuit breaker

**Key class**: BudgetController
**Methods**:
- track(agentId: string, tier: ModelTier, tokens: number): void
- canProceed(tier: ModelTier): boolean
- getUsage(tier?: ModelTier): number
- reset(tier?: ModelTier): void

**Features**: Circuit breaker (pauses when budget exceeded)

---

#### src/core/ownership.ts
- **Created**: Phase 2 (~01:30)
- **Purpose**: File ownership manager for conflict prevention
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/core/ownership.ts`
- **Size**: ~150 lines
- **Commit**: edfa550 - feat(core): add OwnershipManager for file conflict prevention

**Key class**: OwnershipManager
**Methods**:
- declare(agentId: string, files: string[], description: string): void
- release(agentId: string, files: string[]): void
- checkConflict(agentId: string, files: string[]): ConflictCheckResult
- getOwner(filePath: string): string | null

**Features**: Prevents concurrent file modification conflicts (layer 1 of user's 5-layer approach)

---

### Source Code - Messaging Layer (3 files)

#### src/messaging/inbox.ts
- **Created**: Phase 2 (~00:15)
- **Modified**: Phase 2 (typed array fix)
- **Purpose**: Per-agent message inbox with event emission
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/messaging/inbox.ts`
- **Size**: ~120 lines
- **Commits**:
  - 85c6767 - feat: add per-agent message inbox with event emission
  - a807180 - fix: use typed array for inbox query parameters

**Key class**: Inbox (extends EventEmitter)
**Methods**:
- deliver(message: Message): void
- read(limit?: number): Message[]
- markRead(messageId: number): void

**Events**: 'message' event on new message delivery

---

#### src/messaging/context-compressor.ts
- **Created**: Phase 2 (~00:30)
- **Purpose**: Context compressor for inter-agent communication
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/messaging/context-compressor.ts`
- **Size**: ~100 lines
- **Commit**: 28489ed - feat: add context compressor for inter-agent communication

**Key class**: ContextCompressor
**Methods**:
- compress(messages: Message[]): string

**Features**: Summarizes conversation for handoffs (reduces context size)

---

#### src/messaging/mcp-server.ts
- **Created**: Phase 2 (~00:47)
- **Purpose**: MCP server with stdio transport for agent communication
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/messaging/mcp-server.ts`
- **Size**: ~200 lines
- **Commit**: 0197a7f - feat: add MCP server with stdio transport for agent communication

**Key class**: MCPServer
**Methods**:
- start(): void
- stop(): void

**Tools exposed** (via MCP):
- list_agents
- get_task_status
- send_message
- declare_ownership
- release_ownership

---

### Source Code - Logging Layer (3 files)

#### src/logging/logger.ts
- **Created**: Phase 2 (~00:15)
- **Purpose**: Structured JSONL logger for agent activity tracking
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/logging/logger.ts`
- **Size**: ~120 lines
- **Commit**: 40ecb7d - feat: add structured JSONL logger for agent activity tracking

**Key class**: Logger
**Methods**:
- debug(message: string, meta?: object): void
- info(message: string, meta?: object): void
- warn(message: string, meta?: object): void
- error(message: string, meta?: object): void

**Features**: JSONL format (newline-delimited JSON), writes to logs/orchestrator.jsonl

---

#### src/logging/tracer.ts
- **Created**: Phase 2 (~00:25)
- **Purpose**: Distributed tracer for task chain span tracking
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/logging/tracer.ts`
- **Size**: ~100 lines
- **Commit**: 2e04a9c - feat: add distributed tracer for task chain span tracking

**Key class**: Tracer
**Methods**:
- startSpan(taskId: number, agentId: string, operation: string): string
- endSpan(spanId: string): void

**Features**: Span-based tracing for task flow across agents

---

#### src/logging/health.ts
- **Created**: Phase 2 (~00:35)
- **Purpose**: Watchdog health checker for agent session monitoring
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/logging/health.ts`
- **Size**: ~100 lines
- **Commit**: 970fc48 - feat: add watchdog health checker for agent session monitoring

**Key class**: HealthChecker
**Methods**:
- checkAgent(agentId: string): boolean
- checkAll(): Map<string, boolean>

**Features**: Auto-restart on session failure

---

### Source Code - TUI Layer (5 files)

#### src/tui/app.tsx
- **Created**: Phase 2 (~00:30)
- **Purpose**: Ink TUI root component for dashboard rendering
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/tui/app.tsx`
- **Size**: ~50 lines
- **Commit**: ad8c2e8 - feat: add Ink TUI root component for dashboard rendering

**Component**: App (React)
**Renders**: Dashboard component

---

#### src/tui/dashboard.tsx
- **Created**: Phase 2 (~00:40)
- **Purpose**: TUI dashboard layout with agent panels and command bar
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/tui/dashboard.tsx`
- **Size**: ~150 lines
- **Commit**: df68ccc - feat: add TUI dashboard layout with agent panels and command bar

**Component**: Dashboard (React)
**Features**: Polling loop (1s interval), Box layout with 3 panels

---

#### src/tui/agent-panel.tsx
- **Created**: Phase 2 (~00:55)
- **Purpose**: Agent status panel component for TUI dashboard
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/tui/agent-panel.tsx`
- **Size**: ~100 lines
- **Commit**: cc0943b - feat: add agent status panel component for TUI dashboard

**Component**: AgentPanel (React)
**Displays**: Active agents, status, current task, token usage

---

#### src/tui/log-panel.tsx
- **Created**: Phase 2 (~01:05)
- **Purpose**: Log viewer panel component for TUI dashboard
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/tui/log-panel.tsx`
- **Size**: ~100 lines
- **Commit**: 87879fa - feat: add log viewer panel component for TUI dashboard

**Component**: LogPanel (React)
**Displays**: Recent log entries with color coding (error=red, warn=yellow, info=blue)

---

#### src/tui/command-bar.tsx
- **Created**: Phase 2 (~01:15)
- **Purpose**: Command input bar component for TUI dashboard
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/tui/command-bar.tsx`
- **Size**: ~80 lines
- **Commit**: f2d0405 - feat: add command input bar component for TUI dashboard

**Component**: CommandBar (React)
**Features**: Text input, command history (up/down arrows), enter to submit

---

### Source Code - CLI Layer (1 file)

#### src/index.ts
- **Created**: Phase 2 (~00:15)
- **Modified**: Phase 2 (executable permission)
- **Purpose**: CLI entrypoint for orc command
- **Location**: `/Users/aaron-son/Documents/orchestrator/src/index.ts`
- **Size**: ~200 lines
- **Commits**:
  - 7ea0a68 - feat: add CLI entrypoint for orc command
  - 250b537 - fix: set executable permission on CLI entrypoint

**Shebang**: #!/usr/bin/env bun

**Commands**:
- orc spawn <agent> - spawn agent session
- orc task <description> - create task
- orc status - show orchestrator status
- orc stop <agent> - stop agent session
- orc list - list available agent profiles
- orc dashboard - launch TUI dashboard
- orc help - show help

---

### Configuration Files (1 file)

#### config/default.yml
- **Created**: Phase 2 (~01:05)
- **Purpose**: Default orchestrator configuration
- **Location**: `/Users/aaron-son/Documents/orchestrator/config/default.yml`
- **Size**: ~300 bytes
- **Commit**: ae2fb84 - feat(config): add default YAML configuration

**Key settings**:
```yaml
maxConcurrency: 3
budgets:
  opus: 1000000
  sonnet: 5000000
  haiku: 10000000
logging:
  level: info
  format: jsonl
database:
  path: ./db/orchestrator.db
```

---

### Agent Profiles (3 files)

#### profiles/architect.md
- **Created**: Phase 2 (~00:55)
- **Purpose**: Architect agent profile (opus tier)
- **Location**: `/Users/aaron-son/Documents/orchestrator/profiles/architect.md`
- **Size**: ~200 bytes
- **Commit**: 99e3f6f - feat: add architect agent profile

**YAML frontmatter**:
```yaml
---
id: architect
tier: opus
description: System design and architecture planning
keywords: [design, architecture, planning, structure]
---
```

---

#### profiles/coder.md
- **Created**: Phase 2 (~01:00)
- **Purpose**: Coder agent profile (sonnet tier)
- **Location**: `/Users/aaron-son/Documents/orchestrator/profiles/coder.md`
- **Size**: ~200 bytes
- **Commit**: b2190ae - feat: add coder agent profile

**YAML frontmatter**:
```yaml
---
id: coder
tier: sonnet
description: Code implementation and refactoring
keywords: [implement, code, refactor, build]
---
```

---

#### profiles/reviewer.md
- **Created**: Phase 2 (~01:05)
- **Purpose**: Reviewer agent profile (sonnet tier)
- **Location**: `/Users/aaron-son/Documents/orchestrator/profiles/reviewer.md`
- **Size**: ~200 bytes
- **Commit**: 9676ccf - feat: add reviewer agent profile

**YAML frontmatter**:
```yaml
---
id: reviewer
tier: sonnet
description: Code review and quality assurance
keywords: [review, test, quality, verify]
---
```

---

### Compact History Documentation (7 files)

#### compact/session_2026-02-27-02-44.md
- **Created**: Phase 9 (~03:30)
- **Purpose**: Complete session history with all phases, decisions, errors, next steps
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/session_2026-02-27-02-44.md`
- **Size**: ~50 KB (estimated)
- **Commit**: Not yet committed (plan mode)

**Sections**: 20+ sections including summary, state, accomplishments, decisions, errors, files, agents, next steps

---

#### compact/decisions.md
- **Created**: Phase 9 (~03:40)
- **Purpose**: All architectural, technical, and design decisions (cumulative)
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/decisions.md`
- **Size**: ~30 KB (estimated)
- **Commit**: Not yet committed (plan mode)

**Decisions tracked**: 20 decisions across 4 categories (Architecture, Implementation, User Preferences, Technical Details)

---

#### compact/errors_resolved.md
- **Created**: Phase 9 (~03:50)
- **Purpose**: All errors encountered and how they were fixed (cumulative)
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/errors_resolved.md`
- **Size**: ~20 KB (estimated)
- **Commit**: Not yet committed (plan mode)

**Errors tracked**: 7 errors (6 resolved, 1 pending)

---

#### compact/agent_log.md
- **Created**: Phase 9 (~04:00)
- **Purpose**: Complete agent execution history (cumulative)
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/agent_log.md`
- **Size**: ~25 KB (estimated)
- **Commit**: Not yet committed (plan mode)

**Agents tracked**: 11 agents (1 human, 9 sub-agents, 1 historian)

---

#### compact/next_steps.md
- **Created**: Phase 9 (~04:10)
- **Purpose**: Current next steps (always up to date)
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/next_steps.md`
- **Size**: ~20 KB (estimated)
- **Commit**: Not yet committed (plan mode)

**Sections**: Immediate (6 tasks), Short term (4 tasks), Long term (7 tasks), Open questions, Success criteria

---

#### compact/file_index.md
- **Created**: Phase 9 (~04:20)
- **Purpose**: Complete file catalog (this file)
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/file_index.md`
- **Size**: ~15 KB (estimated)
- **Commit**: Not yet committed (plan mode)

**Files indexed**: 42 files (31 source + 4 config + 7 compact docs)

---

#### compact/README.md
- **Created**: Phase 9 (~04:30, pending)
- **Purpose**: Context restoration guide after compact
- **Location**: `/Users/aaron-son/Documents/orchestrator/compact/README.md`
- **Size**: TBD
- **Commit**: Not yet committed (plan mode)

**Sections**: Restore instructions, file guide, usage guide

---

## File Statistics

### By Type
| Type | Count | Total Size (est) |
|------|-------|------------------|
| TypeScript source (.ts) | 22 | ~4000 lines |
| React components (.tsx) | 5 | ~500 lines |
| Configuration (.json, .toml, .yml) | 5 | ~1 KB |
| Agent profiles (.md) | 3 | ~600 bytes |
| Documentation (.md) | 7 | ~160 KB |
| Git ignore (.gitignore) | 1 | ~150 bytes |

**Total files**: 42

### By Layer
| Layer | Files | Lines of Code |
|-------|-------|---------------|
| Config | 2 | ~450 |
| Session | 3 | ~470 |
| Agents | 3 | ~330 |
| Database | 2 | ~600 |
| Core | 5 | ~920 |
| Messaging | 3 | ~420 |
| Logging | 3 | ~320 |
| TUI | 5 | ~480 |
| CLI | 1 | ~200 |

**Total source code**: ~4200 lines (excluding docs)

### By Status
| Status | Count |
|--------|-------|
| Created (new files) | 42 |
| Modified (after creation) | 6 |
| Deleted | 0 |

### By Commit
- Total commits: 45
- Files per commit (avg): ~0.93 (most commits touched 1 file)
- Largest commit: Types file (~300 lines)

---

## File Dependencies

### Core Dependencies (imported by many files)
1. src/config/types.ts - Imported by 20+ files
2. src/db/store.ts - Imported by 8 files
3. src/logging/logger.ts - Imported by 10+ files

### Subsystem Dependencies
- **Orchestrator** depends on: config, db, session, agents, logging, messaging, core
- **TUI** depends on: orchestrator, db, logging
- **CLI** depends on: orchestrator, TUI, agents

### External Dependencies
- @modelcontextprotocol/sdk (messaging)
- ink + react (TUI)
- yaml (config)
- zod (MCP validation)
- bun:sqlite (database)

---

## File Locations (Directory Tree)

```
/Users/aaron-son/Documents/orchestrator/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── .gitignore
├── config/
│   └── default.yml
├── profiles/
│   ├── architect.md
│   ├── coder.md
│   └── reviewer.md
├── src/
│   ├── index.ts
│   ├── config/
│   │   ├── types.ts
│   │   └── loader.ts
│   ├── session/
│   │   ├── terminal.ts
│   │   ├── manager.ts
│   │   └── worktree.ts
│   ├── agents/
│   │   ├── provider.ts
│   │   ├── registry.ts
│   │   └── preflight.ts
│   ├── db/
│   │   ├── schema.ts
│   │   └── store.ts
│   ├── core/
│   │   ├── orchestrator.ts
│   │   ├── router.ts
│   │   ├── scheduler.ts
│   │   ├── budget.ts
│   │   └── ownership.ts
│   ├── messaging/
│   │   ├── inbox.ts
│   │   ├── context-compressor.ts
│   │   └── mcp-server.ts
│   ├── logging/
│   │   ├── logger.ts
│   │   ├── tracer.ts
│   │   └── health.ts
│   └── tui/
│       ├── app.tsx
│       ├── dashboard.tsx
│       ├── agent-panel.tsx
│       ├── log-panel.tsx
│       └── command-bar.tsx
└── compact/
    ├── session_2026-02-27-02-44.md
    ├── decisions.md
    ├── errors_resolved.md
    ├── agent_log.md
    ├── next_steps.md
    ├── file_index.md
    └── README.md
```

---

## Runtime-Generated Files (Not in Git)

### Database
- **Path**: `./db/orchestrator.db`
- **Created**: When orchestrator initializes
- **Size**: Variable (grows with usage)
- **Purpose**: SQLite database with agent state, tasks, messages, etc.

### Logs
- **Path**: `./logs/orchestrator.jsonl`
- **Created**: When logger initializes
- **Size**: Variable (grows with activity)
- **Purpose**: Structured JSONL logs

### Worktrees
- **Path**: `./worktrees/<agent-id>/`
- **Created**: When agent spawns with worktree isolation
- **Size**: Same as main repo
- **Purpose**: Isolated working directories for agents

---

## File Modifications Timeline

| Time | File | Action | Reason |
|------|------|--------|--------|
| ~00:00 | package.json | Created | Initial setup |
| ~00:00 | tsconfig.json | Created | Initial setup |
| ~00:00 | bunfig.toml | Created | Initial setup |
| ~00:00 | .gitignore | Created | Initial setup |
| ~00:15 | package.json | Modified | Rename bin: orch -> orc |
| ~00:35 | src/config/types.ts | Created | Type definitions |
| ~01:05 | src/config/types.ts | Modified | Add ownership types |
| ~02:45 | src/db/schema.ts | Modified | Add file_ownership table |
| ~02:50 | src/db/store.ts | Modified | Add ownership CRUD |
| ~03:00 | src/db/store.ts | Modified | Fix typed arrays |
| ~03:05 | src/config/loader.ts | Modified | Fix deep merge types |
| ~03:10 | src/messaging/inbox.ts | Modified | Fix typed arrays |
| ~03:15 | tsconfig.json | Modified | Add allowImportingTsExtensions |
| ~03:20 | src/index.ts | Modified | Add executable permission |

---

## Files to Create (Planned)

### Next Phase: Interactive REPL
1. src/repl/interface.ts (REPL loop)
2. src/repl/parser.ts (NLP parser)
3. src/repl/renderer.ts (output renderer)
4. src/repl/intent.ts (intent extraction)
5. src/repl/decomposer.ts (task decomposition)
6. src/repl/stream-aggregator.ts (output streaming)
7. src/repl/formatter.ts (output formatting)
8. src/core/planner.ts (multi-agent planning)

### Future
1. tests/**/*.test.ts (test files)
2. src/core/decisions.ts (decision registry)
3. src/core/watcher.ts (file watcher)
4. src/core/checkpoint.ts (checkpoint manager)
5. src/core/protocols.ts (shared resource protocols)
6. README.md (project documentation)
7. ARCHITECTURE.md (system design)

---

**Maintained by**: global-pre-compact-historian
**Last updated**: 2026-02-27 02:44
**Total files tracked**: 42 (35 created, 7 docs)
**Next update**: After REPL implementation
