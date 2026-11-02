"""Shared application state handed to routes and services."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from fastapi import Request

from app.db import Database
from app.market import MarketDataSource, PriceCache


@dataclass
class AppContext:
    db: Database
    cache: PriceCache
    source: MarketDataSource
    # Serialises every state mutation (trades, watchlist edits, tracked-ticker sync)
    # so validation and writes never interleave across concurrent requests.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def get_context(request: Request) -> AppContext:
    """FastAPI dependency: the AppContext created in the lifespan."""
    return request.app.state.ctx
