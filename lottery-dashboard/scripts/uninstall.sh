#!/usr/bin/env bash
# Remove the scheduled job. Does not delete data/.
set -euo pipefail
OS="$(uname -s)"
case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.lottery.dashboard.plist"
    if [ -f "$PLIST" ]; then
      launchctl unload "$PLIST" >/dev/null 2>&1 || true
      rm "$PLIST"
      echo "► removed $PLIST"
    else
      echo "► no LaunchAgent installed"
    fi
    ;;
  Linux)
    crontab -l 2>/dev/null | grep -v "lottery-dashboard/scraper.py" | crontab -
    echo "► cron entry removed"
    ;;
  *)
    echo "► on Windows run: schtasks /delete /tn LotteryDashboard /f"
    ;;
esac
