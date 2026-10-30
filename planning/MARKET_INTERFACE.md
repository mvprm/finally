# Market Data Interface: Unified Python API

The one Python API that FinAlly's backend uses to get stock prices. It uses the **Massive API** when `MASSIVE_API_KEY` is set and the **GBM simulator** otherwise. Downstream code (SSE, trades, portfolio valuation, chat) never knows which.

- Massive endpoint research: `MASSIVE_API.md`
- Simulator internals: `MARKET_SIMULATOR.md`
- Product rules this implements: `PLAN.md` §6 (Market Data), §7 (Startup Sequence), §8 (Trade Execution)

The package already exists at `backend/app/market/`. This document is the contract. **§9 lists the changes needed to bring the code in line with it.**

---

## 1. Design in One Picture

```
                 MASSIVE_API_KEY set?
                         │
        create_market_data_source(cache)          ← factory.py
           │                          │
           ▼ no                       ▼ yes
  SimulatorDataSource         MassiveDataSource
  (GBM, 500 ms ticks)         realtime mode: snapshot poll (paid plans)
                              eod mode:      grouped-daily closes (free plan)
           │                          │
           └──────── writes ──────────┘
                         ▼
                    PriceCache  (latest + previous price per ticker, version counter)
                         │ reads
     ┌───────────────┬───┴──────────────┬─────────────────┐
     ▼               ▼                  ▼                 ▼
 SSE stream     trade execution   portfolio valuation   watchlist / chat
 /api/stream/prices
```

Three rules hold the design together:

1. **Producers write, consumers read.** Exactly one data source writes to the `PriceCache`. Everything else reads from the cache and never calls the source for a price.
2. **The source only manages *which* tickers to track.** Its public surface is lifecycle plus `add_ticker` / `remove_ticker` / `get_tickers`.
3. **One function decides the tracked set.** `sync_tracked_tickers()` (§6) is the only caller of `add_ticker` / `remove_ticker`, as `PLAN.md` §6 requires.

---

## 2. Package Layout

```
backend/app/market/
├── __init__.py        # public exports (below)
├── models.py          # PriceUpdate
├── cache.py           # PriceCache
├── interface.py       # MarketDataSource (ABC)
├── factory.py         # create_market_data_source()
├── simulator.py       # GBMSimulator + SimulatorDataSource
├── seed_prices.py     # seed prices, GBM params, correlation groups
├── massive_client.py  # MassiveDataSource
├── tracking.py        # sync_tracked_tickers()  ← new
└── stream.py          # create_stream_router()  (SSE)
```

Public API (`from app.market import ...`):

```python
__all__ = [
    "PriceUpdate",
    "PriceCache",
    "MarketDataSource",
    "create_market_data_source",
    "create_stream_router",
    "sync_tracked_tickers",
]
```

---

## 3. Data Model: `PriceUpdate`

```python
@dataclass(frozen=True, slots=True)
class PriceUpdate:
    ticker: str
    price: float            # rounded to 2 dp by the cache
    previous_price: float   # the price before this update (== price on first update)
    timestamp: float        # Unix seconds

    @property
    def change(self) -> float: ...           # price - previous_price, 4 dp
    @property
    def change_percent(self) -> float: ...   # vs previous_price, 4 dp; 0.0 if previous is 0
    @property
    def direction(self) -> str: ...          # "up" | "down" | "flat"

    def to_dict(self) -> dict: ...           # exactly the per-ticker SSE object in PLAN.md §6
```

`change` / `direction` are **tick-to-tick**, not daily. That's deliberate (`PLAN.md` §6), and the frontend computes the session change.

---

## 4. Price Cache: `PriceCache`

Thread-safe (a `threading.Lock`) because the Massive client runs its HTTP call in a worker thread, and cheap enough to read on every request.

```python
class PriceCache:
    def update(self, ticker: str, price: float, timestamp: float | None = None) -> PriceUpdate
    def get(self, ticker: str) -> PriceUpdate | None
    def get_price(self, ticker: str) -> float | None
    def get_all(self) -> dict[str, PriceUpdate]       # shallow copy
    def remove(self, ticker: str) -> None
    @property
    def version(self) -> int                           # bumps on every update()
    def __len__(self) -> int
    def __contains__(self, ticker: str) -> bool
```

Semantics consumers rely on:

| Question | Answer |
|---|---|
| Ticker tracked but no price yet (Massive, before the next poll; unknown symbol) | `get()` → `None`. API responses show `price: null`, and trades fail with `400 "No price available for X yet"` |
| Ticker removed from tracking | The source calls `cache.remove()`, so `get()` → `None` |
| Has anything changed since I last looked? | Compare `version`. The SSE loop sends an event only when it differs |
| First update for a ticker | `previous_price == price`, `direction == "flat"` |

---

## 5. Data Source Contract: `MarketDataSource`

```python
class MarketDataSource(ABC):
    @abstractmethod
    async def start(
        self,
        tickers: list[str],
        initial_prices: dict[str, float] | None = None,
    ) -> None:
        """Begin producing prices for `tickers` and start the background task.

        initial_prices: optional {ticker: price} starting points. The simulator
        uses them so held positions keep their value across restarts
        (PLAN.md §6 "Price Continuity"). MassiveDataSource ignores them.

        Called exactly once. Tickers are already normalised (uppercase).
        Should write a first price for each ticker it can before returning,
        so the cache is warm when the app starts serving.
        """

    @abstractmethod
    async def stop(self) -> None:
        """Cancel the background task. Idempotent. No cache writes afterwards."""

    @abstractmethod
    async def add_ticker(self, ticker: str) -> None:
        """Start tracking. No-op if already tracked.
        Simulator: priced immediately. Massive: priced on the next poll (realtime)
        or immediately from stored closes (eod)."""

    @abstractmethod
    async def remove_ticker(self, ticker: str) -> None:
        """Stop tracking and remove it from the cache. No-op if not tracked."""

    @abstractmethod
    def get_tickers(self) -> list[str]:
        """Currently tracked tickers."""
```

### Behaviour matrix

| | `SimulatorDataSource` | `MassiveDataSource` (realtime) | `MassiveDataSource` (eod) |
|---|---|---|---|
| Selected when | no `MASSIVE_API_KEY` | key set, plan includes snapshots | key set, plan is Stocks Basic (snapshot → 403) |
| Update cadence | every 0.5 s | every 15 s (default) | refresh closes hourly; prices are static |
| `start()` warms cache | yes, from `initial_prices` or seeds | yes, one immediate poll | yes, one grouped-daily request |
| New ticker priced | immediately | next poll (≤ 15 s) | immediately if Massive knows it |
| Unknown symbol | gets a random $50–$300 price | never priced (`null`) | never priced (`null`) |
| `initial_prices` | used | ignored | ignored |
| Requests per hour | 0 | 240 at 15 s | about 1 |

---

## 6. Tracked-Ticker Sync: `sync_tracked_tickers()` (new, `tracking.py`)

`PLAN.md` §6: *tracked tickers = watchlist ∪ tickers with an open position*, and one function applies the difference. Keep the DB query in the caller (the market package knows nothing about SQLite) and keep the diff here:

```python
"""Single point of control for which tickers the market data source tracks."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable

from .interface import MarketDataSource

_sync_lock = asyncio.Lock()


async def sync_tracked_tickers(source: MarketDataSource, wanted: Iterable[str]) -> None:
    """Make the source track exactly `wanted`.

    `wanted` is watchlist ∪ open-position tickers, already normalised.
    The only code that calls add_ticker/remove_ticker. Serialised with a lock
    so a REST trade and a chat action can't interleave their diffs.
    """
    async with _sync_lock:
        target = set(wanted)
        current = set(source.get_tickers())
        for ticker in sorted(target - current):
            await source.add_ticker(ticker)
        for ticker in sorted(current - target):
            await source.remove_ticker(ticker)
```

Caller side (backend service layer, after any watchlist write or trade):

```python
async def resync(db, source) -> None:
    wanted = db.watchlist_tickers() | db.position_tickers()   # sets of str
    await sync_tracked_tickers(source, wanted)
```

This gives the `PLAN.md` behaviours for free:

- Removing a held ticker from the watchlist keeps it streaming (it's still in positions).
- Selling an unwatched ticker to zero stops it (the position row is deleted, so it's in neither set).
- A trade on a ticker that's not on the watchlist adds it to the watchlist first (`PLAN.md` §8 step 2), then resyncs, so it's priced before the fill in simulator mode.

---

## 7. Source Selection: `create_market_data_source()`

```python
def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    """MASSIVE_API_KEY set and non-empty → MassiveDataSource, otherwise SimulatorDataSource.
    Returns an unstarted source. Call after load_dotenv() (PLAN.md §5)."""
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()
    if api_key:
        return MassiveDataSource(api_key=api_key, price_cache=price_cache)
    return SimulatorDataSource(price_cache=price_cache)
```

The realtime-or-eod choice is made **inside** `MassiveDataSource.start()` with one probe request, because only the API knows the plan. The factory stays a pure env-var switch, so it's trivial to test.

---

## 8. `MassiveDataSource` Design

### 8.1 Modes

```python
class MassiveMode(StrEnum):
    REALTIME = "realtime"   # snapshot endpoint: Starter/Developer (15-min delayed), Advanced/Business (real-time)
    EOD = "eod"             # grouped daily: Stocks Basic (free), previous trading day's close
```

`start()`:

1. Builds `RESTClient(api_key=...)` and passes the key explicitly (the SDK's env default is captured at import time).
2. Runs one `get_snapshot_all` for the starting tickers in a thread.
   - Success → `REALTIME`, and that response is also the first poll, so the cache is warm.
   - `BadResponse` containing `NOT_AUTHORIZED` → `EOD`. Load the latest grouped daily and write closes for the tracked tickers.
   - Any other error (bad key, network) → log it, stay in `REALTIME` and let the loop retry. The app still starts, with tickers showing "—".
3. Starts the background loop with the mode's interval (15 s or 3600 s).

The mode is logged at INFO and exposed as a read-only `mode` property for logs and tests. It isn't part of the ABC.

### 8.2 Parsing a snapshot

```python
def _snapshot_price(snap: TickerSnapshot) -> tuple[float, float] | None:
    """(price, unix_seconds) from a snapshot, or None if it has no usable price."""
    trade = snap.last_trade
    if trade is not None and trade.price:
        ts = _to_seconds(trade.sip_timestamp)      # nanoseconds
        return trade.price, ts or time.time()
    # Plans without trades, or the 03:30–04:00 ET reset window
    for bar in (snap.min, snap.day, snap.prev_day):
        if bar is not None and bar.close:
            return bar.close, _to_seconds(snap.updated) or time.time()
    return None


def _to_seconds(ts: int | float | None) -> float | None:
    if not ts:
        return None
    if ts > 1e17:
        return ts / 1e9      # ns: trades, quotes, snapshot.updated
    if ts > 1e14:
        return ts / 1e6      # µs
    if ts > 1e11:
        return ts / 1e3      # ms: aggregates
    return float(ts)
```

### 8.3 Skeleton

```python
class MassiveDataSource(MarketDataSource):
    REALTIME_INTERVAL = 15.0     # paid plans have no request limit; 2–5 s also works
    EOD_REFRESH_INTERVAL = 3600.0

    def __init__(self, api_key: str, price_cache: PriceCache,
                 poll_interval: float = REALTIME_INTERVAL) -> None:
        self._api_key = api_key
        self._cache = price_cache
        self._interval = poll_interval
        self._tickers: list[str] = []
        self._client: RESTClient | None = None
        self._task: asyncio.Task | None = None
        self._mode = MassiveMode.REALTIME
        self._eod_closes: dict[str, tuple[float, float]] = {}   # ticker → (close, ts)

    @property
    def mode(self) -> MassiveMode:
        return self._mode

    async def start(self, tickers, initial_prices=None) -> None:   # initial_prices ignored
        self._client = RESTClient(api_key=self._api_key)
        self._tickers = list(tickers)
        try:
            await self._poll_realtime(raise_on_error=True)
        except BadResponse as e:
            if "NOT_AUTHORIZED" not in str(e):
                logger.error("Massive startup poll failed: %s", e)
            else:
                self._mode = MassiveMode.EOD
                self._interval = self.EOD_REFRESH_INTERVAL
                await self._refresh_eod()
        except Exception as e:                       # network, etc.
            logger.error("Massive startup poll failed: %s", e)
        logger.info("Massive source started in %s mode, %d tickers", self._mode, len(tickers))
        self._task = asyncio.create_task(self._loop(), name="massive-poller")

    async def add_ticker(self, ticker: str) -> None:
        if ticker in self._tickers:
            return
        self._tickers.append(ticker)
        if self._mode is MassiveMode.EOD and ticker in self._eod_closes:
            price, ts = self._eod_closes[ticker]
            self._cache.update(ticker, price, ts)   # no extra request

    async def remove_ticker(self, ticker: str) -> None:
        self._tickers = [t for t in self._tickers if t != ticker]
        self._cache.remove(ticker)

    def get_tickers(self) -> list[str]:
        return list(self._tickers)

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            if self._mode is MassiveMode.REALTIME:
                await self._poll_realtime()
            else:
                await self._refresh_eod()

    async def _poll_realtime(self, raise_on_error: bool = False) -> None:
        if not self._tickers:
            return
        tickers = list(self._tickers)     # snapshot the list; it can change during the await
        try:
            snaps = await asyncio.to_thread(
                self._client.get_snapshot_all, SnapshotMarketType.STOCKS, tickers
            )
        except Exception as e:
            if raise_on_error:
                raise
            logger.error("Massive poll failed: %s", e)   # 401/429/5xx: retry next cycle
            return
        for snap in snaps:
            if snap.ticker not in self._tickers:          # removed while we were waiting
                continue
            got = _snapshot_price(snap)
            if got:
                self._cache.update(snap.ticker, got[0], got[1])

    async def _refresh_eod(self) -> None:
        try:
            _, rows = await asyncio.to_thread(latest_grouped_daily, self._client)
        except Exception as e:
            logger.error("Massive EOD refresh failed: %s", e)
            return
        self._eod_closes = {r.ticker: (r.close, r.timestamp / 1000) for r in rows if r.close}
        for t in self._tickers:
            if t in self._eod_closes:
                self._cache.update(t, *self._eod_closes[t])
```

`latest_grouped_daily()` is the walk-back helper from `MASSIVE_API.md` §4.3: start at yesterday in `America/New_York`, skip weekends, step past holidays.

### 8.4 Behaviours worth knowing

- **Unknown symbols** are simply absent from the snapshot or grouped data, so they stay `null` forever. That matches `PLAN.md` §6, and trades on them get the `400` "no price" error.
- **Market closed / weekends:** realtime mode keeps writing the same last price. The cache version still bumps, so SSE sends an unchanged event about every 15 s, which is harmless and keeps the "last update" time fresh.
- **EOD mode prices never move during the session.** The UI still works (flash animations just don't fire). Log it clearly at startup: `Massive free plan detected: using previous close prices (end-of-day)`.
- **Removing a ticker during an in-flight poll:** the `snap.ticker not in self._tickers` check stops a late write from bringing a removed ticker back into the cache.

---

## 9. Changes Required to the Current Code

| # | File | Change | Why |
|---|---|---|---|
| 1 | `interface.py` | `start(self, tickers, initial_prices: dict[str, float] \| None = None)` | Price continuity (`PLAN.md` §6, pending change 1) |
| 2 | `simulator.py` | `GBMSimulator(tickers, initial_prices=...)` and pass it through from `SimulatorDataSource.start` | Same (see `MARKET_SIMULATOR.md` §5) |
| 3 | `stream.py` | Move `router = APIRouter(prefix="/api/stream", ...)` inside `create_stream_router()` | Calling the factory twice duplicates routes (pending change 2) |
| 4 | `pyproject.toml` | Move `rich` to the `dev` extra | Only the demo uses it (pending change 3) |
| 5 | `massive_client.py` | Read `last_trade.sip_timestamp` (ns ÷ 1e9) instead of the nonexistent `last_trade.timestamp` (÷ 1000) | **Bug: every Massive snapshot is currently skipped with AttributeError**, so the cache is never populated |
| 6 | `massive_client.py` | Fall back from `last_trade` to `min` / `day` / `prev_day` close | `last_trade` is `None` on plans without trades and during the morning reset |
| 7 | `massive_client.py` | Add the EOD mode (§8) | The free plan gets 403 on every snapshot endpoint |
| 8 | `massive_client.py` | Accept `initial_prices` and ignore it; skip writes for tickers removed mid-poll | Interface conformance; no reappearing tickers |
| 9 | `tracking.py` (new) + `__init__.py` | `sync_tracked_tickers()` | `PLAN.md` §6: one function owns the tracked set |
| 10 | `tests/market/test_massive.py` | Build fixtures with `TickerSnapshot.from_dict({...})` (real wire JSON) instead of `MagicMock` | MagicMock invented `last_trade.timestamp` and hid bug #5 |
| 11 | `PLAN.md` §6 | Update "Free tier: poll every 15 s" to describe EOD mode | Correct the spec (needs the plan owner's sign-off) |

Ticker normalisation (`strip().upper()`, `^[A-Z.]{1,10}$`) happens at the API boundary in the backend service layer, **before** anything reaches the market package. The sources may still defensively uppercase, but they don't validate.

---

## 10. Using It from the App

### 10.1 Lifespan (`PLAN.md` §7 startup sequence)

```python
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

from app.market import PriceCache, create_market_data_source, create_stream_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_dotenv(PROJECT_ROOT / ".env")                         # 1. env (doesn't override Docker vars)
    db = init_database()                                       # 2. schema + seed

    cache = PriceCache()                                       # 3. market data
    source = create_market_data_source(cache)
    tracked = db.watchlist_tickers() | db.position_tickers()
    initial = db.latest_trade_prices(held_only=True)           # {ticker: last fill price}
    await source.start(sorted(tracked), initial_prices=initial)

    app.state.cache, app.state.source, app.state.db = cache, source, db
    record_snapshot(db, cache)                                 # 4. first P&L point
    snapshot_task = asyncio.create_task(snapshot_loop(db, cache))   # 5. every 30 s
    try:
        yield                                                  # 6. serve
    finally:
        snapshot_task.cancel()
        await source.stop()


app = FastAPI(lifespan=lifespan)
```

The SSE router needs the cache when it's created. Either create the cache at module level and pass it to both the lifespan and `create_stream_router(cache)`, or include the router inside the lifespan before `yield`. The first is simpler:

```python
cache = PriceCache()
app = FastAPI(lifespan=lifespan)          # lifespan uses this same `cache`
app.include_router(create_stream_router(cache))
```

### 10.2 Consumers

```python
# Trade execution (PLAN.md §8 step 3)
update = cache.get(ticker)
if update is None:
    raise HTTPException(400, f"No price available for {ticker} yet")
fill_price = update.price

# Portfolio valuation (PLAN.md §7): positions without a price are valued at avg_cost
price = cache.get_price(pos.ticker)
market_value = pos.quantity * (price if price is not None else pos.avg_cost)

# Watchlist response (PLAN.md §8)
u = cache.get(t)
{"ticker": t,
 "price": u.price if u else None,
 "previous_price": u.previous_price if u else None,
 "direction": u.direction if u else None}
```

### 10.3 Concurrency notes

- Every source method is `async` and runs on the event loop. The only off-loop work is the Massive HTTP call (`asyncio.to_thread`). The cache's lock covers that.
- `sync_tracked_tickers()` holds an `asyncio.Lock`, so concurrent trade and chat paths apply their diffs one after another.
- The chat route must not block the loop (`PLAN.md` §9). A blocked loop freezes the simulator and every SSE stream.

---

## 11. Testing the Interface

| Test | How |
|---|---|
| Both sources conform | Parametrised test over `[SimulatorDataSource, MassiveDataSource(mocked client)]`: start → add → remove → get_tickers → stop; `stop()` twice is safe |
| Factory | `monkeypatch.setenv/delenv("MASSIVE_API_KEY")`; whitespace-only key → simulator |
| Snapshot parsing | `TickerSnapshot.from_dict(<JSON from MASSIVE_API.md §4.1>)`: price from `lastTrade.p`, ts = `t / 1e9`; `lastTrade` missing → falls back to `min.c` |
| Mode detection | Client whose `get_snapshot_all` raises `BadResponse('{"status":"NOT_AUTHORIZED",...}')` → `mode == EOD`, cache holds closes from `get_grouped_daily_aggs` |
| EOD add_ticker | After EOD start, `add_ticker("PYPL")` writes PYPL's stored close without calling the client |
| Removed during poll | Remove a ticker between issuing the poll and processing its results → not re-added to the cache |
| Sync | Fake source; `sync_tracked_tickers(src, {"A", "B"})` from `{"B", "C"}` → add A, remove C |
| Initial prices | Simulator `start(["AAPL"], {"AAPL": 123.45})` → `cache.get_price("AAPL") == 123.45` |
| SSE router | `create_stream_router` called twice → two distinct routers, each with one `/prices` route |
