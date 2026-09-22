"""Supabase Postgres 연결. .env의 SUPABASE_DB_URL과 SUPABASE_DB_PASSWORD를 쓴다.

실행하면 연결과 PostGIS 상태를 확인한다: .venv\\Scripts\\python pipeline\\db.py
"""

import os
from pathlib import Path
from urllib.parse import quote

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


def connection_url() -> str:
    load_dotenv(ROOT / ".env")
    url = os.environ.get("SUPABASE_DB_URL", "").strip()
    password = os.environ.get("SUPABASE_DB_PASSWORD", "")
    if not url or not password:
        raise SystemExit(".env에 SUPABASE_DB_URL과 SUPABASE_DB_PASSWORD를 채워 주세요.")
    # 비밀번호에 @, # 같은 특수문자가 있으면 주소가 깨지므로 인코딩해서 끼워 넣는다.
    return url.replace("[YOUR-PASSWORD]", quote(password, safe=""))


def connect() -> psycopg.Connection:
    return psycopg.connect(connection_url())


if __name__ == "__main__":
    with connect() as conn:
        version = conn.execute("select version()").fetchone()[0]
        postgis = conn.execute(
            "select installed_version from pg_available_extensions where name = 'postgis'"
        ).fetchone()
    print("연결 성공:", version.split(",")[0])
    if postgis is None:
        print("PostGIS: 없음")
    else:
        print("PostGIS:", "켜져 있음" if postgis[0] else "사용 가능 (아직 안 켬)")
