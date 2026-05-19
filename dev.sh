#!/usr/bin/env bash
# Vite dev server runner — defaults to nohup background mode.
#
# Usage:
#   ./dev.sh              # alias for: start (background, nohup)
#   ./dev.sh start        # start in background (nohup), idempotent
#   ./dev.sh stop         # stop background server (graceful)
#   ./dev.sh restart      # stop + start
#   ./dev.sh status       # show pid + port + tail of recent log
#   ./dev.sh logs [-f]    # cat (or tail -f) the log file
#   ./dev.sh foreground   # run in current shell (old behavior, no nohup)
#
# Sources ACP_BRIDGE_TOKEN from acp-bridge/.env so vite proxy can authenticate
# against /heartbeat and /health/agents (only /health is public on bridge).

set -u
cd "$(dirname "$0")"

ENV_FILE="${ACP_BRIDGE_ENV:-/home/ec2-user/projects/acp-bridge/.env}"
PID_FILE=".dev.pid"
LOG_FILE="nohup.out"

load_env() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a
    . "$ENV_FILE"
    set +a
    echo "[dev.sh] sourced $ENV_FILE (ACP_BRIDGE_TOKEN ${ACP_BRIDGE_TOKEN:+set})"
  else
    echo "[dev.sh] WARN: $ENV_FILE not found — proxied auth endpoints will return 401"
  fi
}

# Auto-restart loop — used by both foreground and background modes.
run_loop() {
  while true; do
    echo "[$(date)] Starting Vite dev server..."
    npm run dev 2>&1
    EXIT_CODE=$?
    echo "[$(date)] Vite exited with code $EXIT_CODE, restarting in 3s..."
    sleep 3
  done
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "[dev.sh] already running (pid $(cat "$PID_FILE"))"
    cmd_status
    return 0
  fi

  load_env
  echo "[dev.sh] starting in background → $LOG_FILE"

  # Start the supervised loop in a NEW session (setsid) so it becomes its own
  # process group leader. Required for `kill -- -PGID` in stop to terminate the
  # whole tree (loop + npm + vite + node) reliably.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$0" --loop </dev/null >"$LOG_FILE" 2>&1 &
  else
    # Fallback: nohup detaches from terminal but does not create new pgrp.
    # stop will still work via fallback per-pid kill, just less robust.
    nohup "$0" --loop </dev/null >"$LOG_FILE" 2>&1 &
  fi
  local pid=$!
  echo "$pid" >"$PID_FILE"
  disown "$pid" 2>/dev/null || true

  # Give Vite a moment to bind the port for a useful status message.
  sleep 1
  if is_running; then
    echo "[dev.sh] started (pid $pid). tail logs: ./dev.sh logs -f"
  else
    echo "[dev.sh] FAILED to start — see $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "[dev.sh] not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid pgid
  pid=$(cat "$PID_FILE")
  # When started via setsid, the leader's PGID == its PID. Read it back to be safe.
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  echo "[dev.sh] stopping pid $pid (pgid ${pgid:-?})..."

  # Try to kill the entire process group first (reaches npm + vite + node).
  if [ -n "$pgid" ]; then
    kill -TERM "-$pgid" 2>/dev/null || true
  fi
  # Fallback: also signal the leader directly in case setsid wasn't available.
  kill -TERM "$pid" 2>/dev/null || true

  for _ in 1 2 3 4 5; do
    sleep 1
    is_running || break
  done

  if is_running; then
    echo "[dev.sh] still alive, sending SIGKILL"
    [ -n "$pgid" ] && kill -KILL "-$pgid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi

  # Defensive sweep: any lingering vite/npm child rooted at our cwd.
  # (Catches stragglers if process group machinery failed.)
  pkill -f 'node .*/agent-space/node_modules/\.bin/vite' 2>/dev/null || true

  rm -f "$PID_FILE"
  echo "[dev.sh] stopped"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "[dev.sh] running (pid $pid)"
    # Show vite child + listening port if available
    pgrep -P "$pid" -a 2>/dev/null | sed 's/^/  child: /'
    if command -v ss >/dev/null 2>&1; then
      ss -lntp 2>/dev/null | grep -E ':5173\b' | sed 's/^/  port:  /'
    fi
    echo "[dev.sh] last log lines:"
    tail -n 5 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
  else
    echo "[dev.sh] not running"
    rm -f "$PID_FILE"
    return 1
  fi
}

cmd_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "[dev.sh] no $LOG_FILE yet"
    return 1
  fi
  if [ "${1:-}" = "-f" ]; then
    tail -n 50 -f "$LOG_FILE"
  else
    cat "$LOG_FILE"
  fi
}

cmd_foreground() {
  load_env
  run_loop
}

# Internal: invoked by `start` via nohup self-re-exec.
cmd_loop() {
  load_env
  run_loop
}

case "${1:-start}" in
  start)       cmd_start ;;
  stop)        cmd_stop ;;
  restart)     cmd_restart ;;
  status)      cmd_status ;;
  logs)        shift; cmd_logs "${1:-}" ;;
  foreground|fg) cmd_foreground ;;
  --loop)      cmd_loop ;;  # internal, used by start
  -h|--help|help)
    sed -n '2,12p' "$0"
    ;;
  *)
    echo "[dev.sh] unknown command: $1" >&2
    echo "Try: ./dev.sh help" >&2
    exit 2
    ;;
esac
