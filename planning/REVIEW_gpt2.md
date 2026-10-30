# Review of `planning/PLAN.md`

Date: 2026-10-29

## Overall assessment

The plan is unusually complete for a capstone specification. It defines the product, API shapes, persistence model, market-data behavior, UI responsibilities, mock mode, and test strategy clearly enough for separate backend and frontend implementations to converge.

The main remaining risks are not missing features; they are contradictions at the boundaries between asynchronous market data, SQLite transactions, automatic watchlist changes, LLM execution, and frontend synchronization. Resolve the high-priority items below before parallel implementation begins.

## High-priority findings

### 1. Require an asynchronous chat route

Section 9 suggests either `litellm.acompletion()` or a synchronous `def` route. These are not equivalent for this application. After inference, the route must call asynchronous market-source methods and may update shared simulator state. Running the entire route in FastAPI's worker thread creates event-loop/thread ownership problems and can also conflict with a SQLite connection created on another thread.

Recommendation:

- Require `async def` for `/api/chat`.
- Call `litellm.acompletion()` under an explicit timeout, such as `asyncio.timeout(LLM_TIMEOUT_SECONDS)`.
- Keep all post-inference trade, watchlist, snapshot, and ticker-sync work on the application event loop.
- Define the SQLite access model: preferably a connection per transaction, or `aiosqlite` with clearly owned connections. Do not share a default `sqlite3` connection across threads.

### 2. Serialize trade execution to prevent overspending and overselling

The plan requires a trade to validate cash or shares and then update several tables atomically, but it does not prevent two concurrent requests from validating against the same old state. Two simultaneous buys could both spend the same cash; two sells could both sell the same shares. A database transaction alone is insufficient if it begins as a deferred SQLite transaction and both requests read before either writes.

Recommendation:

- Put all manual and LLM trades through one trade service.
- Serialize the read-check-write sequence with an application-level `asyncio.Lock` for this single-user application and use one SQLite transaction for cash, position, and trade-log changes.
- Alternatively use `BEGIN IMMEDIATE` plus retry handling for `database is locked`; document whichever rule is chosen.
- Record the post-trade snapshot only after the trade transaction commits. A snapshot failure should not roll back an otherwise valid trade.

Add concurrency tests for two simultaneous buys and two simultaneous sells.

### 3. Auto-adding traded tickers has inconsistent and hidden side effects

Trade rule 2 adds a ticker to the watchlist before price, cash, or holdings validation and applies to both buys and sells. This causes several bugs:

- A failed trade can still mutate the watchlist.
- A sell can re-add a ticker the user deliberately removed, making the documented “sell an unwatched ticker to zero” path impossible.
- A successful manual buy can add a ticker, but the trade response does not include the updated watchlist and the frontend is told not to refetch.
- In Massive mode, a first buy necessarily fails until a price arrives, yet it has already changed persistent state.

Recommendation:

- Auto-add on buys only; an existing position already keeps a sell ticker tracked.
- Define the auto-add as a visible action, not a hidden implementation detail.
- Return the full watchlist from `POST /api/portfolio/trade` whenever it may change.
- For chat, include auto-adds in `actions.watchlist_changes`, even when the subsequent buy cannot execute yet.
- Explicitly decide whether a failed buy should keep the newly added watchlist entry. Either choice is acceptable, but the response and UI must expose it.

### 4. The LLM message cannot truthfully confirm execution

The model produces `message` before server-side actions run, so it cannot know the fill price or whether validation will succeed. The example response says “Done — bought 10 AAPL at $190.52,” which encourages an implementation that can display and later replay a false confirmation.

Recommendation:

- Instruct the model to describe intent, for example “I’ll submit a market buy for 10 AAPL,” rather than claim success.
- Treat server-generated `actions` as the only source of truth for fills and failures.
- Show server-generated execution confirmations in the UI.
- When prior assistant messages are sent back to the LLM, include a compact server-generated summary of their actual outcomes so later replies do not rely on failed actions as facts.
- Make E2E tests assert action outcomes, not model prose.

### 5. Container paths and database persistence are underspecified

The plan says the default `db/finally.db` resolves to `/app/db/finally.db`, but that depends on the Docker `WORKDIR`, copy layout, and how the Python code defines “project root.” A common `COPY backend/ .` layout can cause path calculations based on `__file__` to resolve outside `/app`, silently bypassing the mounted volume. The same ambiguity affects `.env` and static assets.

