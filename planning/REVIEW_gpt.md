# Review of `planning/PLAN.md`

## Overall assessment

The plan is detailed, coherent, and close to implementation-ready. It defines the product, major interfaces, response shapes, lifecycle, and testing approach much better than a typical project plan. The existing market-data code also supports most of the assumptions made in the document.

Before parallel implementation begins, the issues below should be resolved in the plan. The first five are contract gaps that could cause independently built frontend and backend components to disagree or produce incorrect state.

## Blocking issues

### 1. A failed first-time trade can mutate state without telling the frontend

Section 8 says a trade for a ticker not on the watchlist first adds the ticker, then rejects with `400` when no price is available. This is expected in Massive mode until the next poll. The response is only FastAPI's `{"detail": "..."}`, while the frontend is told not to refetch after writes.

The result is a successful watchlist mutation hidden behind a failed trade response. The same ambiguity affects chat: an implicitly added ticker may be the only state change even though the requested trade failed.

Choose and document one contract:

- Make trade execution atomic and do not retain the implicit watchlist addition when the trade fails. This requires another mechanism to obtain a first Massive price.
- Treat first-time Massive trades as a pending workflow, with a distinct response and a later retry.
- Keep the addition, but return the updated watchlist in the error/result shape and count it as an executed watchlist change in chat.

Add API and E2E coverage for this exact case.

### 2. The P&L chart has no ongoing update path

The backend records snapshots every 30 seconds, but the frontend only has a documented `GET /api/portfolio/history`; snapshots are not part of SSE, and write responses do not include history. The instruction not to refetch after writes does not explain how the chart sees newly recorded snapshots.

Specify one approach:

- poll `/api/portfolio/history` on a defined interval;
- add a separate snapshot SSE event/stream; or
- append client-computed points while the page is open and reconcile with persisted history on reload.

Also add a history limit or time-range query. Returning every 30-second snapshot forever makes both the SQLite file and the initial frontend payload grow without bound.

### 3. Concurrent trades are not protected by a stated serialization rule

“Update cash, the position and the trades log in one transaction” is necessary but not sufficient. Two requests can both validate against the same cash or share balance before either commits, allowing overspending or overselling. Chat actions and manual trades can also overlap.

Define a single trade service with a process-level async lock or a SQLite transaction mode that acquires the write lock before reading balances (for example, `BEGIN IMMEDIATE`), with bounded busy timeout/retry behavior. All manual and LLM trades must use it. Add concurrent buy and concurrent sell tests.

### 4. “Price continuity across restarts” is overstated

Starting a held ticker at its most recent trade price avoids returning to the original seed, but it does not preserve the last simulated price. If a ticker moves substantially after its last trade, restart still produces a discontinuity and changes unrealized P&L.

Either rename this behavior to “restart fallback price” and document the limitation, or persist the latest simulated prices periodically/on shutdown and restore those values at startup. A persisted cache is the only option that provides actual continuity after an unclean restart.

### 5. The LLM implementation depends on an unavailable agent skill

Section 9 requires a `cerebras-inference` skill, but that skill is not present in this workspace's available skill set. The application contract should not depend on a particular coding agent having an external skill installed.

Replace the skill requirement with a self-contained implementation contract: exact LiteLLM model/provider arguments, Pydantic response model, strict-schema settings, timeout behavior, and mock behavior. Add direct runtime dependencies such as `litellm` to `backend/pyproject.toml`; do not rely on undeclared transitive dependencies. Pin or constrain the model/provider configuration through normal application config so it can be changed without editing business logic.

## Important clarifications

### Docker persistence is described in two incompatible ways

Section 11 uses a named volume (`finally-data:/app/db`) but then says the repository's `db/` directory maps to `/app/db`. A named volume is Docker-managed and does not map the project directory. Choose either the named volume and remove the host-directory claim, or use a bind mount such as `./db:/app/db`. Make the start scripts and Compose file use the same choice.

### First-run configuration conflicts with the promised experience

The vision promises a single command and immediate AI chat, while `OPENROUTER_API_KEY` is required and `docker run --env-file .env` fails when `.env` does not exist. Define first-run behavior explicitly. A good default is to start successfully without `.env`, use simulator market data, and put chat in a clear unavailable or mock state with setup guidance. Start scripts should not require a missing file.

### SSE needs keepalives and an explicit client state machine

In Massive mode there may be no data event for roughly 15 seconds, and there is currently no documented heartbeat. Add periodic SSE comment frames (for example, `: keepalive`) so proxies do not close an otherwise healthy stream.

Also define connection-state transitions rather than relying only on `EventSource.readyState`: recoverable failures generally leave it in `CONNECTING`, while `CLOSED` commonly means the client was explicitly closed. State when yellow becomes red, whether a stale-data timeout is used, and how retries reset the state.

### Database evolution and integrity need a policy

“Create missing tables” is not a migration strategy: it cannot add or alter columns as the schema changes during development. Add a schema version and migrations, or explicitly state that incompatible development databases are discarded and reseeded. The latter is simpler but must be reflected in scripts and documentation.

Consider database-level `CHECK` constraints for sides and positive quantities, foreign keys or an explicit reason not to use them, and indexes for the chronological queries on trades, chat messages, and snapshots. For a trading demo, also decide whether binary `REAL` arithmetic is accepted or whether money is represented as integer cents/`Decimal`.

### Startup and shutdown ownership should be explicit

The FastAPI lifespan should own and cleanly stop the market source and the 30-second snapshot task. Specify cancellation and awaited shutdown so reloads/tests do not leak background tasks. Also state what happens if database initialization or the initial market-data start fails: the health endpoint should not report ready until required startup work succeeds.

### Static serving needs a precise fallback rule

Document that `/api/*` routes take precedence over static files, which directory from the Next.js export is copied, and whether unknown non-API paths fall back to `index.html` or return 404. Even a nominal single-page export needs this defined to avoid backend and frontend routing assumptions diverging.

## Testing gaps to add

In addition to the listed tests, add acceptance coverage for:

1. Two simultaneous buys cannot spend the same cash, and two simultaneous sells cannot sell the same shares.
2. A first-time Massive ticker trade with no cached price produces the documented watchlist/result state.
3. Portfolio history gains a visible point after 30 seconds without reloading the page.
4. Restart behavior matches the chosen continuity/fallback claim.
5. SSE sends keepalives during unchanged prices and reconnects without duplicating client points.
6. FastAPI lifespan shutdown leaves no market or snapshot background task running.
7. The app starts without `.env` and presents the documented degraded chat experience.
8. The production container serves `/`, static assets, API routes, and unknown paths according to the chosen routing rule.

## Recommended implementation order

1. Resolve the five blocking contracts above and update `PLAN.md`.
2. Implement database initialization/migration policy and the serialized trade service.
3. Integrate the existing market subsystem and make its three pending changes.
4. Implement REST/SSE endpoints, including lifecycle and keepalives, then lock response schemas with backend tests.
5. Build the frontend against those tested contracts.
6. Add mock-chat integration, then real LiteLLM integration.
7. Finish Docker/start scripts and run the full E2E suite from a fresh volume.

With those changes, the plan will be a strong shared contract for parallel agent implementation rather than only a thorough product specification.
