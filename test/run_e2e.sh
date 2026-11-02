#!/usr/bin/env bash
# Build the app image, run the Playwright E2E suite against it, then tear everything down.
# Exit code is the Playwright exit code. Report: test/playwright-report/index.html
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
COMPOSE=(docker compose -f test/docker-compose.test.yml)

"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
"${COMPOSE[@]}" up --build --abort-on-container-exit --exit-code-from playwright
status=$?
if [ "$status" -ne 0 ]; then
  echo "E2E failed (exit $status). App logs:"
  "${COMPOSE[@]}" logs --no-color --tail 200 finally
fi
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
exit "$status"
