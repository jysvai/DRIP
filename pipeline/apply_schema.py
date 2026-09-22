r"""supabase/schema.sql을 Supabase DB에 적용한다. 여러 번 실행해도 된다.

실행: .venv\Scripts\python pipeline\apply_schema.py
"""

from pathlib import Path

from db import ROOT, connect

SCHEMA = ROOT / "supabase" / "schema.sql"


def main():
    sql = SCHEMA.read_text(encoding="utf-8")
    with connect() as conn:
        conn.execute(sql)
        conn.commit()
        rows = conn.execute(
            "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'drip_%' order by 1"
        ).fetchall()
    print("적용 완료:", ", ".join(r[0] for r in rows))


if __name__ == "__main__":
    main()
