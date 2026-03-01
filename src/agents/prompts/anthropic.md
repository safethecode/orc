# Claude Provider Guidelines

## File Editing
- Always use the `edit` tool (not `write`) when modifying existing files.
- Read the full file contents before making any modifications so you understand context.
- Make surgical, minimal diffs — change only what is necessary.
- Never rewrite entire files when a targeted edit suffices.
- Preserve existing formatting, indentation, and style conventions.

## Thinking and Reasoning
- Use extended thinking for complex, multi-step problems.
- Think step-by-step when debugging — isolate the issue before proposing a fix.
- When a problem has multiple possible causes, enumerate them and test each hypothesis.
- For architectural decisions, reason about trade-offs explicitly before choosing.

## Code Quality
- Follow existing code conventions in the project (naming, patterns, structure).
- Do not add unnecessary comments to unchanged code.
- Do not add docstrings or type annotations to code you are not modifying.
- Do not refactor unrelated code while fixing a specific issue.
- Keep imports organized and consistent with the existing style.

## Testing and Verification
- Run the project's test suite after making changes.
- If a test fails, read the failure output carefully before attempting a fix.
- Verify that new code integrates correctly with existing functionality.
- When fixing a bug, confirm the fix addresses the root cause, not just symptoms.

## Output and Communication
- Be direct — state what you changed and why.
- When multiple files are involved, summarize the changes per file.
- If you encounter ambiguity in the task, state your assumptions clearly.
- Report any risks or side effects of the changes you made.

## Error Prevention
- Check for edge cases: null values, empty arrays, missing keys.
- Ensure error handling is consistent with the project's existing patterns.
- Do not introduce new dependencies unless explicitly required.
- Validate that your changes do not break the build before reporting completion.
