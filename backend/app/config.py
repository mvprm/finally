"""Backend configuration: tunable constants and filesystem paths.

Tunable values are plain constants (PLAN.md §5), not environment variables.
Paths that may be overridden by environment variables are resolved by functions
so they are read at call time (after `.env` has been loaded).
"""

from __future__ import annotations

import os
from pathlib import Path

# --- Tunable parameters (PLAN.md §5) ---

CHAT_HISTORY_LIMIT = 50  # Messages returned by GET /api/chat/history
LLM_CONTEXT_MESSAGES = 20  # Past messages sent to the LLM as history
LLM_TIMEOUT_SECONDS = 30  # Timeout on the LLM call

SNAPSHOT_INTERVAL_SECONDS = 30  # Background portfolio snapshot cadence (PLAN.md §7)

# --- LLM settings (cerebras-inference skill) ---

LLM_MODEL = "openrouter/openai/gpt-oss-120b"
LLM_EXTRA_BODY = {"provider": {"order": ["cerebras"]}}
LLM_REASONING_EFFORT = "low"

# --- Users and seed data ---

DEFAULT_USER_ID = "default"
DEFAULT_CASH_BALANCE = 10000.0
DEFAULT_WATCHLIST = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX"]

# --- Paths ---

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent
ENV_FILE = PROJECT_ROOT / ".env"


def get_db_path() -> Path:
    """SQLite file location: DB_PATH env var, else <project root>/db/finally.db."""
    raw = os.environ.get("DB_PATH", "").strip()
    return Path(raw) if raw else PROJECT_ROOT / "db" / "finally.db"


def get_static_dir() -> Path:
    """Static frontend export directory: STATIC_DIR env var, else <backend>/static."""
    raw = os.environ.get("STATIC_DIR", "").strip()
    return Path(raw) if raw else BACKEND_DIR / "static"


def llm_mock_enabled() -> bool:
    return os.environ.get("LLM_MOCK", "").strip().lower() == "true"


def openrouter_api_key() -> str:
    return os.environ.get("OPENROUTER_API_KEY", "").strip()
