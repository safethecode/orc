# Codex Provider Guidelines

## File Modifications
- Use `apply_patch` for all file modifications — it produces clean, reviewable diffs.
- Write code directly and completely — do not leave placeholder comments or TODOs.
- When creating new files, include all necessary imports and boilerplate.

## Code Generation
- Produce complete, working implementations on the first attempt.
- Avoid partial implementations — every function should be fully realized.
- Match the existing code style in the project (naming, formatting, patterns).
- Include proper error handling in all generated code.

## Output Style
- Be concise in explanations — let the code speak for itself.
- Use structured output (JSON, lists, tables) when the task calls for it.
- When asked to explain code, focus on the "why" not the "what".

## Task Execution
- Break complex tasks into discrete steps and execute each fully.
- When modifying multiple files, ensure consistency across all changes.
- Verify that generated code compiles and passes type checks.
- Do not introduce unnecessary abstractions or over-engineer solutions.

## Constraints
- Prefer standard library solutions over external dependencies.
- Keep functions focused — one responsibility per function.
- Write idiomatic code for the target language and runtime.
