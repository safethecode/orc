# Development Guidelines for Claude

## Investigation Process

When analyzing this codebase, especially for agent-based functionality:

- **ALWAYS read actual file contents** before making conclusions about features
- Never assume "feature doesn't exist" based on directory structure or file naming alone
- For agent-based projects: verify agent implementations in detail by reading source code
- Use the Read tool to inspect actual implementation before analyzing
- Don't rush to conclusions—spend time on comprehensive codebase exploration
- When unsure about feature existence, ask the user or read more files rather than guessing

## Architecture Overview

The Orchestrator project implements a complete multi-agent system:

- **Agent System**: Full implementations in `/src/agents/` (Ideation, Decomposer, Router, Critique, QA, Supervisor, etc.)
- **Each agent has complete implementation** (not just class stubs)—verify by reading actual code
- **Worker Pool**: Handles parallel task execution in `/src/orchestrator/worker-pool.ts`
- **Scheduler**: Manages task scheduling in `/src/orchestrator/scheduler.ts`
- **MCP Integration**: Model Context Protocol support for external tool integration
- **CLI**: Terminal-first interface with dashboard and commands

## Analysis Quality Standards

- Read key implementation files (agents, core orchestrator logic) before drawing conclusions
- Examine at least 2-3 agent implementations in detail when analyzing agent functionality
- Verify architectural claims with concrete code inspection
- Don't assume stub implementations—agents may have sophisticated internal logic
- When features seem missing, verify by reading source before reporting gaps

## Code Patterns & Conventions

- Bun runtime (not Node.js)
- TypeScript with strict typing
- **Karma convention commits** (CRITICAL):
  - Format: `<type>: <subject>` (e.g., `docs: add CLAUDE.md`, `feat: implement repl`, `fix: agent timeout`)
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
  - NO co-author tags or additional metadata
  - One logical change per commit (not multiple features)
  - Verify with `git log` before pushing—check that each commit follows the format exactly
  - If commit message doesn't follow format, use `git commit --amend` BEFORE pushing
- ora spinner uses `stream: process.stdout` to avoid cursor mismatch
- After `spinner.stop()`, write `\r\x1b[K` for clean cursor position
- Terminal operations: use `\x1b[2J\x1b[3J\x1b[H` for full clear with scrollback
- CJK input: skip custom escape codes and let readline handle it

## Commit Verification Checklist

Before pushing ANY commit:
1. Run `git log -1 --oneline` to see the last commit
2. Verify format matches `<type>: <subject>` (e.g., `docs: add CLAUDE.md`)
3. Ensure NO co-author tags in the commit message
4. Verify only ONE logical change in the commit
5. If commit message doesn't follow format, use `git commit --amend` to fix before pushing
6. Only then push to remote

## Testing & Verification

- Run test suite before reporting feature completion
- All new logic should have test coverage
- Verify changes don't break existing agent/scheduler functionality

## Critical Error Prevention: Common Mistakes to Avoid

### Mistake 1: False Confidence Without Verification
**What I did wrong:**
- Claimed commits were successful without actually verifying `git log`
- Said "force push completed" without checking if remote was actually updated
- Confused what I *intended* to do with what I *actually* did

**How to prevent:**
- ALWAYS run verification commands AFTER claiming something is done
- Never say "done" until you've seen proof in the output
- If you say "I'll do X", actually do it and show the result before claiming completion
- Never claim a git operation succeeded without showing `git log` output

### Mistake 2: Multiple Commits When One Is Expected
**What I did wrong:**
- Created two different commits (`97ccc7c` and `794257d`) with similar content
- Didn't notice the duplication when user said "둘이 해시도 다르고" (they have different hashes)
- Confused which commit was correct

**How to prevent:**
- After each commit, immediately run `git log --oneline -3` to verify
- If you see multiple commits with similar messages, investigate why
- Understand: one task = one commit (not multiple attempts)
- If you need to fix a commit, use `git commit --amend` before ANY push

### Mistake 3: Claiming Push Success Without Evidence
**What I did wrong:**
- Said "push completed" multiple times without showing the actual `git push` output
- Didn't verify the commit hash on remote matched local
- Assumed operations succeeded when they may have failed silently

**How to prevent:**
- Always show the actual output of `git push` or `git log` commands
- Never claim success in git operations without terminal output proof
- If unsure whether something pushed, check `git log` and compare with remote

### Mistake 4: Ignoring User's Direct Feedback
**What I did wrong:**
- User said "삭제가 안 되었다니까" (deletion didn't work)
- I responded "완료했습니다! ✅" (completed!) without actually checking
- Continued assuming I was right instead of investigating the actual state

**How to prevent:**
- When user says something isn't working, STOP and verify immediately
- Never dismiss user feedback — they are seeing the actual state
- Run `git log` immediately to see the current state
- Only claim completion after addressing the specific concern user raised
