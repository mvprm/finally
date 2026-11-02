"""Database initialization, seeding and queries."""

import sqlite3

import pytest

from app.config import (
    BACKEND_DIR,
    DEFAULT_WATCHLIST,
    PROJECT_ROOT,
    get_db_path,
    get_static_dir,
)
from app.db import Database

TABLES = {
    "users_profile",
    "watchlist",
    "positions",
    "trades",
    "portfolio_snapshots",
    "chat_messages",
}


def _tables(path) -> set[str]:
    conn = sqlite3.connect(path)
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    conn.close()
    return {r[0] for r in rows}


def test_creates_file_dir_schema_and_seed(tmp_path):
    path = tmp_path / "nested" / "dir" / "finally.db"
    db = Database(path)
    db.initialize()
    assert path.exists()
    assert TABLES <= _tables(path)
    assert db.get_cash() == 10000.0
    assert db.get_watchlist_tickers() == DEFAULT_WATCHLIST
    db.close()


def test_initialize_is_idempotent_and_does_not_reseed(tmp_path):
    path = tmp_path / "f.db"
    db = Database(path)
    db.initialize()
    db.remove_watchlist_ticker("AAPL")
    with db.transaction() as conn:
        db.set_cash(conn, 5.0)
    db.close()

    db2 = Database(path)
    db2.initialize()
    assert "AAPL" not in db2.get_watchlist_tickers()
    assert db2.get_cash() == 5.0
    db2.close()


def test_recreates_missing_tables(tmp_path):
    path = tmp_path / "f.db"
    sqlite3.connect(path).close()  # empty file
    db = Database(path)
    db.initialize()
    assert TABLES <= _tables(path)
    assert len(db.get_watchlist_tickers()) == 10
    db.close()


def test_db_path_env(monkeypatch, tmp_path):
    monkeypatch.delenv("DB_PATH", raising=False)
    assert get_db_path() == PROJECT_ROOT / "db" / "finally.db"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "x.db"))
    assert get_db_path() == tmp_path / "x.db"


@pytest.mark.parametrize("value", ["", "   ", "\t\n"])
def test_empty_path_env_falls_back_to_default(monkeypatch, value):
    # docker --env-file can set DB_PATH= / STATIC_DIR= to empty strings
    monkeypatch.setenv("DB_PATH", value)
    monkeypatch.setenv("STATIC_DIR", value)
    assert get_db_path() == PROJECT_ROOT / "db" / "finally.db"
    assert get_static_dir() == BACKEND_DIR / "static"


def test_static_dir_env(monkeypatch, tmp_path):
    monkeypatch.setenv("STATIC_DIR", f"  {tmp_path}  ")
    assert get_static_dir() == tmp_path


def test_watchlist_add_remove_idempotent(db):
    assert db.add_watchlist_ticker("PYPL") is True
    assert db.add_watchlist_ticker("PYPL") is False
    assert db.get_watchlist_tickers()[-1] == "PYPL"
    assert db.remove_watchlist_ticker("PYPL") is True
    assert db.remove_watchlist_ticker("PYPL") is False


def test_transaction_rolls_back(db):
    try:
        with db.transaction() as conn:
            db.set_cash(conn, 1.0)
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert db.get_cash() == 10000.0


def test_latest_trade_prices(db):
    with db.transaction() as conn:
        db.insert_trade(conn, "AAPL", "buy", 1, 100.0)
        db.insert_trade(conn, "AAPL", "buy", 1, 110.0)
        db.insert_trade(conn, "MSFT", "buy", 1, 400.0)
    assert db.latest_trade_prices(["AAPL", "MSFT", "TSLA"]) == {"AAPL": 110.0, "MSFT": 400.0}


def test_chat_messages_limit_and_order(db):
    for i in range(5):
        db.insert_chat_message("user", f"m{i}")
    db.insert_chat_message("assistant", "reply", {"trades": [], "watchlist_changes": [], "errors": []})
    recent = db.get_recent_chat_messages(3)
    assert [m["content"] for m in recent] == ["m3", "m4", "reply"]
    assert recent[0]["actions"] is None
    assert recent[-1]["actions"] == {"trades": [], "watchlist_changes": [], "errors": []}
