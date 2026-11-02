"""API routes against the full app (simulator, temp DB via DB_PATH, LLM_MOCK=true)."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

PORTFOLIO_KEYS = {"cash_balance", "total_value", "total_unrealized_pnl", "positions"}


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_fresh_start(client):
    p = client.get("/api/portfolio").json()
    assert p == {
        "cash_balance": 10000.0,
        "total_value": 10000.0,
        "total_unrealized_pnl": 0.0,
        "positions": [],
    }
    wl = client.get("/api/watchlist").json()
    assert [w["ticker"] for w in wl] == [
        "AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX",
    ]
    assert all(isinstance(w["price"], float) for w in wl)
    assert set(wl[0]) == {"ticker", "price", "previous_price", "direction"}
    history = client.get("/api/portfolio/history").json()
    assert len(history) == 1  # startup snapshot
    assert history[0]["total_value"] == 10000.0
    assert history[0]["recorded_at"].endswith("Z")
    assert client.get("/api/chat/history").json() == []


def test_buy_and_sell(client):
    r = client.post("/api/portfolio/trade", json={"ticker": "aapl", "quantity": 2, "side": "buy"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"trade", "portfolio"}
    assert set(body["trade"]) == {"id", "ticker", "side", "quantity", "price", "executed_at"}
    assert set(body["portfolio"]) == PORTFOLIO_KEYS
    price = body["trade"]["price"]
    assert body["portfolio"]["cash_balance"] == pytest.approx(10000 - 2 * price, abs=0.01)
    assert body["portfolio"]["positions"][0]["ticker"] == "AAPL"

    r = client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 2, "side": "sell"})
    assert r.status_code == 200
    assert r.json()["portfolio"]["positions"] == []
    assert len(client.get("/api/portfolio/history").json()) == 3  # startup + 2 trades


@pytest.mark.parametrize(
    "payload,fragment",
    [
        ({"ticker": "AAPL1", "quantity": 1, "side": "buy"}, "Invalid ticker"),
        ({"ticker": "AAPL", "quantity": 0, "side": "buy"}, "greater than 0"),
        ({"ticker": "AAPL", "quantity": -3, "side": "buy"}, "greater than 0"),
        ({"ticker": "AAPL", "quantity": 1, "side": "hold"}, "Unknown side"),
        ({"ticker": "AAPL", "quantity": 1000, "side": "buy"}, "Insufficient cash"),
        ({"ticker": "AAPL", "quantity": 1, "side": "sell"}, "Insufficient shares"),
    ],
)
def test_trade_rule_violations_are_400(client, payload, fragment):
    r = client.post("/api/portfolio/trade", json=payload)
    assert r.status_code == 400
    assert fragment in r.json()["detail"]


def test_malformed_trade_is_422(client):
    assert client.post("/api/portfolio/trade", json={"ticker": "AAPL"}).status_code == 422
    r = client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": "x", "side": "buy"})
    assert r.status_code == 422


def test_watchlist_add_remove(client):
    r = client.post("/api/watchlist", json={"ticker": " pypl "})
    assert r.status_code == 200
    wl = r.json()
    assert wl[-1]["ticker"] == "PYPL"
    assert isinstance(wl[-1]["price"], float)  # simulator prices new tickers immediately

    again = client.post("/api/watchlist", json={"ticker": "PYPL"})
    assert again.status_code == 200 and len(again.json()) == len(wl)

    r = client.delete("/api/watchlist/pypl")
    assert r.status_code == 200
    assert "PYPL" not in [w["ticker"] for w in r.json()]
    r2 = client.delete("/api/watchlist/PYPL")
    assert r2.status_code == 200 and r2.json() == r.json()


def test_watchlist_invalid(client):
    assert client.post("/api/watchlist", json={"ticker": "N0PE"}).status_code == 400
    assert client.delete("/api/watchlist/N0PE").status_code == 400
    assert client.post("/api/watchlist", json={}).status_code == 422


def test_chat_mock_buy(client):
    r = client.post("/api/chat", json={"message": "buy 1 AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"message", "actions", "portfolio", "watchlist"}
    assert body["message"] == "Mock: buy 1 AAPL"
    assert body["actions"]["trades"][0]["ticker"] == "AAPL"
    assert body["actions"]["errors"] == []
    assert body["portfolio"]["positions"][0]["quantity"] == 1
    assert body["watchlist"][0]["ticker"] == "AAPL"

    history = client.get("/api/chat/history").json()
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert set(history[0]) == {"id", "role", "content", "actions", "created_at"}
    assert history[1]["actions"] == body["actions"]


def test_chat_without_key_returns_200(app_env, monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "false")
    with TestClient(create_app(load_env=False)) as c:
        r = c.post("/api/chat", json={"message": "buy 1 AAPL"})
        assert r.status_code == 200
        body = r.json()
        assert "OPENROUTER_API_KEY" in body["message"]
        assert body["portfolio"] is None and body["watchlist"] is None
        assert c.get("/api/portfolio").json()["positions"] == []


def test_sse_stream_route_is_mounted(client):
    paths = {route.path for route in client.app.routes}
    assert "/api/stream/prices" in paths


def test_static_served_when_present(app_env, monkeypatch):
    static = app_env / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>FinAlly</html>")
    monkeypatch.setenv("STATIC_DIR", str(static))
    with TestClient(create_app(load_env=False)) as c:
        assert "FinAlly" in c.get("/").text
        assert c.get("/api/health").json() == {"status": "ok"}


def test_price_continuity_and_persistence_across_restart(app_env):
    with TestClient(create_app(load_env=False)) as c:
        trade = c.post(
            "/api/portfolio/trade", json={"ticker": "PYPL", "quantity": 3, "side": "buy"}
        ).json()["trade"]
        c.delete("/api/watchlist/PYPL")  # held but unwatched

    with TestClient(create_app(load_env=False)) as c:
        p = c.get("/api/portfolio").json()
        pos = p["positions"][0]
        assert pos["ticker"] == "PYPL" and pos["quantity"] == 3
        # Simulator restarts the held ticker at its last trade price (one tick may have run)
        assert pos["current_price"] == pytest.approx(trade["price"], rel=0.01)
        assert "PYPL" not in [w["ticker"] for w in c.get("/api/watchlist").json()]
        assert len(c.get("/api/portfolio/history").json()) == 3  # 2 startups + 1 trade
