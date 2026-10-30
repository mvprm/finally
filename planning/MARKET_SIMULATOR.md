# Market Simulator: Approach and Code Structure

How FinAlly simulates live stock prices when no `MASSIVE_API_KEY` is set. The simulator is the **default** data source: no network, no key, no rate limits, and prices that move every 500 ms so the UI looks alive.

It implements the `MarketDataSource` contract in `MARKET_INTERFACE.md` and writes only to the shared `PriceCache`. Code: `backend/app/market/simulator.py` and `backend/app/market/seed_prices.py`.

---

## 1. Goals

| Goal | How |
|---|---|
| Looks like a real market | Geometric Brownian Motion: log-normal, always-positive prices, % moves that scale with price |
| Tickers move together | Sector correlation through a Cholesky-factored correlation matrix |
| Some drama | Rare random 2–5 % "events" on a single ticker |
| Realistic starting prices | Seed table (AAPL ≈ $190, NVDA ≈ $800, …) |
| No P&L jumps after restart | Held tickers resume at their last trade price (`initial_prices`) |
| Any symbol works | Unknown tickers get a random $50–$300 start and default parameters |
| Cheap | One vectorised normal draw per tick; n < 50 tickers |

---

## 2. The Model: Geometric Brownian Motion

Each tick, every price evolves by the exact GBM solution:

```
S(t + dt) = S(t) · exp( (μ − σ²/2)·dt + σ·√dt·Z )
```

| Symbol | Meaning | Source |
|---|---|---|
| `S(t)` | current price (kept **unrounded** internally) | |
| `μ` | annualised drift | `TICKER_PARAMS[t]["mu"]`, default 0.05 |
| `σ` | annualised volatility | `TICKER_PARAMS[t]["sigma"]`, default 0.25 |
| `dt` | tick length as a fraction of a trading year | `0.5 / (252 × 6.5 × 3600)` ≈ 8.48 × 10⁻⁸ |
| `Z` | standard normal, **correlated** across tickers (§3) | |

Why GBM:

- The exponential keeps prices **strictly positive**.
- Returns, not dollar amounts, are normally distributed, so a $800 stock moves more dollars than a $50 one, as in real markets.
- The `−σ²/2` term (Itô correction) makes the *expected* price grow at exactly μ.

### The clock: wall time = trading time

`dt` treats each 500 ms of wall time as 500 ms of **trading** time (a year = 252 days × 6.5 h). So the app produces realistic intraday volatility in real time:

| Ticker | σ | 1σ move per tick | 1σ over 1 hour | 1σ over 6.5 h (one "day") |
|---|---|---|---|---|
| JPM | 0.18 | 0.0052 % | 0.44 % | 1.13 % |
| AAPL | 0.22 | 0.0064 % (≈ $0.012) | 0.54 % | 1.39 % |
| TSLA | 0.50 | 0.0146 % (≈ $0.036) | 1.24 % | 3.15 % |

(Per tick: σ·√dt. Over N ticks: × √N. One hour = 7,200 ticks.)

Because the cache rounds to cents, low-volatility stocks sometimes tick "flat". That's expected and keeps the flash animations from strobing.

The drift is negligible at this timescale (μ·dt ≈ 4 × 10⁻⁹ per tick). It exists for correctness, not for show.

---

## 3. Correlated Moves

Real stocks in a sector move together. The simulator builds an `n × n` correlation matrix `C` from sector membership, factors it once with Cholesky (`C = L·Lᵀ`), and every tick turns independent normals into correlated ones:

```
z_independent ~ N(0, I)          # n draws
z_correlated  = L @ z_independent  # now Cov(z) = C
```

### Correlation rules (`_pairwise_correlation`)

Checked in this order:

| Pair | ρ | Constant |
|---|---|---|
| Either ticker is TSLA | 0.3 | `TSLA_CORR` (TSLA is in the tech set but "does its own thing") |
| Both in tech `{AAPL, GOOGL, MSFT, AMZN, META, NVDA, NFLX}` | 0.6 | `INTRA_TECH_CORR` |
| Both in finance `{JPM, V}` | 0.5 | `INTRA_FINANCE_CORR` |
| Anything else (cross-sector, unknown tickers) | 0.3 | `CROSS_GROUP_CORR` |

