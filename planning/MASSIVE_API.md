# Massive API Reference (formerly Polygon.io)

Research notes on the Massive REST API for getting **real-time and end-of-day prices for several tickers at once**, as FinAlly uses it. Researched 2026-10-30 against the official docs (`massive.com/docs`), the Massive knowledge base, and the source of the official Python client (`massive-com/client-python`, `master`, plus the `2.2.0` wheel pinned in `backend/uv.lock`).

The design that builds on this is in `MARKET_INTERFACE.md`.

---

## 1. Overview

| Item | Value |
|---|---|
| Base URL | `https://api.massive.com` (the legacy `https://api.polygon.io` still works) |
| Python package | `massive` on PyPI (official). Latest is 2.9.1 (2026-10-26). FinAlly locks **2.2.0**. Requires Python ≥ 3.10 |
| Not this one | `massive-api` on PyPI is an unaffiliated third-party async client |
| Auth | `Authorization: Bearer <key>` header (the client adds it), or `?apiKey=<key>` on raw HTTP calls |
| Env var | `MASSIVE_API_KEY` |
| Client errors | `massive.exceptions.AuthError` (no key), `massive.exceptions.BadResponse` (any non-200) |

```bash
cd backend
uv add massive          # already a dependency
```

### Client construction

```python
import os
from massive import RESTClient

client = RESTClient(api_key=os.environ["MASSIVE_API_KEY"])
```

Defaults, from `massive/rest/__init__.py`:

```python
RESTClient(
    api_key=os.getenv("MASSIVE_API_KEY"),   # see the gotcha below
    connect_timeout=10.0,
    read_timeout=10.0,
    num_pools=10,
    retries=3,                 # urllib3 Retry on 413, 429, 499, 500, 502, 503, 504, backoff 0.1
    base="https://api.massive.com",
    pagination=True,           # list_* methods follow next_url automatically
    verbose=False,
    trace=False,
)
```

> **Gotcha: the default `api_key` is read at import time.** `os.getenv(ENV_KEY)` is a default argument, so it's evaluated when `massive` is imported, not when `RESTClient()` is called. If `.env` is loaded after the import, `RESTClient()` sees `None` and raises `AuthError`. Always pass `api_key=` explicitly.

> **The client is synchronous** (urllib3). From async code, call it with `await asyncio.to_thread(...)` so the event loop isn't blocked.

> **Retries include 429.** On the free tier a rate-limited request is retried 3 times with a short backoff, and each retry is another request against the 5/min budget. Keep the poll interval at or above the budget rather than relying on retries.

---

## 2. Plans, Rate Limits and Data Recency

Access differs **per endpoint and per plan**. This is the most important thing to understand before choosing endpoints.

### Rate limits

From the Massive knowledge base ("What is the request limit for Massive's RESTful APIs?"):

- **Free (Basic) tier: 5 requests per minute**, counted **per asset class** (stocks, options, indices, currencies, futures).
- **Any paid tier: unlimited** for that asset class. A paid Options plan doesn't lift the stocks limit.
- More API keys don't add capacity.
- Exceeding the limit returns **HTTP 429**:
  ```json
  {"status":"ERROR","error":"You've exceeded the maximum requests per minute, please wait or upgrade your subscription to continue. https://massive.com/pricing"}
  ```

### Which endpoints each Stocks plan gets

| Endpoint | Basic ($0) | Starter | Developer | Advanced | Business |
|---|---|---|---|---|---|
| Full market snapshot `/v2/snapshot/.../tickers` | **Not included** | 15-min delayed | 15-min delayed | Real-time | Real-time |
| Single-ticker snapshot | **Not included** | 15-min delayed | 15-min delayed | Real-time | Real-time |
| Unified snapshot `/v3/snapshot` | **Not included** | 15-min delayed | 15-min delayed | Real-time | Real-time |
| Previous day bar `/v2/aggs/ticker/{T}/prev` | End-of-day | 15-min delayed | 15-min delayed | Real-time | Real-time |
| Daily market summary (grouped daily) | End-of-day | 15-min delayed | 15-min delayed | Real-time | Real-time |
| Daily ticker summary (open/close) | End-of-day | 15-min delayed | 15-min delayed | Real-time | Real-time |
| Custom bars (aggregates) | End-of-day | 15-min delayed | 15-min delayed | Real-time | Real-time |
| History depth (aggregates) | 2 years | 5 years | 10 years | All (since 2003-09-10) | All |

