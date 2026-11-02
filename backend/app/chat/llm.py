"""LLM access: structured output schema, real calls via LiteLLM -> OpenRouter
(Cerebras provider), and the deterministic mock (PLAN.md §9)."""

from __future__ import annotations

import asyncio
import os
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.config import (
    LLM_EXTRA_BODY,
    LLM_MODEL,
    LLM_REASONING_EFFORT,
    LLM_TIMEOUT_SECONDS,
)

# Use LiteLLM's bundled model cost map instead of fetching it over the network at import.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import litellm  # noqa: E402


class TradeAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticker: str
    side: Literal["buy", "sell"]
    quantity: float


class WatchlistAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticker: str
    action: Literal["add", "remove"]


class LLMResponse(BaseModel):
    """Structured output the LLM must return. Both arrays are required (strict mode)."""

    model_config = ConfigDict(extra="forbid")

    message: str
    trades: list[TradeAction]
    watchlist_changes: list[WatchlistAction]


class LLMError(Exception):
    """The LLM call failed; `user_message` is safe to show to the user."""

    def __init__(self, user_message: str) -> None:
        super().__init__(user_message)
        self.user_message = user_message


def parse_llm_response(content: str | None) -> LLMResponse:
    """Validate the raw JSON content against the schema; raise LLMError if it doesn't match."""
    if not content:
        raise LLMError("The AI assistant returned an empty response. Please try again.")
    try:
        return LLMResponse.model_validate_json(content)
    except ValueError:
        raise LLMError(
            "The AI assistant returned a response I couldn't understand. Please try again."
        ) from None


async def call_llm(messages: list[dict[str, str]], api_key: str) -> LLMResponse:
    """Call the model asynchronously (never blocks the event loop), with a hard timeout."""
    try:
        response = await asyncio.wait_for(
            litellm.acompletion(
                model=LLM_MODEL,
                messages=messages,
                response_format=LLMResponse,
                reasoning_effort=LLM_REASONING_EFFORT,
                extra_body=LLM_EXTRA_BODY,
                api_key=api_key,
                timeout=LLM_TIMEOUT_SECONDS,
            ),
            timeout=LLM_TIMEOUT_SECONDS,
        )
    except (TimeoutError, litellm.Timeout):
        raise LLMError("The AI assistant took too long to respond. Please try again.") from None
    except Exception as exc:  # network, auth, provider errors
        raise LLMError(
            f"The AI assistant is unavailable right now ({type(exc).__name__}). Please try again."
        ) from exc
    return parse_llm_response(response.choices[0].message.content)


# --- Mock mode ---------------------------------------------------------------

_MOCK_RE = re.compile(
    r"\b(?P<side>buy|sell)\s+(?P<qty>\d+(?:\.\d+)?|\.\d+)\s+(?P<trade_ticker>[A-Za-z.]+)"
    r"|\b(?P<wl_action>add|remove)\s+(?P<wl_ticker>[A-Za-z.]+)",
    re.IGNORECASE,
)


def mock_response(user_message: str) -> LLMResponse:
    """Deterministic response built from the user's message (PLAN.md §9 rules table)."""
    trades: list[TradeAction] = []
    changes: list[WatchlistAction] = []
    descriptions: list[str] = []
    for m in _MOCK_RE.finditer(user_message):
        if m.group("side"):
            side = m.group("side").lower()
            ticker = m.group("trade_ticker").upper()
            trades.append(TradeAction(ticker=ticker, side=side, quantity=float(m.group("qty"))))
            descriptions.append(f"{side} {m.group('qty')} {ticker}")
        else:
            action = m.group("wl_action").lower()
            ticker = m.group("wl_ticker").upper()
            changes.append(WatchlistAction(ticker=ticker, action=action))
            descriptions.append(f"{action} {ticker}")
    if not descriptions:
        return LLMResponse(message="Mock response: no actions.", trades=[], watchlist_changes=[])
    return LLMResponse(
        message="Mock: " + ", ".join(descriptions), trades=trades, watchlist_changes=changes
    )