The diagonal is 1.0. With these values the matrix is positive definite for any mix of tickers. This was checked numerically with the 10 defaults plus 40 unknown tickers (n = 50). Adding sectors later: keep every ρ in [0, 1) and intra-group ρ ≥ cross-group ρ to stay PD. A defensive fallback (catch `np.linalg.LinAlgError` and use independent draws) costs one `try`.

### When the matrix is rebuilt

On every `add_ticker` / `remove_ticker` (O(n²) build + O(n³) Cholesky, microseconds at n < 50). The constructor adds all starting tickers first and rebuilds **once**. With n ≤ 1 there's nothing to correlate, so `_cholesky = None` and raw draws are used.

---

## 4. Random Events

After the GBM step, each ticker independently has `event_probability` (default **0.001**) of a shock:

```python
if random.random() < self._event_prob:
    shock = random.uniform(0.02, 0.05) * random.choice([-1, 1])
    self._prices[ticker] *= 1 + shock
```

With 10 tickers at 2 ticks/s, that's 10 × 2 × 0.001 = 0.02 events/s, or **about one every 50 seconds** somewhere on the board. Events are uncorrelated (one stock's news) and permanent: the walk continues from the new level. They're logged at DEBUG.

---

## 5. Starting Prices and Continuity

The starting price of a ticker is chosen in this order:

1. **`initial_prices[ticker]`**, passed to `start()`. The backend passes each **held** ticker's most recent trade price from the `trades` table (`PLAN.md` §6 "Price Continuity"). Without this, unrealized P&L would jump on every container restart.
2. **`SEED_PRICES[ticker]`**, a realistic snapshot for the 10 default tickers.
3. **`random.uniform(50, 300)`**, for any other valid symbol (`PLAN.md` §6: "Simulator mode accepts any valid symbol").

Parameters come from `TICKER_PARAMS[ticker]` or `DEFAULT_PARAMS` (`σ = 0.25, μ = 0.05`). A copy is stored per ticker, so changes to one ticker never touch the shared default.

`initial_prices` only matters at startup: every held ticker is tracked from startup onward, so a later `add_ticker` is always a new or re-added ticker and gets a seed or random price. A ticker removed and added again restarts from its seed or a new random price. That's acceptable, because a held ticker is never removed (positions keep it tracked).

### Required change (pending in `PLAN.md` §6)

```python
class GBMSimulator:
    def __init__(
        self,
        tickers: list[str],
        dt: float = DEFAULT_DT,
        event_probability: float = 0.001,
        initial_prices: dict[str, float] | None = None,
    ) -> None:
        self._initial_prices = dict(initial_prices or {})
        ...

    def _add_ticker_internal(self, ticker: str) -> None:
        if ticker in self._prices:
            return
        self._tickers.append(ticker)
        self._prices[ticker] = self._starting_price(ticker)
        self._params[ticker] = TICKER_PARAMS.get(ticker, dict(DEFAULT_PARAMS))

    def _starting_price(self, ticker: str) -> float:
        start = self._initial_prices.get(ticker)
        if start is not None and start > 0:
            return start
        if ticker in SEED_PRICES:
            return SEED_PRICES[ticker]
        return random.uniform(50.0, 300.0)
```

```python
class SimulatorDataSource(MarketDataSource):
    async def start(self, tickers, initial_prices=None) -> None:
        self._sim = GBMSimulator(
            tickers=tickers,
            event_probability=self._event_prob,
            initial_prices=initial_prices,
        )
        ...  # unchanged: seed the cache, start the loop
```

---

## 6. Code Structure

### 6.1 Two layers

```
SimulatorDataSource (async, implements MarketDataSource)
│   owns: PriceCache reference, asyncio.Task, update_interval
│   job:  lifecycle + "every 0.5 s: step → write cache"
│
└── GBMSimulator (pure, synchronous, no I/O)
        owns: tickers, unrounded prices, params, Cholesky factor
        job:  the math: step(), add/remove, correlation
```

