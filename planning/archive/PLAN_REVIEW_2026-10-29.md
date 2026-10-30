# PLAN.md Review — 2026-10-29

Full review of PLAN.md (questions Q1–Q30, simplifications S1–S7, findings N1–N3, impact assessment). The adopted decisions have been incorporated into PLAN.md; this file preserves the reasoning.

*Review date: 2026-10-29. Checked against the completed market data code in `backend/app/market/`. Each item has a proposed default so agents can keep working; the project owner should confirm or override them.*

### 13.1 Highest Priority: Missing API Contract

The frontend and backend agents will work in parallel, but the plan lists endpoints without request/response shapes. This will cause integration bugs more than anything else in the plan.

- **Q1. Response shapes.** Add a short JSON example for each endpoint. Proposed shapes:
  - `GET /api/portfolio` → `{cash_balance, total_value, total_unrealized_pnl, positions: [{ticker, quantity, avg_cost, current_price, market_value, unrealized_pnl, unrealized_pnl_percent}]}`
  - `POST /api/portfolio/trade` → `200 {trade: {id, ticker, side, quantity, price, executed_at}, portfolio: <same as GET>}`. Returning the updated portfolio saves the frontend a second request.
  - `GET /api/portfolio/history` → `[{total_value, recorded_at}]`, oldest first
  - `GET /api/watchlist` → `[{ticker, price, previous_price, change_percent, direction}]`. `price` is `null` until the first tick arrives.
  - `POST /api/chat` → `{message, actions: {trades: [...], watchlist_changes: [...], errors: [...]}}`
  - `GET /api/chat/history`: **not in the plan, but needed.** Without it the chat panel is empty after every page reload, even though messages are stored. Proposed: add it, returning the last N messages.
- **Q2. Error format.** Proposed: FastAPI's default `{"detail": "..."}` with `400` for validation failures (insufficient cash or shares, bad quantity), `404` for an unknown ticker on DELETE, and `409` for a duplicate watchlist add (or make the add idempotent and return `200`; this is simpler and probably better).
- **Q3. SSE payload doesn't match the plan.** The plan says "each SSE event contains ticker, price…". The implemented `stream.py` sends **one event per tick holding a dict of every ticker**: `data: {"AAPL": {ticker, price, previous_price, timestamp, change, change_percent, direction}, ...}`. It also only emits when `PriceCache.version` changes. Proposed: update §6 to describe the implemented format, since the code is done and tested.

### 13.2 Data & Domain Logic

- **Q4. What does "daily change %" mean?** No source provides a daily open. `PriceUpdate.change_percent` is the change since the *previous tick*, which is close to zero and useless as a daily figure. Options: (a) change since the seed/session-start price, tracked in the cache or on the frontend from the first SSE price; (b) rename the column to "change since open". Proposed: (a), computed on the frontend from the first price seen. That needs no backend change.
- **Q5. Positions outside the watchlist.** If the user removes AAPL from the watchlist while holding AAPL, `remove_ticker` stops price updates and the position can no longer be valued. Proposed: the market source tracks the **union of watchlist and open positions**. Removing a held ticker from the watchlist keeps it streaming. Selling to zero on a ticker that isn't watched stops it.
- **Q6. Trading a ticker with no price yet.** If a ticker was just added and hasn't ticked, or Massive doesn't recognise it, what happens? Proposed: reject with `400 "No price available for X"`. Also: can you trade a ticker that isn't on the watchlist? Proposed: yes, and auto-add it to the tracked set.
- **Q7. Ticker validation.** The simulator will invent a price for any string, such as `"ASDFG"`. Proposed: normalise to uppercase, require `^[A-Z.]{1,10}$`, and accept anything matching in simulator mode. In Massive mode, reject tickers that return no snapshot after the first poll. What seed price does the simulator use for tickers not in `seed_prices.py`? Document it in this plan.
- **Q8. Trade arithmetic.** Spell out:
  - Buy: `avg_cost = (old_qty*old_avg + qty*price) / (old_qty + qty)`. Sell: `avg_cost` is unchanged.
  - Delete the position row when quantity falls below a small epsilon (e.g. `1e-9`), to avoid floating-point dust like `0.0000000001` shares.
  - `quantity` must be `> 0`. Round cash to cents, or keep full floats and round only for display? Proposed: keep floats and round in the UI.
  - Is realized P&L tracked anywhere? It isn't today. The trades log makes it derivable later. Proposed: out of scope.
