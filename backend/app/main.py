"""FastAPI application: lifespan startup sequence, routes and static frontend.

Run from backend/:  uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import config
from app.api import router as api_router
from app.context import AppContext
from app.db import Database
from app.market import PriceCache, create_market_data_source, create_stream_router
from app.portfolio import record_snapshot
from app.tickers import compute_tracked_tickers

logger = logging.getLogger(__name__)


async def _snapshot_loop(ctx: AppContext, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            record_snapshot(ctx.db, ctx.cache)
        except Exception:
            logger.exception("Portfolio snapshot failed")


def create_app(load_env: bool = True) -> FastAPI:
    """Build the app. `load_env=False` skips reading the project .env (used by tests)."""
    cache = PriceCache()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # 1. Load .env (variables already set, e.g. by Docker, take precedence)
        if load_env:
            load_dotenv(config.ENV_FILE, override=False)

        # 2. Initialise and seed the database
        db = Database(config.get_db_path())
        db.initialize()

        # 3. Start market data for the tracked tickers, held ones at their last trade price
        source = create_market_data_source(cache)
        tickers = compute_tracked_tickers(db)
        held = [p["ticker"] for p in db.get_positions()]
        await source.start(tickers, initial_prices=db.latest_trade_prices(held))

        ctx = AppContext(db=db, cache=cache, source=source)
        app.state.ctx = ctx

        # 4. One snapshot so the P&L chart has a starting point; 5. the 30 s task
        record_snapshot(db, cache)
        snapshot_task = asyncio.create_task(
            _snapshot_loop(ctx, config.SNAPSHOT_INTERVAL_SECONDS), name="portfolio-snapshots"
        )
        logger.info("FinAlly backend ready (db=%s, %d tickers)", db.path, len(tickers))

        # 6. Serve requests
        try:
            yield
        finally:
            snapshot_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await snapshot_task
            await source.stop()
            db.close()

    app = FastAPI(title="FinAlly", lifespan=lifespan)

    # Local dev only: the Next.js dev server on :3000 calling the API on :8000.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router)
    app.include_router(create_stream_router(cache))

    # Static frontend last, so /api routes take precedence. Skipped if not built.
    static_dir = config.get_static_dir()
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    else:
        logger.warning("Static directory %s not found; serving API only", static_dir)

    return app


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
app = create_app()
