#!/usr/bin/env bash
set -euo pipefail

# setup_cron.sh - Install cron job for Open Brain Reddit pipeline
# Replaces schedule_tasks.ps1 (Windows Task Scheduler)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/run_reddit.sh"
CRON_SCHEDULE="30 7 * * *"
CRON_ENTRY="$CRON_SCHEDULE $RUN_SCRIPT >> $SCRIPT_DIR/logs/cron.log 2>&1"

# Verify run_reddit.sh exists and is executable
if [[ ! -x "$RUN_SCRIPT" ]]; then
    echo "Error: $RUN_SCRIPT not found or not executable"
    echo "Run: chmod +x $RUN_SCRIPT"
    exit 1
fi

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -qF "$RUN_SCRIPT"; then
    echo "Cron job already installed:"
    crontab -l | grep -F "$RUN_SCRIPT"
    echo ""
    echo "To remove: crontab -e  (and delete the line)"
    exit 0
fi

# Append cron entry to existing crontab
(crontab -l 2>/dev/null || true; echo "$CRON_ENTRY") | crontab -

echo "Cron job installed:"
crontab -l | grep -F "$RUN_SCRIPT"
echo ""
echo "Schedule: daily at 07:30"
echo ""
echo "To test immediately:"
echo "  $RUN_SCRIPT"
echo ""
echo "To check logs:"
echo "  tail -f $SCRIPT_DIR/logs/reddit_\$(date '+%Y-%m-%d').log"
echo "  tail -f $SCRIPT_DIR/logs/cron.log"
echo ""
echo "To remove:"
echo "  crontab -e  # delete the run_reddit.sh line"
