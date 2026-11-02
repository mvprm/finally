"""Ticker symbol validation and tracked-ticker synchronisation (PLAN.md §6)."""

from __future__ import annotations

import logging
import re

from app.db import Database
from app.market import MarketDataSource

logger = logging.getLogger(__name__)

TICKER_RE = re.compile(r"^[A-Z.]{1,10}$")


class InvalidTickerError(ValueError):
    """Raised for a ticker symbol that fails validation (-> HTTP 400)."""


def normalize_ticker(raw: str) -> str:
    """Uppercase and strip whitespace; must match ^[A-Z.]{1,10}$."""
    ticker = "".join(str(raw).split()).upper()
    if not TICKER_RE.fullmatch(ticker):
        raise InvalidTickerError(f"Invalid ticker symbol: {raw!r}")
    return ticker


def compute_tracked_tickers(db: Database) -> list[str]:
    """tracked tickers = watchlist ∪ tickers with an open position (watchlist order first)."""
    tickers = db.get_watchlist_tickers()
    seen = set(tickers)
    for pos in db.get_positions():
        if pos["ticker"] not in seen:
            tickers.append(pos["ticker"])
            seen.add(pos["ticker"])
    return tickers


async def sync_tracked_tickers(db: Database, source: MarketDataSource) -> None:
    """Diff the desired tracked set against the source and add/remove the difference.

    This is the only code that calls source.add_ticker / source.remove_ticker.
    """
    desired = compute_tracked_tickers(db)
    current = set(source.get_tickers())
    desired_set = set(desired)
    for ticker in desired:
        if ticker not in current:
            await source.add_ticker(ticker)
    for ticker in current - desired_set:
        await source.remove_ticker(ticker)
    if desired_set != current:
        logger.info("Tracked tickers: %s", ", ".join(desired))
