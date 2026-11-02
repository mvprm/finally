"""LLM structured output parsing, mock mode, failure handling and chat auto-execution."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from app.chat import llm as llm_module
from app.chat import service
from app.chat.llm import LLMError, LLMResponse, call_llm, mock_response, parse_llm_response


def _payload(**overrides):
    data = {"message": "hi", "trades": [], "watchlist_changes": []}
    data.update(overrides)
    return json.dumps(data)


class TestParse:
    def test_minimal(self):
        r = parse_llm_response(_payload())
        assert r.message == "hi" and r.trades == [] and r.watchlist_changes == []

    def test_full(self):
        r = parse_llm_response(
            _payload(
                trades=[{"ticker": "AAPL", "side": "buy", "quantity": 2.5}],
                watchlist_changes=[{"ticker": "PYPL", "action": "remove"}],
            )
        )
        assert r.trades[0].quantity == 2.5 and r.trades[0].side == "buy"
        assert r.watchlist_changes[0].action == "remove"

    @pytest.mark.parametrize(
        "content",
        [
            None,
            "",
            "not json",
            json.dumps({"message": "hi"}),  # arrays are required
            _payload(trades=[{"ticker": "AAPL", "side": "hold", "quantity": 1}]),
            _payload(watchlist_changes=[{"ticker": "AAPL", "action": "toggle"}]),
            _payload(extra="field"),
        ],
    )
    def test_malformed(self, content):
        with pytest.raises(LLMError):
            parse_llm_response(content)

    def test_schema_is_strict(self):
        schema = LLMResponse.model_json_schema()
        assert set(schema["required"]) == {"message", "trades", "watchlist_changes"}
        assert schema["additionalProperties"] is False


class TestMock:
    def test_no_match(self):
        r = mock_response("How is my portfolio doing?")
        assert r.message == "Mock response: no actions."
        assert r.trades == [] and r.watchlist_changes == []

    def test_buy(self):
        r = mock_response("buy 1 AAPL")
        assert r.message == "Mock: buy 1 AAPL"
        assert [(t.side, t.quantity, t.ticker) for t in r.trades] == [("buy", 1.0, "AAPL")]

    def test_all_patterns_in_order_case_insensitive(self):
        r = mock_response("Please SELL 2.5 msft, then Add pypl and remove tsla; buy 3 nvda")
        assert r.message == "Mock: sell 2.5 MSFT, add PYPL, remove TSLA, buy 3 NVDA"
        assert [(t.side, t.quantity, t.ticker) for t in r.trades] == [
            ("sell", 2.5, "MSFT"),
            ("buy", 3.0, "NVDA"),
        ]
        assert [(c.action, c.ticker) for c in r.watchlist_changes] == [
            ("add", "PYPL"),
            ("remove", "TSLA"),
        ]


class TestCallLLM:
    async def test_success(self, monkeypatch):
        async def fake(**kwargs):
            assert kwargs["model"] == "openrouter/openai/gpt-oss-120b"
            assert kwargs["extra_body"] == {"provider": {"order": ["cerebras"]}}
            assert kwargs["response_format"] is LLMResponse
            msg = SimpleNamespace(content=_payload(message="ok"))
            return SimpleNamespace(choices=[SimpleNamespace(message=msg)])

        monkeypatch.setattr(llm_module.litellm, "acompletion", fake)
        r = await call_llm([{"role": "user", "content": "x"}], "key")
        assert r.message == "ok"

    async def test_exception_becomes_llm_error(self, monkeypatch):
        async def fake(**kwargs):
            raise ConnectionError("down")

        monkeypatch.setattr(llm_module.litellm, "acompletion", fake)
        with pytest.raises(LLMError, match="unavailable"):
            await call_llm([], "key")

    async def test_timeout(self, monkeypatch):
        async def fake(**kwargs):
            await asyncio.sleep(10)

        monkeypatch.setattr(llm_module.litellm, "acompletion", fake)
        monkeypatch.setattr(llm_module, "LLM_TIMEOUT_SECONDS", 0.05)
        with pytest.raises(LLMError, match="too long"):
            await call_llm([], "key")


class TestHandleChat:
    async def test_mock_buy_executes_and_persists(self, ctx, monkeypatch):
        monkeypatch.setenv("LLM_MOCK", "true")
        result = await service.handle_chat(ctx, "buy 1 AAPL")
        assert result["message"] == "Mock: buy 1 AAPL"
        assert result["actions"] == {
            "trades": [{"ticker": "AAPL", "side": "buy", "quantity": 1.0, "price": 100.0}],
            "watchlist_changes": [],
            "errors": [],
        }
        assert result["portfolio"]["cash_balance"] == 9900.0
        assert result["watchlist"][0]["ticker"] == "AAPL"
        history = ctx.db.get_recent_chat_messages(10)
        assert [(m["role"], m["content"]) for m in history] == [
            ("user", "buy 1 AAPL"),
            ("assistant", "Mock: buy 1 AAPL"),
        ]
        assert history[0]["actions"] is None
        assert history[1]["actions"] == result["actions"]

    async def test_no_actions_returns_null_state(self, ctx, monkeypatch):
        monkeypatch.setenv("LLM_MOCK", "true")
        result = await service.handle_chat(ctx, "hello")
        assert result["portfolio"] is None and result["watchlist"] is None

    async def test_failures_reported_and_dont_stop_later_actions(self, ctx, monkeypatch):
        monkeypatch.setenv("LLM_MOCK", "true")
        result = await service.handle_chat(ctx, "sell 5 AAPL, buy 1000 NVDA, add 1BAD, buy 1 MSFT")
        actions = result["actions"]
        assert [t["ticker"] for t in actions["trades"]] == ["MSFT"]
        assert len(actions["errors"]) == 2  # the sell and the NVDA buy; "1BAD" doesn't match
        assert "Insufficient shares" in actions["errors"][0]
        assert "Insufficient cash" in actions["errors"][1]
        assert result["portfolio"] is not None

    async def test_chat_error_quantity_has_no_scientific_notation(self, ctx, monkeypatch):
        monkeypatch.setenv("LLM_MOCK", "true")
        result = await service.handle_chat(ctx, "sell 1000000 AAPL")
        assert result["message"] == "Mock: sell 1000000 AAPL"
        assert result["actions"]["errors"] == [
            "Could not sell 1,000,000 AAPL: Insufficient shares: you hold 0 AAPL, "
            "tried to sell 1,000,000"
        ]

    async def test_watchlist_runs_before_trades(self, ctx, monkeypatch):
        monkeypatch.setenv("LLM_MOCK", "true")
        # The trade appears first in the text, but the watchlist remove runs first,
        # so the buy re-adds AAPL to the watchlist.
        result = await service.handle_chat(ctx, "buy 1 AAPL then remove AAPL")
        assert result["actions"]["watchlist_changes"] == [{"ticker": "AAPL", "action": "remove"}]
        assert "AAPL" in ctx.db.get_watchlist_tickers()

    async def test_invalid_watchlist_ticker_error(self, ctx, monkeypatch):
        async def fake_response(c, m):
            return LLMResponse(
                message="ok",
                trades=[],
                watchlist_changes=[{"ticker": "BAD!", "action": "add"}],
            )

        monkeypatch.setattr(service, "_get_response", fake_response)
        result = await service.handle_chat(ctx, "x")
        assert result["actions"]["errors"][0].startswith("Could not add BAD! to the watchlist")
        assert result["portfolio"] is None

    async def test_missing_api_key(self, ctx, monkeypatch):
        monkeypatch.delenv("LLM_MOCK", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        result = await service.handle_chat(ctx, "buy 1 AAPL")
        assert "OPENROUTER_API_KEY" in result["message"]
        assert result["actions"] == {"trades": [], "watchlist_changes": [], "errors": []}
        assert result["portfolio"] is None and result["watchlist"] is None
        assert ctx.db.get_positions() == []
        assert len(ctx.db.get_recent_chat_messages(10)) == 2

    async def test_llm_failure_returns_message(self, ctx, monkeypatch):
        monkeypatch.delenv("LLM_MOCK", raising=False)
        monkeypatch.setenv("OPENROUTER_API_KEY", "k")

        async def boom(messages, api_key):
            raise LLMError("The AI assistant took too long to respond. Please try again.")

        monkeypatch.setattr(service, "call_llm", boom)
        result = await service.handle_chat(ctx, "buy 1 AAPL")
        assert "too long" in result["message"]
        assert result["portfolio"] is None
        assert ctx.db.get_positions() == []

    async def test_real_path_builds_context_and_history(self, ctx, monkeypatch):
        monkeypatch.delenv("LLM_MOCK", raising=False)
        monkeypatch.setenv("OPENROUTER_API_KEY", "k")
        ctx.db.insert_chat_message("user", "earlier question")
        ctx.db.insert_chat_message(
            "assistant",
            "earlier answer",
            {"trades": [{"ticker": "AAPL", "side": "buy", "quantity": 1, "price": 100.0}],
             "watchlist_changes": [], "errors": []},
        )
        seen = {}

        async def fake_call(messages, api_key):
            seen["messages"] = messages
            return LLMResponse(message="sure", trades=[], watchlist_changes=[])

        monkeypatch.setattr(service, "call_llm", fake_call)
        result = await service.handle_chat(ctx, "new question")
        msgs = seen["messages"]
        assert msgs[0]["role"] == "system" and "FinAlly" in msgs[0]["content"]
        assert '"cash_balance": 10000.0' in msgs[1]["content"]
        assert msgs[2] == {"role": "user", "content": "earlier question"}
        assert msgs[3]["content"].startswith("earlier answer")
        assert "buy 1 AAPL @ 100.00" in msgs[3]["content"]
        assert msgs[-1] == {"role": "user", "content": "new question"}
        assert result["message"] == "sure"
