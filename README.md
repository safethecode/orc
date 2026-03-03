# orc

A terminal-native AI agent orchestrator. One prompt decomposes into subtasks, routes to the right models, executes in parallel, and verifies the result — without manual intervention.

```bash
bun install && bun link
orc
```

## Features

**Multi-agent execution** — A single prompt gets decomposed into a dependency graph of subtasks. Each subtask is assigned a role (architect, coder, tester, reviewer, QA) and routed to an appropriate model tier. Agents run in parallel across isolated git worktrees so changes never conflict.

**Provider-agnostic** — Claude (Haiku / Sonnet / Opus), OpenAI (GPT-4o), Google (Gemini 2.5 Pro / Flash), Codex, and custom providers. The router picks the cheapest model that can handle each subtask. If a provider is down, runtime fallback kicks in.

**Interactive REPL** — 30+ commands. `/task`, `/spawn`, `/optimize`, `/fork`, `/plan`, `/spec`, `/ideate`, `/benchmark`, `/status`, `/checkpoint`, `/undo`. Sessions persist across restarts. Live streaming with tool activity visualization.

**Optimization harness** — For any task with a measurable metric, orc runs a phased tournament: parallel paths with different strategies compete, winners seed the next round, golden solutions persist across sessions.

**Memory & context** — Codebase map tracks file purposes and agent history. Context builder extracts semantic keywords from prompts and pre-populates agent context. Long outputs get compressed to prevent token bloat while keeping full refs for retrieval.

**Safety** — Doom-loop detection aborts agents spinning in circles. Shell commands are classified (safe / prompt / forbidden) via tree-sitter parsing. Permission engine with hierarchical rules per agent, session, and tool. Sandbox adapts per repo trust level.

**MCP integration** — 40+ official MCP servers (filesystem, git, databases, GitHub, Docker, Slack, Notion, AWS, etc.) with dynamic discovery and OAuth support.

**TUI dashboard** — Real-time monitoring of agent status, progress, cost, and tool activity across parallel workers.

## How it works

```
prompt
  │
  ▼
┌─────────────┐     ┌──────────┐
│  Decomposer │────▶│  Router   │   classify complexity, pick model tier
└─────────────┘     └────┬─────┘
                         │
                         ▼
                  ┌─────────────┐
                  │  Scheduler  │   build dependency DAG, plan phases
                  └──────┬──────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        ┌──────────┐┌──────────┐┌──────────┐
        │ Worker 1 ││ Worker 2 ││ Worker 3 │   isolated worktrees
        │ (coder)  ││ (coder)  ││ (tester) │   parallel execution
        └────┬─────┘└────┬─────┘└────┬─────┘
             │           │           │
             └───────────┼───────────┘
                         ▼
                  ┌─────────────┐
                  │ Supervisor  │   stuck detection, escalation
                  └──────┬──────┘
                         ▼
                  ┌─────────────┐
                  │   QA Agent  │   reads actual files, not summaries
                  └──────┬──────┘
                         ▼
                      result
```

The decomposer detects 8 domains (frontend, backend, database, auth, testing, devops, docs, security) and assigns roles accordingly. The scheduler supports sequential, parallel, and pipeline execution strategies based on the dependency graph. The supervisor watches for doom loops and triggers recovery or escalation when agents stall.

## Optimization mode

For metric-driven tasks, orc goes further. Give it a file, a test command, and a target:

```
> optimize perf_takehome.py — target 2500 cycles, lower is better
```

It runs a 5-phase tournament:

| Phase | What happens | Model | Paths |
|---|---|---|---|
| 0. Study | Reads source files, builds domain reference | — | 1 |
| 1. Foundation | Algorithmic wins, obvious inefficiencies | Sonnet | 3 |
| 2. Intermediate | Parallelism, batching, memory layout | Sonnet | 4 |
| 3. Advanced | Pipeline restructuring, dependency breaking | Opus | 4 |
| 4. Extreme | Slot-level packing, micro-optimization | Opus | 4 |

Each path gets a different personality (conservative, aggressive, creative, systematic). Winners carry forward. A Haiku domain verifier catches rule violations before expensive test runs. Golden solutions persist to disk and seed future sessions.

### Benchmark

Tested on [Anthropic's performance engineering take-home](./original_performance_takehome/Readme.md) — a VLIW SIMD kernel optimization challenge. Baseline: 147,734 cycles.

| | Cycles | Speedup | Condition |
|---|---|---|---|
| Baseline | 147 734 | 1.0x | unoptimized starter code |
| Claude Opus 4 | 2 164 | — | many hours, Anthropic's harness |
| Claude Opus 4.5 | 1 790 | — | casual Claude Code session |
| Claude Opus 4.5 | 1 363 | — | improved test-time compute harness |
| **orc** | **2 147** | **68.81x** | **single prompt, zero intervention** |

The point: you type one sentence and walk away.

## Commands

```bash
orc                              # interactive REPL
orc task "add auth to the API"   # decompose and execute
orc spawn researcher             # spin up a single agent
orc dashboard                    # TUI monitor
orc status                       # check running agents
orc agents                       # list available profiles
orc help                         # full command list
```

### Flags

```
-v, --version      print version
--config <path>    custom config file
--verbose          stack traces on error
ORC_DEBUG=1        debug mode
```

## Project structure

```
src/
├── core/           orchestrator, decomposer, router, scheduler, worker-pool,
│                   supervisor, doom-loop, optimization-harness, and ~90 more
├── agents/         harness builder, provider abstraction, dynamic harness
├── repl/           interactive terminal, commands, streaming, themes
├── tui/            React/Ink dashboard
├── mcp/            MCP client, server catalog, OAuth
├── memory/         codebase map, context builder, compression, insights
├── session/        worktree isolation, prewarming, fork manager
├── sandbox/        permission rules, safety classifier, output limiter
├── lsp/            language server integration
├── logging/        structured tracing, health checks
└── messaging/      inter-agent inbox, context compression
```

## Install

```bash
git clone https://github.com/anthropics/orchestrator.git
cd orchestrator
bun install
bun link   # makes `orc` available globally
```

Requires [Bun](https://bun.sh).

## License

MIT
