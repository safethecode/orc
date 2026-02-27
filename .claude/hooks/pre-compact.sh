#!/bin/bash
# Pre-compact hook: saves context snapshot before compaction
set -euo pipefail

INPUT=$(cat)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')
PROJECT_DIR="$CLAUDE_PROJECT_DIR"
COMPACT_DIR="$PROJECT_DIR/compact"
TIMESTAMP=$(date +%Y-%m-%d-%H-%M)
SNAPSHOT="$COMPACT_DIR/session_$TIMESTAMP.md"

mkdir -p "$COMPACT_DIR"

{
  echo "# Session Snapshot: $TIMESTAMP"
  echo "Trigger: $TRIGGER"
  echo ""

  # Git state
  echo "## Git State"
  echo '```'
  cd "$PROJECT_DIR"
  echo "Branch: $(git branch --show-current 2>/dev/null || echo 'unknown')"
  echo ""
  git log --oneline -15 2>/dev/null || true
  echo '```'
  echo ""

  # Modified files
  echo "## Working Tree"
  echo '```'
  git status --short 2>/dev/null || true
  echo '```'
  echo ""

  # Recent transcript context (last 100 assistant messages)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    echo "## Recent Conversation Context"
    echo '```'
    # Extract last few assistant text messages
    tail -200 "$TRANSCRIPT" \
      | jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' 2>/dev/null \
      | tail -c 3000 || true
    echo '```'
    echo ""
  fi

  # Current files summary
  echo "## Project Files (recently modified)"
  echo '```'
  find "$PROJECT_DIR/src" -name '*.ts' -exec stat -f '%m %N' {} \; 2>/dev/null \
    | sort -rn | head -20 | cut -d' ' -f2- || \
  find "$PROJECT_DIR/src" -name '*.ts' 2>/dev/null | head -20
  echo '```'

} > "$SNAPSHOT"

exit 0