Keeping the math in a plain synchronous class means it's unit-testable with no event loop or cache, and reusable (the Rich demo `market_data_demo.py` drives it directly).

### 6.2 `GBMSimulator` API

```python
class GBMSimulator:
    TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600      # 5,896,800
    DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR      # ≈ 8.48e-8

    def __init__(self, tickers, dt=DEFAULT_DT, event_probability=0.001,
                 initial_prices=None) -> None
    def step(self) -> dict[str, float]          # advance one tick → {ticker: price rounded to 2 dp}
    def add_ticker(self, ticker: str) -> None   # no-op if present; rebuilds Cholesky
    def remove_ticker(self, ticker: str) -> None  # no-op if absent; rebuilds Cholesky
    def get_price(self, ticker: str) -> float | None   # unrounded current price
    def get_tickers(self) -> list[str]

    # internals
    def _add_ticker_internal(self, ticker) -> None   # add without a Cholesky rebuild (batch init)
    def _starting_price(self, ticker) -> float       # §5
    def _rebuild_cholesky(self) -> None
    @staticmethod
    def _pairwise_correlation(t1, t2) -> float
```

`step()`, the hot path:

```python
def step(self) -> dict[str, float]:
    n = len(self._tickers)
    if n == 0:
        return {}
    z = np.random.standard_normal(n)
    if self._cholesky is not None:
        z = self._cholesky @ z
    out = {}
    for i, t in enumerate(self._tickers):
        mu, sigma = self._params[t]["mu"], self._params[t]["sigma"]
        self._prices[t] *= math.exp((mu - 0.5 * sigma**2) * self._dt
                                    + sigma * math.sqrt(self._dt) * z[i])
        if random.random() < self._event_prob:             # §4
            self._prices[t] *= 1 + random.uniform(0.02, 0.05) * random.choice([-1, 1])
        out[t] = round(self._prices[t], 2)
    return out
```

Internal prices stay unrounded so rounding error never compounds. Only the returned and cached values are rounded.

### 6.3 `SimulatorDataSource`

```python
class SimulatorDataSource(MarketDataSource):
    def __init__(self, price_cache: PriceCache,
                 update_interval: float = 0.5, event_probability: float = 0.001) -> None

    async def start(self, tickers, initial_prices=None) -> None:
        # build GBMSimulator, write every starting price to the cache
        # (so SSE and trades have data immediately), then start the loop task
    async def stop(self) -> None:          # cancel + await the task; idempotent
    async def add_ticker(self, ticker) -> None:
        # sim.add_ticker, then write its starting price to the cache immediately,
        # so a trade on a new ticker can fill straight away (PLAN.md §8 step 2)
    async def remove_ticker(self, ticker) -> None:   # sim.remove_ticker + cache.remove
    def get_tickers(self) -> list[str]

    async def _run_loop(self) -> None:
        while True:
            try:
                for t, p in self._sim.step().items():
                    self._cache.update(ticker=t, price=p)
            except Exception:
                logger.exception("Simulator step failed")   # never let one bad tick kill the feed
            await asyncio.sleep(self._interval)
```

Everything runs on the event loop with no threads. `step()` for 50 tickers takes microseconds, so it never meaningfully blocks. `add_ticker` / `remove_ticker` mutate the simulator between ticks. There's no `await` inside `step()`, so a tick can't see a half-applied change.

### 6.4 `seed_prices.py`: all tunables in one place

```python
SEED_PRICES: dict[str, float]               # AAPL 190, GOOGL 175, MSFT 420, AMZN 185, TSLA 250,
                                            # NVDA 800, META 500, JPM 195, V 280, NFLX 600
TICKER_PARAMS: dict[str, dict[str, float]]  # per-ticker {"sigma", "mu"}
DEFAULT_PARAMS = {"sigma": 0.25, "mu": 0.05}
CORRELATION_GROUPS = {"tech": {...}, "finance": {"JPM", "V"}}
INTRA_TECH_CORR = 0.6
INTRA_FINANCE_CORR = 0.5
CROSS_GROUP_CORR = 0.3
TSLA_CORR = 0.3
```

