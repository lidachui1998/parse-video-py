from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from utils.auth_db import get_conn, get_db_path, init_auth_db


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def init_db() -> None:
    # ensure users table
    init_auth_db()
    conn = get_conn()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS history_v2 (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              share_url TEXT NOT NULL,
              title TEXT NOT NULL,
              kind TEXT NOT NULL,
              data_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_history_v2_user_time ON history_v2(user_id, id DESC)"
        )
        conn.commit()
    finally:
        conn.close()


def insert_history(
    *,
    user_id: int,
    share_url: str,
    title: str,
    kind: str,
    data: Any,
) -> int:
    conn = get_conn()
    try:
        cur = conn.execute(
            """
            INSERT INTO history_v2(user_id, share_url, title, kind, data_json, created_at)
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                int(user_id),
                share_url or "",
                title or "",
                kind or "",
                json.dumps(data, ensure_ascii=False),
                _utc_now_iso(),
            ),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def list_history(*, user_id: int, limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit or 50), 200))
    conn = get_conn()
    try:
        rows = conn.execute(
            """
            SELECT id, share_url, title, kind, created_at
            FROM history_v2
            WHERE user_id=?
            ORDER BY id DESC
            LIMIT ?
            """,
            (int(user_id), limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_history_item(*, user_id: int, item_id: int) -> dict[str, Any] | None:
    conn = get_conn()
    try:
        row = conn.execute(
            """
            SELECT id, share_url, title, kind, created_at, data_json
            FROM history_v2
            WHERE user_id=? AND id=?
            """,
            (int(user_id), int(item_id)),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["data"] = json.loads(d.pop("data_json"))
        return d
    finally:
        conn.close()


def delete_history_item(*, user_id: int, item_id: int) -> bool:
    conn = get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM history_v2 WHERE user_id=? AND id=?",
            (int(user_id), int(item_id)),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()

