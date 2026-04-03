#!/usr/bin/env bash
set -euo pipefail

# run_reddit.sh - Open Brain Reddit pipeline wrapper for cron
# Features: lock file (no overlapping runs), timestamped logs, 30-day log rotation

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$REPO_ROOT/pipeline/logs"
LOCK_FILE="$LOG_DIR/reddit.lock"
LOG_FILE="$LOG_DIR/reddit_$(date '+%Y-%m-%d').log"

log() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') $1"
    echo "$line" >> "$LOG_FILE"
    echo "$line"
}

# Ensure log dir exists
mkdir -p "$LOG_DIR"

# Lock check - bail if a previous run is still active
if [[ -f "$LOCK_FILE" ]]; then
    lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
        log "[SKIP] Previous run (PID $lock_pid) still active - exiting"
        exit 0
    fi
    log "[WARN] Stale lock file found (PID ${lock_pid:-unknown}) - removing"
    rm -f "$LOCK_FILE"
fi

# Acquire lock
echo $$ > "$LOCK_FILE"

# Ensure lock is removed on exit
cleanup() {
    rm -f "$LOCK_FILE"
}
trap cleanup EXIT

exit_code=0

log "[START] Reddit pipeline"

cd "$REPO_ROOT"
export PYTHONPATH="$REPO_ROOT"

# Ensure pyenv python is available (cron has minimal PATH)
export PATH="$HOME/.pyenv/versions/3.13.12/bin:$HOME/.pyenv/shims:$PATH"

# Run pipeline and capture output line-by-line with timestamps
if python3 -u -m pipeline.reddit.run --subreddits 2>&1 | while IFS= read -r line; do
    log "  $line"
done; then
    exit_code=${PIPESTATUS[0]:-0}
else
    exit_code=${PIPESTATUS[0]:-1}
fi

log "[DONE] Exit code: $exit_code"

# Rotate logs older than 30 days
find "$LOG_DIR" -name 'reddit_*.log' -mtime +30 -print0 2>/dev/null | while IFS= read -r -d '' old_log; do
    log "[ROTATE] Deleting old log: $(basename "$old_log")"
    rm -f "$old_log"
done

exit "$exit_code"
