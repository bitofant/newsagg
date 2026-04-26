#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=newsagg.pid

if [ ! -f "$PIDFILE" ]; then
  echo "newsagg is not running (no pidfile)"
  exit 1
fi

PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "newsagg is running (pid $PID)"
  exit 0
else
  echo "newsagg is not running (stale pidfile, pid $PID)"
  exit 1
fi
