# FinAlly — AI Trading Workstation

## Project Specification

## 1. Vision

FinAlly (Finance Ally) is a visually stunning AI-powered trading workstation that streams live market data, lets users trade a simulated portfolio, and integrates an LLM chat assistant that can analyze positions and execute trades on the user's behalf. It looks and feels like a modern Bloomberg terminal with an AI copilot.

This is the capstone project for an agentic AI coding course. It is built entirely by Coding Agents demonstrating how orchestrated AI agents can produce a production-quality full-stack application. Agents interact through files in `planning/`.

## 2. User Experience

### First Launch

The user runs a single Docker command (or a provided start script). A browser opens to `http://localhost:8000`. No login, no signup. They immediately see:

- A watchlist of 10 default tickers with live-updating prices in a grid
- $10,000 in virtual cash
- A dark, data-rich trading terminal aesthetic
- An AI chat panel ready to assist

### What the User Can Do

- **Watch prices stream** — prices flash green (uptick) or red (downtick) with subtle CSS animations that fade
- **View sparkline mini-charts** — price action beside each ticker in the watchlist, accumulated on the frontend from the SSE stream since page load (sparklines fill in progressively)
- **Click a ticker** to see a larger detailed chart in the main chart area
- **Buy and sell shares** — market orders only, instant fill at current price, no fees, no confirmation dialog
- **Monitor their portfolio** — a heatmap (treemap) showing positions sized by weight and colored by P&L, plus a P&L chart tracking total portfolio value over time
- **View a positions table** — ticker, quantity, average cost, current price, unrealized P&L, % change
- **Chat with the AI assistant** — ask about their portfolio, get analysis, and have the AI execute trades and manage the watchlist through natural language
- **Manage the watchlist** — add/remove tickers manually or via the AI chat

### Visual Design

- **Dark theme**: backgrounds around `#0d1117` or `#1a1a2e`, muted gray borders, no pure black
- **Price flash animations**: brief green/red background highlight on price change, fading over ~500ms via CSS transitions
- **Connection status indicator**: a small colored dot (green = connected, yellow = reconnecting, red = disconnected) visible in the header
- **Professional, data-dense layout**: inspired by Bloomberg/trading terminals — every pixel earns its place
- **Responsive but desktop-first**: optimized for wide screens, functional on tablet

### Color Scheme
- Accent Yellow: `#ecad0a`
- Blue Primary: `#209dd7`
- Purple Secondary: `#753991` (submit buttons)

## 3. Architecture Overview

### Single Container, Single Port

```
┌─────────────────────────────────────────────────┐
│  Docker Container (port 8000)                   │
│                                                 │
│  FastAPI (Python/uv)                            │
│  ├── /api/*          REST endpoints             │
│  ├── /api/stream/*   SSE streaming              │
│  └── /*              Static file serving         │
│                      (Next.js export)            │
│                                                 │
│  SQLite database (volume-mounted)               │
│  Background task: market data polling/sim        │
└─────────────────────────────────────────────────┘
```

- **Frontend**: Next.js with TypeScript, built as a static export (`output: 'export'`), served by FastAPI as static files
- **Backend**: FastAPI (Python), managed as a `uv` project
- **Database**: SQLite, single file at `db/finally.db`, volume-mounted for persistence
- **Real-time data**: Server-Sent Events (SSE) — simpler than WebSockets, one-way server→client push, works everywhere
- **AI integration**: LiteLLM → OpenRouter (Cerebras for fast inference), with structured outputs for trade execution
- **Market data**: Environment-variable driven — simulator by default, real data via Massive API if key provided

### Why These Choices

| Decision | Rationale |
|---|---|
| SSE over WebSockets | One-way push is all we need; simpler, no bidirectional complexity, universal browser support |
| Static Next.js export | Single origin, no CORS issues, one port, one container, simple deployment |
| SQLite over Postgres | No auth = no multi-user = no need for a database server; self-contained, zero config |
| Single Docker container | Students run one command; no docker-compose for production, no service orchestration |
| uv for Python | Fast, modern Python project management; reproducible lockfile; what students should learn |
| Market orders only | Eliminates order book, limit order logic, partial fills — dramatically simpler portfolio math |

