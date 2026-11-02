# Backend — Developer Guide

## Project Setup

```bash
cd backend
uv sync --extra dev   # Install all dependencies including test/lint tools
```

## Market Data API

The market data subsystem lives in `app/market/`. Use these imports:

```python
from app.market import PriceCache, PriceUpdate, MarketDataSource, create_market_data_source
```

### Core Types

- **`PriceUpdate`** — Immutable dataclass: `ticker`, `price`, `previous_price`, `timestamp`, plus properties `change`, `change_percent`, `direction` ("up"/"down"/"flat"), and `to_dict()` for JSON serialization.

- **`PriceCache`** — Thread-safe in-memory store. Key methods:
  - `update(ticker, price, timestamp=None) -> PriceUpdate`
  - `get(ticker) -> PriceUpdate | None`
  - `get_price(ticker) -> float | None`
  - `get_all() -> dict[str, PriceUpdate]`
  - `remove(ticker)`
  - `version` property — monotonic counter, increments on every update (for SSE change detection)

- **`MarketDataSource`** — Abstract interface implemented by `SimulatorDataSource` and `MassiveDataSource`. Lifecycle: `start(tickers)` -> `add_ticker()` / `remove_ticker()` -> `stop()`.

- **`create_market_data_source(cache)`** — Factory. Returns `MassiveDataSource` if `MASSIVE_API_KEY` is set, otherwise `SimulatorDataSource`.

### SSE Streaming

```python
from app.market import create_stream_router

router = create_stream_router(price_cache)  # Returns FastAPI APIRouter
# Endpoint: GET /api/stream/prices (text/event-stream)
```

### Seed Data

Default tickers: AAPL, GOOGL, MSFT, AMZN, TSLA, NVDA, META, JPM, V, NFLX. Seed prices and per-ticker volatility/drift params are in `app/market/seed_prices.py`.

## App Layout (beyond market data)

- `app/main.py` — `create_app()` + module-level `app`; lifespan runs the PLAN §7 startup sequence. Run: `uv run uvicorn app.main:app --host 0.0.0.0 --port 8000`
- `app/config.py` — tunable constants (`CHAT_HISTORY_LIMIT`, `LLM_CONTEXT_MESSAGES`, `LLM_TIMEOUT_SECONDS`) and path helpers (`DB_PATH`, `STATIC_DIR`)
- `app/db/` — schema SQL and `Database` (single sqlite3 connection, queries, `transaction()`)
- `app/tickers.py` — `normalize_ticker()` and `sync_tracked_tickers()` (the only caller of `add_ticker`/`remove_ticker`)
- `app/portfolio.py` — valuation, snapshots, `execute_trade()` (shared by REST and chat)
- `app/watchlist.py`, `app/api.py` — watchlist ops and all `/api/*` routes
- `app/chat/` — `llm.py` (structured-output schema, `litellm.acompletion` call, `LLM_MOCK` parser), `service.py` (context, auto-execution, persistence)

Tests use a temp DB via `DB_PATH` (fixtures in `tests/conftest.py`, including a deterministic `FakeSource`).

## Running Tests

```bash
uv run --extra dev pytest -v              # All tests
uv run --extra dev pytest --cov=app       # With coverage
uv run --extra dev ruff check app/ tests/ # Lint
```

## Demo

```bash
uv run market_data_demo.py   # Live terminal dashboard with simulated prices
```
