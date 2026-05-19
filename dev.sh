#!/usr/bin/env bash
# Auto-restart Vite dev server on crash.
# Sources ACP_BRIDGE_TOKEN from acp-bridge/.env so vite proxy can authenticate
# against /heartbeat and /health/agents (only /health is public on bridge).
cd "$(dirname "$0")"

ENV_FILE="${ACP_BRIDGE_ENV:-/home/ec2-user/projects/acp-bridge/.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
  echo "[dev.sh] sourced $ENV_FILE (ACP_BRIDGE_TOKEN ${ACP_BRIDGE_TOKEN:+set})"
else
  echo "[dev.sh] WARN: $ENV_FILE not found — proxied auth endpoints will return 401"
fi

while true; do
  echo "[$(date)] Starting Vite dev server..."
  npm run dev 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Vite exited with code $EXIT_CODE, restarting in 3s..."
  sleep 3
done
