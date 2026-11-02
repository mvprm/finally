"""Trade execution, valuation, tracked tickers and snapshots (service level, fixed prices)."""

import pytest

from app.portfolio import (
    TradeError,
    build_portfolio,
    execute_trade,
    format_quantity,
    total_value,
)
from app.tickers import InvalidTickerError, compute_tracked_tickers, normalize_ticker
from app.watchlist import add_to_watchlist, build_watchlist, remove_from_watchlist


class TestNormalizeTicker:
    @pytest.mark.parametrize("raw,expected", [("aapl", "AAPL"), (" brk.b ", "BRK.B"), ("V", "V")])
    def test_valid(self, raw, expected):
        assert normalize_ticker(raw) == expected

    @pytest.mark.parametrize("raw", ["", "   ", "AAPL1", "TOOLONGTICK", "AA-PL", "$$"])
    def test_invalid(self, raw):
        with pytest.raises(InvalidTickerError):
            normalize_ticker(raw)


@pytest.mark.parametrize(
    "qty,expected",
    [(1000000, "1,000,000"), (1e6, "1,000,000"), (2.0, "2"), (0.5, "0.5"),
     (1234.25, "1,234.25"), (0.19999999999999998, "0.2"), (1e-12, "0")],
)
def test_format_quantity(qty, expected):
    assert format_quantity(qty) == expected


class TestQuantityInErrors:
    async def test_large_sell_has_no_scientific_notation(self, ctx):
        await execute_trade(ctx, "AAPL", 0.5, "buy")
        with pytest.raises(TradeError) as err:
            await execute_trade(ctx, "AAPL", 1000000, "sell")
        assert str(err.value) == "Insufficient shares: you hold 0.5 AAPL, tried to sell 1,000,000"

    async def test_large_buy_has_no_scientific_notation(self, ctx):
        with pytest.raises(TradeError) as err:
            await execute_trade(ctx, "AAPL", 1000000, "buy")
        assert "to buy 1,000,000 AAPL" in str(err.value)
        assert "e+" not in str(err.value)


class TestBuy:
    async def test_buy_updates_cash_position_trade_and_snapshot(self, ctx):
        trade = await execute_trade(ctx, "aapl", 10, "buy")
        assert trade["ticker"] == "AAPL" and trade["price"] == 100.0 and trade["side"] == "buy"
        assert trade["executed_at"].endswith("Z")
        assert ctx.db.get_cash() == pytest.approx(9000.0)
        assert ctx.db.get_position("AAPL") == {"ticker": "AAPL", "quantity": 10, "avg_cost": 100.0}
        assert len(ctx.db.get_snapshots()) == 1

    async def test_average_cost(self, ctx):
        await execute_trade(ctx, "AAPL", 10, "buy")
        ctx.source.set_price("AAPL", 130.0)
        await execute_trade(ctx, "AAPL", 5, "buy")
        pos = ctx.db.get_position("AAPL")
        assert pos["quantity"] == 15
        assert pos["avg_cost"] == pytest.approx((10 * 100 + 5 * 130) / 15)

    async def test_fractional(self, ctx):
        await execute_trade(ctx, "AAPL", 0.5, "buy")
        assert ctx.db.get_cash() == pytest.approx(9950.0)

    async def test_insufficient_cash(self, ctx):
        with pytest.raises(TradeError, match="Insufficient cash"):
            await execute_trade(ctx, "NVDA", 13, "buy")  # 10,400 > 10,000
        assert ctx.db.get_cash() == 10000.0
        assert ctx.db.get_positions() == []

    async def test_exact_cash_allowed(self, ctx):
        await execute_trade(ctx, "AAPL", 100, "buy")
        assert ctx.db.get_cash() == pytest.approx(0.0)

    async def test_unwatched_ticker_added_to_watchlist_and_tracked(self, ctx):
        await execute_trade(ctx, "PYPL", 1, "buy")
        assert ctx.db.get_watchlist_tickers()[-1] == "PYPL"
        assert "PYPL" in ctx.source.get_tickers()

    async def test_no_price_rejected_ticker_stays_on_watchlist(self, ctx):
        with pytest.raises(TradeError, match="No price available for ZZZ yet"):
            await execute_trade(ctx, "ZZZ", 1, "buy")
        assert "ZZZ" in ctx.db.get_watchlist_tickers()
        assert ctx.db.get_cash() == 10000.0
        # Retry works once a price arrives
        ctx.source.set_price("ZZZ", 10.0)
        await execute_trade(ctx, "ZZZ", 1, "buy")

    @pytest.mark.parametrize("qty", [0, -1, float("nan"), float("inf"), "abc"])
    async def test_bad_quantity(self, ctx, qty):
        with pytest.raises(TradeError):
            await execute_trade(ctx, "AAPL", qty, "buy")

    async def test_bad_side(self, ctx):
        with pytest.raises(TradeError, match="Unknown side"):
            await execute_trade(ctx, "AAPL", 1, "short")

    async def test_bad_ticker(self, ctx):
        with pytest.raises(InvalidTickerError):
            await execute_trade(ctx, "AAPL1", 1, "buy")
        assert "AAPL1" not in ctx.db.get_watchlist_tickers()


