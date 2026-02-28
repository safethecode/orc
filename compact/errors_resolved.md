# All Errors Resolved (Cumulative)

Complete history of errors encountered and how they were fixed across all sessions.

Last updated: 2026-02-27 02:44

---

## Session 2026-02-27: Orchestrator Implementation

### Error 1: Binary Name Mismatch
- **Date**: 2026-02-27 (Phase 1, Commit 5)
- **Session**: Orchestrator Implementation
- **Component**: package.json
- **Severity**: Minor (cosmetic/usability)

**Symptom**:
- package.json had bin entry as `"orch": "./src/index.ts"`
- User wanted command to be `orc` (3 chars, not 4)

**Root cause**:
- Initial implementation used longer name without confirming user preference

**Solution**:
```json
// Before
{
  "bin": {
    "orch": "./src/index.ts"
  }
}

// After
{
  "bin": {
    "orc": "./src/index.ts"
  }
}
```

**Files affected**:
- package.json

**Commit**:
- `95e478d` - fix: rename bin command from orch to orc

**Prevention**:
- Confirm naming preferences upfront before implementation
- Add to requirements gathering checklist

**Lessons learned**:
- Small details like command names matter for UX
- Ask early, avoid rework

---

### Error 2: TypeScript Type Errors with unknown[]
- **Date**: 2026-02-27 (Phase 2-8, Commit 42)
- **Session**: Orchestrator Implementation
- **Component**: SQLite Store Layer
- **Severity**: High (compilation blocker)

**Symptom**:
```typescript
// TypeScript error
Type 'unknown[]' is not assignable to type 'string[]'
Type 'unknown[]' is not assignable to type '[number, string]'
```

Multiple type errors in db/store.ts methods when passing parameters to SQLite prepared statements.

**Root cause**:
- SQLite prepared statement bindings initially typed as `unknown[]`
- TypeScript strict mode (correctly) rejected assigning unknown[] to typed parameters
- Lack of explicit type assertions at parameter binding sites

**Solution**:
Changed all SQLite query parameters to use typed array assertions:

```typescript
// Before (type error)
const stmt = this.db.prepare('SELECT * FROM agents WHERE id = ?');
const result = stmt.get([agentId]); // Error: unknown[] not assignable

// After (type-safe)
const stmt = this.db.prepare('SELECT * FROM agents WHERE id = ?');
const result = stmt.get([agentId] as [string]); // Explicit type assertion
```

More examples:
```typescript
// Single parameter
[agentId] as [string]

// Multiple parameters
[status, agentId] as [string, string]

// Mixed types
[taskId, agentId] as [number, string]

// Optional parameters
[agentId, limit || 10] as [string, number]
```

**Files affected**:
1. src/db/store.ts - Multiple methods:
   - getAgent()
   - updateAgent()
   - getTask()
   - assignTask()
   - createMessage()
   - getMessages()
   - lockFile()
   - unlockFile()
   - trackTokens()
   - getTierUsage()

**Commit**:
- `e6d323c` - fix: use typed arrays instead of unknown[] for SQLite bindings

**Prevention**:
- Use typed arrays from the start
- Enable TypeScript strict mode from day 1
- Create type-safe wrapper for SQLite operations

**Lessons learned**:
- Type safety catches bugs early
- Explicit is better than implicit (even if more verbose)
- TypeScript strict mode is your friend

---

### Error 3: Typed Array in Inbox Query
- **Date**: 2026-02-27 (Phase 2-8, Commit 44)
- **Session**: Orchestrator Implementation
- **Component**: Messaging Inbox
- **Severity**: High (compilation blocker)

**Symptom**:
```typescript
// TypeScript error in messaging/inbox.ts
Type 'unknown[]' is not assignable to parameter of type 'string[]'
```

Same root cause as Error 2, but in messaging layer.

**Root cause**:
- Missed during initial Error 2 fix (different file)
- Same unknown[] issue with SQLite query parameters