- **Q9. Multiple trades in one LLM response.** Run them sequentially, each validated against the state left by the previous one, with partial success allowed. Failures go into `actions.errors`. Confirm this, rather than all-or-nothing.
- **Q10. Where is the live header total computed?** The header shows "portfolio total value (updating live)", but `/api/portfolio` is a snapshot. Proposed: the frontend computes `cash + Σ qty × latest SSE price` on every SSE event and refreshes `/api/portfolio` only after trades and chat actions.
- **Q11. Snapshot details.**
  - Record one snapshot at startup, or the P&L chart is empty for the first 30 seconds.
  - Snapshots every 30s add about 2,900 rows a day. That is fine for SQLite, but should `/api/portfolio/history` downsample, or cap at the last N points?
  - Should the 30s snapshots skip when nothing changed (no positions and no trades)? This is a simplification, not required.

### 13.3 Schema

- **Q12. `users_profile` has no `user_id` column**, which contradicts "all tables include a `user_id` column". Its `id` plays that role. Reword the rule to "all tables except `users_profile`".
- **Q13. UUID text primary keys everywhere.** These work, but `INTEGER PRIMARY KEY AUTOINCREMENT` is simpler, sorts naturally by insertion order, and gives you `ORDER BY id` for free. Low priority; either is fine.
- **Q14. Lazy init "on startup (or first request)": pick one.** Proposed: **startup** (FastAPI lifespan). The market source needs the watchlist at startup anyway, so the database must exist by then. This also removes per-request initialisation checks.
- **Q15. Database path.** The container path is `/app/db/finally.db`. For local runs without Docker, use `DB_PATH` with a default of `<repo>/db/finally.db`, so tests can point at a temp file.

### 13.4 LLM Integration

- **Q16. How much history goes into the prompt?** "Recent conversation history" should be a number. Proposed: last 20 messages.
- **Q17. Failure handling.** Define what `/api/chat` returns when the LLM times out, returns invalid JSON, or `OPENROUTER_API_KEY` is missing. Proposed: return `200` with a friendly `message` explaining the problem and empty actions. Store the user message either way. Never return a 500 to the chat panel.
- **Q18. Mock mode needs a spec.** The E2E test "trade execution appears inline" depends on what the mock returns. Proposed: deterministic keyword rules, for example a message containing `buy N TICKER` returns that trade, `add TICKER` returns a watchlist add, and anything else returns a fixed greeting. Document the rules so the test author and the backend author agree.
- **Q19. Should `actions` stored in `chat_messages` record outcomes or intents?** Proposed: outcomes (executed trades with fill prices, plus errors). That is what the UI shows inline.

### 13.5 Frontend

- **Q20. Charting library.** The plan says "canvas-based… (Lightweight Charts or Recharts)", but Recharts is SVG, not canvas. Neither library draws a treemap well: Lightweight Charts has none, and Recharts has a basic one. Proposed: **Lightweight Charts** for the main chart and the P&L chart, **hand-rolled inline SVG** for sparklines (tiny, no library), and a **simple hand-rolled squarified treemap** for the heatmap (or Recharts `Treemap` if adding a second library is acceptable).
- **Q21. Empty states.** With no positions, the heatmap, positions table and P&L chart are all empty on first launch. Define a placeholder such as "No positions yet — buy something or ask FinAlly".
- **Q22. Sparkline buffer.** Cap the per-ticker history (e.g. last 200 points) so memory doesn't grow forever in a long-open tab. The main chart can use the same buffer, so it also starts empty on page load. Is that acceptable, or should the backend serve recent history? Proposed: accept it. It keeps the backend stateless.

### 13.6 Infrastructure & Repo Hygiene