**Consequence for FinAlly:** a free key **cannot use the snapshot endpoints at all**. They return HTTP 403 `NOT_AUTHORIZED`. A free key gets only end-of-day data, and the best way to get it for many tickers is the **grouped daily** endpoint (§4.3). `MARKET_INTERFACE.md` designs the Massive source around this.

### End-of-day timing on Basic

From the knowledge base ("On the free Basic plan, when can I pull the previous trading day's data?"):

- A trading day's bars become available **after midnight ET**, once that day is no longer the current day.
- Requesting the current ET day on Basic returns **HTTP 403**:
  ```json
  {"status":"NOT_AUTHORIZED","message":"Your plan doesn't include this data timeframe..."}
  ```
- The 11:00 AM ET availability time in the flat-file docs applies to flat files, not to REST.
- The recommended pattern: request the previous trading day by date, once, rather than polling for it.

### Market sessions (ET)

| Session | Hours |
|---|---|
| Pre-market | 04:00 – 09:30 |
| Regular | 09:30 – 16:00 |
| After-hours | 16:00 – 20:00 |

Snapshot data is **cleared at 3:30 AM ET** and repopulates as exchanges report, from as early as 4:00 AM ET. Between those times, `day` and `min` can be empty. Outside trading hours a snapshot still returns the last trade, so prices sit still (expected, not a bug).

---

## 3. Timestamps

Units differ between endpoints. The docs don't state them, but the sample values and the knowledge base make them clear:

| Field | Unit | Evidence |
|---|---|---|
| Snapshot `lastTrade.t` → SDK `last_trade.sip_timestamp` | **nanoseconds** | 19-digit samples, e.g. `1605192894630916600` |
| Snapshot `lastQuote.t` → SDK `last_quote.sip_timestamp` | nanoseconds | 19 digits |
| Snapshot `updated` → SDK `updated` | nanoseconds | 19 digits |
| Snapshot `min.t` → SDK `min.timestamp` | milliseconds | 13 digits, e.g. `1684428600000` |
| Aggregates `t` (prev, grouped, custom bars) → SDK `timestamp` | milliseconds | KB: "t is in milliseconds: 1792440000000 is 4:00 PM ET on 19 October 2026" |
| Unified snapshot `last_trade.last_updated`, `fmv_last_updated` | nanoseconds | 19 digits |

A robust converter, since the cache wants Unix seconds:

```python
def to_unix_seconds(ts: int | float | None) -> float | None:
    """Massive timestamps are ns (trades/quotes/snapshots) or ms (aggregates)."""
    if not ts:
        return None
    if ts > 1e17:   # nanoseconds
        return ts / 1e9
    if ts > 1e14:   # microseconds (not seen, but cheap to handle)
        return ts / 1e6
    if ts > 1e11:   # milliseconds
        return ts / 1e3
    return float(ts)  # already seconds
```

---

## 4. Endpoints for Multi-Ticker Prices

### 4.1 Full Market Snapshot (real-time / delayed, many tickers, one call)

The primary endpoint for paid plans: **one request returns every requested ticker**.

**REST**: `GET /v2/snapshot/locale/us/markets/stocks/tickers`

| Query param | Type | Default | Notes |
|---|---|---|---|
| `tickers` | comma-separated string | empty = all 10,000+ tickers | **Case-sensitive**, e.g. `AAPL,TSLA,GOOG` |
| `include_otc` | bool | `false` | Include OTC securities |

```bash
curl "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL,MSFT&apiKey=$MASSIVE_API_KEY"
```

**Response** (official sample, one ticker):

```json
{
  "count": 1,
  "status": "OK",
  "tickers": [
    {
      "ticker": "BCAT",
      "day":     {"o": 20.64, "h": 20.64, "l": 20.506, "c": 20.506, "v": 37216, "vw": 20.616, "dv": "37216.0"},
      "lastQuote": {"P": 20.6, "S": 22, "p": 20.5, "s": 13, "t": 1605192959994246100},
      "lastTrade": {"c": [14, 41], "i": "71675577320245", "p": 20.506, "s": 2416, "ds": "2416.0",
                    "t": 1605192894630916600, "x": 4},
      "min":     {"o": 20.506, "h": 20.506, "l": 20.506, "c": 20.506, "v": 5000, "vw": 20.5105,
                  "av": 37216, "n": 1, "t": 1684428600000, "dv": "5000.0", "dav": "37216.0"},
      "prevDay": {"o": 20.79, "h": 21, "l": 20.5, "c": 20.63, "v": 292738, "vw": 20.6939},
      "todaysChange": -0.124,
      "todaysChangePerc": -0.601,
      "updated": 1605192894630916600
    }
  ]
}
```

