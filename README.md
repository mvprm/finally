# FinAlly — AI Trading Workstation

An AI-powered trading terminal: live market data, a simulated $10k portfolio, and an LLM assistant that can analyze positions and execute trades through chat. Built entirely by coding agents as the capstone of an agentic AI coding course.

## Features

- Live prices over SSE with green/red flash animations and sparklines
- Market orders with instant fills, fractional shares, no fees
- Portfolio heatmap, P&L chart and positions table
- AI chat (LiteLLM → OpenRouter, Cerebras) that auto-executes trades and watchlist changes
- Built-in GBM market simulator, or real data via the Massive (Polygon.io) API

## Stack

One Docker container on port 8000: FastAPI (Python, `uv`) serves the API, the SSE stream and a static Next.js export. State lives in SQLite at `db/finally.db`.

## Quick Start

Requires Docker. Set `OPENROUTER_API_KEY` in `.env` for AI chat (the start scripts create `.env` from `.env.example` if it is missing).

```bash
# macOS / Linux
./scripts/start_mac.sh            # builds the image on first run, starts the container, opens the browser
./scripts/start_mac.sh --build    # rebuild after code changes
./scripts/stop_mac.sh             # stop; data in the finally-data volume is kept
```

```powershell
# Windows PowerShell
.\scripts\start_windows.ps1       # add -Build to rebuild, -NoOpen to skip the browser
.\scripts\stop_windows.ps1
```

Or by hand:

```bash
cp .env.example .env
docker build -t finally .
docker run -d --name finally -v finally-data:/app/db -p 8000:8000 --env-file .env finally
```

Open http://localhost:8000. `docker compose up -d --build` also works. To reset all data, stop the app and run `docker volume rm finally-data`.

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | AI chat |
| `MASSIVE_API_KEY` | No | Real market data; the simulator is used when empty |
| `LLM_MOCK` | No | `true` for deterministic mock chat responses (tests) |
| `DB_PATH` | No | SQLite file location (default `db/finally.db`) |

## Development

```bash
cd backend
uv sync --extra dev
uv run pytest
```

### End-to-end tests

Playwright tests live in `test/` and run in Docker against the app with `LLM_MOCK=true` and a fresh database:

```bash
./test/run_e2e.sh            # or .\test\run_e2e.ps1 on Windows
```

The HTML report is written to `test/playwright-report/`. To run against an app you started yourself (with `LLM_MOCK=true`): `cd test && npm ci && npx playwright install chromium && BASE_URL=http://localhost:8000 npx playwright test`.

## Status

The market data subsystem (`backend/app/market/`) is complete. The rest of the backend, the frontend, Docker setup and E2E tests are in progress. The spec is [planning/PLAN.md](planning/PLAN.md).

## License

See [LICENSE](LICENSE).
