"""국가교통정보센터(ITS) 돌발상황 수집: 고속도로의 지금 진행 중인 사고·공사·고장·기상 사건을 모은다.

  python pipeline/events_its.py                한 번 받아서 data/raw/its/events/날짜.jsonl에 덧붙인다
  python pipeline/events_its.py --loop 5       5분마다 계속 (끝난 사건은 목록에서 빠지므로 자주 받아야 기록이 남는다)
  --upload                                     그날 파일을 R2(raw/its/events/)에도 올린다

키: .env의 ITS_API_KEY (its.go.kr 회원가입 → 오픈API 신청 → 승인 3~5일, 신청할 때 '돌발상황정보'를 골라야 한다).
예시 키 test는 늘 같은 20건 표본만 준다.

사건마다 가까운 게임 주행선과 위치(s)를 붙인다 (좌표가 주행선에서 60m 안일 때).
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from pyproj import Transformer

from traffic_ex import RoadGeom, load_roads

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "its" / "events"
URL = "https://openapi.its.go.kr:9443/eventInfo"
KST = timezone(timedelta(hours=9))
SNAP_M = 60


def api_key(override: str | None) -> str:
    if override:
        return override
    load_dotenv(ROOT / ".env")
    key = os.environ.get("ITS_API_KEY", "").strip()
    if not key:
        raise SystemExit(".env에 ITS_API_KEY를 채워 주세요. 시험만 하려면 --key test")
    return key


def parse(text: str) -> list[dict]:
    """JSON 또는 XML 응답 → 사건 목록. JSON 모양은 설명서에 없어 여러 모양을 받아 준다."""
    if text.lstrip().startswith("<"):
        import xml.etree.ElementTree as ET

        root = ET.fromstring(text)
        code = (root.findtext("header/resultCode") or "0").strip()
        if code not in ("0", "00"):
            raise RuntimeError(f"ITS 오류 {code}: {root.findtext('header/resultMsg')}")
        return [{c.tag: (c.text or "").strip() for c in item} for item in root.iter("item")]
    data = json.loads(text)
    header = data.get("header") or data.get("response", {}).get("header") or {}
    code = str(header.get("resultCode", "0"))
    if code not in ("0", "00"):
        raise RuntimeError(f"ITS 오류 {code}: {header.get('resultMsg')}")
    body = data.get("body") or data.get("response", {}).get("body") or data
    items = body.get("items", [])
    if isinstance(items, dict):
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    return [{k: (v.strip() if isinstance(v, str) else v) for k, v in it.items()} for it in items]


def fetch(key: str) -> list[dict]:
    q = {"apiKey": key, "type": "ex", "eventType": "all", "minX": 124, "maxX": 132, "minY": 33, "maxY": 39, "getType": "json"}
    with urllib.request.urlopen(URL + "?" + urllib.parse.urlencode(q), timeout=60) as res:
        return parse(res.read().decode("utf-8"))


class Snapper:
    """위경도 → 가까운 게임 주행선 (road_id, s, 거리)"""

    def __init__(self):
        self.roads: list[RoadGeom] = load_roads()
        self.tf = Transformer.from_crs(4326, 5179, always_xy=True)
        self.box = [(r, r.x.min() - 200, r.x.max() + 200, r.y.min() - 200, r.y.max() + 200) for r in self.roads]

    def snap(self, lon: float, lat: float) -> list[dict]:
        x, y = self.tf.transform(lon, lat)
        out = []
        for r, x0, x1, y0, y1 in self.box:
            if not (x0 <= x <= x1 and y0 <= y <= y1):
                continue
            s, d = r.project(np.array([x]), np.array([y]))
            if d[0] < SNAP_M:
                out.append({"road_id": r.id, "s": round(float(s[0])), "dist": round(float(d[0]), 1)})
        return sorted(out, key=lambda c: c["dist"])


def collect(key: str, snapper: Snapper, upload: bool) -> int:
    now = datetime.now(KST)
    events = fetch(key)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{now:%Y%m%d}.jsonl"
    with path.open("a", encoding="utf-8") as fp:
        for e in events:
            try:
                e["roads"] = snapper.snap(float(e["coordX"]), float(e["coordY"]))
            except (KeyError, TypeError, ValueError):
                e["roads"] = []
            e["fetchedAt"] = now.isoformat(timespec="seconds")
            fp.write(json.dumps(e, ensure_ascii=False) + "\n")
    if upload:
        from storage import bucket, client

        client().put_object(Bucket=bucket(), Key=f"raw/its/events/{path.name}", Body=path.read_bytes())
    snapped = sum(1 for e in events if e["roads"])
    print(f"{now:%H:%M} 돌발상황 {len(events)}건 (게임 주행선 위 {snapped}건) → {path.relative_to(ROOT)}")
    return len(events)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", help="ITS_API_KEY 대신 쓸 키 (시험: test)")
    ap.add_argument("--loop", type=float, help="이 분마다 계속 받는다")
    ap.add_argument("--upload", action="store_true")
    args = ap.parse_args()
    key = api_key(args.key)
    snapper = Snapper()
    while True:
        try:
            collect(key, snapper, args.upload)
        except Exception as e:  # 한 번 실패해도 계속 돈다
            print(f"실패: {e}")
            if not args.loop:
                raise
        if not args.loop:
            break
        time.sleep(args.loop * 60)


if __name__ == "__main__":
    main()