- **Q23. Directory structure is out of date.** §4 shows `backend/db/` for schema and seed code, but the backend is a package at `backend/app/`. Proposed: `backend/app/db/`, and update §4 to show `backend/app/market/`, which already exists.
- **Q24. Missing repo files.** `db/.gitkeep`, `.env.example`, and a `.gitignore` entry for `db/*.db` do not exist yet. The current `.gitignore` only ignores `db.sqlite3`, so `finally.db` would be committed.
- **Q25. How `.env` is loaded.** The plan names both "backend reads `.env` from project root" and "docker `--env-file`". In Docker, `--env-file` is enough. For local runs, `python-dotenv` is already installed through `uvicorn[standard]` (see `uv.lock`), and the cerebras-inference skill expects `.env` to be loaded into environment variables. Proposed: call `load_dotenv()` on the project-root `.env` at startup. It does nothing when Docker has already set the variables, and needs no new dependency.
- **Q26. Static file serving.** Specify the mount: `StaticFiles(directory="static", html=True)` mounted at `/` *after* all `/api` routers, so it doesn't shadow them. Also confirm the Next.js `trailingSlash`/`basePath` settings. For a single-page export the defaults are fine.
- **Q27. Docker `uv sync` flags.** Use `uv sync --frozen` so the image matches the lockfile. Dev tools are declared as an *extra* (`[project.optional-dependencies].dev`), not a dependency group, so they are already excluded unless `--extra dev` is passed, and `--no-dev` would do nothing.
- **Q28. Minor code issue found during review.** `create_stream_router` in `stream.py` registers its route on a **module-level** `router`. Calling the factory twice, for example from multiple test apps, adds a duplicate `/prices` route bound to the first cache. Move `router = APIRouter(...)` inside the factory.

### 13.7 Testing

