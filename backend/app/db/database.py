"""SQLite access: initialization, seeding and the queries the app needs.

A single connection is shared by the app. All access goes through a
re-entrant lock, so it is safe to use from the event loop and from worker
threads alike. Multi-statement writes use `transaction()`.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import DEFAULT_CASH_BALANCE, DEFAULT_USER_ID, DEFAULT_WATCHLIST

from .schema import SCHEMA_SQL

logger = logging.getLogger(__name__)


def utc_now_iso() -> str:
    """ISO 8601 UTC timestamp with a trailing Z, e.g. 2026-10-29T14:03:12Z."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id() -> str:
    return str(uuid.uuid4())


class Database:
    """Thin wrapper over one sqlite3 connection plus the app's queries."""

    def __init__(self, path: Path | str, user_id: str = DEFAULT_USER_ID) -> None:
        self.path = Path(path)
        self.user_id = user_id
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._lock = threading.RLock()

    # --- Lifecycle ---

    def initialize(self) -> None:
        """Create missing tables and seed default data on first run."""
        # executescript() issues its own COMMIT, so run it outside transaction().
        with self._lock:
            self._conn.executescript(SCHEMA_SQL)
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT 1 FROM users_profile WHERE id = ?", (self.user_id,)
            ).fetchone()
            if row is None:
                now = utc_now_iso()
                conn.execute(
                    "INSERT INTO users_profile (id, cash_balance, created_at) VALUES (?, ?, ?)",
                    (self.user_id, DEFAULT_CASH_BALANCE, now),
                )
                for ticker in DEFAULT_WATCHLIST:
                    conn.execute(
                        "INSERT OR IGNORE INTO watchlist (id, user_id, ticker, added_at) "
                        "VALUES (?, ?, ?, ?)",
                        (new_id(), self.user_id, ticker, now),
                    )
                logger.info("Seeded database at %s", self.path)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Run several statements atomically: commit on success, roll back on error."""
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    # --- Cash ---

    def get_cash(self) -> float:
        rows = self._query("SELECT cash_balance FROM users_profile WHERE id = ?", (self.user_id,))
        return float(rows[0]["cash_balance"]) if rows else 0.0

    def set_cash(self, conn: sqlite3.Connection, cash: float) -> None:
        conn.execute(
            "UPDATE users_profile SET cash_balance = ? WHERE id = ?", (cash, self.user_id)
        )

    # --- Watchlist ---

    def get_watchlist_tickers(self) -> list[str]:
        rows = self._query(
            "SELECT ticker FROM watchlist WHERE user_id = ? ORDER BY added_at, rowid",
            (self.user_id,),
        )
        return [r["ticker"] for r in rows]

    def add_watchlist_ticker(self, ticker: str) -> bool:
        """Add a ticker; returns True if it was inserted, False if already present."""
        with self.transaction() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
                (new_id(), self.user_id, ticker, utc_now_iso()),
            )
            return cur.rowcount > 0

    def remove_watchlist_ticker(self, ticker: str) -> bool:
        """Remove a ticker; returns True if a row was deleted."""
        with self.transaction() as conn:
            cur = conn.execute(
                "DELETE FROM watchlist WHERE user_id = ? AND ticker = ?", (self.user_id, ticker)
            )
            return cur.rowcount > 0

    # --- Positions ---

    def get_positions(self) -> list[dict[str, Any]]:
        rows = self._query(
            "SELECT ticker, quantity, avg_cost FROM positions WHERE user_id = ? "
            "ORDER BY rowid",
            (self.user_id,),
        )
        return [dict(r) for r in rows]

    def get_position(self, ticker: str) -> dict[str, Any] | None:
        rows = self._query(
            "SELECT ticker, quantity, avg_cost FROM positions WHERE user_id = ? AND ticker = ?",
            (self.user_id, ticker),
        )
        return dict(rows[0]) if rows else None

    def upsert_position(
        self, conn: sqlite3.Connection, ticker: str, quantity: float, avg_cost: float
    ) -> None:
        conn.execute(
            "INSERT INTO positions (id, user_id, ticker, quantity, avg_cost, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (user_id, ticker) DO UPDATE SET "
            "quantity = excluded.quantity, avg_cost = excluded.avg_cost, "
            "updated_at = excluded.updated_at",
            (new_id(), self.user_id, ticker, quantity, avg_cost, utc_now_iso()),
        )

    def delete_position(self, conn: sqlite3.Connection, ticker: str) -> None:
        conn.execute(
            "DELETE FROM positions WHERE user_id = ? AND ticker = ?", (self.user_id, ticker)
        )

    # --- Trades ---

    def insert_trade(
        self, conn: sqlite3.Connection, ticker: str, side: str, quantity: float, price: float
    ) -> dict[str, Any]:
        trade = {
            "id": new_id(),
            "ticker": ticker,
            "side": side,
            "quantity": quantity,
            "price": price,
            "executed_at": utc_now_iso(),
        }
        conn.execute(
            "INSERT INTO trades (id, user_id, ticker, side, quantity, price, executed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                trade["id"],
                self.user_id,
                ticker,
                side,
                quantity,
                price,
                trade["executed_at"],
            ),
        )
        return trade

    def latest_trade_prices(self, tickers: list[str]) -> dict[str, float]:
        """Most recent trade price for each of the given tickers that has trades."""
        result: dict[str, float] = {}
        for ticker in tickers:
            rows = self._query(
                "SELECT price FROM trades WHERE user_id = ? AND ticker = ? "
                "ORDER BY rowid DESC LIMIT 1",
                (self.user_id, ticker),
            )
            if rows:
                result[ticker] = float(rows[0]["price"])
        return result

    # --- Portfolio snapshots ---

    def insert_snapshot(self, total_value: float) -> None:
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO portfolio_snapshots (id, user_id, total_value, recorded_at) "
                "VALUES (?, ?, ?, ?)",
                (new_id(), self.user_id, total_value, utc_now_iso()),
            )

    def get_snapshots(self) -> list[dict[str, Any]]:
        rows = self._query(
            "SELECT total_value, recorded_at FROM portfolio_snapshots WHERE user_id = ? "
            "ORDER BY rowid",
            (self.user_id,),
        )
        return [dict(r) for r in rows]

    # --- Chat ---

    def insert_chat_message(
        self, role: str, content: str, actions: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        message = {
            "id": new_id(),
            "role": role,
            "content": content,
            "actions": actions,
            "created_at": utc_now_iso(),
        }
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO chat_messages (id, user_id, role, content, actions, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    message["id"],
                    self.user_id,
                    role,
                    content,
                    json.dumps(actions) if actions is not None else None,
                    message["created_at"],
                ),
            )
        return message

    def get_recent_chat_messages(self, limit: int) -> list[dict[str, Any]]:
        """The last `limit` messages, oldest first."""
        rows = self._query(
            "SELECT id, role, content, actions, created_at FROM ("
            "  SELECT rowid AS rid, * FROM chat_messages WHERE user_id = ? "
            "  ORDER BY rowid DESC LIMIT ?"
            ") ORDER BY rid",
            (self.user_id, limit),
        )
        messages = []
        for r in rows:
            m = dict(r)
            m["actions"] = json.loads(m["actions"]) if m["actions"] else None
            messages.append(m)
        return messages
