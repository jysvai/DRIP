"""국가교통정보센터(ITS) 돌발상황 수집: 고속도로의 지금 진행 중인 사고·공사·고장·기상 사건을 모은다.

  python pipeline/events_its.py                한 번 받아서 data/raw/its/events/날짜.jsonl에 덧붙인다
  python pipeline/events_its.py --loop 5       5분마다 계속 (끝난 사건은 목록에서 빠지므로 자주 받아야 기록이 남는다)
  --upload                                     그날 파일을 R2(raw/its/events/)에도 올린다
  --export                                     받은 사건을 게임용 game/public/events/latest.json으로도 쓴다
                                               (공사·작업 → 공사 구간, 교통사고 → 사고 차량, 고장 → 고장 차량)

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
GAME_OUT = ROOT / "game" / "public" / "events" / "latest.json"
GAME_SNAP_M = 80.0
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


def collect(key: str, snapper: Snapper, upload: bool, export: bool = False) -> int:
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
    if export:
        GAME_OUT.parent.mkdir(parents=True, exist_ok=True)
        GAME_OUT.write_text(json.dumps(export_game(events, now), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(events)


def classify(e: dict) -> str | None:
    """게임에서 쓰는 종류: work(공사·작업), crash(교통사고), breakdown(고장). 나머지(기상·재난 등)는 None"""
    text = " ".join(str(e.get(k) or "") for k in ("eventType", "eventDetailType", "message"))
    if "고장" in text:
        return "breakdown"
    kind = e.get("eventType") or ""
    if kind == "교통사고" or "사고" in (e.get("eventDetailType") or ""):
        return "crash"
    if kind in ("공사", "작업"):
        return "work"
    return None


def blocked_lanes(e: dict) -> list[int]:
    """막힌 차로 번호들 ('2차로 차단', '1 차로', '(2,3차로)'). 갓길이면 [0], 모르면 []"""
    import re

    text = f"{e.get('lanesBlocked') or ''} {e.get('message') or ''}"
    lanes: set[int] = set()
    for m in re.finditer(r"((?:\d\s*,\s*)*\d)\s*차로", text):
        lanes.update(int(x) for x in re.findall(r"\d", m.group(1)) if 0 < int(x) <= 8)
    if not lanes and "갓길" in text:
        return [0]
    return sorted(lanes)


def export_game(events: list[dict], fetched: datetime) -> dict:
    """사건을 게임 주행선 위치로 옮긴다. 방향은 cameras.py처럼 방향 글('부산방향')로 정하고, 모르면 확실히 가까운 주행선만"""
    from cameras import CLEAR, Line, direction_words

    index = json.loads((ROOT / "game" / "public" / "roads" / "index.json").read_text(encoding="utf-8"))
    lines = [Line(m) for m in index["roads"]]
    tf = Transformer.from_crs(4326, 5179, always_xy=True)
    roads: dict[str, list] = {}
    skipped = {"종류": 0, "주행선 없음": 0, "방향 모름": 0}
    for e in events:
        kind = classify(e)
        if not kind:
            skipped["종류"] += 1
            continue
        try:
            x, y = tf.transform(float(e["coordX"]), float(e["coordY"]))
        except (KeyError, TypeError, ValueError):
            skipped["주행선 없음"] += 1
            continue
        near = sorted(((ln.nearest(x, y), ln) for ln in lines), key=lambda t: t[0][0])
        near = [(d, s, ln) for (d, s), ln in near if d < GAME_SNAP_M]
        if not near:
            skipped["주행선 없음"] += 1
            continue
        cand = [c for c in near if c[2].ref == near[0][2].ref]
        frm, to = direction_words(f"{e.get('roadDrcType') or ''} {e.get('message') or ''}")
        pick = None
        if to or frm:
            scored = [(int(c[2].place_score(c[1], to, True)) * 2 + int(c[2].place_score(c[1], frm, False)), c) for c in cand]
            best = max(scored, key=lambda t: t[0])
            if best[0] > 0 and sum(1 for sc, _ in scored if sc == best[0]) == 1:
                pick = best[1]
        if pick is None and (len(cand) == 1 or cand[0][0] < CLEAR * cand[1][0]):
            pick = cand[0]
        if pick is None:
            skipped["방향 모름"] += 1
            continue
        _, s, ln = pick
        msg = " ".join(str(e.get("message") or "").split())[:80]
        roads.setdefault(ln.id, []).append([round(s), kind, blocked_lanes(e), str(e.get("startDate") or "")[:12], msg])
    for v in roads.values():
        v.sort()
    n = sum(len(v) for v in roads.values())
    print(f"게임용 돌발상황 {n}건 (건너뜀: {skipped}) → {GAME_OUT.relative_to(ROOT)}")
    return {
        "source": "국가교통정보센터(ITS) 돌발상황정보",
        "fetchedAt": fetched.isoformat(timespec="minutes"),
        "fields": ["s", "kind(work|crash|breakdown)", "blockedLanes(0=갓길)", "startDate(YYYYMMDDHHmm)", "message"],
        "roads": roads,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", help="ITS_API_KEY 대신 쓸 키 (시험: test)")
    ap.add_argument("--loop", type=float, help="이 분마다 계속 받는다")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--export", action="store_true", help="게임용 events/latest.json도 쓴다")
    args = ap.parse_args()
    key = api_key(args.key)
    snapper = Snapper()
    while True:
        try:
            collect(key, snapper, args.upload, args.export)
        except Exception as e:  # 한 번 실패해도 계속 돈다
            print(f"실패: {e}")
            if not args.loop:
                raise
        if not args.loop:
            break
        time.sleep(args.loop * 60)


if __name__ == "__main__":
    main()
