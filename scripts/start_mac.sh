#!/usr/bin/env bash
# Start FinAlly in Docker (macOS / Linux). Safe to run repeatedly.
#
#   scripts/start_mac.sh            build the image if missing, start the container
#   scripts/start_mac.sh --build    rebuild the image and recreate the container
#   scripts/start_mac.sh --no-open  don't open the browser
#
# The SQLite database lives in the named volume "finally-data" and survives restarts.
set -euo pipefail

IMAGE="finally"
CONTAINER="finally"
VOLUME="finally-data"
PORT="${FINALLY_PORT:-8000}"
URL="http://localhost:${PORT}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --build)    BUILD=1 ;;
    --no-open)  OPEN=0 ;;
    -h|--help)  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not on PATH." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Error: the Docker daemon is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

# .env is optional for the app but required by --env-file: create it from the template.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi
if grep -Eq '^OPENROUTER_API_KEY=(your-openrouter-api-key-here)?[[:space:]]*$' .env \
   && ! grep -Eiq '^LLM_MOCK=true' .env; then
  echo "Warning: OPENROUTER_API_KEY is not set in .env, so AI chat will reply with an error message."
  echo "         Set it in .env (or LLM_MOCK=true for mock replies) and run this script again."
fi

if [ "$BUILD" -eq 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building image '$IMAGE'..."
  docker build -t "$IMAGE" .
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  running="$(docker container inspect -f '{{.State.Running}}' "$CONTAINER")"
  if [ "$running" = "true" ] && [ "$BUILD" -eq 0 ]; then
    echo "FinAlly is already running at $URL"
    exit 0
  fi
  echo "Replacing existing container '$CONTAINER'..."
  docker rm -f "$CONTAINER" >/dev/null
fi

docker run -d \
  --name "$CONTAINER" \
  -v "$VOLUME:/app/db" \
  -p "$PORT:8000" \
  --env-file .env \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

printf "Waiting for FinAlly to become healthy"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  printf "."
  sleep 1
done
echo

if [ "$healthy" -eq 1 ]; then
  echo "FinAlly is running at $URL"
else
  echo "Warning: no healthy response from $URL/api/health after 60 s." >&2
  echo "         Check the logs with: docker logs $CONTAINER" >&2
fi

if [ "$OPEN" -eq 1 ] && [ "$healthy" -eq 1 ]; then
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
fi
