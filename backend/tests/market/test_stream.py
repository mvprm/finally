"""Tests for the SSE streaming module."""

import json
from unittest.mock import MagicMock

import pytest

from app.market.cache import PriceCache
from app.market.stream import _generate_events, create_stream_router

DATA_PREFIX = "data: "


def _request(disconnect_after: int) -> MagicMock:
    """Fake Request whose is_disconnected() turns True after N checks."""
    calls = {"n": 0}

    async def is_disconnected() -> bool:
        calls["n"] += 1
        return calls["n"] > disconnect_after

    request = MagicMock()
    request.client.host = "127.0.0.1"
    request.is_disconnected = is_disconnected
    return request


async def _collect(cache: PriceCache, request: MagicMock) -> list[str]:
    return [chunk async for chunk in _generate_events(cache, request, interval=0.001)]


def _data_events(events: list[str]) -> list[dict]:
    return [json.loads(e[len(DATA_PREFIX):]) for e in events if e.startswith(DATA_PREFIX)]


class TestGenerateEvents:
    @pytest.mark.asyncio
    async def test_first_message_is_retry(self):
        events = await _collect(PriceCache(), _request(disconnect_after=0))
        assert events == ["retry: 1000\n\n"]

    @pytest.mark.asyncio
    async def test_emits_all_tickers_in_one_event(self):
        cache = PriceCache()
        cache.update("AAPL", 190.0)
        cache.update("GOOGL", 175.0)

        events = await _collect(cache, _request(disconnect_after=1))

        assert len(events) == 2
        assert events[1].endswith("\n\n")
        payload = _data_events(events)[0]
        assert set(payload) == {"AAPL", "GOOGL"}
        assert payload["AAPL"]["price"] == 190.0
        assert payload["AAPL"]["ticker"] == "AAPL"

    @pytest.mark.asyncio
    async def test_no_event_when_unchanged(self):
        cache = PriceCache()
        cache.update("AAPL", 190.0)

        # Several loop iterations, but the cache version never changes
        events = await _collect(cache, _request(disconnect_after=5))

        assert len(_data_events(events)) == 1

    @pytest.mark.asyncio
    async def test_no_event_when_cache_empty(self):
        events = await _collect(PriceCache(), _request(disconnect_after=3))
        assert events == ["retry: 1000\n\n"]

    @pytest.mark.asyncio
    async def test_new_event_after_price_change(self):
        cache = PriceCache()
        cache.update("AAPL", 190.0)

        events = []
        async for chunk in _generate_events(cache, _request(disconnect_after=4), interval=0.001):
            events.append(chunk)
            if len(events) == 2:
                cache.update("AAPL", 191.0)

        data = _data_events(events)
        assert [d["AAPL"]["price"] for d in data] == [190.0, 191.0]
        assert data[1]["AAPL"]["direction"] == "up"

    @pytest.mark.asyncio
    async def test_missing_client_info(self):
        request = _request(disconnect_after=0)
        request.client = None
        events = await _collect(PriceCache(), request)
        assert events == ["retry: 1000\n\n"]


class TestCreateStreamRouter:
    def test_route_registered(self):
        router = create_stream_router(PriceCache())
        assert [r.path for r in router.routes] == ["/api/stream/prices"]

    def test_factory_returns_independent_routers(self):
        r1 = create_stream_router(PriceCache())
        r2 = create_stream_router(PriceCache())
        assert r1 is not r2
        assert len(r1.routes) == 1
        assert len(r2.routes) == 1

    @pytest.mark.asyncio
    async def test_endpoint_response_headers(self):
        router = create_stream_router(PriceCache())
        endpoint = router.routes[0].endpoint

        response = await endpoint(_request(disconnect_after=0))

        assert response.media_type == "text/event-stream"
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["x-accel-buffering"] == "no"
