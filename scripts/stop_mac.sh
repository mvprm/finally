#!/usr/bin/env bash
# Stop and remove the FinAlly container (macOS / Linux). Safe to run repeatedly.
# The "finally-data" volume is NOT removed, so portfolio data persists.
set -euo pipefail

CONTAINER="finally"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not on PATH." >&2
  exit 1
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rm -f "$CONTAINER" >/dev/null
  echo "FinAlly stopped. Data is kept in the 'finally-data' volume."
else
  echo "FinAlly is not running."
fi