- **Q29. E2E state isolation.** The buy and sell scenarios change the persisted state, so test order matters and reruns drift. Options: a fresh volume per E2E run in `docker-compose.test.yml` (simplest), or a test-only `POST /api/reset` gated on `LLM_MOCK=true`. Proposed: a fresh volume, plus tests written so they don't depend on exact cash values from earlier tests.
- **Q30. SSE resilience E2E test.** Simulating a disconnect from Playwright is fiddly (offline mode doesn't always kill an `EventSource` cleanly). Proposed: cover reconnection with a frontend unit test of the status-indicator state machine, and drop it from E2E or make it best-effort.

### 13.8 Opportunities to Simplify

Each item below changes a decision in this plan; none depends on code beyond the existing market data package. They are ordered by impact, highest first.

#### S1. One function owns the set of tracked tickers (Q5) — **High impact**

- **Change:** Define one rule, *tracked tickers = watchlist ∪ tickers with an open position*. One backend function recomputes that set and diffs it against `source.get_tickers()`, calling `add_ticker` or `remove_ticker` as needed. It runs at startup and after every watchlist change or trade, whether it comes from the REST API or the chat.
- **What it removes:** Without this rule, every write path needs its own decision about whether to start or stop a ticker. There are at least five such paths: manual watchlist add and remove, manual trade, and LLM trades and watchlist changes. Getting any one of them wrong produces a position with no price, which breaks the valuation, the heatmap, the snapshots and the LLM context, and is hard to spot in testing.
- **Trade-off:** It adds one helper function. A diff costs nothing at this scale (10–20 tickers).
- **Why it ranks first:** It is the only simplification that also prevents a correctness bug. The others mostly save effort.

#### S2. The frontend computes live values from the SSE stream (Q4, Q10) — **High impact**

- **Change:** The frontend already receives every price every ~500 ms. It computes the header total (`cash + Σ qty × price`), each position's current value and P&L, and the watchlist "change %" against the first price it saw in this session. The backend only provides quantities, average cost and cash, from `/api/portfolio`.
- **What it removes:** The backend would otherwise need either a second SSE stream for portfolio values or frontend polling of `/api/portfolio`. It also removes the need for a "daily open" price, which no data source provides.
- **Trade-off:**
  - The P&L calculation exists twice: the backend still needs it for `/api/portfolio`, snapshots and the LLM context. The formula is one line, so the two copies are unlikely to drift, but both should round the same way.
  - "Change %" resets when the page reloads. That is a weaker meaning than a true daily change, and the UI label should say so (for example "Session %").

#### S3. Write endpoints return the updated portfolio (Q1) — **Medium impact**

- **Change:** `POST /api/portfolio/trade` returns the new portfolio state alongside the trade. Extend the same idea to `POST /api/chat`, which should return the portfolio and watchlist whenever actions ran.
- **What it removes:** The frontend's "after X, refetch Y" logic, which is especially awkward after chat because the frontend can't easily tell which actions happened. It also removes a window where the UI shows stale cash for one round trip.
- **Trade-off:** Responses get larger, and the endpoints become coupled to the portfolio format. Both costs are small with a single user.
- **Why it ranks here:** The payoff is mostly in the chat flow. That is where refetch bugs would show up, and it is the core demo.

#### S4. Frontend unit tests cover pure logic only — **Medium impact (effort)**

- **Change:** Replace the frontend unit-test list in §12 with tests of plain functions: portfolio calculations (S2), the flash trigger (did the price go up or down), the treemap layout, and the connection-status state machine. Rendering and interaction (chat messages, watchlist add and remove) are left to the existing E2E scenarios.
- **What it removes:** The heaviest part of frontend test setup: React Testing Library, a DOM test environment, and mocks for `EventSource`, `fetch` and canvas charts. Lightweight Charts in particular is awkward to render in a test DOM. Plain-function tests only need a test runner.
- **Trade-off:** Less component-level coverage, so layout regressions are caught later, by E2E, or not at all.
- **Why it ranks here:** It saves a lot of agent time without touching what the user sees. The risk is low because the E2E scenarios already cover these flows.

#### S5. Initialise the database at startup only (Q14) — **Medium-low impact**

- **Change:** Create tables and seed data in the FastAPI lifespan handler, before the market source starts. Drop "or first request" from §7.
- **What it removes:** Per-request "is the database ready?" checks, and a race where two concurrent first requests both try to seed. It also settles the ordering: the market source needs the seeded watchlist at startup anyway, so the database must exist by then.
- **Trade-off:** None in practice. The plan's no-migration, zero-setup behaviour stays the same.

#### S6. Idempotent watchlist writes (Q2) — **Low-medium impact**

- **Change:** `POST /api/watchlist` for a ticker already on the list returns `200` with no change, and `DELETE` for a ticker not on the list also returns `200`.
- **What it removes:** Two error branches on the backend, two error states on the frontend, and, most usefully, noise in the LLM flow. The model will sometimes "add" a ticker that is already watched. With strict errors, that shows up as a failure in the chat even though the user got what they wanted.
- **Trade-off:** A typo'd delete fails silently. That doesn't matter here, because the UI only offers delete on rows that exist.

#### S7. Move `rich` to the dev extra — **Low impact**

- **Change:** `rich` is listed as a core dependency in `backend/pyproject.toml` but is only imported by `market_data_demo.py`. Move it to `[project.optional-dependencies].dev`.
- **What it removes:** A few MB (`rich` plus `pygments`) from the production image, and an unused runtime dependency.
- **Trade-off:** The demo needs `uv sync --extra dev` first. It is a one-line change.


#### Comparison

| # | Simplification | Effort saved | Bugs prevented | Who benefits | Downside |
|---|---|---|---|---|---|
| S1 | One function owns tracked tickers | Medium | **High**: positions without prices | Backend, LLM flow | One extra helper |
| S2 | Frontend computes live values | **High**: no portfolio stream or polling | Medium | Backend, Frontend | P&L math in two places; session-based change % |
| S3 | Write endpoints return the portfolio | Medium | Medium: stale UI after chat | Frontend, chat UX | Larger responses |
| S4 | Pure-logic frontend tests | **High**: test setup | Low | Frontend | Less component coverage |
| S5 | Database init at startup only | Low | Low–Medium: seed race, ordering | Backend | None |
| S6 | Idempotent watchlist writes | Low | Low–Medium: false chat errors | All layers, LLM flow | Silent no-op on a typo |
| S7 | `rich` to the dev extra | Trivial | None | Docker image | Demo needs the dev extra |

**Recommendation:** Adopt S1–S6 into the main plan before backend and frontend work starts, because they settle contracts that both agents depend on. Apply S7 whenever convenient.

### 13.9 Second-Pass Findings

These came from checking Q1–Q30 against the market data code and the cerebras-inference skill. They are new issues, not repeats.

#### N1. Prices reset on every restart, so P&L jumps — **Medium-high impact**

- **Finding:** `GBMSimulator` always starts from `SEED_PRICES`. Tickers that aren't seeded get `random.uniform(50, 300)` (`simulator.py`, `_add_ticker_internal`). Prices move noticeably within a session: GBM drift is about ±0.6% per hour, and each ticker gets a 2–5% shock roughly every 8 minutes. After a container restart, every position is revalued at its seed price, or at a new random price for unseeded tickers. The result is a sudden jump in unrealized P&L and a cliff in the P&L chart. This works against the main reason for the persistent volume.
- **Proposed:** At startup, start each held ticker at its most recent trade price, which the `trades` table already stores, so no new table is needed. This needs a small optional argument on the finished market code, such as `start(tickers, initial_prices=None)`. The Massive source ignores it. The alternative is to accept the jump and document it.
- **Verdict:** Adopt. The change is small, and P&L that survives a restart is an explicit feature.

#### N2. A synchronous LLM call freezes the price stream — **High impact, trivial fix**

- **Finding:** The cerebras-inference skill uses LiteLLM's synchronous `completion()`. Calling it from an `async def` route blocks the event loop for the whole LLM call. That stops the simulator task and every SSE stream, so prices freeze for 1–3 seconds, which is exactly when the user is watching the AI trade.
- **Proposed:** In §9, require either a plain `def` chat route, which FastAPI runs in a threadpool, or `litellm.acompletion()`. The same rule applies to other blocking work in async routes, although SQLite calls are fast enough not to matter.
- **Verdict:** Adopt. The fix is one word, but the bug is very visible.

#### N3. Optional fields in the structured-output model — **Medium impact**

- **Finding:** §9 marks `trades` and `watchlist_changes` as optional. With a Pydantic `response_format`, strict JSON-schema modes usually require every property to be listed as `required`, so optional or defaulted fields can be rejected on the first call or silently left out.
- **Proposed:** Declare both as required lists that may be empty. Check this on the first real call to the model.
- **Verdict:** Adopt. It costs nothing and prevents a confusing first failure.

### 13.10 Impact Assessment of Q1–Q30

**Verdicts:**
- **Adopt:** worth a change in the main plan before development starts.
- **Covered:** handled by a simplification in §13.8.
- **Implementer:** a detail the implementing agent will settle naturally, so it isn't worth a plan change.
- **Drop:** not worth doing.
- **Resolved:** already decided.

**Adopt: high impact.** These set contracts that both agents, or the tests, depend on. Getting them wrong causes integration bugs.

| Q | Change | Impact |
|---|---|---|
| Q1 | Request/response shapes for every endpoint, plus `GET /api/chat/history` | **High.** This is the main contract between the parallel agents, and without the history endpoint the chat is lost on reload. |
| Q3 | Update §6 to describe the SSE format that is actually implemented | **High.** A frontend built from the current §6 text would parse the stream wrongly. |
| Q17 | `/api/chat` never returns a 500; failures come back as a friendly message | **High.** Chat is the core demo, and a missing key or LLM timeout would otherwise break the panel. |
| Q18 | Fixed keyword rules for mock-mode responses | **High.** The AI-chat E2E scenario can't be written until these exist. |

**Adopt: medium impact.** These are small rules that prevent subtle bugs.

| Q | Change | Impact |
|---|---|---|
| Q2 | `400` with `{"detail"}` for validation failures (watchlist writes are idempotent, per S6) | Medium. Gives one way to handle errors on the frontend and in chat. |
| Q8 | Average-cost formula, epsilon for closing a position, quantity `> 0` | Medium. Prevents floating-point "dust" positions and wrong average cost. |
| Q9 | LLM trades run sequentially, with partial success allowed | Medium. This is what a simple implementation does anyway, and writing it down keeps the UI and tests consistent. |
| Q15 | `DB_PATH` environment variable, defaulting to `db/finally.db` | Medium. Backend tests need a temporary database, and without this they share the real one. |
| Q20 | Lightweight Charts for the main and P&L charts, hand-rolled SVG for sparklines and the treemap | Medium. The plan's "canvas… or Recharts" is self-contradictory, and neither library draws a good treemap. |
| Q23 | Fix §4 so schema and seed code live in `backend/app/db/`, not `backend/db/` | Medium. The current text would send an agent to the wrong folder. |
| Q29 | Fresh volume per E2E run; tests don't depend on exact cash values | Medium. Prevents flaky, order-dependent E2E runs. |

**Adopt: low impact.** Mostly one line each in the plan.

| Q | Change | Impact |
|---|---|---|
| Q6 | Reject trades on tickers with no price yet | Low in simulator mode, because `add_ticker` seeds the cache immediately. Medium in Massive mode, where a new ticker has no price for up to 15 seconds. |
| Q7 | Uppercase tickers and check them against `^[A-Z.]{1,10}$` | Low on its own; mostly matters together with N1. Drop the "reject after first Massive poll" part, which needs async handling: an unpriced ticker shows "—", and Q6 blocks trades on it. |
| Q11 (startup snapshot only) | Record one snapshot at startup | Low-medium. Without it the P&L chart is empty for the first 30 seconds. |
| Q12 | Reword "all tables include `user_id`" to exclude `users_profile` | Low. Stops an agent adding a redundant column. |
| Q16 | Send the last 20 messages as conversation history | Low. It's a single constant. |
| Q19 | `actions` stores outcomes (fills and errors), not intents | Low-medium. This is what the inline chat confirmations display. |
| Q22 (cap only) | Keep at most about 200 points per ticker on the frontend; the main chart starting empty on load is acceptable | Low. Without the cap, an open tab accumulates about 72,000 points per hour. |
| Q25 | Call `load_dotenv()` at startup (corrected above) | Low. Local runs just work, with no new dependency. |
| Q28 | Move `router = APIRouter(...)` inside `create_stream_router` | Low. No current test creates the router twice, so nothing breaks today, but it is a two-line fix. Do it when the API layer is built. |
| Q30 | Test reconnection as a frontend unit test of the status state machine, not in E2E | Low-medium. Avoids a flaky E2E test. |

**Covered by §13.8:**

| Q | Covered by |
|---|---|
| Q4 | S2. `models.py` confirms that `change_percent` is the change since the previous tick. |
| Q5 | S1 |
| Q10 | S2 |
| Q14 | S5 |

**Implementer, drop or resolved:**

| Q | Verdict | Reason |
|---|---|---|
| Q11 (downsampling, skip unchanged snapshots) | Drop | About 2,900 rows a day is trivial for SQLite and for Lightweight Charts. |
| Q13 | Resolved | Keep UUIDs; the integer-key simplification (S8) was removed. |
| Q21 | Implementer | Empty-state wording is a UI detail the frontend agent will handle. |
| Q24 | Drop | `db/.gitkeep` and `.env.example` are already planned in §4. The only real gap, adding `db/*.db` to `.gitignore`, belongs with the database work. |
| Q26 | Implementer | Mounting the static files after the API routes is standard, and the mistake shows up immediately as a 404 on `/api/*`. |
| Q27 | Implementer | Corrected above: plain `uv sync --frozen` is enough. |

**Summary:** 4 high-impact and 7 medium-impact changes are worth writing into the main plan now, together with N1–N3 and S1–S6. The low-impact rules can go in as one-line notes. The six items in the last table need no plan change.
