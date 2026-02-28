# Orchestrator

A terminal-based AI agent orchestration system built with Bun and TypeScript. Orchestrate multiple AI agents, manage profiles, and coordinate complex workflows from the command line.

## Features

- 🤖 **Multi-Agent Orchestration** - Coordinate multiple AI agents with a unified CLI interface
- ⚙️ **Profile Management** - Store and manage agent profiles with persistent configuration
- 🎯 **Task Execution** - Define and execute complex workflows across agents
- 📊 **Interactive Dashboard** - Monitor agent activity and system status in real-time
- 🔧 **Model Context Protocol (MCP)** - Native MCP support for agent communication
- 🎨 **Terminal UI** - Rich, responsive terminal interface powered by Ink and React

## Installation

### Requirements
- **Bun** (latest version)
- **Node.js 18+** (for compatibility)

### Quick Start

```bash
git clone <repository-url>
cd orchestrator
bun install
```

### Build Binary

```bash
bun build ./src/index.ts --outdir ./dist
```

The binary is configured to run as `orc`:

```bash
./dist/index.js help
```

## Usage

### Commands

#### View Help
```bash
orc help
```

#### Dashboard
```bash
orc dashboard
```
Launch the interactive dashboard to monitor agent activity and system status.

#### Version
```bash
orc --version
# or
orc -v
```

### Global Flags

- `--config <path>` - Specify custom configuration file path
- `--verbose` - Enable verbose logging output
- `ORC_DEBUG=1` - Enable debug mode via environment variable

## Configuration

### Profile System

Profiles are stored in two locations:
1. **Project-local**: `./profiles/` directory
2. **User home**: `~/.orchestrator/profiles/` directory

Profiles define agent configurations and are loaded in order of precedence (local > home).

### Configuration Files

Configuration files are typically located in:
- `./config/` - Project-level configuration
- `~/.orchestrator/config/` - User-level configuration

## Project Structure

```
.
├── src/
│   ├── index.ts              # CLI entry point
│   ├── core/                 # Core orchestration logic
│   ├── config/               # Configuration loading and management
│   ├── agents/               # Agent implementations
│   └── ui/                   # Terminal UI components
├── profiles/                 # Local agent profiles
├── config/                   # Local configuration
├── tests/                    # Test suite
├── skills/                   # Agent skill definitions
└── package.json              # Project manifest
```

## Development

### Run Development Server

```bash
bun run dev
```

### Run Tests

```bash
bun test
```

### Type Checking

```bash
bun run typecheck
```

## Key Technologies

- **Bun** - Runtime and package manager
- **TypeScript** - Type-safe implementation
- **React** - Terminal UI components
- **Ink** - React renderer for terminal
- **MCP SDK** - Model Context Protocol support
- **Zod** - Schema validation
- **YAML** - Configuration format
- **Ora** - Spinners and loading indicators

## Key Patterns

### Terminal UI
- Spinners use `stream: process.stdout` to prevent cursor mismatch
- After spinner completion, write `\r\x1b[K]` to ensure clean cursor state
- Use `\x1b[2J\x1b[3J\x1b[H` for full terminal clear with scrollback

### Keyboard Input
- Avoid `\n` in escape sequences during readline input
- Use inline positioning with `\x1b[{col}G` + `\x1b[K]` instead
- CJK input: skip custom escape codes, let readline handle it

### Event Streaming
- Emit `text_complete` for buffered full text (not per-delta `text`)
- Emit `tool_use` for tool events
- Buffer deltas between `content_block_start` and `content_block_stop`

### Claude CLI Integration
- Use `--verbose` flag with `-p` mode for stream-json parsing

## Documentation

See [AGENTS.md](./AGENTS.md) for detailed project instructions and agent configuration.

## Contributing

When contributing:
1. Follow Karma convention for commit messages (English, one file per commit)
2. No co-author tags on commits
3. Push after each commit
4. Run tests before submitting changes
5. Ensure TypeScript type checking passes

## License

MIT

---

Built with ❤️ using Bun and TypeScript