---

## 4. Directory Structure

```
finally/
├── frontend/                 # Next.js TypeScript project (static export)
├── backend/                  # FastAPI uv project (Python)
│   └── app/                  # Python package
│       ├── market/           # Market data subsystem (complete)
│       └── db/               # Schema definitions, seed data, startup initialization
├── planning/                 # Project-wide documentation for agents
│   ├── PLAN.md               # This document
│   └── ...                   # Additional agent reference docs
├── scripts/
│   ├── start_mac.sh          # Launch Docker container (macOS/Linux)
│   ├── stop_mac.sh           # Stop Docker container (macOS/Linux)
│   ├── start_windows.ps1     # Launch Docker container (Windows PowerShell)
│   └── stop_windows.ps1      # Stop Docker container (Windows PowerShell)
├── test/                     # Playwright E2E tests + docker-compose.test.yml
├── db/                       # Volume mount target (SQLite file lives here at runtime)
│   └── .gitkeep              # Directory exists in repo; finally.db is gitignored
├── Dockerfile                # Multi-stage build (Node → Python)
├── docker-compose.yml        # Optional convenience wrapper
├── .env                      # Environment variables (gitignored, .env.example committed)
└── .gitignore
```

### Key Boundaries

- **`frontend/`** is a self-contained Next.js project. It knows nothing about Python. It talks to the backend via `/api/*` endpoints and `/api/stream/*` SSE endpoints. Internal structure is up to the Frontend Engineer agent.
- **`backend/`** is a self-contained uv project with its own `pyproject.toml`. It owns all server logic including database initialization, schema, seed data, API routes, SSE streaming, market data, and LLM integration. Internal structure is up to the Backend/Market Data agents.
- **`backend/app/market/`** is the completed market data subsystem (see `planning/MARKET_DATA_SUMMARY.md`).
- **`backend/app/db/`** contains schema SQL definitions and seed logic. The backend initializes the database at startup — creating tables and seeding default data if the SQLite file doesn't exist or is empty (see §7).
- **`db/`** at the top level is the runtime volume mount point. The SQLite file (`db/finally.db`) is created here by the backend and persists across container restarts via Docker volume.
- **`planning/`** contains project-wide documentation, including this plan. All agents reference files here as the shared contract.
- **`test/`** contains Playwright E2E tests and supporting infrastructure (e.g., `docker-compose.test.yml`). Unit tests live within `frontend/` and `backend/` respectively, following each framework's conventions.
- **`scripts/`** contains start/stop scripts that wrap Docker commands.

---

## 5. Environment Variables

```bash
# Required: OpenRouter API key for LLM chat functionality
OPENROUTER_API_KEY=your-openrouter-api-key-here

# Optional: Massive (Polygon.io) API key for real market data
# If not set, the built-in market simulator is used (recommended for most users)
MASSIVE_API_KEY=

# Optional: Set to "true" for deterministic mock LLM responses (testing)
LLM_MOCK=false

# Optional: SQLite file location (default: db/finally.db at the project root)
DB_PATH=
```

### Behavior

- If `MASSIVE_API_KEY` is set and non-empty → backend uses Massive REST API for market data
- If `MASSIVE_API_KEY` is absent or empty → backend uses the built-in market simulator
- If `LLM_MOCK=true` → backend returns deterministic mock LLM responses (for E2E tests)
- In Docker, variables come from `docker run --env-file .env`
- For local runs, the backend calls `load_dotenv()` on the project-root `.env` at startup (`python-dotenv` is already installed via `uvicorn[standard]`). Variables that are already set, such as those from Docker, take precedence

### Configuration Parameters

Tunable values live in one config file per side, never inline in the code that uses them. They are plain constants, not environment variables, and the frontend can't read the backend's file, so each side has its own:

