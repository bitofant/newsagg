#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=newsagg.pid
LOGFILE=newsagg.log

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "newsagg is already running (pid $(cat "$PIDFILE"))"
  exit 1
fi

nohup node dist/index.js >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
echo "newsagg started (pid $!, log: $LOGFILE)"
