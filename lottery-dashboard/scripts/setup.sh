#!/usr/bin/env bash
# Auto-detect OS, install venv, register daily 6 AM scheduler, run scraper once.
# Usage: bash scripts/setup.sh
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$PROJECT/.venv"
PY="$VENV/bin/python"

echo "► project root: $PROJECT"

if [ ! -x "$PY" ]; then
  echo "► creating venv"
  python3 -m venv "$VENV"
fi
echo "► installing requirements"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$PROJECT/requirements.txt"

OS="$(uname -s)"
case "$OS" in
  Darwin)
    echo "► detected macOS, installing LaunchAgent"
    AGENT_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$AGENT_DIR"
    PLIST="$AGENT_DIR/com.lottery.dashboard.plist"
    sed -e "s|__VENV_PY__|$PY|g" -e "s|__PROJECT__|$PROJECT|g" \
        "$PROJECT/scripts/com.lottery.dashboard.plist" > "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    echo "► registered: $PLIST"
    echo "► verify:    launchctl list | grep lottery"
    ;;
  Linux)
    echo "► detected Linux, installing cron entry"
    CRON_LINE="0 6 * * * $PY $PROJECT/scraper.py >> $PROJECT/logs/scraper.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v "lottery-dashboard/scraper.py" ; echo "$CRON_LINE  # lottery-dashboard/scraper.py" ) | crontab -
    echo "► cron line installed"
    echo "► verify:    crontab -l | grep lottery"
    ;;
  *)
    echo "► unsupported OS ($OS) for auto-scheduling. Use Task Scheduler on Windows (see setup_windows.ps1)."
    ;;
esac

echo "► running scraper once now"
"$PY" "$PROJECT/scraper.py" || echo "► scraper exited non-zero, check logs/"

echo "► done. Open: $PROJECT/index.html"