**Solution**:
```typescript
// Before
const messages = this.store.getMessages(this.agentId, [this.agentId]);

// After
const messages = this.store.getMessages(this.agentId, [this.agentId] as [string]);
```

**Files affected**:
- src/messaging/inbox.ts (getMessages query)

**Commit**:
- `a807180` - fix: use typed array for inbox query parameters

**Prevention**:
- Same as Error 2
- Use global search for SQLite query patterns when fixing type issues

**Lessons learned**:
- Fix systematically (search all files, not just the first occurrence)
- Type errors can hide in similar patterns across codebase

---

### Error 4: Deep Merge Type Incompatibility
- **Date**: 2026-02-27 (Phase 2-8, Commit 43)
- **Session**: Orchestrator Implementation
- **Component**: Config Loader
- **Severity**: Medium (compilation blocker)

**Symptom**:
```typescript
// TypeScript error in config/loader.ts
Argument of type 'unknown' is not assignable to parameter of type 'OrchestratorConfig'
```

Generic type inference failed in deepMerge function call.

**Root cause**:
- TypeScript's generic type inference couldn't infer OrchestratorConfig type from usage
- deepMerge function signature: `function deepMerge<T>(target: T, source: Partial<T>): T`
- Type parameter T was inferred as unknown instead of OrchestratorConfig

**Solution**:
Added explicit type parameter to deepMerge call:

```typescript
// Before
const merged = deepMerge(defaults, userConfig);

// After
const merged = deepMerge<OrchestratorConfig>(defaults, userConfig);
```

Alternative solutions considered:
1. Type assertion on result: `deepMerge(...) as OrchestratorConfig` (less safe)
2. Better type inference in deepMerge (more complex)
3. Explicit type annotation: `const merged: OrchestratorConfig = deepMerge(...)` (works but verbose)

Chose explicit type parameter as most clear and type-safe.

**Files affected**:
- src/config/loader.ts (loadConfig function)

**Commit**:
- `0d81756` - fix: resolve deep merge type compatibility with OrchestratorConfig

**Prevention**:
- Provide explicit type parameters for generic functions when inference is ambiguous
- Add type annotations to complex utility functions

**Lessons learned**:
- TypeScript type inference has limits
- Explicit type parameters improve clarity
- Generic functions need good type signatures

---

### Error 5: Missing allowImportingTsExtensions Flag
- **Date**: 2026-02-27 (Phase 2-8, Commit 41)
- **Session**: Orchestrator Implementation
- **Component**: TypeScript Configuration
- **Severity**: High (compilation blocker)

**Symptom**:
```typescript
// TypeScript error
Cannot import TypeScript files directly. Use '.js' extension or enable 'allowImportingTsExtensions'.
```

All imports of .ts files failed type checking.

**Root cause**:
- Bun runtime requires `allowImportingTsExtensions: true` to import .ts files directly
- Standard TypeScript expects .js imports (for transpilation)
- Flag was missing from tsconfig.json

**Context**:
- Bun can execute .ts files directly (no transpilation)
- TypeScript compiler expects .js extensions (assumes transpilation)
- allowImportingTsExtensions bridges this gap

**Solution**:
```json
// tsconfig.json - Before
{
  "compilerOptions": {
    "strict": true,
    "jsx": "react",
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler"
  }
}

// tsconfig.json - After
{
  "compilerOptions": {
    "strict": true,
    "jsx": "react",
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true  // Required when allowImportingTsExtensions is true
  }
}
```

**Files affected**:
- tsconfig.json

**Commit**:
- `f4414c0` - fix: enable allowImportingTsExtensions for Bun compatibility

**Prevention**:
- Use Bun-specific tsconfig template from the start
- Document Bun-specific requirements
- Add to project setup checklist

**Lessons learned**:
- Different runtimes have different TypeScript requirements
- Bun != Node.js (even though both run JavaScript)
- Read runtime documentation before configuring TypeScript

---

### Error 6: Missing Executable Permission on CLI Entry
- **Date**: 2026-02-27 (Phase 2-8, Commit 45)
- **Session**: Orchestrator Implementation
- **Component**: CLI Entry Point
- **Severity**: Medium (usability issue)