- `lastTrade` is returned only if the plan includes trades, and `lastQuote` only if it includes quotes. `fmv` is Business-only.
- Tickers Massive doesn't recognise are **left out** of `tickers[]`. There's no per-ticker error.

**Python client**:

```python
from massive import RESTClient
from massive.rest.models import SnapshotMarketType   # STOCKS = "stocks"

client = RESTClient(api_key=api_key)

snapshots = client.get_snapshot_all(
    market_type=SnapshotMarketType.STOCKS,
    tickers=["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA"],   # list or comma string
    include_otc=False,
)

for snap in snapshots:                       # list[TickerSnapshot]
    trade = snap.last_trade                  # LastTrade | None
    print(
        snap.ticker,
        trade.price if trade else None,      # last trade price
        trade.sip_timestamp if trade else None,   # ns
        snap.day.close if snap.day else None,
        snap.prev_day.close if snap.prev_day else None,
        snap.todays_change_percent,
        snap.updated,                        # ns
    )
```

Full signature:

```python
def get_snapshot_all(
    self,
    market_type: Union[str, SnapshotMarketType],
    tickers: Optional[Union[str, List[str]]] = None,
    params: Optional[Dict[str, Any]] = None,
    raw: bool = False,
    include_otc: Optional[bool] = False,
    options: Optional[RequestOptionBuilder] = None,
) -> Union[List[TickerSnapshot], HTTPResponse]
```

**SDK model mapping** (`massive/rest/models/snapshot.py`, `trades.py`, `quotes.py`, `aggs.py`):

| SDK attribute | Wire key | Type |
|---|---|---|
| `TickerSnapshot.ticker` | `ticker` | str |
| `TickerSnapshot.day` | `day` | `Agg` (`open`, `high`, `low`, `close`, `volume`, `vwap`, `timestamp`, `transactions`, `otc`) |
| `TickerSnapshot.prev_day` | `prevDay` | `Agg` |
| `TickerSnapshot.min` | `min` | `MinuteSnapshot` (`open`, `high`, `low`, `close`, `volume`, `vwap`, `accumulated_volume`, `timestamp` (ms), `transactions`) |
| `TickerSnapshot.last_trade` | `lastTrade` | `LastTrade` |
| `TickerSnapshot.last_quote` | `lastQuote` | `LastQuote` |
| `TickerSnapshot.todays_change` | `todaysChange` | float |
| `TickerSnapshot.todays_change_percent` | `todaysChangePerc` | float |
| `TickerSnapshot.updated` | `updated` | int (ns) |
| `TickerSnapshot.fair_market_value` | `fmv` | float (Business) |
| `LastTrade.price` | `p` | float |
| `LastTrade.size` | `s` | float |
| `LastTrade.sip_timestamp` | `t` | int (ns) |
| `LastTrade.participant_timestamp` | `y` | int (ns) |
| `LastTrade.exchange` | `x` | int |
| `LastTrade.conditions` | `c` | list[int] |
| `LastQuote.bid_price` / `ask_price` | `p` / `P` | float |
| `LastQuote.bid_size` / `ask_size` | `s` / `S` | int |
| `LastQuote.sip_timestamp` | `t` | int (ns) |

> **`LastTrade` has no `timestamp` attribute.** The trade time is `sip_timestamp` (nanoseconds). Every attribute is `Optional` and may be `None`.

### 4.2 Single-Ticker Snapshot

**REST**: `GET /v2/snapshot/locale/us/markets/stocks/tickers/{stocksTicker}`. Same plan access and per-ticker shape as §4.1, wrapped as `{"status": "OK", "request_id": "...", "ticker": {...}}`.

```python
snap = client.get_snapshot_ticker(SnapshotMarketType.STOCKS, "AAPL")   # TickerSnapshot
print(snap.last_trade.price, snap.last_quote.bid_price, snap.last_quote.ask_price)
```

Not needed for FinAlly: the full-market snapshot with `tickers=` covers one ticker or many in a single request.

### 4.3 Daily Market Summary / Grouped Daily (end-of-day, all tickers, one call), works on Basic

The best multi-ticker endpoint on the **free** plan: **one request returns the OHLCV bar of every US stock** for a date (~12,000 rows).

