#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=newsagg.pid

if [ ! -f "$PIDFILE" ]; then
  echo "newsagg is not running (no pidfile)"
  exit 0
fi

PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "newsagg stopped (pid $PID)"
else
  echo "newsagg was not running (stale pidfile)"
fi
rm -f "$PIDFILE"