class TestSell:
    async def test_partial_sell_keeps_avg_cost(self, ctx):
        await execute_trade(ctx, "AAPL", 10, "buy")
        ctx.source.set_price("AAPL", 120.0)
        trade = await execute_trade(ctx, "AAPL", 4, "sell")
        assert trade["price"] == 120.0
        assert ctx.db.get_position("AAPL") == {"ticker": "AAPL", "quantity": 6, "avg_cost": 100.0}
        assert ctx.db.get_cash() == pytest.approx(9000 + 480)

    async def test_sell_at_loss(self, ctx):
        await execute_trade(ctx, "AAPL", 10, "buy")
        ctx.source.set_price("AAPL", 80.0)
        await execute_trade(ctx, "AAPL", 10, "sell")
        assert ctx.db.get_cash() == pytest.approx(9800.0)
        assert ctx.db.get_position("AAPL") is None

    async def test_sell_more_than_owned(self, ctx):
        await execute_trade(ctx, "AAPL", 1, "buy")
        with pytest.raises(TradeError, match="Insufficient shares"):
            await execute_trade(ctx, "AAPL", 2, "sell")
        assert ctx.db.get_position("AAPL")["quantity"] == 1

    async def test_sell_unowned(self, ctx):
        with pytest.raises(TradeError, match="Insufficient shares"):
            await execute_trade(ctx, "PYPL", 1, "sell")
        assert "PYPL" not in ctx.db.get_watchlist_tickers()

    async def test_dust_position_deleted(self, ctx):
        await execute_trade(ctx, "AAPL", 0.3, "buy")
        await execute_trade(ctx, "AAPL", 0.1, "sell")
        await execute_trade(ctx, "AAPL", 0.2, "sell")  # 0.3 - 0.1 - 0.2 is ~-2.8e-17
        assert ctx.db.get_position("AAPL") is None


class TestTrackedTickers:
    async def test_held_ticker_removed_from_watchlist_keeps_streaming(self, ctx):
        await execute_trade(ctx, "AAPL", 1, "buy")
        await remove_from_watchlist(ctx, "AAPL")
        assert "AAPL" not in ctx.db.get_watchlist_tickers()
        assert "AAPL" in ctx.source.get_tickers()
        assert ctx.cache.get_price("AAPL") == 100.0

    async def test_selling_unwatched_to_zero_stops_it(self, ctx):
        await execute_trade(ctx, "AAPL", 1, "buy")
        await remove_from_watchlist(ctx, "AAPL")
        await execute_trade(ctx, "AAPL", 1, "sell")
        assert "AAPL" not in ctx.source.get_tickers()
        assert "AAPL" not in ctx.db.get_watchlist_tickers()
        assert ctx.cache.get("AAPL") is None

    async def test_remove_unheld_ticker_stops_it(self, ctx):
        await remove_from_watchlist(ctx, "TSLA")
        assert "TSLA" not in ctx.source.get_tickers()

    async def test_compute_is_union(self, ctx):
        await execute_trade(ctx, "PYPL", 1, "buy")
        await remove_from_watchlist(ctx, "PYPL")
        tracked = compute_tracked_tickers(ctx.db)
        assert set(tracked) == set(ctx.db.get_watchlist_tickers()) | {"PYPL"}


class TestValuation:
    async def test_portfolio_shape_and_pnl(self, ctx):
        await execute_trade(ctx, "AAPL", 10, "buy")
        ctx.source.set_price("AAPL", 108.031)
        p = build_portfolio(ctx.db, ctx.cache)
        assert set(p) == {"cash_balance", "total_value", "total_unrealized_pnl", "positions"}
        pos = p["positions"][0]
        assert set(pos) == {
            "ticker", "quantity", "avg_cost", "current_price",
            "market_value", "unrealized_pnl", "unrealized_pnl_percent",
        }
        assert pos["current_price"] == 108.03  # cache rounds to cents
        assert pos["market_value"] == 1080.3
        assert pos["unrealized_pnl"] == 80.3
        assert pos["unrealized_pnl_percent"] == 8.03
        assert p["cash_balance"] == 9000.0
        assert p["total_value"] == 10080.3
        assert p["total_unrealized_pnl"] == 80.3

    async def test_unpriced_position_valued_at_avg_cost(self, ctx):
        await execute_trade(ctx, "AAPL", 10, "buy")
        ctx.cache.remove("AAPL")
        p = build_portfolio(ctx.db, ctx.cache)
        pos = p["positions"][0]
        assert pos["current_price"] is None
        assert pos["market_value"] == 1000.0
        assert pos["unrealized_pnl"] == 0.0
        assert p["total_value"] == 10000.0
        assert total_value(ctx.db, ctx.cache) == pytest.approx(10000.0)


class TestWatchlist:
    async def test_shape_order_and_idempotency(self, ctx):
        await add_to_watchlist(ctx, "pypl")
        await add_to_watchlist(ctx, "PYPL")
        await add_to_watchlist(ctx, "ZZZ")  # no price in FakeSource
        wl = build_watchlist(ctx.db, ctx.cache)
        assert [w["ticker"] for w in wl][-2:] == ["PYPL", "ZZZ"]
        assert wl[-1] == {"ticker": "ZZZ", "price": None, "previous_price": None, "direction": None}
        assert wl[0] == {"ticker": "AAPL", "price": 100.0, "previous_price": 100.0, "direction": "flat"}
        await remove_from_watchlist(ctx, "ZZZ")
        await remove_from_watchlist(ctx, "ZZZ")
        assert "ZZZ" not in [w["ticker"] for w in build_watchlist(ctx.db, ctx.cache)]