**REST**: `GET /v2/aggs/grouped/locale/us/market/stocks/{date}`

| Param | Type | Default | Notes |
|---|---|---|---|
| `date` (path) | `YYYY-MM-DD` | required | The trading day |
| `adjusted` | bool | `true` | Split-adjusted |
| `include_otc` | bool | `false` | |

```bash
curl "https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/2026-10-29?adjusted=true&apiKey=$MASSIVE_API_KEY"
```

```json
{
  "adjusted": true,
  "queryCount": 12638,
  "resultsCount": 12638,
  "status": "OK",
  "results": [
    {"T": "AAPL", "o": 340.775, "h": 346, "l": 340.115, "c": 342.94,
     "v": 34573181.500186, "vw": 343.0361, "n": 670892, "t": 1792440000000}
  ]
}
```

- No ticker filter: you get the whole market and pick out what you need. That's still one request, and it gives a price for **any** ticker the user adds later without another call.
- A weekend or market holiday returns no results (`resultsCount: 0`, and `results` absent).
- The current ET day returns 403 on Basic. Start from yesterday (ET) and walk back.

```python
rows = client.get_grouped_daily_aggs("2026-10-29", adjusted=True)   # list[GroupedDailyAgg]
closes = {r.ticker: r.close for r in rows}
print(closes["AAPL"], closes.get("PYPL"))
```

```python
def get_grouped_daily_aggs(
    self,
    date: Union[str, date],
    adjusted: Optional[bool] = None,
    params: Optional[Dict[str, Any]] = None,
    raw: bool = False,
    locale: str = "us",
    market_type: str = "stocks",
    include_otc: bool = False,
    options: Optional[RequestOptionBuilder] = None,
) -> Union[List[GroupedDailyAgg], HTTPResponse]
```

`GroupedDailyAgg`: `ticker`←`T`, `open`←`o`, `high`←`h`, `low`←`l`, `close`←`c`, `volume`←`v`, `vwap`←`vw`, `timestamp`←`t` (ms), `transactions`←`n`, `otc`.

**Finding the latest available trading day:**

```python
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

def latest_grouped_daily(client, max_lookback_days: int = 7) -> tuple[date, list]:
    """Return (trading_day, rows) for the most recent day the plan can see.

    Starts at yesterday in ET (Basic can't see today), skips weekends without
    a request, and steps back past holidays (empty result).
    """
    day = datetime.now(ET).date() - timedelta(days=1)
    for _ in range(max_lookback_days):
        if day.weekday() < 5:                       # Mon–Fri only
            rows = client.get_grouped_daily_aggs(day.isoformat(), adjusted=True)
            if rows:
                return day, rows
        day -= timedelta(days=1)
    raise RuntimeError("No grouped daily data in the last week")
```

On a paid plan the same endpoint also accepts **today's** date and returns the bar so far (delayed or real-time), but the snapshot is the better tool for live prices there.

### 4.4 Previous Day Bar (per ticker), works on Basic

**REST**: `GET /v2/aggs/ticker/{stocksTicker}/prev?adjusted=true`

```json
{
  "ticker": "AAPL", "adjusted": true, "queryCount": 1, "resultsCount": 1, "status": "OK",
  "request_id": "6a7e466379af0a71039d60cc78e72282",
  "results": [{"T": "AAPL", "o": 115.55, "h": 117.59, "l": 114.13, "c": 115.97,
               "v": 131704427, "vw": 116.3058, "t": 1605042000000}]
}
```

```python
prev = client.get_previous_close_agg("AAPL")
# Returns the deserialised `results` list → [PreviousCloseAgg]
bar = prev[0] if isinstance(prev, list) else prev
print(bar.ticker, bar.close, bar.timestamp)   # timestamp in ms
```

`PreviousCloseAgg`: `ticker`, `open`, `high`, `low`, `close`, `volume`, `vwap`, `timestamp`.

**One request per ticker.** With 10 tickers on Basic (5 req/min) that's 2 minutes of budget, so use grouped daily (§4.3) for many tickers.

### 4.5 Daily Ticker Summary / Open-Close (per ticker, per date), works on Basic

**REST**: `GET /v1/open-close/{stocksTicker}/{date}?adjusted=true`. The response is flat and includes pre-market and after-hours prices:

```json
{"status": "OK", "symbol": "AAPL", "from": "2023-01-09",
 "open": 324.66, "high": 326.2, "low": 322.3, "close": 325.12,
 "volume": 26122646, "preMarket": 324.5, "afterHours": 322.1}
```

