"""REST API routes (PLAN.md §8)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.chat import handle_chat
from app.config import CHAT_HISTORY_LIMIT
from app.context import AppContext, get_context
from app.portfolio import build_portfolio, execute_trade, get_history
from app.watchlist import add_to_watchlist, build_watchlist, remove_from_watchlist

router = APIRouter(prefix="/api")


class TradeRequest(BaseModel):
    ticker: str
    quantity: float
    side: str  # validated by execute_trade so an unknown side is a 400, not a 422


class WatchlistRequest(BaseModel):
    ticker: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)


def _bad_request(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


# --- System ---


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# --- Portfolio ---


@router.get("/portfolio")
async def get_portfolio(ctx: AppContext = Depends(get_context)) -> dict[str, Any]:
    return build_portfolio(ctx.db, ctx.cache)


@router.post("/portfolio/trade")
async def post_trade(
    body: TradeRequest, ctx: AppContext = Depends(get_context)
) -> dict[str, Any]:
    try:
        trade = await execute_trade(ctx, body.ticker, body.quantity, body.side)
    except ValueError as exc:
        raise _bad_request(exc) from None
    return {"trade": trade, "portfolio": build_portfolio(ctx.db, ctx.cache)}


@router.get("/portfolio/history")
async def portfolio_history(ctx: AppContext = Depends(get_context)) -> list[dict[str, Any]]:
    return get_history(ctx.db)


# --- Watchlist ---


@router.get("/watchlist")
async def get_watchlist(ctx: AppContext = Depends(get_context)) -> list[dict[str, Any]]:
    return build_watchlist(ctx.db, ctx.cache)


@router.post("/watchlist")
async def post_watchlist(
    body: WatchlistRequest, ctx: AppContext = Depends(get_context)
) -> list[dict[str, Any]]:
    try:
        await add_to_watchlist(ctx, body.ticker)
    except ValueError as exc:
        raise _bad_request(exc) from None
    return build_watchlist(ctx.db, ctx.cache)


@router.delete("/watchlist/{ticker}")
async def delete_watchlist(
    ticker: str, ctx: AppContext = Depends(get_context)
) -> list[dict[str, Any]]:
    try:
        await remove_from_watchlist(ctx, ticker)
    except ValueError as exc:
        raise _bad_request(exc) from None
    return build_watchlist(ctx.db, ctx.cache)


# --- Chat ---


@router.post("/chat")
async def post_chat(body: ChatRequest, ctx: AppContext = Depends(get_context)) -> dict[str, Any]:
    return await handle_chat(ctx, body.message)


@router.get("/chat/history")
async def chat_history(ctx: AppContext = Depends(get_context)) -> list[dict[str, Any]]:
    return ctx.db.get_recent_chat_messages(CHAT_HISTORY_LIMIT)
