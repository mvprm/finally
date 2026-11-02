"""Portfolio valuation, snapshots and the shared trade execution function (PLAN.md §7-§8).

Amounts are stored unrounded. API responses round money values and P&L
percentages to 2 decimals; quantities and average cost are returned unrounded.
"""

from __future__ import annotations

import logging
import math
from typing import Any

from app.context import AppContext
from app.db import Database
from app.market import PriceCache
from app.tickers import normalize_ticker, sync_tracked_tickers
from app.watchlist import add_ticker_unlocked

logger = logging.getLogger(__name__)

# A position whose remaining quantity falls below this is closed (row deleted).
DUST_QUANTITY = 1e-9


class TradeError(ValueError):
    """A trade that violates a rule (-> HTTP 400 with this message as detail)."""


def format_quantity(quantity: float) -> str:
    """Human-readable share count: no scientific notation, fractional part only if present.

    1000000 -> "1,000,000", 0.5 -> "0.5", 2.0 -> "2" (up to 8 decimal places).
    """
    text = f"{quantity:,.8f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _money(value: float) -> float:
    return round(value, 2)


def total_value(db: Database, cache: PriceCache) -> float:
    """cash + Σ quantity × current price; unpriced positions valued at avg_cost. Unrounded."""
    value = db.get_cash()
    for pos in db.get_positions():
        price = cache.get_price(pos["ticker"])
        value += pos["quantity"] * (price if price is not None else pos["avg_cost"])
    return value


def build_portfolio(db: Database, cache: PriceCache) -> dict[str, Any]:
    """The portfolio object returned by GET /api/portfolio and embedded elsewhere."""
    cash = db.get_cash()
    positions = []
    total = cash
    total_pnl = 0.0
    for pos in db.get_positions():
        qty = pos["quantity"]
        avg = pos["avg_cost"]
        price = cache.get_price(pos["ticker"])
        mark = price if price is not None else avg
        market_value = qty * mark
        pnl = qty * (mark - avg)
        pnl_pct = (mark - avg) / avg * 100 if avg else 0.0
        total += market_value
        total_pnl += pnl
        positions.append(
            {
                "ticker": pos["ticker"],
                "quantity": qty,
                "avg_cost": avg,
                "current_price": price,
                "market_value": _money(market_value),
                "unrealized_pnl": _money(pnl),
                "unrealized_pnl_percent": round(pnl_pct, 2),
            }
        )
    return {
        "cash_balance": _money(cash),
        "total_value": _money(total),
        "total_unrealized_pnl": _money(total_pnl),
        "positions": positions,
    }


def record_snapshot(db: Database, cache: PriceCache) -> float:
    """Store one portfolio_snapshots row with the current total value."""
    value = total_value(db, cache)
    db.insert_snapshot(value)
    return value


def get_history(db: Database) -> list[dict[str, Any]]:
    return [
        {"total_value": _money(s["total_value"]), "recorded_at": s["recorded_at"]}
        for s in db.get_snapshots()
    ]


def _validate_quantity(quantity: Any) -> float:
    try:
        qty = float(quantity)
    except (TypeError, ValueError):
        raise TradeError("Quantity must be a number") from None
    if not math.isfinite(qty) or qty <= 0:
        raise TradeError("Quantity must be greater than 0")
    return qty


async def execute_trade(
    ctx: AppContext, raw_ticker: str, quantity: Any, side: str
) -> dict[str, Any]:
    """Execute a market order. Used by both the REST API and the chat assistant.

    Returns the trade record. Raises TradeError (or InvalidTickerError, also a
    ValueError) on a rule violation; nothing is written in that case.
    """
    ticker = normalize_ticker(raw_ticker)
    qty = _validate_quantity(quantity)
    side = str(side).strip().lower()
    if side not in ("buy", "sell"):
        raise TradeError(f"Unknown side: {side!r} (expected 'buy' or 'sell')")

    async with ctx.lock:
        db = ctx.db
        position = db.get_position(ticker)

        if side == "sell":
            held = position["quantity"] if position else 0.0
            if qty > held + DUST_QUANTITY:
                raise TradeError(
                    f"Insufficient shares: you hold {format_quantity(held)} {ticker}, "
                    f"tried to sell {format_quantity(qty)}"
                )
        elif ticker not in db.get_watchlist_tickers():
            # Buying an unwatched ticker adds it to the watchlist first, which
            # starts its price feed (immediately in simulator mode). Sells never
            # touch the watchlist, so selling an unwatched holding to zero stops it.
            await add_ticker_unlocked(ctx, ticker)

        price = ctx.cache.get_price(ticker)
        if price is None:
            raise TradeError(f"No price available for {ticker} yet")

        cash = db.get_cash()
        with db.transaction() as conn:
            if side == "buy":
                cost = qty * price
                if cost > cash + 1e-9:
                    raise TradeError(
                        f"Insufficient cash: need ${cost:,.2f} to buy {format_quantity(qty)} {ticker}, "
                        f"have ${cash:,.2f}"
                    )
                old_qty = position["quantity"] if position else 0.0
                old_avg = position["avg_cost"] if position else 0.0
                new_qty = old_qty + qty
                new_avg = (old_qty * old_avg + qty * price) / new_qty
                db.set_cash(conn, cash - cost)
                db.upsert_position(conn, ticker, new_qty, new_avg)
            else:
                remaining = position["quantity"] - qty
                db.set_cash(conn, cash + qty * price)
                if remaining < DUST_QUANTITY:
                    db.delete_position(conn, ticker)
                else:
                    db.upsert_position(conn, ticker, remaining, position["avg_cost"])
            trade = db.insert_trade(conn, ticker, side, qty, price)

        record_snapshot(db, ctx.cache)
        await sync_tracked_tickers(db, ctx.source)

    logger.info("Trade: %s %s %s @ %.2f", side, format_quantity(qty), ticker, price)
    return trade
