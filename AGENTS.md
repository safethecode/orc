# Orchestrator Project Instructions

## User Preferences
- **No co-author tags** on commits — never add `Co-Authored-By`
- Karma convention commits, English, one file per commit
- Push after commit
- Binary name: `orc`
- Runtime: Bun

## Key Patterns
- ora spinner uses `stream: process.stdout` (not default stderr) to avoid cursor mismatch
- After `spinner.stop()`, always write `\r\x1b[K` to ensure clean cursor position
- Claude CLI stream-json requires `--verbose` flag with `-p` mode
- Profile loading needs local `profiles/` dir in addition to `~/.orchestrator/profiles`
- Keypress hints: never use `\n` in escape sequences during readline — use inline `\x1b[{col}G` + `\x1b[K`
- CJK input: skip custom escape codes, let readline handle it. `line.length` ≠ display width
- Terminal clear with scrollback: `\x1b[2J\x1b[3J\x1b[H`
- Streamer events: `text_complete` (buffered), `tool_use` instead of per-delta `text`
- content_block_start/stop: buffer deltas, emit on block completion

## Context Preservation
- On compact: read `compact/decisions.md` and `compact/next_steps.md` for full context
- Session snapshots are auto-saved to `compact/session_*.md`