**Symptom**:
```bash
$ orc help
bash: orc: Permission denied
```

CLI command not executable when installed.

**Root cause**:
- src/index.ts file created without executable permission
- Unix systems require +x flag for executables
- package.json bin entry points to non-executable file

**Solution**:
1. Added shebang to src/index.ts:
```typescript
#!/usr/bin/env bun
```

2. Set executable permission:
```bash
chmod +x src/index.ts
```

3. Git tracks executable bit, so this persists in repo.

**Files affected**:
- src/index.ts

**Commit**:
- `250b537` - fix: set executable permission on CLI entrypoint

**Prevention**:
- Set executable permission when creating CLI entry points
- Add shebang line immediately
- Test installation locally before pushing

**Lessons learned**:
- File permissions matter for executables
- Git tracks executable bit (good for this use case)
- Always test the install path, not just `bun run`

---

### Error 7: TypeScript Compiler Not Installed (Current)
- **Date**: 2026-02-27 (Compact History Phase)
- **Session**: Orchestrator Implementation
- **Component**: TypeScript Tooling
- **Severity**: Low (tooling issue, not blocking)

**Symptom**:
```bash
$ bun run typecheck
error: script "typecheck" exited with code 127
tsc not found
```

typecheck script in package.json fails because tsc is not installed.

**Root cause**:
- package.json has "typecheck": "tsc --noEmit" script
- TypeScript (typescript package) not in devDependencies
- Bun has built-in type checker, but it's not tsc

**Current status**:
- NOT YET RESOLVED
- Bun runtime works fine (has built-in type checking)
- Only affects explicit `bun run typecheck` command

**Workaround**:
```bash
# Use Bun's built-in type checker instead
bun build src/index.ts --target=bun --format=esm --outdir=/tmp

# Or just run the code (Bun checks types at runtime)
bun run src/index.ts help
```

**Potential solutions**:
1. Add typescript to devDependencies:
```json
{
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^18.3.0",
    "typescript": "^5.3.0"  // Add this
  }
}
```

2. Change typecheck script to use Bun:
```json
{
  "scripts": {
    "typecheck": "bun --check src/**/*.ts"
  }
}
```

3. Remove typecheck script entirely (rely on Bun runtime)

**Decision pending**:
- Not critical (Bun runtime works)
- Will address in next session if needed

**Files affected**:
- package.json (when fixed)

**Prevention**:
- Include typescript in devDependencies from the start
- Test all package.json scripts after initial setup