Recommendation:

- Define the image layout explicitly, for example `/app/backend`, `/app/static`, and `/app/db`.
- Set `DB_PATH=/app/db/finally.db` in the image or start scripts.
- Resolve the local default from a documented anchor, create its parent directory, and log the final path during startup.
- Add a restart acceptance test that makes a trade, recreates the container without deleting the volume, and verifies that state persists.

## Medium-priority findings

### 6. The proposed simulator restart continuity does not preserve the last visible value

Starting a held ticker at its most recent trade price is better than reverting to a seed, but it still resets gains or losses accumulated since that trade. For a position opened with one buy, unrealized P&L often resets to exactly zero after restart.

Recommendation: persist the latest cached price for held tickers periodically and during graceful shutdown. At startup use that value, falling back to the most recent trade price, then the seed. If exact continuity is intentionally out of scope, change the plan's wording so it does not promise it.

### 7. Portfolio history has no frontend update mechanism

The backend writes snapshots every 30 seconds and after trades, but the frontend appears to load history only on startup. The “no refetching after writes” rule means the P&L chart can remain stale indefinitely.

Recommendation: explicitly poll `GET /api/portfolio/history` every 30 seconds and refresh it after successful trade/chat actions, or add snapshot events to an existing stream. Polling is simplest at this scale. A provisional live point may be appended from the frontend's calculated total.

### 8. SSE needs heartbeat and stale-data behavior

In Massive mode, valid price events may be 15 seconds apart, and during market closure timestamps may not advance. Some proxies close quiet streams even when the browser still considers the connection open.

Recommendation:

- Send periodic SSE comment frames such as `: keepalive` independently of price changes.
- Define connection states based on both `EventSource` state and time since the last frame/data update.
- Recreate an `EventSource` that reaches `CLOSED`, using capped backoff.
- Append a chart point only when that ticker's source timestamp advances, so repeated snapshots do not create duplicates.

### 9. Timestamps need deterministic ordering and chart deduplication

UUID primary keys do not provide insertion order, while several rows can share the same second-resolution timestamp: seed watchlist entries, user/assistant messages, multiple chat trades, and post-trade snapshots. `ORDER BY created_at` alone can reverse a user/assistant pair or choose the wrong “latest” trade. Lightweight Charts also expects strictly increasing unique timestamps.

Recommendation:

- Generate UTC timestamps with microsecond precision from one helper.
- Use a stable tie-breaker in queries, such as `ORDER BY created_at, rowid`.
- Deduplicate chart points by normalized timestamp, keeping the last value for a duplicate.
- Add frontend unit tests for equal and out-of-order timestamps.

### 10. Strict validation can discard a useful LLM response because of one bad action

Validating the entire structured response as one strict Pydantic object means one malformed trade can discard the conversational reply and every otherwise valid action.

Recommendation: validate a minimal envelope (`message`, `trades`, and `watchlist_changes`), then normalize and validate each action independently. Convert invalid actions into `actions.errors`; reserve the generic LLM-failure response for an unparseable or invalid envelope. The server's normal trade/watchlist validation still remains authoritative.

### 11. Exact float comparisons can reject “all” trades

Binary floats can make `quantity * price` infinitesimally greater than cash or make a rounded “sell all” quantity slightly greater than the holding. The current `1e-9` deletion threshold does not address values copied from a rounded UI or LLM context.

Recommendation:

- Prefer integer minor units or `Decimal` for cash and execution arithmetic. If retaining `REAL`, define comparison tolerances and clamp a sell within tolerance to the full holding.
- Provide unrounded quantities to the LLM when asking it to close a position.
- Define a display-independent dust threshold and test boundary cases.

### 12. Database initialization is not a schema-evolution strategy

“Create tables if missing” does not add columns, constraints, or indexes to an existing database as development proceeds.

Recommendation: add a small migration mechanism and schema version before the schema begins changing. For this course project, numbered SQL migrations are sufficient; a full migration framework is optional. Also enable and test `PRAGMA foreign_keys = ON`, use `CHECK` constraints for side/action domains where practical, and add indexes for chronological history queries.

### 13. Startup and shutdown ownership need to be explicit

