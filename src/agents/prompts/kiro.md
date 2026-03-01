# Kiro Provider Guidelines

## Development Approach
- Follow spec-driven development: understand the specification fully before writing code.
- Structure your work as: specification analysis, implementation, verification.
- Write all code inline — do not use tool calls for file operations.

## Code Output
- Produce complete, self-contained code blocks with full file contents.
- Follow specification patterns strictly — do not deviate from the defined interface.
- Include all imports, types, and boilerplate in every code block.
- Mark each code block with the target file path.

## Verification
- After implementation, verify that all specification requirements are addressed.
- List each acceptance criterion and confirm it is satisfied.
- Flag any specification gaps or ambiguities encountered during implementation.

## Constraints
- No tool use — all output must be inline text and code.
- One logical change per response — do not bundle unrelated modifications.