| Parameter | Default | File | Used by |
|---|---|---|---|
| `CHAT_HISTORY_LIMIT` | 50 | `backend/app/config.py` | Messages returned by `GET /api/chat/history` (§8) |
| `LLM_CONTEXT_MESSAGES` | 20 | `backend/app/config.py` | Past messages sent to the LLM as history (§9) |
| `LLM_TIMEOUT_SECONDS` | 30 | `backend/app/config.py` | Timeout on the LLM call (§9) |
| `PRICE_BUFFER_POINTS` | 200 | a single frontend config module (e.g. `frontend/src/config.ts`) | Points kept per ticker for sparklines and the main chart (§10) |

---

## 6. Market Data

### Two Implementations, One Interface

Both the simulator and the Massive client implement the same abstract interface. The backend selects which to use based on the environment variable. All downstream code (SSE streaming, price cache, frontend) is agnostic to the source.

### Simulator (Default)

- Generates prices using geometric Brownian motion (GBM) with configurable drift and volatility per ticker
- Updates at ~500ms intervals
- Correlated moves across tickers (e.g., tech stocks move together)
- Occasional random "events" — sudden 2-5% moves on a ticker for drama
- Starts from realistic seed prices (e.g., AAPL ~$190, GOOGL ~$175, etc.)
- Runs as an in-process background task — no external dependencies

### Massive API (Optional)

- REST API polling (not WebSocket) — simpler, works on all tiers
- One snapshot call per poll covers every tracked ticker (see Tracked Tickers below)
- Free tier (5 calls/min): poll every 15 seconds (the default)
- Paid tiers: poll every 2-15 seconds depending on tier
- Parses REST response into the same format as the simulator
- A newly added ticker has no price until the next poll (up to 15 s), and a symbol Massive doesn't recognise never gets one. Both show as "—" in the UI, and trades on them are rejected (§8)

### Shared Price Cache

- A single background task (simulator or Massive poller) writes to an in-memory price cache
- The cache holds the latest price, previous price, and timestamp for each tracked ticker
- SSE streams, portfolio valuation and trade execution all read from this cache
- This architecture supports future multi-user scenarios without changes to the data layer

### Tracked Tickers

The market data source tracks exactly this set:

**tracked tickers = watchlist ∪ tickers with an open position**

- One backend function recomputes the set and diffs it against `source.get_tickers()`, calling `add_ticker` / `remove_ticker` for the differences. It runs at startup and after every watchlist change or trade, whether it comes from the REST API or the chat. No other code calls `add_ticker` / `remove_ticker` directly.
- Removing a held ticker from the watchlist keeps it streaming, so the position stays valued. Selling an unwatched ticker to zero stops it.

### Ticker Symbols

- Normalised to uppercase with whitespace stripped, and must match `^[A-Z.]{1,10}$`; otherwise the request fails with `400`
- Simulator mode accepts any valid symbol. Tickers not in `seed_prices.py` start at a random price between $50 and $300 with default parameters (σ = 0.25, μ = 0.05)
- Massive mode: see above

### Price Continuity Across Restarts

On its own, the simulator restarts every ticker at its seed price (or a new random price), which would make unrealized P&L jump after a container restart. To avoid that, at startup each **held** ticker starts at its most recent trade price from the `trades` table. Other tickers start at seed prices as before. The Massive source ignores this, since it fetches real prices.

### SSE Streaming

- Endpoint: `GET /api/stream/prices` (implemented in `app/market/stream.py`)
- Long-lived SSE connection; client uses native `EventSource` API
- The first message is `retry: 1000`, so the browser reconnects 1 s after a drop
- The server checks the cache every ~500 ms and sends an event **only when prices have changed**: every tick with the simulator, roughly once per poll with Massive
- Each event carries **every tracked ticker** in one JSON object keyed by ticker:

```
data: {"AAPL": {"ticker": "AAPL", "price": 190.52, "previous_price": 190.41, "timestamp": 1761746592.1, "change": 0.11, "change_percent": 0.0578, "direction": "up"}, "GOOGL": {...}, ...}
```

