#!/usr/bin/env bash
# Auto-restart Vite dev server on crash
cd "$(dirname "$0")"
while true; do
  echo "[$(date)] Starting Vite dev server..."
  npm run dev 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Vite exited with code $EXIT_CODE, restarting in 3s..."
  sleep 3
done
