# Market Data Backend — Detailed Design

**Owner:** Market Data agent
**Status:** Authoritative design for `backend/app/market/`. Supersedes `planning/archive/MARKET_DATA_DESIGN.md`, `MARKET_INTERFACE.md`, `MARKET_SIMULATOR.md`, and `MASSIVE_API.md`.
**Audience:** Any agent implementing, extending, or consuming market data (backend API, portfolio, LLM chat, frontend).

This document gives the complete design of the market data subsystem: a unified interface, a GBM price simulator, a Massive (Polygon.io) REST poller, the shared price cache, the SSE stream, and how they plug into FastAPI. Every section has the code to implement it.

Most of this already exists in `backend/app/market/` (see `planning/MARKET_DATA_SUMMARY.md`). This document matches that code, and adds a small set of **design changes** marked with **▲ CHANGE**. Each one fixes a gap found while reviewing the code against `PLAN.md`. Section 13 lists them all as one checklist.

---

## Table of Contents

1. [Goals & Requirements](#1-goals--requirements)
2. [Architecture](#2-architecture)
3. [File Layout](#3-file-layout)
4. [Data Model — `PriceUpdate`](#4-data-model--priceupdate)
5. [Price Cache — `PriceCache`](#5-price-cache--pricecache)
6. [Unified Interface — `MarketDataSource`](#6-unified-interface--marketdatasource)
7. [Simulator — `GBMSimulator` + `SimulatorDataSource`](#7-simulator)
8. [Massive API — `MassiveDataSource`](#8-massive-api--massivedatasource)
9. [Factory & Configuration](#9-factory--configuration)
10. [SSE Streaming — `/api/stream/prices`](#10-sse-streaming)
11. [FastAPI Integration (lifespan, dependencies, routes)](#11-fastapi-integration)
12. [Frontend Contract](#12-frontend-contract)
13. [Design Changes Checklist](#13-design-changes-checklist)
14. [Testing](#14-testing)
15. [Edge Cases & Failure Modes](#15-edge-cases--failure-modes)

---

## 1. Goals & Requirements

From `PLAN.md` §6 and §10:

| # | Requirement | Where it is met |
|---|---|---|
| R1 | Two implementations (simulator, Massive) behind **one interface**; downstream code is source-agnostic | §6, §9 |
| R2 | Source selected by `MASSIVE_API_KEY` (set → Massive, empty/absent → simulator) | §9 |
| R3 | Simulator: GBM, ~500 ms ticks, correlated moves, random 2–5% events, realistic seed prices, in-process | §7 |
| R4 | Massive: REST polling (not WebSocket), one call for all tickers, 15 s on free tier, configurable | §8 |
| R5 | Shared in-memory cache: latest price, previous price, timestamp per ticker | §5 |
| R6 | SSE at `GET /api/stream/prices`, ~500 ms cadence; each event has ticker, price, previous price, timestamp, direction | §10 |
| R7 | Watchlist changes (REST or LLM) add/remove tracked tickers at runtime | §6, §11 |
| R8 | Watchlist shows **daily change %** | §4, §7, §8 (▲ CHANGE) |
| R9 | Trades fill at the current cached price | §11 |

Non-goals: order books, bid/ask spreads, historical bars, persisting prices to SQLite. Sparklines and the main chart are built on the frontend from the SSE stream (PLAN §2).

---

## 2. Architecture

```
                    create_market_data_source(cache)
                    (reads MASSIVE_API_KEY)
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
   SimulatorDataSource                  MassiveDataSource
   asyncio task, every 0.5 s            asyncio task, every 15 s
   GBMSimulator.step()                  RESTClient.get_snapshot_all()  (in a thread)
              │                                 │
              └──────────── writes ─────────────┘
                               ▼
                    ┌──────────────────────┐
                    │      PriceCache      │  thread-safe, latest PriceUpdate per ticker,
                    │  dict[str, Update]   │  monotonic `version` counter
                    └──────────┬───────────┘
            reads              │              reads
     ┌─────────────────────────┼──────────────────────────┐
     ▼                         ▼                          ▼
 SSE /api/stream/prices   Portfolio valuation       Trade execution
 (push when version       (GET /api/portfolio,      (POST /api/portfolio/trade,
  changes, every 0.5 s)    snapshots, LLM context)   LLM auto-trades)
```

Rules:

1. **Producers only write to the cache; consumers only read from it.** Nobody downstream calls the data source for prices. The only calls made to the source after startup are `add_ticker` / `remove_ticker`.
2. **One producer at a time.** The factory picks exactly one source per process.
3. **The cache stores latest values only.** Memory is O(number of tickers). History lives on the frontend (sparklines) and in `portfolio_snapshots` (P&L chart).

---

## 3. File Layout

```
backend/
├── app/
│   └── market/
│       ├── __init__.py        # Public exports
│       ├── models.py          # PriceUpdate dataclass, normalize_ticker()
│       ├── cache.py           # PriceCache
│       ├── interface.py       # MarketDataSource ABC
│       ├── seed_prices.py     # Seed prices, GBM params, correlation constants
│       ├── simulator.py       # GBMSimulator + SimulatorDataSource
│       ├── massive_client.py  # MassiveDataSource
│       ├── factory.py         # create_market_data_source()
│       └── stream.py          # create_stream_router() — SSE endpoint
├── tests/market/              # pytest suite (one module per source file)
└── market_data_demo.py        # Rich terminal demo (uv run market_data_demo.py)
```

Dependencies (`backend/pyproject.toml`): `fastapi`, `uvicorn[standard]`, `numpy` (Cholesky + vectorised normals), `massive` (the Polygon.io client, renamed). Dev: `pytest`, `pytest-asyncio` (`asyncio_mode = "auto"`), `pytest-cov`, `ruff`.

---

## 4. Data Model — `PriceUpdate`

**File: `app/market/models.py`**

`PriceUpdate` is the only type that leaves the market data layer. It is immutable (`frozen=True`) so a snapshot handed to a reader cannot be changed under it by a writer. `slots=True` keeps it small.

```python
"""Data models for market data."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def normalize_ticker(ticker: str) -> str:
    """Canonical ticker form used everywhere: stripped, upper-case.

    Raises ValueError for anything that isn't a plausible US equity symbol
    (1-10 chars, letters/digits/'.'/'-', starting with a letter), e.g. "BRK.B".
    """
    t = ticker.strip().upper()
    if not _TICKER_RE.match(t):
        raise ValueError(f"Invalid ticker symbol: {ticker!r}")
    return t


@dataclass(frozen=True, slots=True)
class PriceUpdate:
    """Immutable snapshot of a single ticker's price at a point in time."""

    ticker: str
    price: float
    previous_price: float
    timestamp: float = field(default_factory=time.time)  # Unix seconds
    prev_close: float | None = None  # ▲ CHANGE: reference price for daily change

    @property
    def change(self) -> float:
        """Absolute price change from previous update."""
        return round(self.price - self.previous_price, 4)

    @property
    def change_percent(self) -> float:
        """Percentage change from previous update."""
        if self.previous_price == 0:
            return 0.0
        return round((self.price - self.previous_price) / self.previous_price * 100, 4)

    @property
    def direction(self) -> str:
        """'up', 'down', or 'flat' relative to the previous update."""
        if self.price > self.previous_price:
            return "up"
        elif self.price < self.previous_price:
            return "down"
        return "flat"

    @property
    def day_change(self) -> float | None:  # ▲ CHANGE
        """Absolute change versus the previous close, or None if unknown."""
        if self.prev_close is None:
            return None
        return round(self.price - self.prev_close, 4)

    @property
    def day_change_percent(self) -> float | None:  # ▲ CHANGE
        """Percent change versus the previous close, or None if unknown."""
        if not self.prev_close:
            return None
        return round((self.price - self.prev_close) / self.prev_close * 100, 4)

    def to_dict(self) -> dict:
        """Serialize for JSON / SSE transmission."""
        return {
            "ticker": self.ticker,
            "price": self.price,
            "previous_price": self.previous_price,
            "timestamp": self.timestamp,
            "change": self.change,
            "change_percent": self.change_percent,
            "direction": self.direction,
            "prev_close": self.prev_close,  # ▲ CHANGE
            "day_change": self.day_change,  # ▲ CHANGE
            "day_change_percent": self.day_change_percent,  # ▲ CHANGE
        }
```

### Why the change

PLAN §10 asks the watchlist to show **daily change %**. The current `change_percent` is *tick-to-tick* (versus the previous 500 ms update), which is almost always ~0.00% and is not what a trader means by "daily change". Adding `prev_close` gives a stable reference:

| Source | `prev_close` means |
|---|---|
| Simulator | The ticker's price when the simulator started tracking it (the seed price). "Today" = since server start. |
| Massive | `prev_day.close` from the snapshot (yesterday's official close). |

The field defaults to `None`, so all existing constructors and tests keep working.

### `normalize_ticker` (▲ CHANGE)

Today, `MassiveDataSource` upper-cases tickers but `SimulatorDataSource` does not, so `"aapl"` and `"AAPL"` could be tracked as two tickers. The rule is now: **every entry point (REST route, LLM action parser) calls `normalize_ticker()` before touching the DB or the source.** The sources also call it defensively, so the data layer cannot be given a non-canonical ticker.

---

## 5. Price Cache — `PriceCache`

**File: `app/market/cache.py`**

```python
"""Thread-safe in-memory price cache."""

from __future__ import annotations

import time
from threading import Lock

from .models import PriceUpdate


class PriceCache:
    """Thread-safe in-memory cache of the latest price for each ticker.

    Writers: SimulatorDataSource or MassiveDataSource (one at a time).
    Readers: SSE streaming endpoint, portfolio valuation, trade execution.
    """

    def __init__(self) -> None:
        self._prices: dict[str, PriceUpdate] = {}
        self._lock = Lock()
        self._version: int = 0  # Monotonically increasing; bumped on every write

    def update(
        self,
        ticker: str,
        price: float,
        timestamp: float | None = None,
        prev_close: float | None = None,  # ▲ CHANGE
    ) -> PriceUpdate:
        """Record a new price for a ticker. Returns the created PriceUpdate.

        - First update for a ticker: previous_price == price (direction 'flat').
        - prev_close=None keeps the previously stored prev_close (sticky), so
          the simulator only has to provide it once, at seed time.
        """
        with self._lock:
            ts = timestamp if timestamp is not None else time.time()
            prev = self._prices.get(ticker)
            previous_price = prev.price if prev else price
            if prev_close is None and prev is not None:
                prev_close = prev.prev_close

            update = PriceUpdate(
                ticker=ticker,
                price=round(price, 2),
                previous_price=round(previous_price, 2),
                timestamp=ts,
                prev_close=round(prev_close, 2) if prev_close is not None else None,
            )
            self._prices[ticker] = update
            self._version += 1
            return update

    def get(self, ticker: str) -> PriceUpdate | None:
        """Latest update for one ticker, or None if unknown."""
        with self._lock:
            return self._prices.get(ticker)

    def get_price(self, ticker: str) -> float | None:
        """Convenience: just the price, or None."""
        update = self.get(ticker)
        return update.price if update else None

    def get_all(self) -> dict[str, PriceUpdate]:
        """Snapshot of all current prices (shallow copy; values are immutable)."""
        with self._lock:
            return dict(self._prices)

    def remove(self, ticker: str) -> None:
        """Forget a ticker (e.g. removed from the watchlist and not held)."""
        with self._lock:
            if self._prices.pop(ticker, None) is not None:
                self._version += 1  # ▲ CHANGE: removal is a change SSE should push

    @property
    def version(self) -> int:
        """Monotonic change counter for SSE change detection."""
        with self._lock:  # ▲ CHANGE: read under the lock (safe on free-threaded builds)
            return self._version

    def __len__(self) -> int:
        with self._lock:
            return len(self._prices)

    def __contains__(self, ticker: str) -> bool:
        with self._lock:
            return ticker in self._prices
```

### Design notes

- **Why `threading.Lock`, not `asyncio.Lock`?** The Massive client is synchronous and runs in a worker thread via `asyncio.to_thread`. Today it only *fetches* in the thread and writes on the event loop, but a thread lock keeps the cache correct whatever thread a writer runs on. Critical sections are a dict lookup plus an assignment, so contention costs nothing.
- **Why a `version` counter?** The SSE generator compares `cache.version` with the last version it sent. If nothing changed (Massive between polls, or market closed) it sends nothing, so the client gets no duplicate frames. One integer comparison per client per 500 ms.
- **Prices are rounded to cents in the cache.** The simulator keeps full precision internally and only rounds what it publishes, so rounding never builds up over many ticks.
- **`timestamp or time.time()` → `timestamp if timestamp is not None else time.time()`** (▲ CHANGE). This is a small correctness fix: a timestamp of `0.0` is falsy and would otherwise be replaced.
- **`remove()` bumps the version** (▲ CHANGE). Without this, removing a ticker in the Massive steady state (no new writes for up to 15 s) doesn't push the shorter snapshot to clients. The frontend should still drop the row optimistically when the DELETE succeeds (§12).

### Usage

```python
cache = PriceCache()
u = cache.update("AAPL", 190.00, prev_close=190.00)  # first write: flat
u = cache.update("AAPL", 190.37)                      # prev_close stays 190.00
u.direction            # "up"
u.change               # 0.37
u.day_change_percent   # 0.1947
cache.get_price("AAPL")  # 190.37
cache.get("ZZZZ")        # None
```

---

## 6. Unified Interface — `MarketDataSource`

**File: `app/market/interface.py`**

```python
"""Abstract interface for market data sources."""

from __future__ import annotations

from abc import ABC, abstractmethod


class MarketDataSource(ABC):
    """Contract for market data providers.

    Implementations push price updates into a shared PriceCache on their own
    schedule. Downstream code never asks the source for prices — it reads the cache.

    Lifecycle:
        source = create_market_data_source(cache)
        await source.start(["AAPL", "GOOGL", ...])
        await source.add_ticker("TSLA")
        await source.remove_ticker("GOOGL")
        await source.stop()
    """

    @abstractmethod
    async def start(self, tickers: list[str]) -> None:
        """Begin producing updates for `tickers` and start the background task.

        Must be called exactly once, before add_ticker/remove_ticker.
        Implementations should populate the cache before returning when they
        can, so the first SSE frame and the first trade have prices.
        """

    @abstractmethod
    async def stop(self) -> None:
        """Cancel the background task and release resources. Idempotent."""

    @abstractmethod
    async def add_ticker(self, ticker: str) -> None:
        """Track an additional ticker. No-op if already tracked."""

    @abstractmethod
    async def remove_ticker(self, ticker: str) -> None:
        """Stop tracking a ticker and remove it from the cache. No-op if absent."""

    @abstractmethod
    def get_tickers(self) -> list[str]:
        """Currently tracked tickers (a copy)."""
```

### Why "push into a cache" instead of `get_price()` on the source

- Readers are never blocked by a slow network call (Massive) or by simulator state.
- Different sources update at different rates (0.5 s vs 15 s); the cache hides that from consumers.
- Readers (SSE, trades, portfolio, LLM context) all see the same snapshot of the truth.
- Tests can drive any consumer by writing to a `PriceCache` directly, with no source involved.

### Behavioural contract (both implementations must satisfy)

| Call | Contract |
|---|---|
| `start(tickers)` | Creates exactly one background `asyncio.Task`. Returns quickly (simulator: immediately; Massive: after one initial poll). |
| `stop()` | Cancels and awaits the task, swallowing `CancelledError`. Safe to call twice or before `start`. After it returns, nothing writes to the cache. |
| `add_ticker(t)` | Idempotent. Simulator: price in cache immediately. Massive: price appears on the next poll (≤ poll interval). |
| `remove_ticker(t)` | Idempotent. Removes from the tracked set **and** from the cache. A poll already in flight must not put it back (§8.4). |
| `get_tickers()` | Returns a copy; callers may mutate it freely. |

---

## 7. Simulator

### 7.1 Parameters — `app/market/seed_prices.py`

```python
"""Seed prices and per-ticker parameters for the market simulator."""

# Realistic starting prices for the default watchlist
SEED_PRICES: dict[str, float] = {
    "AAPL": 190.00, "GOOGL": 175.00, "MSFT": 420.00, "AMZN": 185.00, "TSLA": 250.00,
    "NVDA": 800.00, "META": 500.00, "JPM": 195.00, "V": 280.00, "NFLX": 600.00,
}

# Per-ticker GBM parameters. sigma = annualised volatility, mu = annualised drift
TICKER_PARAMS: dict[str, dict[str, float]] = {
    "AAPL": {"sigma": 0.22, "mu": 0.05},
    "GOOGL": {"sigma": 0.25, "mu": 0.05},
    "MSFT": {"sigma": 0.20, "mu": 0.05},
    "AMZN": {"sigma": 0.28, "mu": 0.05},
    "TSLA": {"sigma": 0.50, "mu": 0.03},  # High volatility
    "NVDA": {"sigma": 0.40, "mu": 0.08},  # High volatility, strong drift
    "META": {"sigma": 0.30, "mu": 0.05},
    "JPM": {"sigma": 0.18, "mu": 0.04},   # Low volatility (bank)
    "V": {"sigma": 0.17, "mu": 0.04},     # Low volatility (payments)
    "NFLX": {"sigma": 0.35, "mu": 0.05},
}

# Tickers added at runtime that aren't listed above
DEFAULT_PARAMS: dict[str, float] = {"sigma": 0.25, "mu": 0.05}

# Sector groups for correlated moves
CORRELATION_GROUPS: dict[str, set[str]] = {
    "tech": {"AAPL", "GOOGL", "MSFT", "AMZN", "META", "NVDA", "NFLX"},
    "finance": {"JPM", "V"},
}

INTRA_TECH_CORR = 0.6     # Tech stocks move together
INTRA_FINANCE_CORR = 0.5  # Finance stocks move together
CROSS_GROUP_CORR = 0.3    # Between sectors / unknown tickers
TSLA_CORR = 0.3           # TSLA does its own thing
```

Unknown tickers (e.g. `PYPL` added by the LLM) start at `random.uniform(50, 300)` with `DEFAULT_PARAMS`, and correlate at 0.3 with everything.

### 7.2 The math

Each tick, for each ticker *i*:

```
S_i(t+dt) = S_i(t) · exp( (μ_i − σ_i²/2)·dt + σ_i·√dt·Z_i )

dt = 0.5 s / (252 days × 6.5 h × 3600 s) = 0.5 / 5,896,800 ≈ 8.48e-8 trading-years
Z  = L · ε,   ε ~ N(0, I),   L = cholesky(C)
```

- `exp(·)` is always positive, so prices can never go negative or reach zero.
- The `−σ²/2` term (Itô correction) makes the *expected* price grow at μ.
- One simulated second equals one second of trading-hours time, so intraday volatility looks right.

What that looks like in practice:

| Ticker | σ | 1-σ move per tick | 1-σ move per minute | 1-σ move per 6.5 h "day" |
|---|---|---|---|---|
| V @ $280 | 0.17 | 0.0050% ≈ 1.4¢ | 0.055% ≈ 15¢ | 1.07% ≈ $3.00 |
| AAPL @ $190 | 0.22 | 0.0064% ≈ 1.2¢ | 0.070% ≈ 13¢ | 1.39% ≈ $2.63 |
| TSLA @ $250 | 0.50 | 0.0146% ≈ 3.6¢ | 0.159% ≈ 40¢ | 3.15% ≈ $7.88 |

So per-tick moves are a few cents. That's enough to make the flash animation fire on most ticks (a few ticks round to the same cent and come out `flat`, which is realistic). Sparklines show visible structure within a minute.

**Random events.** Each ticker has probability `p = 0.001` per tick of an extra shock of ±2–5%. With 10 tickers × 2 ticks/s = 20 trials/s, that's one event about every 50 s somewhere on the board.

### 7.3 Correlation matrix (and why Cholesky never fails)

Pairwise correlation ρ(a, b):

| Pair | ρ |
|---|---|
| Either is TSLA | 0.3 |
| Both tech | 0.6 |
| Both finance | 0.5 |
| Anything else (cross-sector, unknown tickers) | 0.3 |

This is a **one-market-factor + sector-factor model**: every stock loads √0.3 on a market factor, tech stocks add √0.3 on a tech factor (0.3 + 0.3 = 0.6), finance stocks add √0.2 on a finance factor (0.3 + 0.2 = 0.5), and the rest is idiosyncratic noise. A correlation matrix built from a factor model with positive idiosyncratic variance is always positive definite. So `np.linalg.cholesky` succeeds for **any** set of tickers, including 50 unknown ones. Keep this property if you change the constants: within-group ρ must be ≥ cross-group ρ, and all ρ < 1.

### 7.4 `GBMSimulator` — `app/market/simulator.py`

A pure, synchronous math engine with no asyncio and no cache, so it is easy to unit test.

```python
"""GBM-based market simulator."""

from __future__ import annotations

import asyncio
import logging
import math
import random

import numpy as np

from .cache import PriceCache
from .interface import MarketDataSource
from .models import normalize_ticker
from .seed_prices import (
    CORRELATION_GROUPS, CROSS_GROUP_CORR, DEFAULT_PARAMS, INTRA_FINANCE_CORR,
    INTRA_TECH_CORR, SEED_PRICES, TICKER_PARAMS, TSLA_CORR,
)

logger = logging.getLogger(__name__)


class GBMSimulator:
    """Geometric Brownian Motion simulator for correlated stock prices."""

    TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600  # 5,896,800
    DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR  # ~8.48e-8

    def __init__(
        self,
        tickers: list[str],
        dt: float = DEFAULT_DT,
        event_probability: float = 0.001,
    ) -> None:
        self._dt = dt
        self._event_prob = event_probability
        self._tickers: list[str] = []                 # ordered — index i ↔ row i of Cholesky
        self._prices: dict[str, float] = {}           # full-precision internal prices
        self._params: dict[str, dict[str, float]] = {}
        self._cholesky: np.ndarray | None = None

        for ticker in tickers:
            self._add_ticker_internal(ticker)
        self._rebuild_cholesky()                      # once, not once per ticker

    # --- Public API ---

    def step(self) -> dict[str, float]:
        """Advance all tickers one time step. Returns {ticker: price rounded to cents}.

        Hot path (every 500 ms). O(n²) for the matrix-vector product, n ≤ ~50.
        """
        n = len(self._tickers)
        if n == 0:
            return {}

        z = np.random.standard_normal(n)
        if self._cholesky is not None:
            z = self._cholesky @ z

        result: dict[str, float] = {}
        for i, ticker in enumerate(self._tickers):
            mu = self._params[ticker]["mu"]
            sigma = self._params[ticker]["sigma"]

            drift = (mu - 0.5 * sigma**2) * self._dt
            diffusion = sigma * math.sqrt(self._dt) * z[i]
            self._prices[ticker] *= math.exp(drift + diffusion)

            # Occasional 2-5% shock for drama
            if random.random() < self._event_prob:
                shock = random.uniform(0.02, 0.05) * random.choice([-1, 1])
                self._prices[ticker] *= 1 + shock
                logger.debug("Random event on %s: %+.1f%%", ticker, shock * 100)

            result[ticker] = round(self._prices[ticker], 2)
        return result

    def add_ticker(self, ticker: str) -> None:
        """Add a ticker and rebuild the correlation matrix. No-op if present."""
        if ticker in self._prices:
            return
        self._add_ticker_internal(ticker)
        self._rebuild_cholesky()

    def remove_ticker(self, ticker: str) -> None:
        """Remove a ticker and rebuild the correlation matrix. No-op if absent."""
        if ticker not in self._prices:
            return
        self._tickers.remove(ticker)
        del self._prices[ticker]
        del self._params[ticker]
        self._rebuild_cholesky()

    def get_price(self, ticker: str) -> float | None:
        return self._prices.get(ticker)

    def get_tickers(self) -> list[str]:
        return list(self._tickers)

    # --- Internals ---

    def _add_ticker_internal(self, ticker: str) -> None:
        if ticker in self._prices:
            return
        self._tickers.append(ticker)
        self._prices[ticker] = SEED_PRICES.get(ticker, random.uniform(50.0, 300.0))
        self._params[ticker] = TICKER_PARAMS.get(ticker, dict(DEFAULT_PARAMS))

    def _rebuild_cholesky(self) -> None:
        n = len(self._tickers)
        if n <= 1:
            self._cholesky = None
            return
        corr = np.eye(n)
        for i in range(n):
            for j in range(i + 1, n):
                rho = self._pairwise_correlation(self._tickers[i], self._tickers[j])
                corr[i, j] = corr[j, i] = rho
        self._cholesky = np.linalg.cholesky(corr)

    @staticmethod
    def _pairwise_correlation(t1: str, t2: str) -> float:
        tech = CORRELATION_GROUPS["tech"]
        finance = CORRELATION_GROUPS["finance"]
        if t1 == "TSLA" or t2 == "TSLA":       # checked first: TSLA is not "tech" here
            return TSLA_CORR
        if t1 in tech and t2 in tech:
            return INTRA_TECH_CORR
        if t1 in finance and t2 in finance:
            return INTRA_FINANCE_CORR
        return CROSS_GROUP_CORR
```

Example:

```python
sim = GBMSimulator(["AAPL", "MSFT", "JPM"])
sim.step()   # {'AAPL': 190.01, 'MSFT': 419.98, 'JPM': 195.0}
sim.add_ticker("PYPL")          # random seed in [50, 300], default params
sim.step()   # {'AAPL': 190.03, 'MSFT': 420.02, 'JPM': 194.99, 'PYPL': 132.47}
```

### 7.5 `SimulatorDataSource` — async wrapper

```python
class SimulatorDataSource(MarketDataSource):
    """MarketDataSource backed by GBMSimulator, ticking every `update_interval` s."""

    def __init__(
        self,
        price_cache: PriceCache,
        update_interval: float = 0.5,
        event_probability: float = 0.001,
    ) -> None:
        self._cache = price_cache
        self._interval = update_interval
        self._event_prob = event_probability
        self._sim: GBMSimulator | None = None
        self._task: asyncio.Task | None = None

    async def start(self, tickers: list[str]) -> None:
        tickers = [normalize_ticker(t) for t in tickers]  # ▲ CHANGE
        self._sim = GBMSimulator(tickers=tickers, event_probability=self._event_prob)
        # Seed the cache so the first SSE frame / first trade have prices.
        for ticker in tickers:
            self._seed(ticker)
        self._task = asyncio.create_task(self._run_loop(), name="simulator-loop")
        logger.info("Simulator started with %d tickers", len(tickers))

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("Simulator stopped")

    async def add_ticker(self, ticker: str) -> None:
        ticker = normalize_ticker(ticker)  # ▲ CHANGE
        if self._sim and ticker not in self._sim.get_tickers():
            self._sim.add_ticker(ticker)
            self._seed(ticker)             # price available immediately
            logger.info("Simulator: added ticker %s", ticker)

    async def remove_ticker(self, ticker: str) -> None:
        ticker = normalize_ticker(ticker)  # ▲ CHANGE
        if self._sim:
            self._sim.remove_ticker(ticker)
        self._cache.remove(ticker)
        logger.info("Simulator: removed ticker %s", ticker)

    def get_tickers(self) -> list[str]:
        return self._sim.get_tickers() if self._sim else []

    def _seed(self, ticker: str) -> None:
        """Write the starting price; it doubles as prev_close for daily change."""
        price = self._sim.get_price(ticker) if self._sim else None
        if price is not None:
            self._cache.update(ticker=ticker, price=price, prev_close=price)  # ▲ CHANGE

    async def _run_loop(self) -> None:
        """Step → write to cache → sleep. Never dies on a bad step."""
        while True:
            try:
                if self._sim:
                    for ticker, price in self._sim.step().items():
                        self._cache.update(ticker=ticker, price=price)
            except Exception:
                logger.exception("Simulator step failed")
            await asyncio.sleep(self._interval)
```

Concurrency note: `step()`, `add_ticker()` and `remove_ticker()` all run on the event loop thread and none of them awaits partway through. So the simulator's lists and dicts never change while a step is running, and no lock is needed inside `GBMSimulator`.

---

## 8. Massive API — `MassiveDataSource`

### 8.1 API facts used

| Item | Value |
|---|---|
| Package | `massive` (renamed `polygon-api-client`), `from massive import RESTClient` |
| Endpoint | `GET /v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL,MSFT,...` — **all tickers, one call** |
| Client call | `client.get_snapshot_all(market_type=SnapshotMarketType.STOCKS, tickers=[...])` → `list[TickerSnapshot]` |
| Auth | `RESTClient(api_key=...)` (sends `Authorization: Bearer`) |
| Rate limit | Free: 5 req/min → poll every **15 s** (4/min, leaving headroom). Paid: effectively unlimited → 2–5 s |
| Client is | **Synchronous** (urllib3). Must run in a thread: `asyncio.to_thread`. Retries 5xx itself (3×). |

Per-ticker snapshot fields we use:

```
snap.ticker                 "AAPL"
snap.last_trade.price       125.07        ← primary price
snap.last_trade.timestamp   SIP timestamp ← see §8.3: may be nanoseconds
snap.min.close              minute-bar close (fallback price)
snap.day.close              today's running close (fallback price)
snap.prev_day.close         yesterday's close     → prev_close (daily change)
snap.todays_change_percent  provider-computed daily change % (cross-check only)
```

> ⚠ **Verify before relying on it.** These field names come from the archived `MASSIVE_API.md` and from the `polygon-api-client` model layout (`TickerSnapshot.day / last_trade / min / prev_day`). The archived doc says `day.previous_close`; the client model uses `prev_day.close`, so this design reads `prev_day` and falls back gracefully. Run the probe script in §8.6 once with a real key and adjust `_extract()` if needed. Because everything goes through `getattr(..., None)`, a wrong guess just means the field is skipped, never a crash.

### 8.2 Implementation — `app/market/massive_client.py`

```python
"""Massive (Polygon.io) API client for real market data."""

from __future__ import annotations

import asyncio
import logging

from massive import RESTClient
from massive.rest.models import SnapshotMarketType

from .cache import PriceCache
from .interface import MarketDataSource
from .models import normalize_ticker

logger = logging.getLogger(__name__)


def _to_unix_seconds(ts: float | int | None) -> float | None:  # ▲ CHANGE
    """Normalise a Massive timestamp to Unix seconds, whatever its unit.

    Snapshot trade timestamps are SIP nanoseconds; aggregate bars use
    milliseconds. Detect the unit by magnitude (valid for dates 2001-2286).
    """
    if not ts:
        return None
    ts = float(ts)
    if ts > 1e17:      # nanoseconds
        return ts / 1e9
    if ts > 1e14:      # microseconds
        return ts / 1e6
    if ts > 1e11:      # milliseconds
        return ts / 1e3
    return ts          # already seconds


def _extract(snap) -> tuple[float, float | None, float | None] | None:  # ▲ CHANGE
    """Pull (price, timestamp_s, prev_close) from a snapshot, or None if unusable.

    Price fallback chain: last trade → minute bar close → day close → prev close.
    Delayed / lower-tier plans and pre-market hours can omit some of these.
    """
    last_trade = getattr(snap, "last_trade", None)
    minute = getattr(snap, "min", None)
    day = getattr(snap, "day", None)
    prev_day = getattr(snap, "prev_day", None)

    prev_close = getattr(prev_day, "close", None) or None
    candidates = [
        (getattr(last_trade, "price", None), getattr(last_trade, "timestamp", None)),
        (getattr(minute, "close", None), getattr(minute, "timestamp", None)),
        (getattr(day, "close", None), None),
        (prev_close, None),
    ]
    for price, ts in candidates:
        if isinstance(price, (int, float)) and price > 0:
            return float(price), _to_unix_seconds(ts), prev_close
    return None


class MassiveDataSource(MarketDataSource):
    """MarketDataSource backed by the Massive REST snapshot endpoint.

    One API call per poll covers every tracked ticker.
    Free tier: 5 req/min → default 15 s interval. Paid: 2-5 s.
    """

    def __init__(
        self,
        api_key: str,
        price_cache: PriceCache,
        poll_interval: float = 15.0,
    ) -> None:
        self._api_key = api_key
        self._cache = price_cache
        self._interval = poll_interval
        self._tickers: list[str] = []
        self._task: asyncio.Task | None = None
        self._client: RESTClient | None = None

    async def start(self, tickers: list[str]) -> None:
        self._client = RESTClient(api_key=self._api_key)
        self._tickers = list(dict.fromkeys(normalize_ticker(t) for t in tickers))
        await self._poll_once()  # immediate first poll so the cache isn't empty
        self._task = asyncio.create_task(self._poll_loop(), name="massive-poller")
        logger.info("Massive poller started: %d tickers, %.1fs interval",
                    len(self._tickers), self._interval)

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._client = None
        logger.info("Massive poller stopped")

    async def add_ticker(self, ticker: str) -> None:
        ticker = normalize_ticker(ticker)
        if ticker not in self._tickers:
            self._tickers.append(ticker)
            logger.info("Massive: added %s (price on next poll)", ticker)

    async def remove_ticker(self, ticker: str) -> None:
        ticker = normalize_ticker(ticker)
        self._tickers = [t for t in self._tickers if t != ticker]
        self._cache.remove(ticker)
        logger.info("Massive: removed %s", ticker)

    def get_tickers(self) -> list[str]:
        return list(self._tickers)

    # --- Internal ---

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            await self._poll_once()

    async def _poll_once(self) -> None:
        if not self._tickers or not self._client:
            return
        requested = list(self._tickers)  # ▲ CHANGE: freeze the list handed to the thread
        try:
            snapshots = await asyncio.to_thread(self._fetch_snapshots, requested)
        except Exception as e:
            # 401 bad key, 403 plan lacks endpoint, 429 rate limit, network errors.
            # Never re-raise: the loop retries on the next interval.
            logger.error("Massive poll failed: %s", e)
            return

        tracked = set(self._tickers)  # ▲ CHANGE: may have shrunk while we were awaiting
        processed = 0
        for snap in snapshots:
            ticker = getattr(snap, "ticker", None)
            if ticker not in tracked:
                continue  # removed mid-poll, or not requested — don't resurrect it
            extracted = _extract(snap)
            if extracted is None:
                logger.warning("Skipping snapshot for %s: no usable price", ticker)
                continue
            price, ts, prev_close = extracted
            self._cache.update(ticker=ticker, price=price, timestamp=ts, prev_close=prev_close)
            processed += 1
        logger.debug("Massive poll: updated %d/%d tickers", processed, len(requested))

    def _fetch_snapshots(self, tickers: list[str]) -> list:
        """Blocking HTTP call. Runs in a worker thread."""
        return self._client.get_snapshot_all(
            market_type=SnapshotMarketType.STOCKS,
            tickers=tickers,
        )
```

### 8.3 Changes vs. current `massive_client.py` and why

| ▲ CHANGE | Reason |
|---|---|
| `_to_unix_seconds()` replaces `timestamp / 1000.0` | Polygon documents the snapshot `lastTrade.t` as a **nanosecond** SIP timestamp. `/1000` would produce a year-50,000 timestamp and break any frontend chart that uses it as the x-axis. Detecting the unit by magnitude is correct for ns, µs, ms and s, so it is safe whichever the client returns. |
| `_extract()` fallback chain | On delayed or lower plans and outside market hours `last_trade` can be missing. Previously that raised `AttributeError` and the ticker was skipped forever, so the user saw no price and could not trade it. |
| `prev_close` from `prev_day.close` | Daily change % (R8). |
| `requested = list(self._tickers)` passed to the thread | Before, the worker thread read `self._tickers` while `add_ticker` could `append` to the same list on the loop thread. |
| Filter results to `tracked` | Before, a ticker removed during an in-flight poll was written back into the cache and reappeared in SSE until restart. |
| `normalize_ticker` + de-dupe on `start` | Consistent canonical tickers across both sources. |

### 8.4 Timing

```
t=0      start(): poll #1 (blocking up to ~1 s) → cache populated → task created
t=15s    poll #2
t=30s    poll #3 ...
add_ticker("PYPL") at t=20s → PYPL first priced at t=30s
```

On the free tier, `add_ticker` deliberately does **not** fire an extra poll: four scheduled polls a minute plus one burst from the LLM adding three tickers would hit HTTP 429. A trade on a ticker with no price yet gets a clear 400 (§11.4), and the LLM is told so.

### 8.5 Rate-limit budget

| Plan | Limit | Interval | Calls/min |
|---|---|---|---|
| Free | 5/min | 15 s (default) | 4 |
| Starter+ | unlimited (keep < 100/s) | 5 s | 12 |
| Low-latency demo | unlimited | 2 s | 30 |

Set with `MASSIVE_POLL_INTERVAL` (§9, ▲ CHANGE).

> ⚠ **Plan caveat.** Polygon's free "Basic" plan has historically been end-of-day only, and the snapshot endpoint may need a paid plan. If the first poll logs `403 NOT_AUTHORIZED`, the key works but the plan lacks the endpoint. The poller keeps retrying harmlessly; the fix is to upgrade the plan or unset `MASSIVE_API_KEY` to use the simulator. The startup log line (§9) makes this easy to diagnose.

### 8.6 Probe script (run once with a real key)

Save as `backend/scripts/probe_massive.py` (not part of the app):

```python
"""Print the raw shape of a Massive snapshot to verify field names and units."""
import os
from pprint import pprint

from massive import RESTClient
from massive.rest.models import SnapshotMarketType

client = RESTClient(api_key=os.environ["MASSIVE_API_KEY"])
snaps = client.get_snapshot_all(market_type=SnapshotMarketType.STOCKS, tickers=["AAPL", "MSFT"])
for s in snaps:
    pprint(vars(s))
    lt = getattr(s, "last_trade", None)
    print("last_trade.timestamp =", getattr(lt, "timestamp", None),
          "digits:", len(str(getattr(lt, "timestamp", "") or "")))  # 19 → ns, 13 → ms
```

```bash
cd backend && MASSIVE_API_KEY=... uv run python scripts/probe_massive.py
```

---

## 9. Factory & Configuration

**File: `app/market/factory.py`**

```python
"""Factory for creating market data sources."""

from __future__ import annotations

import logging
import os

from .cache import PriceCache
from .interface import MarketDataSource
from .massive_client import MassiveDataSource
from .simulator import SimulatorDataSource

logger = logging.getLogger(__name__)


def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    """Pick the data source from the environment. Returns an *unstarted* source.

    MASSIVE_API_KEY non-empty → MassiveDataSource; otherwise SimulatorDataSource.
    """
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()

    if api_key:
        interval = _float_env("MASSIVE_POLL_INTERVAL", 15.0, minimum=1.0)  # ▲ CHANGE
        logger.info("Market data source: Massive API (poll every %.1fs)", interval)
        return MassiveDataSource(api_key=api_key, price_cache=price_cache,
                                 poll_interval=interval)

    logger.info("Market data source: GBM Simulator")
    return SimulatorDataSource(price_cache=price_cache)


def _float_env(name: str, default: float, minimum: float) -> float:  # ▲ CHANGE
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(float(raw), minimum)
    except ValueError:
        logger.warning("Ignoring invalid %s=%r; using %.1f", name, raw, default)
        return default
```

### Configuration reference

| Setting | Where | Default | Effect |
|---|---|---|---|
| `MASSIVE_API_KEY` | env / `.env` | empty | Non-empty → Massive; else simulator |
| `MASSIVE_POLL_INTERVAL` ▲ | env / `.env` | `15` | Seconds between Massive polls (min 1) |
| `update_interval` | `SimulatorDataSource(...)` | `0.5` | Simulator tick period |
| `event_probability` | `SimulatorDataSource(...)` | `0.001` | Shock chance per ticker per tick |
| `dt` | `GBMSimulator(...)` | `0.5 / 5,896,800` | GBM step in trading-years |
| SSE `interval` | `_generate_events` | `0.5` | How often each SSE client checks the cache |
| SSE `retry:` | `_generate_events` | `1000` ms | Browser reconnect delay |
| SSE heartbeat ▲ | `_generate_events` | `15` s | Comment frame to keep idle connections open |

Add `MASSIVE_POLL_INTERVAL=` (commented) to `.env.example`.

---

## 10. SSE Streaming

**File: `app/market/stream.py`**

### 10.1 Wire format

One event = one full snapshot of every tracked ticker, as a JSON object keyed by ticker. Sending the whole snapshot (instead of deltas) means a reconnecting client is consistent again after one frame, with no resync logic.

```
retry: 1000

data: {"AAPL":{"ticker":"AAPL","price":190.37,"previous_price":190.35,"timestamp":1767100000.512,"change":0.02,"change_percent":0.0105,"direction":"up","prev_close":190.0,"day_change":0.37,"day_change_percent":0.1947},"MSFT":{...}}

data: {...}

: heartbeat

```

- No `event:` field, so the browser's default `onmessage` handler receives it.
- ~10 tickers × ~260 bytes ≈ 2.6 KB per frame, 5 KB/s per client at 500 ms. Negligible.

### 10.2 Implementation

```python
"""SSE streaming endpoint for live price updates."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .cache import PriceCache

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 15.0


def create_stream_router(price_cache: PriceCache) -> APIRouter:
    """Build the SSE router bound to `price_cache` (no globals)."""
    router = APIRouter(prefix="/api/stream", tags=["streaming"])  # ▲ CHANGE: per call

    @router.get("/prices")
    async def stream_prices(request: Request) -> StreamingResponse:
        return StreamingResponse(
            _generate_events(price_cache, request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # disable proxy buffering (nginx, App Runner)
            },
        )

    return router


async def _generate_events(
    price_cache: PriceCache,
    request: Request,
    interval: float = 0.5,
) -> AsyncGenerator[str, None]:
    """Yield SSE frames: a full snapshot whenever the cache version changes."""
    yield "retry: 1000\n\n"

    last_version = -1
    last_sent = time.monotonic()
    client = request.client.host if request.client else "unknown"
    logger.info("SSE client connected: %s", client)

    try:
        while True:
            if await request.is_disconnected():
                logger.info("SSE client disconnected: %s", client)
                break

            version = price_cache.version
            if version != last_version:
                last_version = version
                data = {t: u.to_dict() for t, u in price_cache.get_all().items()}
                yield f"data: {json.dumps(data)}\n\n"  # ▲ CHANGE: send even if {} (e.g. last ticker removed)
                last_sent = time.monotonic()
            elif time.monotonic() - last_sent >= HEARTBEAT_SECONDS:  # ▲ CHANGE
                yield ": heartbeat\n\n"
                last_sent = time.monotonic()

            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("SSE stream cancelled: %s", client)
```

### 10.3 Changes vs. current `stream.py`

| ▲ CHANGE | Reason |
|---|---|
| `APIRouter` created **inside** `create_stream_router` | The current module-level `router` gets a duplicate `/prices` route on every call, which bites tests that build several apps. |
| Heartbeat comment every 15 s with no data | With Massive (15 s polls) or a quiet cache, proxies and load balancers can close the idle connection. SSE comment lines (`:`) are ignored by `EventSource`. |
| Send `{}` when the cache becomes empty | Removing the last ticker should clear the client's view, not leave the stale snapshot. |

### 10.4 Why poll-and-push rather than notify-on-write

Each client loop checks one integer every 500 ms. That gives evenly spaced frames, which keeps sparklines clean, and needs no subscriber registry, no queues, and no backpressure handling. At 500 ms it adds at most half a tick of latency, which is invisible next to the 500 ms flash animation.

---

## 11. FastAPI Integration

### 11.1 App lifespan — `app/main.py`

The tracked set is **watchlist ∪ open positions**. Positions must keep a live price so portfolio value, the heatmap and P&L stay correct even after a ticker leaves the watchlist.

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.db import get_db, init_db                 # owned by the backend/DB agent
from app.market import PriceCache, create_market_data_source, create_stream_router


async def tracked_tickers(db) -> list[str]:
    """Tickers that need live prices: watchlist ∪ held positions."""
    rows = await db.fetch_all(
        """SELECT ticker FROM watchlist WHERE user_id = 'default'
           UNION
           SELECT ticker FROM positions WHERE user_id = 'default' AND quantity > 0"""
    )
    return [r["ticker"] for r in rows]


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()                                  # lazy schema + seed (PLAN §7)

    source = create_market_data_source(app.state.price_cache)
    async with get_db() as db:
        await source.start(await tracked_tickers(db))
    app.state.market_source = source
    # ... start the portfolio snapshot task (every 30 s, reads price_cache) ...

    try:
        yield
    finally:
        await source.stop()


app = FastAPI(title="FinAlly", lifespan=lifespan)

# The cache exists from import time (empty until the source starts), so every
# router can be registered here, in order, before the static catch-all.
app.state.price_cache = PriceCache()
app.include_router(create_stream_router(app.state.price_cache))
# app.include_router(portfolio_router); app.include_router(watchlist_router); ...
app.mount("/", StaticFiles(directory="static", html=True), name="static")  # MUST be last
```

(Use whatever DB helper the backend agent builds. The important parts are the UNION query, the start/stop ordering, and registering all `/api` routers **before** the `/` static mount. A router added later, e.g. inside `lifespan`, is matched after the mount and gets shadowed by it.)

### 11.2 Dependencies — `app/deps.py`

```python
from fastapi import Request

from app.market import MarketDataSource, PriceCache


def get_price_cache(request: Request) -> PriceCache:
    return request.app.state.price_cache


def get_market_source(request: Request) -> MarketDataSource:
    return request.app.state.market_source
```

Reading from `request.app.state` (instead of a module-level `app`) lets tests swap in their own cache and source.

### 11.3 Watchlist routes — keeping the source in sync

```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import get_market_source, get_price_cache
from app.market import MarketDataSource, PriceCache
from app.market.models import normalize_ticker

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


class WatchlistAdd(BaseModel):
    ticker: str


@router.get("")
async def list_watchlist(cache: PriceCache = Depends(get_price_cache)):
    tickers = await db.watchlist_tickers()
    return [
        {"ticker": t, **(cache.get(t).to_dict() if cache.get(t) else {"price": None})}
        for t in tickers
    ]


@router.post("", status_code=201)
async def add_to_watchlist(
    body: WatchlistAdd,
    source: MarketDataSource = Depends(get_market_source),
    cache: PriceCache = Depends(get_price_cache),
):
    try:
        ticker = normalize_ticker(body.ticker)
    except ValueError as e:
        raise HTTPException(422, str(e))
    await db.insert_watchlist(ticker)              # ON CONFLICT DO NOTHING
    await source.add_ticker(ticker)                # idempotent
    update = cache.get(ticker)                     # simulator: present; Massive: maybe None
    return {"ticker": ticker, "price": update.price if update else None}


@router.delete("/{ticker}", status_code=204)
async def remove_from_watchlist(
    ticker: str,
    source: MarketDataSource = Depends(get_market_source),
):
    ticker = normalize_ticker(ticker)
    await db.delete_watchlist(ticker)
    if not await db.has_open_position(ticker):     # keep pricing held positions
        await source.remove_ticker(ticker)
```

**Put this logic in a shared service** (e.g. `app/services/watchlist.py`: `add_ticker(ticker)` / `remove_ticker(ticker)`) so the REST routes and the LLM's `watchlist_changes` go through exactly the same code path.

### 11.4 Trades — reading the fill price

```python
async def execute_trade(ticker: str, side: str, quantity: float,
                        cache: PriceCache, source: MarketDataSource) -> dict:
    ticker = normalize_ticker(ticker)
    price = cache.get_price(ticker)
    if price is None:
        # Not tracked, or Massive hasn't polled it yet.
        raise TradeError(f"No live price for {ticker} yet. Add it to the watchlist "
                         f"and retry in a few seconds.")
    # ... validate cash / shares, write trades + positions, snapshot portfolio ...
    if side == "sell" and new_quantity == 0 and not await db.in_watchlist(ticker):
        await source.remove_ticker(ticker)         # closed a position nobody's watching
    return {"ticker": ticker, "side": side, "quantity": quantity, "price": price}
```

Rule: **a trade may only fill against a cached price.** The simulator must never be asked to invent a price for an untracked ticker at trade time. If the LLM wants to buy something not on the watchlist, the chat handler applies `watchlist_changes` *before* `trades`; with the simulator the price is then available immediately.

### 11.5 Portfolio valuation & LLM context

```python
def portfolio_value(cash: float, positions: list[dict], cache: PriceCache) -> dict:
    rows, total = [], cash
    for p in positions:
        price = cache.get_price(p["ticker"]) or p["avg_cost"]   # fallback: no price yet
        value = p["quantity"] * price
        total += value
        rows.append({**p, "current_price": price, "market_value": value,
                     "unrealized_pnl": (price - p["avg_cost"]) * p["quantity"],
                     "pnl_percent": (price / p["avg_cost"] - 1) * 100 if p["avg_cost"] else 0.0})
    return {"cash": cash, "positions": rows, "total_value": total}
```

The LLM chat handler builds its "watchlist with live prices" context from `cache.get_all()`, using `price` and `day_change_percent`.

---

## 12. Frontend Contract

TypeScript types matching `PriceUpdate.to_dict()`:

```ts
export type Direction = "up" | "down" | "flat";

export interface PriceUpdate {
  ticker: string;
  price: number;
  previous_price: number;
  timestamp: number;            // Unix seconds (float)
  change: number;               // vs previous tick
  change_percent: number;       // vs previous tick
  direction: Direction;         // drives the green/red flash
  prev_close: number | null;    // reference for daily change
  day_change: number | null;
  day_change_percent: number | null;  // shown in the watchlist "Chg %" column
}

export type PriceSnapshot = Record<string, PriceUpdate>;
```

Minimal hook (status dot + sparkline buffers):

```ts
import { useEffect, useRef, useState } from "react";

type Status = "connected" | "reconnecting" | "disconnected";
const MAX_POINTS = 600; // ~5 min at 500 ms

export function usePriceStream() {
  const [prices, setPrices] = useState<PriceSnapshot>({});
  const [status, setStatus] = useState<Status>("reconnecting");
  const history = useRef<Record<string, { t: number; p: number }[]>>({});

  useEffect(() => {
    const es = new EventSource("/api/stream/prices");
    es.onopen = () => setStatus("connected");
    es.onerror = () =>
      setStatus(es.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting");
    es.onmessage = (e) => {
      const snap: PriceSnapshot = JSON.parse(e.data);
      for (const u of Object.values(snap)) {
        const h = (history.current[u.ticker] ??= []);
        if (h.at(-1)?.t !== u.timestamp) h.push({ t: u.timestamp, p: u.price });
        if (h.length > MAX_POINTS) h.shift();
      }
      setPrices(snap);   // full snapshot — tickers not present have been removed
    };
    return () => es.close();
  }, []);

  return { prices, status, history: history.current };
}
```

Frontend rules:

- **Flash** when `direction !== "flat"` *and* the `timestamp` changed since the last render of that row. With Massive, unchanged tickers are re-sent with the same timestamp and must not flash again.
- **Sparklines** de-duplicate on `timestamp` (as above) so 15 s Massive polls don't draw flat steps.
- **Daily change %** = `day_change_percent` (render "—" when `null`).
- The snapshot is authoritative: a ticker missing from a frame has been removed.

---

## 13. Design Changes Checklist

Everything marked ▲ CHANGE above, in suggested implementation order. Each item is small and independently testable.

| # | File | Change | Test to add |
|---|---|---|---|
| 1 | `models.py` | Add `normalize_ticker()` | valid/invalid symbols, `" aapl "` → `"AAPL"`, `"BRK.B"` ok |
| 2 | `models.py` | `prev_close` field + `day_change`, `day_change_percent`; extend `to_dict()` | None handling, maths, dict keys |
| 3 | `cache.py` | `update(..., prev_close=None)` sticky semantics; `timestamp is not None` | prev_close persists across updates; `timestamp=0.0` kept |
| 4 | `cache.py` | `remove()` bumps `version`; `version` read under lock | version increments on remove of present ticker only |
| 5 | `simulator.py` | normalize tickers; seed with `prev_close=price` | `day_change_percent` 0 at start, non-None after steps |
| 6 | `massive_client.py` | `_to_unix_seconds`, `_extract` fallback chain, `prev_day.close` | ns/µs/ms/s inputs; missing `last_trade` uses `min.close` |
| 7 | `massive_client.py` | freeze ticker list; filter results to tracked set | ticker removed during `_fetch_snapshots` is not re-added |
| 8 | `factory.py` | `MASSIVE_POLL_INTERVAL` | env parsing, invalid value → default, min clamp |
| 9 | `stream.py` | router per call; heartbeat; send empty snapshot | two `create_stream_router` calls → one route each; generator yields heartbeat |
| 10 | `.env.example` | document `MASSIVE_POLL_INTERVAL` | — |

None of these change the public API used by downstream code (`from app.market import ...`); all new parameters are optional.

---

## 14. Testing

Existing suite: 73 tests in `backend/tests/market/` (see `MARKET_DATA_SUMMARY.md`). Run with:

```bash
cd backend
uv run --extra dev pytest tests/market -v
uv run --extra dev pytest --cov=app/market --cov-report=term-missing
uv run --extra dev ruff check app/ tests/
```

### 14.1 Simulator — statistical and structural tests

```python
import numpy as np
from app.market.simulator import GBMSimulator
from app.market.seed_prices import SEED_PRICES

DEFAULTS = list(SEED_PRICES)


def test_full_default_set_builds_cholesky():
    sim = GBMSimulator(DEFAULTS)
    assert sim._cholesky is not None
    assert sim._cholesky.shape == (10, 10)


def test_cholesky_ok_with_many_unknown_tickers():
    GBMSimulator(DEFAULTS + [f"X{i}" for i in range(40)])  # must not raise


def test_prices_stay_positive_over_long_run():
    sim = GBMSimulator(["TSLA"], event_probability=0.05)
    for _ in range(20_000):
        assert sim.step()["TSLA"] > 0


def test_tick_volatility_matches_sigma():
    np.random.seed(0)
    sim = GBMSimulator(["AAPL"], event_probability=0.0)
    p = [sim.get_price("AAPL")]
    for _ in range(20_000):
        sim.step()
        p.append(sim.get_price("AAPL"))       # unrounded internal price
    log_ret = np.diff(np.log(p))
    expected = 0.22 * np.sqrt(GBMSimulator.DEFAULT_DT)
    assert abs(log_ret.std() / expected - 1) < 0.05


def test_tech_more_correlated_than_cross_sector():
    np.random.seed(1)
    sim = GBMSimulator(["AAPL", "MSFT", "JPM"], event_probability=0.0)
    hist = {t: [sim.get_price(t)] for t in sim.get_tickers()}
    for _ in range(5_000):
        sim.step()
        for t in hist:
            hist[t].append(sim.get_price(t))
    r = {t: np.diff(np.log(v)) for t, v in hist.items()}
    tech = np.corrcoef(r["AAPL"], r["MSFT"])[0, 1]
    cross = np.corrcoef(r["AAPL"], r["JPM"])[0, 1]
    assert 0.5 < tech < 0.7 and 0.2 < cross < 0.4
```

### 14.2 Simulator source — lifecycle

```python
import asyncio
from app.market.cache import PriceCache
from app.market.simulator import SimulatorDataSource


async def test_start_seeds_cache_and_ticks():
    cache = PriceCache()
    src = SimulatorDataSource(cache, update_interval=0.01)
    await src.start(["AAPL", "msft"])
    assert cache.get_price("AAPL") == 190.00
    assert "MSFT" in cache                          # normalised
    v = cache.version
    await asyncio.sleep(0.05)
    assert cache.version > v
    await src.stop()
    await src.stop()                                # idempotent


async def test_add_then_remove_ticker():
    cache = PriceCache()
    src = SimulatorDataSource(cache, update_interval=10)
    await src.start([])
    await src.add_ticker("PYPL")
    assert cache.get_price("PYPL") is not None      # immediate
    await src.remove_ticker("PYPL")
    assert "PYPL" not in cache and src.get_tickers() == []
    await src.stop()
```

### 14.3 Massive — mocked snapshots

```python
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

from app.market.cache import PriceCache
from app.market.massive_client import MassiveDataSource, _to_unix_seconds


def snap(ticker, price=None, ts=None, minute=None, prev=None):
    return NS(ticker=ticker,
              last_trade=NS(price=price, timestamp=ts) if price else None,
              min=NS(close=minute, timestamp=None) if minute else None,
              day=None,
              prev_day=NS(close=prev) if prev else None)


def make_source(tickers):
    cache = PriceCache()
    src = MassiveDataSource("k", cache, poll_interval=60)
    src._tickers, src._client = list(tickers), MagicMock()
    return src, cache


def test_timestamp_units():
    for raw in (1_707_580_800, 1_707_580_800_000, 1_707_580_800_000_000,
                1_707_580_800_000_000_000):
        assert abs(_to_unix_seconds(raw) - 1_707_580_800) < 1


async def test_poll_uses_fallbacks_and_prev_close():
    src, cache = make_source(["AAPL", "MSFT"])
    data = [snap("AAPL", 190.5, 1_707_580_800_000_000_000, prev=188.0),
            snap("MSFT", minute=421.0, prev=420.0)]          # no last_trade
    with patch.object(src, "_fetch_snapshots", return_value=data):
        await src._poll_once()
    assert cache.get("AAPL").timestamp == 1_707_580_800
    assert cache.get("AAPL").day_change_percent == round((190.5 / 188 - 1) * 100, 4)
    assert cache.get_price("MSFT") == 421.0


async def test_removed_mid_poll_not_resurrected():
    src, cache = make_source(["AAPL", "TSLA"])

    def fetch(tickers):
        src._tickers.remove("TSLA")                  # simulate concurrent removal
        return [snap("AAPL", 190.0), snap("TSLA", 250.0)]

    with patch.object(src, "_fetch_snapshots", side_effect=fetch):
        await src._poll_once()
    assert "TSLA" not in cache and "AAPL" in cache


async def test_api_error_is_swallowed():
    src, cache = make_source(["AAPL"])
    with patch.object(src, "_fetch_snapshots", side_effect=RuntimeError("429")):
        await src._poll_once()
    assert len(cache) == 0
```

### 14.4 SSE generator — no server needed

```python
import json
from app.market.cache import PriceCache
from app.market.stream import _generate_events, create_stream_router


class FakeRequest:
    client = None

    def __init__(self, frames_before_disconnect: int):
        self._n = frames_before_disconnect

    async def is_disconnected(self) -> bool:
        self._n -= 1
        return self._n < 0


async def test_stream_emits_retry_then_snapshot():
    cache = PriceCache()
    cache.update("AAPL", 190.0)
    frames = [f async for f in _generate_events(cache, FakeRequest(1), interval=0)]
    assert frames[0] == "retry: 1000\n\n"
    payload = json.loads(frames[1].removeprefix("data: "))
    assert payload["AAPL"]["price"] == 190.0


async def test_no_duplicate_frames_without_changes():
    cache = PriceCache()
    cache.update("AAPL", 190.0)
    frames = [f async for f in _generate_events(cache, FakeRequest(5), interval=0)]
    assert sum(f.startswith("data:") for f in frames) == 1


def test_router_factory_is_reentrant():
    r1, r2 = create_stream_router(PriceCache()), create_stream_router(PriceCache())
    assert len(r1.routes) == 1 and len(r2.routes) == 1
```

### 14.5 E2E (Playwright, `test/`)

Run with the simulator (no `MASSIVE_API_KEY`) and assert behaviour, never specific prices:

- On load, 10 watchlist rows show a numeric price within 2 s.
- Within 3 s at least one row gets the up/down flash class.
- After adding `PYPL`, its row shows a price within 2 s (simulator seeds immediately).
- The connection dot is green. After the server restarts it turns yellow, then green again.

---

## 15. Edge Cases & Failure Modes

| Situation | Behaviour |
|---|---|
| Empty watchlist at startup | `start([])` succeeds. Simulator steps nothing; Massive skips the API call. SSE sends nothing until a ticker is added. |
| User adds an unknown symbol (`ZZZZ`) — simulator | Gets a random $50–300 price; any syntactically valid symbol is accepted. |
| User adds an unknown symbol — Massive | No snapshot comes back, so it never gets a price. Watchlist shows "—"; trades return "No live price". Optional: the watchlist route warns after one poll interval. |
| Ticker removed from watchlist but still held | Stays tracked (§11.3). It disappears from the watchlist UI but the positions/heatmap keep a live price. |
| Last share of an unwatched ticker sold | Source stops tracking it (§11.4). |
| Trade before Massive's first price for a new ticker | 400 with an explicit message; the LLM relays it. |
| Invalid Massive key (401) / plan lacks snapshots (403) | Logged at ERROR on every poll; app keeps running with an empty cache. Fix the key/plan or unset it to use the simulator. |
| Rate limited (429) | Logged; next poll retries. Default 15 s interval stays under the free-tier limit. |
| Massive network hang | `RESTClient` has its own timeouts and retries. The thread blocks only that poll; the event loop and SSE keep serving the last prices. |
| Market closed (Massive) | Prices stop changing; the cache version still bumps on every poll (same price, `direction: "flat"`). The frontend doesn't flash because `direction` is flat. |
| Simulator step raises | Logged with traceback; the loop continues on the next tick. |
| Server restart | Simulator restarts from seed prices (`prev_close` resets). Positions keep their `avg_cost` in SQLite, so unrealised P&L jumps to "vs seed price". This is accepted for a demo. |
| Browser tab sleeps / network drops | `EventSource` reconnects after `retry: 1000`. The first frame is a full snapshot, so there is nothing to resync. |
| Many SSE clients | Each costs one coroutine plus a JSON dump per change. Fine into the hundreds. If it ever matters, serialise once per version and share the string across clients. |