- `change`, `change_percent` and `direction` are relative to the **previous tick**, not the day. The session change shown in the UI is computed on the frontend (§10)
- `timestamp` is Unix seconds
- Tracked tickers include held positions that aren't on the watchlist. The frontend uses their prices for valuation but shows only watchlist tickers in the watchlist panel
- The connection status indicator follows `EventSource` state, not event arrival, because Massive events can be ~15 s apart

### Pending Changes to the Completed Market Data Code

Three small changes, to make when the backend API work starts:

1. Add an optional argument, `start(tickers, initial_prices=None)`, to `MarketDataSource`. The simulator uses `initial_prices` for continuity across restarts (above), and `MassiveDataSource` ignores it.
2. Move `router = APIRouter(...)` inside `create_stream_router()` in `stream.py`. Today it is module-level, so calling the factory twice registers a duplicate `/prices` route bound to the first cache.
3. Move `rich` from the core dependencies to the `dev` extra in `backend/pyproject.toml`. Only `market_data_demo.py` uses it.

---

## 7. Database

### SQLite, Initialized at Startup

On startup (FastAPI lifespan), the backend checks the SQLite database. If the file doesn't exist or tables are missing, it creates the schema and seeds default data. There are no per-request initialization checks. This means:

- No separate migration step
- No manual database setup
- Fresh Docker volumes start with a clean, seeded database automatically

The database path comes from `DB_PATH`: by default `db/finally.db` at the project root, which is `/app/db/finally.db` in the container. Tests point it at a temporary file.

### Startup Sequence

1. Load `.env` (§5)
2. Initialize and seed the database
3. Compute the tracked tickers (§6) and start the market data source, passing each held ticker's latest trade price as its initial price
4. Record one portfolio snapshot, so the P&L chart has a starting point
5. Start the 30-second snapshot task
6. Serve requests

### Schema

All tables except `users_profile` include a `user_id` column defaulting to `"default"` (in `users_profile`, `id` plays that role). This is hardcoded for now (single-user) but enables future multi-user support without schema migration.

**users_profile** — User state (cash balance)
- `id` TEXT PRIMARY KEY (default: `"default"`)
- `cash_balance` REAL (default: `10000.0`)
- `created_at` TEXT (ISO timestamp)

**watchlist** — Tickers the user is watching
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `ticker` TEXT
- `added_at` TEXT (ISO timestamp)
- UNIQUE constraint on `(user_id, ticker)`

**positions** — Current holdings (one row per ticker per user)
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `ticker` TEXT
- `quantity` REAL (fractional shares supported)
- `avg_cost` REAL
- `updated_at` TEXT (ISO timestamp)
- UNIQUE constraint on `(user_id, ticker)`

**trades** — Trade history (append-only log)
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `ticker` TEXT
- `side` TEXT (`"buy"` or `"sell"`)
- `quantity` REAL (fractional shares supported)
- `price` REAL
- `executed_at` TEXT (ISO timestamp)

**portfolio_snapshots** — Portfolio value over time (for P&L chart). Recorded once at startup, every 30 seconds by a background task, and immediately after each trade execution. `total_value` = cash + Σ quantity × current price, with a position that has no price yet valued at its `avg_cost`.
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `total_value` REAL
- `recorded_at` TEXT (ISO timestamp)

**chat_messages** — Conversation history with LLM
- `id` TEXT PRIMARY KEY (UUID)
- `user_id` TEXT (default: `"default"`)
- `role` TEXT (`"user"` or `"assistant"`)
- `content` TEXT
- `actions` TEXT (JSON — the outcomes, in the same shape as `actions` in the `/api/chat` response (§8); null for user messages)
- `created_at` TEXT (ISO timestamp)

### Default Seed Data

- One user profile: `id="default"`, `cash_balance=10000.0`
- Ten watchlist entries: AAPL, GOOGL, MSFT, AMZN, TSLA, NVDA, META, JPM, V, NFLX