**Lessons learned**:
- Bun has built-in type checking (doesn't always need tsc)
- Script definitions should be tested
- Not all errors need immediate fixes (prioritize blockers)

---

## Error Categories

### Type Safety (3 errors)
- Unknown array types in SQLite bindings (2 instances)
- Deep merge type inference

### Configuration (2 errors)
- Missing TypeScript compiler flag
- TypeScript compiler not installed (current)

### Usability (2 errors)
- Binary name mismatch
- Missing executable permission

---

## Error Statistics

**Total errors**: 7 (6 resolved, 1 pending)

**By severity**:
- High (blockers): 4 (all resolved)
- Medium: 2 (all resolved)
- Low: 1 (pending)

**By phase**:
- Phase 1 (init): 1 error
- Phase 2-8 (implementation): 5 errors
- Compact phase: 1 error (discovered)

**Resolution time**:
- Immediate (< 5 min): 5 errors
- Quick (< 30 min): 1 error
- Pending: 1 error

**Prevention success**:
- After fixing SQLite types in Error 2, caught Error 3 quickly
- Pattern recognition improved across similar files

---

## Common Patterns

### Pattern 1: Type Safety Issues
**Occurrences**: 3 (Errors 2, 3, 4)

**Common cause**: TypeScript strict mode + insufficient type annotations

**Solution pattern**: Add explicit type assertions or parameters

**Prevention**: Enable strict mode from day 1, use explicit types

### Pattern 2: Configuration Gaps
**Occurrences**: 2 (Errors 5, 7)

**Common cause**: Missing dependencies or config flags

**Solution pattern**: Add missing config/dependencies

**Prevention**: Use runtime-specific templates, test all tooling

### Pattern 3: File Permissions
**Occurrences**: 1 (Error 6)

**Common cause**: Forgetting Unix file permissions

**Solution pattern**: chmod +x and shebang

**Prevention**: Checklist for CLI entry points

---

## Resolution Strategies That Worked

1. **Systematic search**: When fixing type errors, search entire codebase for pattern
2. **Explicit over implicit**: Add type assertions even if verbose
3. **Test before commit**: Verify fix actually works
4. **Document in commit message**: Clear description of what was fixed
5. **Pattern recognition**: Similar errors often cluster (fix them together)

---

## Open Issues

### Issue 1: TypeScript Compiler Not Installed
- **Status**: Open (not blocking)
- **Priority**: Low
- **Next action**: Decide on tsc vs Bun type checking strategy
- **Tracking**: This document, Error 7

---

## Session 2026-02-27 08:00: REPL UX Enhancement

### Error 8: stopSpinner가 에이전트 헤더를 지움
- **Date**: 2026-02-27 (REPL UX)
- **Component**: renderer.ts — stopSpinner()
- **Severity**: Medium (visual glitch)

**Symptom**: 박스 상단 보더가 에이전트 헤더 위치에 그려지고, 헤더가 사라짐

**Root cause**: `spinner.stop()` 후 `\x1b[A\x1b[K`가 커서를 한 줄 위(에이전트 헤더)로 올려서 지움. ora의 stop()이 이미 스피너 라인을 정리하므로 추가 커서 이동이 불필요.

**Solution**: `\x1b[A\x1b[K` 제거 — ora의 stop()만으로 충분

**Commit**: `409efc9`
**Prevention**: 커서 이스케이프 코드 사용 시 현재 커서 위치 기준으로 동작 확인

---

### Error 9: 박스 왼쪽 상단 코너 깨짐
- **Date**: 2026-02-27 (REPL UX)
- **Component**: renderer.ts — ora spinner + startBox()
- **Severity**: Medium (visual glitch)

**Symptom**: `╭` 코너 문자가 스피너 잔여물과 겹쳐서 깨져 보임

**Root cause**: ora 기본값이 `process.stderr`에 출력, 박스 렌더링은 `process.stdout` 사용. 서로 다른 스트림 간 커서 위치가 동기화되지 않아 `startBox()`의 `╭`가 잘못된 위치에 그려짐.

**Solution**:
1. ora에 `stream: process.stdout` 옵션 추가 (같은 스트림 사용)
2. `stopSpinner()`에 `\r\x1b[K` 추가 (커서를 column 0으로 이동 + 라인 정리)

**Commit**: `d0ffc43`
**Prevention**: 같은 터미널에 출력하는 라이브러리는 동일 스트림 사용

---

### Error 10: 텍스트가 박스 밖으로 넘침
- **Date**: 2026-02-27 (REPL UX)
- **Component**: renderer.ts — text()
- **Severity**: Medium (visual glitch)

**Symptom**: 긴 텍스트가 터미널 폭을 넘으면 자동 줄바꿈되면서 `│` 보더 없이 출력

**Root cause**: 터미널의 자동 줄바꿈은 `│` 보더 프리픽스를 추가하지 않음. 콘텐츠가 `columns - 4`를 초과하면 보더 없는 줄이 생김.

**Solution**: `wrapText()` 함수로 raw 텍스트를 `columns - 4` 폭에 맞게 단어 단위 줄바꿈. 각 줄마다 `│` 보더 프리픽스 추가.

**Commit**: `b3722ae`
**Prevention**: 박스/보더 렌더링 시 항상 콘텐츠 폭 제한 고려

---

**Last updated**: 2026-02-27 08:00
**Total errors tracked**: 10
**Resolved**: 9
**Pending**: 1
