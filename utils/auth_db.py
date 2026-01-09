from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from dataclasses import dataclass
from pathlib import Path


def get_db_path() -> str:
    return os.getenv("PARSE_VIDEO_DB_PATH") or "data/parse_video.db"


def _ensure_parent_dir(db_path: str) -> None:
    p = Path(db_path)
    if p.parent and str(p.parent) not in ("", "."):
        p.parent.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    db_path = get_db_path()
    _ensure_parent_dir(db_path)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_auth_db() -> None:
    conn = get_conn()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              pwd_salt BLOB NOT NULL,
              pwd_hash BLOB NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _pbkdf2(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)


@dataclass
class User:
    id: int
    username: str


def create_user(username: str, password: str, created_at: str) -> User:
    username = (username or "").strip()
    if len(username) < 3:
        raise ValueError("用户名至少 3 位")
    if len(password or "") < 6:
        raise ValueError("密码至少 6 位")

    salt = secrets.token_bytes(16)
    ph = _pbkdf2(password, salt)
    conn = get_conn()
    try:
        cur = conn.execute(
            """
            INSERT INTO users(username, pwd_salt, pwd_hash, created_at)
            VALUES(?, ?, ?, ?)
            """,
            (username, salt, ph, created_at),
        )
        conn.commit()
        return User(id=int(cur.lastrowid), username=username)
    except sqlite3.IntegrityError:
        raise ValueError("用户名已存在")
    finally:
        conn.close()


def verify_user(username: str, password: str) -> User | None:
    username = (username or "").strip()
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, username, pwd_salt, pwd_hash FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if not row:
            return None
        salt = row["pwd_salt"]
        expected = row["pwd_hash"]
        got = _pbkdf2(password or "", salt)
        if not hmac.compare_digest(expected, got):
            return None
        return User(id=int(row["id"]), username=str(row["username"]))
    finally:
        conn.close()


def get_user_by_id(user_id: int) -> User | None:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, username FROM users WHERE id=?",
            (int(user_id),),
        ).fetchone()
        if not row:
            return None
        return User(id=int(row["id"]), username=str(row["username"]))
    finally:
        conn.close()

