from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from .config import secret


def connect():
    dsn = secret('DATABASE_URL')
    if not dsn:
        raise RuntimeError('DATABASE_URL_FILE or DATABASE_URL is required')
    return psycopg.connect(dsn, row_factory=dict_row, connect_timeout=10)


def migrate() -> None:
    # API and worker can start together; one admission owner applies the schema.
    with connect() as conn:
        conn.execute('SELECT pg_advisory_xact_lock(7348216001)')
        conn.execute(Path(__file__).resolve().parent.parent.joinpath('schema.sql').read_text())


def rows(query: str, params=()) -> list[dict]:
    with connect() as conn:
        return conn.execute(query, params).fetchall()


def one(query: str, params=()) -> dict | None:
    with connect() as conn:
        return conn.execute(query, params).fetchone()


if __name__ == '__main__':
    migrate()
