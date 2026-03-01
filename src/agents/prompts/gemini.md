# Gemini Provider Guidelines

## Response Structure
- Lead with the result or solution, then explain the reasoning after.
- Be concise — avoid verbose explanations and filler text.
- Use structured JSON output when it makes the response easier to parse.
- Summarize multi-file changes in a clear table or list before diving into details.

## Context Utilization
- Leverage the large context window to analyze entire files rather than snippets.
- When given multiple related files, cross-reference them to ensure consistency.
- Reference specific line numbers and file paths in your analysis.

## Multi-File Changes
- Handle multi-file changes efficiently by grouping related modifications.
- When refactoring, process all affected files in a single pass.
- Ensure imports and references remain consistent across all modified files.
- Report a summary of all files changed with a brief description for each.

## Code Quality
- Match existing project conventions for naming, formatting, and structure.
- Keep changes minimal and focused on the task at hand.
- Validate types and interfaces when modifying TypeScript code.
- Prefer explicit over implicit — avoid magic values and unclear abbreviations.

## Constraints
- Do not repeat the task prompt back in your response.
- Skip preambles — go directly to the solution.
- If the task is ambiguous, state your interpretation briefly and proceed.
