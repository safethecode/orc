#!/bin/bash
# Post-compact hook: restores context after compaction via SessionStart
set -euo pipefail

PROJECT_DIR="$CLAUDE_PROJECT_DIR"
COMPACT_DIR="$PROJECT_DIR/compact"

# Find the most recent session snapshot
LATEST=$(ls -t "$COMPACT_DIR"/session_*.md 2>/dev/null | head -1)

CONTEXT=""

# Load latest session snapshot
if [ -n "$LATEST" ] && [ -f "$LATEST" ]; then
  CONTEXT+="## Latest Session Snapshot
$(cat "$LATEST")

"
fi

# Load architectural decisions
if [ -f "$COMPACT_DIR/decisions.md" ]; then
  CONTEXT+="## Key Decisions
$(head -80 "$COMPACT_DIR/decisions.md")

"
fi

# Load next steps
if [ -f "$COMPACT_DIR/next_steps.md" ]; then
  CONTEXT+="## Next Steps
$(cat "$COMPACT_DIR/next_steps.md")

"
fi

# Load errors resolved
if [ -f "$COMPACT_DIR/errors_resolved.md" ]; then
  CONTEXT+="## Errors Previously Resolved
$(tail -40 "$COMPACT_DIR/errors_resolved.md")

"
fi

# Output as JSON with additionalContext
jq -n --arg ctx "$CONTEXT" '{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": $ctx
  }
}'
