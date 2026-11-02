"""Watchlist operations (PLAN.md §8)."""

from __future__ import annotations

from typing import Any

from app.context import AppContext
from app.db import Database
from app.market import PriceCache
from app.tickers import normalize_ticker, sync_tracked_tickers


def build_watchlist(db: Database, cache: PriceCache) -> list[dict[str, Any]]:
    """Full watchlist in insertion order, with the latest cached price (or nulls)."""
    result = []
    for ticker in db.get_watchlist_tickers():
        update = cache.get(ticker)
        result.append(
            {
                "ticker": ticker,
                "price": update.price if update else None,
                "previous_price": update.previous_price if update else None,
                "direction": update.direction if update else None,
            }
        )
    return result


async def add_ticker_unlocked(ctx: AppContext, ticker: str) -> bool:
    """Add an already-normalised ticker and re-sync tracking. Caller holds ctx.lock."""
    added = ctx.db.add_watchlist_ticker(ticker)
    await sync_tracked_tickers(ctx.db, ctx.source)
    return added


async def add_to_watchlist(ctx: AppContext, raw_ticker: str) -> str:
    """Validate and add a ticker (idempotent). Returns the normalised ticker.

    Raises InvalidTickerError for a bad symbol.
    """
    ticker = normalize_ticker(raw_ticker)
    async with ctx.lock:
        await add_ticker_unlocked(ctx, ticker)
    return ticker


async def remove_from_watchlist(ctx: AppContext, raw_ticker: str) -> str:
    """Validate and remove a ticker (idempotent). Held tickers keep streaming.

    Raises InvalidTickerError for a bad symbol.
    """
    ticker = normalize_ticker(raw_ticker)
    async with ctx.lock:
        ctx.db.remove_watchlist_ticker(ticker)
        await sync_tracked_tickers(ctx.db, ctx.source)
    return ticker
