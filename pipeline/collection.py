"""주행 기록 서버 적재 스위치. 게임(브라우저, anon 역할)이 drip_* 표에 넣을 수 있는지를 DB에서 켜고 끈다.

게임 빌드의 VITE_DRIP_COLLECT 변수만 끄면 옛 페이지(브라우저 캐시)나 공개 키로 직접 부르는 요청은 막지 못하므로,
공개 전에는 DB 권한도 끈다. 연구를 공개할 때 둘 다 켠다.

  python pipeline/collection.py status   지금 상태와 쌓인 행 수
  python pipeline/collection.py off      넣기 권한을 뺀다 (공개 전 기본)
  python pipeline/collection.py on       넣기 권한을 준다 (공개할 때, 저장소 변수 VITE_DRIP_COLLECT=on과 함께)
"""

import argparse

from db import connect

TABLES = ("drip_sessions", "drip_events", "drip_samples", "drip_summaries")
ROLES = ("anon", "authenticated")


def status(conn) -> None:
    for t in TABLES:
        rows = conn.execute(f"select count(*) from public.{t}").fetchone()[0]
        grants = [
            r
            for r in ROLES
            if conn.execute("select has_table_privilege(%s, %s, 'INSERT')", (r, f"public.{t}")).fetchone()[0]
        ]
        print(f"  {t:15} {rows:6}행  넣기: {'켜짐 (' + ', '.join(grants) + ')' if grants else '꺼짐'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["status", "on", "off"])
    args = ap.parse_args()
    tables = ", ".join(f"public.{t}" for t in TABLES)
    roles = ", ".join(ROLES)
    with connect() as conn:
        if args.action == "off":
            conn.execute(f"revoke insert on {tables} from {roles}")
            print("넣기 권한을 뺐습니다. 게임은 기록을 서버에 올릴 수 없습니다.")
        elif args.action == "on":
            conn.execute(f"grant insert on {tables} to {roles}")
            print("넣기 권한을 줬습니다. 게임 빌드의 VITE_DRIP_COLLECT=on도 켜야 올라갑니다.")
        status(conn)


if __name__ == "__main__":
    main()
