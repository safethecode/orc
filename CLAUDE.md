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

## Commit Execution Rules (CRITICAL — Zero Tolerance)

**The #1 rule: NEVER claim a commit was created without actual `git commit` Bash tool output proving it.**

### Per-commit workflow (mandatory for EVERY commit):
1. **`git add <files>`** — stage specific files, show Bash output
2. **`git commit -m "..."`** — run the actual commit, show Bash output with the new hash
3. **`git log --oneline -3`** — verify the commit exists in history, show output
4. Only THEN report the commit to the user, including the hash from `git log`

### Hard rules:
- **NO batching claims**: Do NOT say "8개의 커밋을 생성했습니다" unless you ran `git commit` 8 separate times and each produced a hash
- **NO planning-as-doing**: Listing what you *will* commit is NOT the same as having committed it. The word "완료" (done) must ONLY appear after `git log` confirms the commit exists
- **NO skipping tool calls**: Every `git add` and `git commit` MUST go through the Bash tool. Describing the command in text is not executing it
- **One commit = one Bash call with visible output**: If there's no Bash tool output showing `[main abc1234] feat: ...`, the commit did not happen
- **After ALL commits are done**: Run `git log --oneline -N` (where N = number of commits) to show the full list as final proof

### Before pushing:
1. Verify format matches `<type>: <subject>` (e.g., `docs: add CLAUDE.md`)
2. Ensure NO co-author tags in the commit message
3. Verify only ONE logical change per commit
4. If commit message doesn't follow format, use `git commit --amend` BEFORE pushing
5. Only then push to remote

## Code Style (Strict)

- **No JSX comments**: Never write `{/* */}` comments in JSX/TSX
- **No blank lines between sibling elements**: Write `</div>\n<div>`, NOT `</div>\n\n<div>`
- **No pointless wrapper divs**: Only add elements that serve a structural or styling purpose
- **Icons: always use `lucide-react`**: Never hand-write `<svg>`, `<path>`, `<circle>`. Import from `lucide-react`. Install the package if not present in the project

## Lint Compliance (CRITICAL)

When generating or editing code, ALWAYS comply with the project's linter rules:

1. **Detect linter on session start**: Check for `biome.json`, `biome.jsonc`, `.eslintrc*`, `.prettierrc*`, `deno.json`, or lint scripts in `package.json`
2. **Read the config**: Understand active rules (formatting, naming, imports, etc.) before writing code
3. **Generate compliant code**: Follow the detected rules from the start — don't write code and fix lint errors after
4. **Run linter before commit**: Execute the project's lint command (e.g., `npx biome check`, `npx eslint`) and fix all errors before committing
5. **Common rules to respect**:
   - Import ordering/grouping (biome: `organizeImports`)
   - No unused variables/imports
   - Consistent quotes (single vs double)
   - Trailing commas, semicolons
   - Naming conventions (camelCase, PascalCase, etc.)
   - No `any` types when avoidable
   - Prefer `const` over `let` when variable is not reassigned

If no linter is configured, still follow TypeScript best practices and the project's existing code style.

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

### Mistake 5: Claiming Commits Were Created Without Running git commit
**What I did wrong:**
- Listed 8 planned commits with descriptions
- Said "순서대로 커밋하겠습니다" (I'll commit in order) but never actually ran `git commit`
- Immediately said "완료했습니다! 총 8개의 커밋을 생성했습니다" without a single Bash tool call for git
- Confused *planning what to do* with *actually doing it*

**How to prevent:**
- Planning a commit list is NOT creating commits — the Bash tool must run `git commit` for each one
- NEVER say "N개의 커밋을 생성했습니다" without N corresponding `git commit` Bash outputs with hashes
- After claiming commits: immediately run `git log --oneline -N` and show the output
- If the `git log` output doesn't match the claim, acknowledge the error instead of ignoring it
- Rule of thumb: if you didn't see a commit hash in Bash output, the commit doesn't exist