```python
oc = client.get_daily_open_close_agg("AAPL", "2023-01-09")   # DailyOpenCloseAgg
print(oc.open, oc.close, oc.pre_market, oc.after_hours)
```

### 4.6 Custom Bars / Aggregates (history for one ticker)

**REST**: `GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}`

- `timespan`: `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`
- `from` / `to`: `YYYY-MM-DD` or Unix ms
- `adjusted` (default true), `sort` (`asc`/`desc`), `limit` (default 5000, max 50000)
- Bars are in ET and include extended hours. No trades in a window means no bar. Paginated via `next_url`.

```python
# Iterator, follows pagination
for bar in client.list_aggs("AAPL", 1, "day", "2026-09-01", "2026-10-29", adjusted=True, sort="asc"):
    print(bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume)

# Or a single page as a list
bars = client.get_aggs("AAPL", 5, "minute", "2026-10-29", "2026-10-29")
```

FinAlly doesn't need history (the charts build from the SSE stream since page load), but this is the endpoint if historical charts are ever added.

### 4.7 Unified Snapshot `/v3/snapshot` (alternative multi-ticker snapshot)

Cross-asset snapshot that takes up to **250 tickers** via `ticker.any_of`, with paginated results (`limit` default 10, max 250). Same plan access as the other snapshots (not on Basic).

```python
for s in client.list_universal_snapshots(
    type="stocks", ticker_any_of=["AAPL", "MSFT", "NOPE"], limit=250
):
    if s.error:                     # unknown tickers come back as error rows
        print(s.ticker, s.error, s.message)    # NOPE NOT_FOUND Ticker not found.
        continue
    print(s.ticker, s.last_trade.price, s.session.previous_close, s.market_status)
```

Its advantage over §4.1 is that unknown tickers are reported explicitly (`"error": "NOT_FOUND"`). Its drawbacks are that `limit` must be set (the default of 10 silently truncates a longer list) and that the model is larger. FinAlly uses §4.1.

### 4.8 Last Trade (per ticker)

**REST**: `GET /v2/last/trade/{stocksTicker}`

```python
t = client.get_last_trade("AAPL")    # LastTrade
print(t.price, t.size, t.sip_timestamp)   # ns
```

One call per ticker. Superseded by the snapshot for our purposes.

---

## 5. Error Handling

