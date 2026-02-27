#!/bin/bash
# Codex notify hook: save context snapshot on agent turn completion
# Codex passes event JSON as $1
set -euo pipefail

EVENT=${1:-"{}"}
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPACT_DIR="$PROJECT_DIR/compact"
TIMESTAMP=$(date +%Y-%m-%d-%H-%M)
SNAPSHOT="$COMPACT_DIR/session_$TIMESTAMP.md"

# Only save if 5+ minutes since last snapshot (avoid spam)
LATEST=$(ls -t "$COMPACT_DIR"/session_*.md 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  LATEST_AGE=$(( $(date +%s) - $(stat -f %m "$LATEST" 2>/dev/null || echo 0) ))
  if [ "$LATEST_AGE" -lt 300 ]; then
    exit 0
  fi
fi

mkdir -p "$COMPACT_DIR"

{
  echo "# Session Snapshot: $TIMESTAMP"
  echo "Source: codex-notify (agent-turn-complete)"
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

  # Working tree
  echo "## Working Tree"
  echo '```'
  git status --short 2>/dev/null || true
  echo '```'
  echo ""

  # Last assistant message from event payload
  LAST_MSG=$(echo "$EVENT" | jq -r '.["last-assistant-message"] // empty' 2>/dev/null)
  if [ -n "$LAST_MSG" ]; then
    echo "## Last Assistant Message"
    echo '```'
    echo "$LAST_MSG" | tail -c 2000
    echo '```'
    echo ""
  fi

  # Recently modified files
  echo "## Project Files (recently modified)"
  echo '```'
  find "$PROJECT_DIR/src" -name '*.ts' -exec stat -f '%m %N' {} \; 2>/dev/null \
    | sort -rn | head -20 | cut -d' ' -f2- || \
  find "$PROJECT_DIR/src" -name '*.ts' 2>/dev/null | head -20
  echo '```'

} > "$SNAPSHOT"

exit 0