---

## 8. API Endpoints

All endpoints return JSON. Timestamps are ISO 8601 UTC strings, except in the SSE stream, which uses Unix seconds (§6).

### Market Data
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stream/prices` | SSE stream of live price updates (format in §6) |

### Portfolio
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolio` | Current positions, cash balance, total value, unrealized P&L |
| POST | `/api/portfolio/trade` | Execute a trade: `{ticker, quantity, side}`; returns the trade and the updated portfolio |
| GET | `/api/portfolio/history` | Portfolio value snapshots over time (for P&L chart) |

### Watchlist
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/watchlist` | Current watchlist tickers with latest prices |
| POST | `/api/watchlist` | Add a ticker: `{ticker}`; idempotent; returns the updated watchlist |
| DELETE | `/api/watchlist/{ticker}` | Remove a ticker; idempotent; returns the updated watchlist |

### Chat
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | Send `{message}`, receive the complete response: message, action outcomes, updated portfolio and watchlist |
| GET | `/api/chat/history` | The last `CHAT_HISTORY_LIMIT` stored messages (§5), oldest first, so the chat survives page reloads |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (for Docker/deployment): `{"status": "ok"}` |

### Response Shapes

**Portfolio**: returned by `GET /api/portfolio` and embedded in trade and chat responses.

```json
{
  "cash_balance": 8500.0,
  "total_value": 10120.5,
  "total_unrealized_pnl": 120.5,
  "positions": [
    {"ticker": "AAPL", "quantity": 10, "avg_cost": 150.0, "current_price": 162.05,
     "market_value": 1620.5, "unrealized_pnl": 120.5, "unrealized_pnl_percent": 8.03}
  ]
}
```

If a ticker has no price yet, `current_price` is `null` and the position is valued at `avg_cost`.

**`POST /api/portfolio/trade`**: the request is `{"ticker": "AAPL", "quantity": 10, "side": "buy"}`.

```json
{
  "trade": {"id": "…", "ticker": "AAPL", "side": "buy", "quantity": 10, "price": 150.0,
            "executed_at": "2026-10-29T14:03:12Z"},
  "portfolio": { "…": "portfolio object" }
}
```

**`GET /api/portfolio/history`**: all snapshots, oldest first.

```json
[{"total_value": 10000.0, "recorded_at": "2026-10-29T14:00:00Z"}, "…"]
```

**Watchlist**: returned by `GET`, `POST` and `DELETE /api/watchlist`, and embedded in chat responses. It is always the full, updated list, in the order the tickers were added.

```json
[
  {"ticker": "AAPL", "price": 190.52, "previous_price": 190.41, "direction": "up"},
  {"ticker": "PYPL", "price": null, "previous_price": null, "direction": null}
]
```

**`POST /api/chat`**: the request is `{"message": "Buy 10 AAPL"}`.

```json
{
  "message": "Done — bought 10 AAPL at $190.52.",
  "actions": {
    "trades": [{"ticker": "AAPL", "side": "buy", "quantity": 10, "price": 190.52}],
    "watchlist_changes": [],
    "errors": []
  },
  "portfolio": { "…": "portfolio object" },
  "watchlist": [ "…watchlist…" ]
}
```

- `portfolio` and `watchlist` hold the updated state when at least one action executed, and are `null` otherwise (nothing changed). When present, the frontend replaces its state with them instead of refetching.
- `actions` lists outcomes, not what the LLM asked for: executed trades with fill prices, applied watchlist changes, and one human-readable message per failed action in `errors`.

**`GET /api/chat/history`**:

```json
[
  {"id": "…", "role": "user", "content": "Buy 10 AAPL", "actions": null, "created_at": "…"},
  {"id": "…", "role": "assistant", "content": "Done — …", "actions": { "…": "as above" }, "created_at": "…"}
]
```

### Errors

- Rule violations return `400` with FastAPI's `{"detail": "..."}`: an invalid ticker symbol, quantity ≤ 0, an unknown side, insufficient cash or shares, or no price available
- Malformed request bodies get FastAPI's default `422`
- Watchlist writes don't treat "already there" or "not there" as errors: adding an existing ticker or deleting an absent one returns `200` with the unchanged list
- `/api/chat` never returns an error status for LLM problems (§9)

### Trade Execution Rules

Manual trades and LLM trades go through the same function:

1. Normalise and validate the ticker (§6), and require `quantity > 0` (fractional shares allowed)
2. If the ticker isn't on the watchlist, add it first. This starts its price feed, which is immediate in simulator mode
3. Fill at the current cached price. If there is none yet (Massive mode, before the next poll), reject with `400 "No price available for X yet"`. The ticker stays on the watchlist, so a retry works after the next poll
4. Buy: require `cash ≥ quantity × price`. The new average cost is `(old_qty × old_avg + qty × price) / (old_qty + qty)`
5. Sell: require `quantity ≤ shares held`. The average cost is unchanged. If the remaining quantity is below `1e-9`, delete the position row
6. Update cash, the position and the `trades` log in one transaction, then record a portfolio snapshot and re-sync the tracked tickers (§6)

Amounts are stored as unrounded floats and rounded only for display. Realized P&L is not tracked; it can be derived from `trades` later.

---

## 9. LLM Integration

When writing code to make calls to LLMs, use cerebras-inference skill to use LiteLLM via OpenRouter to the `openrouter/openai/gpt-oss-120b` model with Cerebras as the inference provider. Structured Outputs should be used to interpret the results.

There is an OPENROUTER_API_KEY in the .env file in the project root.

### How It Works

When the user sends a chat message, the backend:

1. Loads the user's current portfolio context (cash, positions with P&L, watchlist with live prices, total portfolio value)
2. Loads the last `LLM_CONTEXT_MESSAGES` messages (§5) from the `chat_messages` table as conversation history
3. Constructs a prompt with a system message, portfolio context, conversation history, and the user's new message
4. Calls the LLM via LiteLLM → OpenRouter, requesting structured output, using the cerebras-inference skill, without blocking the event loop (see below)
5. Parses the complete structured JSON response
6. Auto-executes the watchlist changes first, then the trades, in the order given. Each action is validated against the state left by the previous one, and a failed action doesn't stop the ones after it (all-or-nothing is not required)
7. Stores the user message, and the assistant message with the action outcomes, in `chat_messages`
8. Returns the complete JSON response to the frontend (shape in §8). There is no token-by-token streaming: Cerebras inference is fast enough that a loading indicator is sufficient

### Calling the LLM Without Blocking

The cerebras-inference skill's examples use LiteLLM's synchronous `completion()`. Calling it inside an `async def` route would block the event loop for the whole call, freezing the simulator and every SSE stream while the user waits for the AI. Use `litellm.acompletion()` with the same arguments, or declare the chat route with a plain `def` so FastAPI runs it in a threadpool.

### Structured Output Schema

The LLM is instructed to respond with JSON matching this schema:

```json
{
  "message": "Your conversational response to the user",
  "trades": [
    {"ticker": "AAPL", "side": "buy", "quantity": 10}
  ],
  "watchlist_changes": [
    {"ticker": "PYPL", "action": "add"}
  ]
}
```

- `message` (required): The conversational text shown to the user
- `trades` (required, may be empty): Array of trades to auto-execute. Each trade goes through the same rules as manual trades (§8 Trade Execution Rules)
- `watchlist_changes` (required, may be empty): Array of watchlist modifications, where `action` is `"add"` or `"remove"`

Both arrays are required rather than optional because strict JSON-schema modes reject properties that aren't listed as required. Check this on the first real call to the model.

### Auto-Execution

Trades specified by the LLM execute automatically — no confirmation dialog. This is a deliberate design choice:
- It's a simulated environment with fake money, so the stakes are zero
- It creates an impressive, fluid demo experience
- It demonstrates agentic AI capabilities — the core theme of the course

If a trade fails validation (e.g., insufficient cash), the error is added to `actions.errors` in the chat response and shown inline, next to the LLM's message.

### Failure Handling

`/api/chat` never returns an error status for LLM problems. If `OPENROUTER_API_KEY` is missing (and `LLM_MOCK` isn't `true`), the call fails or times out after `LLM_TIMEOUT_SECONDS` (§5), or the response doesn't match the schema, the endpoint returns `200` with a short explanatory `message`, empty actions, and `null` portfolio and watchlist. No trades run. Both the user message and this reply are stored, so the history matches what the user saw.

### System Prompt Guidance

The LLM should be prompted as "FinAlly, an AI trading assistant" with instructions to:
- Analyze portfolio composition, risk concentration, and P&L
- Suggest trades with reasoning
- Execute trades when the user asks or agrees
- Manage the watchlist proactively
- Be concise and data-driven in responses
- Always respond with valid structured JSON

### LLM Mock Mode

When `LLM_MOCK=true`, the backend returns deterministic mock responses instead of calling OpenRouter. The response is built from the user's message with these case-insensitive rules, applied to every match in the order they appear:

| Pattern in the message | Mock response includes |
|---|---|
| `buy <quantity> <TICKER>` | a buy trade |
| `sell <quantity> <TICKER>` | a sell trade |
| `add <TICKER>` | a watchlist add |
| `remove <TICKER>` | a watchlist remove |

`message` lists the requested actions (e.g. `"Mock: buy 10 AAPL"`). If nothing matches, `message` is `"Mock response: no actions."` and the lists are empty. The actions then run through the normal execution path, so validation errors behave exactly as in real mode.

This enables:
- Fast, free, reproducible E2E tests
- Development without an API key
- CI/CD pipelines

---

## 10. Frontend Design

### Layout

The frontend is a single-page application with a dense, terminal-inspired layout. The specific component architecture and layout system is up to the Frontend Engineer, but the UI should include these elements:

- **Watchlist panel** — grid/table of watched tickers with: ticker symbol, current price (flashing green/red on change; "—" until the first price arrives), session change % (against the first price received after page load; labelled as such, since no source provides a daily open), and a sparkline mini-chart (accumulated from SSE since page load)
- **Main chart area** — larger chart for the currently selected ticker, with at minimum price over time since page load. Clicking a ticker in the watchlist selects it here.
- **Portfolio heatmap** — treemap visualization where each rectangle is a position, sized by portfolio weight, colored by P&L (green = profit, red = loss)
- **P&L chart** — line chart showing total portfolio value over time, using data from `portfolio_snapshots`
- **Positions table** — tabular view of all positions: ticker, quantity, avg cost, current price, unrealized P&L, % change
- **Trade bar** — simple input area: ticker field, quantity field, buy button, sell button. Market orders, instant fill.
- **AI chat panel** — docked/collapsible sidebar. Message input, scrolling conversation history (loaded from `GET /api/chat/history` on page load), loading indicator while waiting for LLM response. Trade executions, watchlist changes and failed actions shown inline as confirmations.
- **Header** — portfolio total value (updating live), connection status indicator, cash balance

### Technical Notes

- Use `EventSource` for SSE connection to `/api/stream/prices` (event format in §6). The connection dot follows its state: open = green, reconnecting = yellow, closed = red
- **Live values are computed on the frontend.** On every SSE event the frontend recomputes the header total (`cash + Σ quantity × latest price`), each position's market value and unrealized P&L, and each watchlist ticker's session change %. Cash, quantities and average costs come from `/api/portfolio`. Use the same rounding as the backend
- **No refetching after writes.** Trade and watchlist responses always include the updated portfolio or watchlist, and chat responses include both when an action executed (§8). The frontend replaces its state with them
- Keep at most `PRICE_BUFFER_POINTS` points per ticker (§5) in the price buffer that feeds both the sparklines and the main chart
- Charts:
  - Lightweight Charts (canvas) for the main chart and the P&L chart
  - Small inline SVG for the sparklines, with no library
  - A hand-rolled squarified treemap for the heatmap, since Lightweight Charts has no treemap
- Price flash effect: on receiving a new price, briefly apply a CSS class with background color transition, then remove it
- All API calls go to the same origin (`/api/*`) — no CORS configuration needed
- Tailwind CSS for styling with a custom dark theme

---

## 11. Docker & Deployment

### Multi-Stage Dockerfile

```
Stage 1: Node 20 slim
  - Copy frontend/
  - npm install && npm run build (produces static export)

Stage 2: Python 3.12 slim
  - Install uv
  - Copy backend/
  - uv sync (install Python dependencies from lockfile)
  - Copy frontend build output into a static/ directory
  - Expose port 8000
  - CMD: uvicorn serving FastAPI app
```

FastAPI serves the static frontend files and all API routes on port 8000.

### Docker Volume

The SQLite database persists via a named Docker volume:

```bash
docker run -v finally-data:/app/db -p 8000:8000 --env-file .env finally
```

The `db/` directory in the project root maps to `/app/db` in the container. The backend writes `finally.db` to this path.

### Start/Stop Scripts

**`scripts/start_mac.sh`** (macOS/Linux):
- Builds the Docker image if not already built (or if `--build` flag passed)
- Runs the container with the volume mount, port mapping, and `.env` file
- Prints the URL to access the app
- Optionally opens the browser

**`scripts/stop_mac.sh`** (macOS/Linux):
- Stops and removes the running container
- Does NOT remove the volume (data persists)

**`scripts/start_windows.ps1`** / **`scripts/stop_windows.ps1`**: PowerShell equivalents for Windows.

All scripts should be idempotent — safe to run multiple times.

### Optional Cloud Deployment

The container is designed to deploy to AWS App Runner, Render, or any container platform. A Terraform configuration for App Runner may be provided in a `deploy/` directory as a stretch goal, but is not part of the core build.

---

## 12. Testing Strategy

### Unit Tests (within `frontend/` and `backend/`)

**Backend (pytest)**:
- Market data: simulator generates valid prices, GBM math is correct, Massive API response parsing works, both implementations conform to the abstract interface
- Portfolio: trade execution logic, P&L calculations, edge cases (selling more than owned, buying with insufficient cash, selling at a loss)
- LLM: structured output parsing handles all valid schemas, graceful handling of malformed responses, trade validation within chat flow
- API routes: correct status codes, response shapes, error handling
- Tests use a temporary database via `DB_PATH`, never `db/finally.db`

**Frontend (pure logic only; plain functions with a test runner, no DOM rendering)**:
- Portfolio and session-change calculations
- Price flash trigger (up / down / no change)
- Treemap layout
- Connection-status state machine, including reconnection

Component rendering and interaction (watchlist add/remove, chat messages, loading state) are covered by the E2E tests.

### E2E Tests (in `test/`)

**Infrastructure**: A separate `docker-compose.test.yml` in `test/` that spins up the app container plus a Playwright container. This keeps browser dependencies out of the production image.

**Environment**: Tests run with `LLM_MOCK=true` by default for speed and determinism. Each run starts with a fresh database volume, and tests don't depend on exact cash values left by earlier tests.

**Key Scenarios**:
- Fresh start: default watchlist appears, $10k balance shown, prices are streaming
- Add and remove a ticker from the watchlist
- Buy shares: cash decreases, position appears, portfolio updates
- Sell shares: cash increases, position updates or disappears
- Portfolio visualization: heatmap renders with correct colors, P&L chart has data points
- AI chat (mocked, using the §9 rules): send `buy 1 AAPL`, receive a response, trade execution appears inline

SSE reconnection is covered by the frontend unit test of the connection-status state machine, because simulating a dropped `EventSource` in Playwright is unreliable.

---

## 13. Review Log

The 2026-10-29 review of this plan has been incorporated into the sections above. The full reasoning (questions, simplifications and impact assessment) is in `planning/archive/PLAN_REVIEW_2026-10-29.md`.
