"""Chat orchestration: context, LLM (or mock), auto-execution, persistence (PLAN.md §9)."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import LLM_CONTEXT_MESSAGES, llm_mock_enabled, openrouter_api_key
from app.context import AppContext
from app.portfolio import build_portfolio, execute_trade, format_quantity
from app.watchlist import add_to_watchlist, build_watchlist, remove_from_watchlist

from .llm import LLMError, LLMResponse, call_llm, mock_response

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are FinAlly, an AI trading assistant inside a simulated trading \
workstation. The user trades a virtual portfolio with fake money; market orders fill \
instantly at the current price, with no fees. Fractional shares are allowed.

Your job:
- Analyze the user's portfolio composition, risk concentration and P&L.
- Suggest trades with brief reasoning.
- Execute trades when the user asks for them or agrees to a suggestion, by listing them in "trades".
- Manage the watchlist proactively via "watchlist_changes" (action "add" or "remove").
- Be concise and data-driven. Use the numbers in the portfolio context.

Rules:
- Only include a trade or watchlist change when you intend it to execute right now.
- Ticker symbols are uppercase letters or dots, 1-10 characters (e.g. AAPL, BRK.B).
- Buys need enough cash; sells need enough shares. Check the context before proposing.
- Always respond with valid JSON matching the schema: {"message": string, \
"trades": [{"ticker", "side", "quantity"}], "watchlist_changes": [{"ticker", "action"}]}. \
Use empty arrays when there is nothing to do."""

NOT_CONFIGURED_MESSAGE = (
    "The AI assistant isn't configured: OPENROUTER_API_KEY is not set. "
    "Add it to the .env file and restart, or set LLM_MOCK=true for mock responses."
)


def empty_actions() -> dict[str, list]:
    return {"trades": [], "watchlist_changes": [], "errors": []}


def _portfolio_context(ctx: AppContext) -> str:
    context = {
        "portfolio": build_portfolio(ctx.db, ctx.cache),
        "watchlist": build_watchlist(ctx.db, ctx.cache),
    }
    return "Current portfolio and watchlist (live prices, USD):\n" + json.dumps(context)


def _history_entry(message: dict[str, Any]) -> dict[str, str]:
    """Past message for the LLM; assistant messages note what actually executed."""
    content = message["content"]
    actions = message.get("actions")
    if message["role"] == "assistant" and actions:
        parts = [
            f"{t['side']} {format_quantity(t['quantity'])} {t['ticker']} @ {t['price']:.2f}"
            for t in actions.get("trades", [])
        ]
        parts += [f"{c['action']} {c['ticker']}" for c in actions.get("watchlist_changes", [])]
        parts += [f"failed: {e}" for e in actions.get("errors", [])]
        if parts:
            content += "\n[Outcomes: " + "; ".join(parts) + "]"
    return {"role": message["role"], "content": content}


def build_messages(ctx: AppContext, user_message: str) -> list[dict[str, str]]:
    history = ctx.db.get_recent_chat_messages(LLM_CONTEXT_MESSAGES)
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": _portfolio_context(ctx)},
        *(_history_entry(m) for m in history),
        {"role": "user", "content": user_message},
    ]


async def _get_response(ctx: AppContext, user_message: str) -> LLMResponse:
    if llm_mock_enabled():
        return mock_response(user_message)
    api_key = openrouter_api_key()
    if not api_key:
        raise LLMError(NOT_CONFIGURED_MESSAGE)
    return await call_llm(build_messages(ctx, user_message), api_key)


async def execute_actions(ctx: AppContext, response: LLMResponse) -> dict[str, list]:
    """Watchlist changes first, then trades, in order. Failures don't stop later actions."""
    actions = empty_actions()
    for change in response.watchlist_changes:
        try:
            if change.action == "add":
                ticker = await add_to_watchlist(ctx, change.ticker)
            else:
                ticker = await remove_from_watchlist(ctx, change.ticker)
            actions["watchlist_changes"].append({"ticker": ticker, "action": change.action})
        except ValueError as exc:
            verb = "add" if change.action == "add" else "remove"
            prep = "to" if change.action == "add" else "from"
            actions["errors"].append(
                f"Could not {verb} {change.ticker} {prep} the watchlist: {exc}"
            )
    for t in response.trades:
        try:
            trade = await execute_trade(ctx, t.ticker, t.quantity, t.side)
            actions["trades"].append(
                {
                    "ticker": trade["ticker"],
                    "side": trade["side"],
                    "quantity": trade["quantity"],
                    "price": trade["price"],
                }
            )
        except ValueError as exc:
            actions["errors"].append(f"Could not {t.side} {format_quantity(t.quantity)} {t.ticker}: {exc}")
    return actions


async def handle_chat(ctx: AppContext, user_message: str) -> dict[str, Any]:
    """Full chat turn. Never raises for LLM problems: returns a 200-able payload."""
    try:
        response = await _get_response(ctx, user_message)
        reply = response.message
        actions = await execute_actions(ctx, response)
    except LLMError as exc:
        logger.warning("Chat LLM failure: %s", exc.user_message)
        reply = exc.user_message
        actions = empty_actions()

    executed = bool(actions["trades"] or actions["watchlist_changes"])
    ctx.db.insert_chat_message("user", user_message)
    ctx.db.insert_chat_message("assistant", reply, actions)

    return {
        "message": reply,
        "actions": actions,
        "portfolio": build_portfolio(ctx.db, ctx.cache) if executed else None,
        "watchlist": build_watchlist(ctx.db, ctx.cache) if executed else None,
    }
