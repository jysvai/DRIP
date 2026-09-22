r"""노선별 시간대 날씨 (Open-Meteo, 키 없음) → game/public/weather/latest.json

게임의 '실제 날씨'가 쓴다: 출발 위치에서 가장 가까운 지점의, 고른 시각(어제 같은 시각)의 날씨.
'실제 교통'(pipeline/traffic_ex.py daily)과 같은 날(기본 어제)을 받아 두 자료의 시점을 맞춘다.

주행선마다 시작점부터 40km 간격(끝점 포함)으로 지점을 잡는다. 시간마다 한 글자:
  c 맑음 · o 흐림(구름 70% 이상) · r 비(강수 0.1mm/h 이상) · h 폭우(20mm/h 이상) · f 안개(WMO 45·48) · s 눈 · S 폭설(1cm/h 이상, WMO 75·86)

실행: .venv\Scripts\python pipeline\weather_om.py [--date YYYYMMDD]
자료: Open-Meteo.com (CC BY 4.0), 기상 모델 재분석·예보 값이라 관측소 실측과 다를 수 있다.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pyproj import Transformer

from cameras import Line

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "game" / "public" / "roads" / "index.json"
OUT = ROOT / "game" / "public" / "weather" / "latest.json"
URL = "https://api.open-meteo.com/v1/forecast"
KST = timezone(timedelta(hours=9))
SPACING_M = 40_000
BATCH = 50
# 무료 한도(분당 600회, 지점 하나가 1회)를 넘지 않게 묶음 사이에 쉰다
PAUSE_S = 6
# 약 5km 격자 안의 지점(양방향 주행선 등)은 한 번만 묻는다 (모델 격자도 몇 km라 차이가 없다)
GRID_DEG = 0.05
HEAVY_MM = 20.0
RAIN_MM = 0.1
FOG_CODES = {45, 48}
SNOW_CODES = {71, 73, 75, 77, 85, 86}
HEAVY_SNOW_CODES = {75, 86}
HEAVY_SNOW_CM = 1.0


def code(wmo: int | None, precip: float | None, snow: float | None, cloud: float | None) -> str:
    """한 시간의 날씨 한 글자"""
    w = int(wmo or 0)
    p = float(precip or 0)
    if w in HEAVY_SNOW_CODES or float(snow or 0) >= HEAVY_SNOW_CM:
        return "S"
    if w in SNOW_CODES or float(snow or 0) > 0:
        return "s"
    if p >= HEAVY_MM:
        return "h"
    if p >= RAIN_MM or 51 <= w <= 67 or 80 <= w <= 82 or w >= 95:
        return "r"
    if w in FOG_CODES:
        return "f"
    if float(cloud or 0) >= 70:
        return "o"
    return "c"


def sample_points(lines: list[Line]) -> list[tuple[str, int, float, float]]:
    """(주행선 id, s, 위도, 경도)"""
    tf = Transformer.from_crs("EPSG:5179", "EPSG:4326", always_xy=True)
    out = []
    for ln in lines:
        n = len(ln.x)
        length = (n - 1) * ln.step
        ss = list(range(0, int(length), SPACING_M)) + [int(length)]
        for s in sorted(set(ss)):
            i = min(n - 1, round(s / ln.step))
            lon, lat = tf.transform(float(ln.x[i]), float(ln.y[i]))
            out.append((ln.id, s, round(lat, 3), round(lon, 3)))
    return out


def fetch(points: list[tuple[str, int, float, float]], date: str) -> list[dict]:
    """지점마다 hourly 결과 (격자가 같은 지점은 같은 결과)"""
    day = f"{date[:4]}-{date[4:6]}-{date[6:]}"
    cell = lambda p: (round(p[2] / GRID_DEG), round(p[3] / GRID_DEG))  # noqa: E731
    uniq: dict[tuple[int, int], tuple[str, int, float, float]] = {}
    for p in points:
        uniq.setdefault(cell(p), p)
    keys = list(uniq)
    print(f"  격자 {len(keys)}곳에 묻는다")
    got: dict[tuple[int, int], dict] = {}
    for k in range(0, len(keys), BATCH):
        chunk = [uniq[c] for c in keys[k : k + BATCH]]
        q = {
            "latitude": ",".join(str(p[2]) for p in chunk),
            "longitude": ",".join(str(p[3]) for p in chunk),
            "hourly": "weather_code,precipitation,snowfall,cloud_cover",
            "start_date": day,
            "end_date": day,
            "timezone": "Asia/Seoul",
        }
        req = urllib.request.Request(URL + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "DRIP research (github.com/jysvai/DRIP)"})
        for attempt in range(4):
            try:
                data = json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 3:
                    raise
                print("  한도에 걸려 1분 쉰다")
                time.sleep(65)
        for c, r in zip(keys[k : k + BATCH], data if isinstance(data, list) else [data]):
            got[c] = r
        time.sleep(PAUSE_S)
    return [got[cell(p)] for p in points]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="YYYYMMDD (기본: 어제)")
    args = ap.parse_args()
    date = args.date or (datetime.now(KST) - timedelta(days=1)).strftime("%Y%m%d")
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    lines = [Line(m) for m in index["roads"]]
    points = sample_points(lines)
    print(f"{date}: 주행선 {len(lines)}개, 지점 {len(points)}곳")
    results = fetch(points, date)
    roads: dict[str, list] = {}
    counts: dict[str, int] = {}
    for (rid, s, _, _), r in zip(points, results):
        h = r["hourly"]
        hours = "".join(code(*v) for v in zip(h["weather_code"], h["precipitation"], h["snowfall"], h["cloud_cover"]))
        roads.setdefault(rid, []).append([s, hours])
        for c in hours:
            counts[c] = counts.get(c, 0) + 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "source": "Open-Meteo.com (CC BY 4.0)",
                "date": date,
                "codes": {"c": "clear", "o": "cloudy", "r": "rain", "h": "heavy_rain", "f": "fog", "s": "snow", "S": "heavy_snow"},
                "roads": roads,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    total = sum(counts.values()) or 1
    print("시간 비율:", {k: round(v / total, 3) for k, v in sorted(counts.items())}, "→", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