| Ticker | σ | μ | Character |
|---|---|---|---|
| AAPL | 0.22 | 0.05 | steady large-cap |
| GOOGL | 0.25 | 0.05 | |
| MSFT | 0.20 | 0.05 | steady large-cap |
| AMZN | 0.28 | 0.05 | |
| TSLA | 0.50 | 0.03 | very volatile, weakly correlated |
| NVDA | 0.40 | 0.08 | volatile, strong drift |
| META | 0.30 | 0.05 | |
| JPM | 0.18 | 0.04 | bank, calm |
| V | 0.17 | 0.04 | payments, calmest |
| NFLX | 0.35 | 0.05 | |

To add a sector (e.g. energy), add a group to `CORRELATION_GROUPS`, a constant, and one branch in `_pairwise_correlation`.

---

## 7. Lifecycle Walkthrough

```
lifespan startup
 └─ source = SimulatorDataSource(cache)
 └─ await source.start(["AAPL", …, "PYPL"], initial_prices={"AAPL": 187.12})
       ├─ GBMSimulator: AAPL ← 187.12 (held), GOOGL ← 175.00 (seed), PYPL ← 143.80 (random)
       ├─ Cholesky built once for n tickers
       ├─ cache.update(...) for each ticker  → SSE has data on first connect
       └─ create_task(_run_loop)

every 0.5 s: step() → cache.update × n → cache.version bumps → SSE sends one event

user adds "COIN" → sync_tracked_tickers → source.add_ticker("COIN")
       └─ random start price, Cholesky rebuilt, cache written immediately

user sells all PYPL (not on watchlist) → sync → source.remove_ticker("PYPL")
       └─ removed from sim, Cholesky rebuilt, cache.remove("PYPL")

shutdown → await source.stop()   (task cancelled; no further cache writes)
```

---

## 8. Testing

Existing suite: `backend/tests/market/test_simulator.py` (GBMSimulator) and `test_simulator_source.py` (async integration). What to cover, including the new behaviour:

| Area | Test |
|---|---|
| Positivity | 10,000 steps, every price > 0 |
| Rounding | `step()` values have ≤ 2 dp; `get_price()` stays unrounded |
| GBM statistics | With events off (`event_probability=0`) and a large `dt`, the mean of log-returns ≈ (μ − σ²/2)·dt and the std ≈ σ·√dt (tolerance-based) |
| Correlation | Events off, many steps: sample correlation of AAPL/MSFT log-returns ≈ 0.6, AAPL/JPM ≈ 0.3, TSLA/AAPL ≈ 0.3 (±0.05) |
| Cholesky | Rebuilt on add/remove; `None` for n ≤ 1; PD for 50 mixed tickers |
| Events | `event_probability=1.0` → every tick moves ≥ 2 % |
| Unknown ticker | Start in [50, 300], params == `DEFAULT_PARAMS`, and mutating them doesn't change `DEFAULT_PARAMS` |
| **Initial prices** | `GBMSimulator(["AAPL", "ZZZ"], initial_prices={"AAPL": 123.45, "ZZZ": 77.0})` → `get_price` returns those values; tickers missing from the dict fall back to seed or random; non-positive values are ignored |
| **Source passes them through** | `await SimulatorDataSource(cache).start(["AAPL"], {"AAPL": 123.45})` → `cache.get_price("AAPL") == 123.45` before the first tick |
| Source lifecycle | start → cache warm; add → priced immediately; remove → gone from cache; stop twice OK; no writes after stop |
| Loop resilience | A `step()` that raises once is logged and the loop keeps running |

For flaky-free statistical tests, seed the global generators in a fixture (`np.random.seed(…)`, `random.seed(…)`). Optionally, inject `np.random.Generator` / `random.Random` instances into `GBMSimulator` to remove global state entirely. That's a small refactor and not required.

---

## 9. Non-Goals

- No order book, bid/ask spread, volume or market hours. The simulated market never closes.
- No mean reversion or regime switching. GBM is enough for a convincing demo.
- No history replay. Charts build from the SSE stream since page load (`PLAN.md` §10).
- No persistence of simulator state other than the continuity rule in §5.