| Situation | HTTP | Body | What the SDK does |
|---|---|---|---|
| No API key | — | — | `AuthError` in `RESTClient.__init__` |
| Bad key | 401 | `{"status":"ERROR", ...}` | `BadResponse(body)` |
| Endpoint or timeframe not in plan (snapshot on Basic, today's bars on Basic) | 403 | `{"status":"NOT_AUTHORIZED","message":"..."}` | `BadResponse(body)` |
| Rate limit (Basic, > 5/min) | 429 | `{"status":"ERROR","error":"You've exceeded the maximum requests per minute..."}` | Retried 3× by urllib3, then `BadResponse` |
| Server error | 5xx | — | Retried 3×, then `BadResponse` |
| Unknown ticker in snapshot `tickers=` | 200 | ticker missing from `tickers[]` | Not an error |
| Undecodable JSON | 200 | — | Logged, returns `[]` |

`BadResponse` carries only the **body text** (not the status code), so classify it by content:

```python
from massive.exceptions import BadResponse

def classify(exc: BadResponse) -> str:
    text = str(exc)
    if "NOT_AUTHORIZED" in text:
        return "not_authorized"      # plan lacks this endpoint/timeframe → don't retry
    if "exceeded the maximum requests" in text:
        return "rate_limited"        # back off
    return "other"                   # 401 / 5xx / unknown → log, retry next cycle
```

Per Massive: a 429 on an asset class you pay for is worth reporting (with the `request_id`) rather than retrying, and regenerating the key doesn't help.

---

## 6. Recipes

### 6.1 Live polling (paid plan): snapshot → price cache

```python
import asyncio
import time

from massive import RESTClient
from massive.rest.models import SnapshotMarketType


def snapshot_price(snap) -> tuple[float, float] | None:
    """(price, unix_seconds) from a TickerSnapshot, or None if it has no usable price."""
    trade = snap.last_trade
    if trade and trade.price:
        return trade.price, to_unix_seconds(trade.sip_timestamp) or time.time()
    # Plans without trades, or just after the 03:30 ET reset
    for bar in (snap.min, snap.day, snap.prev_day):
        if bar and bar.close:
            return bar.close, to_unix_seconds(snap.updated) or time.time()
    return None


async def poll_forever(client: RESTClient, tickers: list[str], cache, interval: float = 15.0):
    while True:
        snaps = await asyncio.to_thread(
            client.get_snapshot_all, SnapshotMarketType.STOCKS, tickers
        )
        for snap in snaps:
            got = snapshot_price(snap)
            if got:
                price, ts = got
                cache.update(snap.ticker, price, ts)
        await asyncio.sleep(interval)
```

### 6.2 End-of-day (free plan): grouped daily → price cache

```python
async def load_eod(client: RESTClient, tickers: list[str], cache) -> dict[str, float]:
    day, rows = await asyncio.to_thread(latest_grouped_daily, client)
    closes = {r.ticker: (r.close, r.timestamp / 1000) for r in rows if r.close}
    for t in tickers:
        if t in closes:
            price, ts = closes[t]
            cache.update(t, price, ts)
    return closes   # keep it: later add_ticker() calls look up here, with no new request
```

Refresh it **rarely** (hourly is plenty). The data changes once a day, after midnight ET.

### 6.3 Detecting the plan at startup (one request)

```python
from massive.exceptions import BadResponse

def detect_mode(client: RESTClient, probe: str = "AAPL") -> str:
    try:
        client.get_snapshot_all(SnapshotMarketType.STOCKS, [probe])
        return "realtime"            # Starter+ (15-min delayed) or Advanced+ (real-time)
    except BadResponse as e:
        if "NOT_AUTHORIZED" in str(e):
            return "eod"             # Stocks Basic
        raise                        # bad key, outage, etc.
```

---

## 7. Findings That Affect FinAlly's Existing Code

Checked against `backend/app/market/massive_client.py` and the locked SDK (2.2.0):

1. **`snap.last_trade.timestamp` doesn't exist.** `LastTrade` has `sip_timestamp` (and `participant_timestamp`), so the current code raises `AttributeError` for every snapshot. It's caught and logged as "Skipping snapshot", so **no Massive price ever reaches the cache**. The unit tests miss this because they build snapshots with `MagicMock`, which accepts any attribute. Fix: use `last_trade.sip_timestamp`, which is **nanoseconds** (÷ 1e9, not ÷ 1000), and build test fixtures with the real model classes (`TickerSnapshot.from_dict(...)`).
2. **The free tier can't call the snapshot endpoint.** `PLAN.md` §6 assumes "free tier: poll the snapshot every 15 s". In reality Stocks Basic gets `403 NOT_AUTHORIZED` from every snapshot endpoint and only has end-of-day aggregates. The Massive source needs an end-of-day mode built on grouped daily. See `MARKET_INTERFACE.md`.
3. **`last_trade` can be `None`** on plans without trades, and `day`/`min` can be empty between 03:30 and ~04:00 ET. Fall back through `min.close` → `day.close` → `prev_day.close`.
4. **Pass `api_key` explicitly** (the code already does). The SDK's default is captured at import time.
5. **429 retries burn budget.** The default `retries=3` retries 429s. That's fine for paid plans (no limit). End-of-day mode makes about one request per hour, so it never gets near the limit.

---

## 8. Sources

- [Full Market Snapshot](https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot)
- [Single Ticker Snapshot](https://massive.com/docs/rest/stocks/snapshots/single-ticker-snapshot)
- [Unified Snapshot](https://massive.com/docs/rest/stocks/snapshots/unified-snapshot)
- [Previous Day Bar](https://massive.com/docs/rest/stocks/aggregates/previous-day-bar)
- [Daily Market Summary](https://massive.com/docs/rest/stocks/aggregates/daily-market-summary)
- [Daily Ticker Summary](https://massive.com/docs/rest/stocks/aggregates/daily-ticker-summary)
- [Custom Bars](https://massive.com/docs/rest/stocks/aggregates/custom-bars)
- [KB: request limits](https://massive.com/knowledge-base/article/what-is-the-request-limit-for-massives-restful-apis)
- [KB: previous trading day on Basic](https://massive.com/knowledge-base/article/on-the-free-basic-plan-when-can-i-pull-the-previous-trading-days-data)
- [Python client source](https://github.com/massive-com/client-python) (`massive/rest/{__init__,base,snapshot,aggs,trades}.py`, `massive/rest/models/{snapshot,aggs,trades,quotes,common}.py`)
- [`massive` on PyPI](https://pypi.org/project/massive/)
