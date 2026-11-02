"""Pytest configuration and fixtures."""

from __future__ import annotations

import pytest

from app.context import AppContext
from app.db import Database
from app.market import MarketDataSource, PriceCache


@pytest.fixture
def event_loop_policy():
    """Use the default event loop policy for all async tests."""
    import asyncio

    return asyncio.DefaultEventLoopPolicy()


class FakeSource(MarketDataSource):
    """Deterministic market data source: fixed prices from a dict, no background task.

    Tickers missing from `prices` never get a price (like Massive before a poll).
    """

    def __init__(self, cache: PriceCache, prices: dict[str, float]) -> None:
        self.cache = cache
        self.prices = prices
        self.tickers: list[str] = []
        self.initial_prices: dict[str, float] | None = None

    async def start(self, tickers, initial_prices=None):
        self.initial_prices = initial_prices
        for t in tickers:
            await self.add_ticker(t)

    async def stop(self):
        pass

    async def add_ticker(self, ticker):
        if ticker not in self.tickers:
            self.tickers.append(ticker)
            if ticker in self.prices:
                self.cache.update(ticker, self.prices[ticker])

    async def remove_ticker(self, ticker):
        if ticker in self.tickers:
            self.tickers.remove(ticker)
        self.cache.remove(ticker)

    def get_tickers(self):
        return list(self.tickers)

    def set_price(self, ticker: str, price: float) -> None:
        self.prices[ticker] = price
        if ticker in self.tickers:
            self.cache.update(ticker, price)


DEFAULT_TEST_PRICES = {
    "AAPL": 100.0,
    "GOOGL": 175.0,
    "MSFT": 420.0,
    "AMZN": 185.0,
    "TSLA": 250.0,
    "NVDA": 800.0,
    "META": 500.0,
    "JPM": 195.0,
    "V": 280.0,
    "NFLX": 600.0,
    "PYPL": 60.0,
}


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "test.db")
    database.initialize()
    yield database
    database.close()


@pytest.fixture
async def ctx(db):
    """AppContext over a temp DB and a FakeSource tracking the seeded watchlist."""
    from app.tickers import sync_tracked_tickers

    cache = PriceCache()
    source = FakeSource(cache, dict(DEFAULT_TEST_PRICES))
    context = AppContext(db=db, cache=cache, source=source)
    await sync_tracked_tickers(db, source)
    return context


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """Environment for a full app: temp DB, simulator, mock LLM, no static dir."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setenv("STATIC_DIR", str(tmp_path / "no-static"))
    monkeypatch.setenv("LLM_MOCK", "true")
    monkeypatch.delenv("MASSIVE_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    return tmp_path


@pytest.fixture
def client(app_env):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(load_env=False)) as test_client:
        yield test_client