The plan describes startup but not complete cleanup. Reloads and tests can leak the simulator/poller or snapshot task.

Recommendation: make the FastAPI lifespan own all background tasks. On shutdown, signal/cancel and await the snapshot task, then await `source.stop()`, then close database resources. Health/readiness should only report success after database initialization and market-source startup complete.

### 14. Mock parsing rules need exact syntax

Rules such as `add <TICKER>` can accidentally interpret ordinary text (“add some exposure”) as ticker `SOME`, and decimal quantities are unspecified.

Recommendation: publish the exact regular expressions and expected joined message format. Include word boundaries, decimal quantities, normalized uppercase tickers, and the difference between textual match order and the server's execution order. Unit-test multi-action messages and non-command prose.

## Lower-priority clarifications and best practices

- FastAPI request-model constraints normally produce `422`, while the plan requires `400` for quantity, ticker, and side rule violations. Decide whether these are schema errors (`422`) or domain errors (`400`) and make tests match. A clean split is type/shape errors as `422`, domain and account-state violations as `400`.
- Define API precision. Prefer unrounded numeric API values with two-decimal UI formatting. State that an unpriced position uses `avg_cost` for total value and whether its unrealized P&L is `0` or `null`.
- Load `.env` before modules read configuration. Better still, centralize configuration in a settings object created during startup rather than reading environment variables throughout the code.
- The claim that `python-dotenv` is “installed via `uvicorn[standard]`” should not be relied upon as an intentional dependency. Declare packages that application code imports directly in `pyproject.toml`.
- Move `rich` to the development extra as already planned. Add LiteLLM, the chosen SQLite helper, and `python-dotenv` as explicit runtime dependencies when their code is introduced.
- Move `router = APIRouter(...)` inside `create_stream_router()` as planned; the current module-level router can accumulate duplicate routes bound to an earlier cache in tests/app factories.
- Specify static serving precisely: register `/api` routes first, define the copied Next.js output directory, and decide whether unknown non-API paths return `index.html` or 404.
- The first-launch promise conflicts with a required API key and `docker run --env-file .env`. Start scripts should work when `.env` is absent. The app should start with simulator data and show chat as unavailable with setup guidance, or intentionally enable mock chat.
- Add `db/*.db`, SQLite journal/WAL files, frontend build output, and local test artifacts to `.gitignore`. Commit `.env.example`, never `.env`.
- Add structured logs with request/action IDs, but do not log API keys, full prompts, or sensitive environment values.
- Cap or downsample `/api/portfolio/history` eventually. Roughly 2,880 periodic rows per day is fine initially, but an unbounded “all snapshots” response grows indefinitely.

## Additional acceptance tests

Add these to the plan's existing test matrix:

1. Concurrent buys cannot spend the same cash; concurrent sells cannot sell the same shares.
2. A buy of an unwatched ticker returns a synchronized watchlist; a failed buy has the documented watchlist behavior.
3. Removing a held ticker and later selling it to zero does not re-add it.
4. A Massive ticker without a cached price produces the documented response and later becomes tradable.
5. The P&L chart gains new points without a page reload.
6. Duplicate or out-of-order timestamps do not break either chart.
7. SSE heartbeats keep an unchanged stream alive, and reconnects do not duplicate points.
8. Container recreation preserves the database and follows the chosen simulator price-continuity guarantee.
9. Lifespan shutdown leaves no market-data or snapshot tasks running.
10. The production container serves `/`, static assets, API routes, and unknown paths according to the routing contract.
11. The app starts without `.env` and presents the documented degraded chat experience.
12. One malformed LLM action does not discard valid sibling actions or the conversational message.

## Recommended implementation order

1. Resolve the five high-priority contracts and update `PLAN.md`.
2. Implement configuration, migrations, database ownership, and the serialized trade service.
3. Apply the three pending market-data changes and define lifespan cleanup.
4. Implement and contract-test REST/SSE endpoints, including heartbeat and error behavior.
5. Build the frontend against those locked response shapes and synchronization rules.
6. Add deterministic mock chat, then real LiteLLM integration.
7. Finish Docker/start scripts and run the restart, concurrency, and E2E tests from fresh state.

Once these issues are resolved, the plan will be a strong implementation contract rather than only a detailed product specification.
