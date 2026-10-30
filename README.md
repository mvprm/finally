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

```bash
cp .env.example .env        # then set OPENROUTER_API_KEY
docker build -t finally .
docker run -v finally-data:/app/db -p 8000:8000 --env-file .env finally
```

Open http://localhost:8000. The `scripts/` folder will provide start/stop wrappers for macOS/Linux and Windows.

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
uv sync --dev
uv run pytest
```

## Status

The market data subsystem (`backend/app/market/`) is complete. The rest of the backend, the frontend, Docker setup and E2E tests are in progress. The spec is [planning/PLAN.md](planning/PLAN.md).

## License

See [LICENSE](LICENSE).
