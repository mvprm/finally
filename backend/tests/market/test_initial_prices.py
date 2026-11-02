"""start(tickers, initial_prices) — price continuity across restarts (PLAN.md §6)."""

from unittest.mock import MagicMock, patch

import pytest

from app.market.cache import PriceCache
from app.market.massive_client import MassiveDataSource
from app.market.seed_prices import SEED_PRICES
from app.market.simulator import GBMSimulator, SimulatorDataSource


def test_gbm_uses_initial_prices_over_seeds():
    sim = GBMSimulator(["AAPL", "GOOGL", "ZZZ"], initial_prices={"AAPL": 123.45, "ZZZ": 9.5})
    assert sim.get_price("AAPL") == 123.45
    assert sim.get_price("ZZZ") == 9.5
    assert sim.get_price("GOOGL") == SEED_PRICES["GOOGL"]


def test_gbm_ignores_non_positive_initial_price():
    sim = GBMSimulator(["AAPL"], initial_prices={"AAPL": 0})
    assert sim.get_price("AAPL") == SEED_PRICES["AAPL"]


@pytest.mark.asyncio
async def test_simulator_source_seeds_cache_with_initial_prices():
    cache = PriceCache()
    source = SimulatorDataSource(price_cache=cache, update_interval=10)
    await source.start(["AAPL", "MSFT"], initial_prices={"AAPL": 150.0})
    assert cache.get_price("AAPL") == 150.0
    assert cache.get_price("MSFT") == SEED_PRICES["MSFT"]
    await source.stop()


@pytest.mark.asyncio
async def test_simulator_start_without_initial_prices_still_works():
    cache = PriceCache()
    source = SimulatorDataSource(price_cache=cache, update_interval=10)
    await source.start(["AAPL"])
    assert cache.get_price("AAPL") == SEED_PRICES["AAPL"]
    await source.stop()


@pytest.mark.asyncio
async def test_massive_ignores_initial_prices():
    cache = PriceCache()
    source = MassiveDataSource(api_key="k", price_cache=cache, poll_interval=60)
    with patch("app.market.massive_client.RESTClient", return_value=MagicMock()):
        with patch.object(source, "_fetch_snapshots", return_value=[]):
            await source.start(["AAPL"], initial_prices={"AAPL": 1.0})
    assert cache.get("AAPL") is None
    assert source.get_tickers() == ["AAPL"]
    await source.stop()
