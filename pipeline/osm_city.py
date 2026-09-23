"""시내·국도 도로망: 지역의 간선도로를 교차로에서 끊은 그래프로 만든다. 게임이 두 곳 사이 길을 찾아 달린다.
  seoul          서울 시내 (도시고속도로·대로·로)
  gyeonggi_east  경기 동부 국도 (강동구·하남·남양주·양평·구리의 국도·지방도·시군도, 고속도로 빼고). 지형 격자·물·도로 높이 굴곡을 함께 넣는다

입력: OpenStreetMap (Overpass API)
      - 도로: highway=motorway·trunk·primary·secondary·tertiary와 그 연결로(_link)
      - 신호등(highway=traffic_signals), 횡단보도(highway=crossing)
      - 찾을 곳: 지하철역, 이름 있는 큰 건물(○○타워·빌딩·센터…), 대학·병원·관공서, 공원·명소
      지형 고도: AWS Terrain Tiles (osm_roads.py와 같은 것)
출력: game/public/city/<region>.json

  python pipeline/osm_city.py                          서울 (받은 OSM은 data/raw/osm/city_seoul.json에 두고 다시 쓴다)
  python pipeline/osm_city.py --region gyeonggi_east   경기 동부 국도
  python pipeline/osm_city.py --refresh                OSM을 새로 받는다

그래프
  node: 교차로(도로 두 개 이상이 만나는 점)나 막다른 끝. [x, y, z(m), 신호(0/1), 이어진 도로 수]
  edge: node a → b 사이 도로 한 토막. 좌표는 원점 기준 0.1m 정수, 1m 오차로 줄인 꺾은선.
        cls(도로 등급), lanes(한 방향 차로 수), speed(제한속도), oneway(1이면 a→b만), name, bridge, tunnel

신호: OSM 신호등이 교차로 30m 안에 있거나, 대로·로(primary·secondary)끼리 만나는 교차로면 신호가 있는 것으로 본다
      (OSM에는 서울 신호등의 일부만 들어 있다). 차로 수·제한속도가 없는 도로는 등급별 기본값 (안전속도 5030: 간선 50km/h).
교차로 이름: 45m 안에 이름 있는 신호등(○○사거리)이 있으면 그 이름.
마주 보는 짝(sep): 중앙분리대로 나뉜 왕복 도로는 OSM에 한 방향 도로 두 줄로 그려진다. 같은 이름·반대 방향 한 방향 도로가 50m 안에 나란히 있으면
      두 중심선 사이 거리(m)를 sep에 넣는다. 0은 한 줄로 그린 왕복 도로(가운데 중앙선), -1은 짝이 없는 일방통행.
차로 수: 한 방향 도로에 왕복 차로 수를 적은 경우가 있어 등급별 상한으로 자른다.
국도 지역(dem): 도로 토막 높이는 40m마다 지형을 따라가고(등급별 기울기 상한, 다리·터널은 양 끝 사이를 곧게), 지역 전체에 지형 격자(dem m 간격, 0.1m 정수를
      행마다 앞 값과의 차로)와 물(강·호수) 덮임(0~8)을 같은 격자로 넣는다. 게임이 산·들·강을 그린다.
좌표는 UTM-K(EPSG:5179) 미터. 도로 데이터 © OpenStreetMap contributors (ODbL).
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer

from osm_roads import OVERPASS_URLS, USER_AGENT, Terrain, parse_lanes, parse_speed

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "osm"
OUT_DIR = ROOT / "game" / "public" / "city"

def _areas(names: tuple[str, ...], level: int = 6) -> str:
    return "(" + "".join(f'area["name"="{n}"]["admin_level"="{level}"];' for n in names) + ")"


# kind: city(시내) · rural(국도). signals: all(대로·로끼리 만나면 신호로 봄) · primary(대로끼리만) · osm(OSM 신호등만)
# speeds: 제한속도가 없는 도로의 기본값 (city: 등급별 CLASS_INFO, rural: 편도 차로 수로). dem: 지형 격자 간격(m, 0이면 없음)
REGIONS = {
    "seoul": {"name": "서울", "area": 'area["name"="서울특별시"]["admin_level"="4"]', "kind": "city", "classes": "motorway|trunk|primary|secondary|tertiary", "signals": "all", "speeds": "city", "dem": 0},
    "gyeonggi_east": {
        "name": "경기 동부",
        "area": _areas(("강동구", "하남시", "남양주시", "양평군", "구리시")),
        "kind": "rural",
        # 고속도로는 고속도로 주행으로 달리므로 뺀다
        "classes": "trunk|primary|secondary|tertiary",
        "signals": "primary",
        # 도시부 밖 일반도로 (도로교통법 시행규칙 제19조: 편도 2차로 이상 80, 그 밖 60)
        "speeds": "rural",
        # 통째로 도시부로 보는 구 (서울: 안전속도 5030). 나머지는 OSM 시가지 땅으로 가린다
        "cities": ("강동구",),
        "dem": 75,
    },
}

QUERY = """
[out:json][timeout:900];
{area}->.a;
way["highway"~"^({classes})(_link)?$"](area.a);
out body geom;
node["highway"~"^(traffic_signals|crossing)$"](area.a);
out body;
(
  nwr["railway"="station"](area.a);
  nwr["amenity"~"^(university|hospital|townhall|library)$"]["name"](area.a);
  nwr["tourism"~"^(attraction|museum|viewpoint)$"]["name"](area.a);
  nwr["leisure"="park"]["name"](area.a);
  nwr["building"]["name"~"(타워|빌딩|센터|플라자|스퀘어|몰|호텔|병원|청사)"](area.a);
);
out center tags;
"""
# 물은 따로 받는다 (한강 같은 큰 면이 무거워서 지역 경계 대신 도로 범위 사각형과 겹치는 것만. 고리가 끊기지 않게 모양은 자르지 않는다)
WATER_QUERY = """
[out:json][timeout:900];
(
  way["natural"="water"]({bbox});
  relation["natural"="water"]({bbox});
  way["waterway"="riverbank"]({bbox});
  relation["waterway"="riverbank"]({bbox});
);
out geom;
"""
# 시가지: 주거·상업·공업 용도 땅. 제한속도가 적히지 않은 도로의 기본값(도로교통법 시행규칙 제19조)과 읍내 풍경에 쓴다
URBAN = ("residential", "commercial", "industrial", "retail")
URBAN_QUERY = """
[out:json][timeout:900];
(
  way["landuse"~"^(residential|commercial|industrial|retail)$"]({bbox});
  relation["landuse"~"^(residential|commercial|industrial|retail)$"]({bbox});
);
out geom;
"""
CITY_AREA_QUERY = """
[out:json][timeout:300];
relation["boundary"="administrative"]["admin_level"="6"]["name"~"^({names})$"]({bbox});
out geom;
"""

# 등급: 코드, 한 방향 기본 차로 수, 기본 제한속도(km/h)
CLASS_INFO = {
    "motorway": ("m", 3, 80),
    "trunk": ("t", 3, 70),
    "primary": ("p", 3, 50),
    "secondary": ("s", 2, 50),
    "tertiary": ("r", 1, 50),
}
SIGNAL_RADIUS = 30.0
NAME_RADIUS = 45.0
SIMPLIFY_TOL = 1.0
# 한 방향 차로 수 상한 (등급별). 한 방향 도로에 왕복 차로 수를 적은 경우를 자른다
MAX_LANES = {"motorway": 6, "trunk": 5, "primary": 5, "secondary": 4, "tertiary": 3}
# 마주 보는 짝을 찾는 거리 (m)
PAIR_RADIUS = 50.0
# OSM에서 찾을 수 없는 곳 (이름, 종류, 경도, 위도): 주소 검색(Nominatim)으로 확인한 좌표
EXTRA_PLACES = {
    "seoul": [
        ("삼원타워", "건물", 127.0317054, 37.4987814),  # 서울 강남구 테헤란로 124
    ],
}
# 도로 토막 높이 굴곡: 20m마다 지형을 재서 ±80m로 고르고 기울기를 자른 뒤 40m마다 남긴다
PROFILE_STEP = 40.0
# 등급별 기울기 상한 (도로의 구조·시설 기준에 관한 규칙의 최대 종단경사 언저리: 국도 6~8%, 지방도 8~10%, 산지 시군도는 더 가파르다)
MAX_GRADE = {"t": 0.08, "p": 0.08, "s": 0.1, "r": 0.13}


def download(region: str, refresh: bool, query: str | None = None, suffix: str = "") -> dict:
    path = RAW / f"city_{region}{suffix}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    path.parent.mkdir(parents=True, exist_ok=True)
    r = REGIONS[region]
    q = query or QUERY.replace("{area}", r["area"]).replace("{classes}", r["classes"])
    body = urllib.parse.urlencode({"data": q}).encode()
    err = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=900) as res:
                raw = res.read()
            json.loads(raw)
            path.write_bytes(raw)
            return json.loads(raw)
        except Exception as e:  # 서버가 바쁘면 다음 미러로
            err = e
    raise SystemExit(f"Overpass 서버에서 받지 못했습니다: {err}")


def simplify(pts: np.ndarray, tol: float) -> np.ndarray:
    """Douglas–Peucker: 양 끝은 남기고 tol(m) 안으로 줄인다."""
    if len(pts) <= 2:
        return pts
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        a, b = pts[i], pts[j]
        ab = b - a
        L = float(np.hypot(*ab))
        seg = pts[i + 1 : j]
        if not len(seg):
            continue
        if L < 1e-6:
            dist = np.hypot(*(seg - a).T)
        else:
            dist = np.abs(ab[0] * (seg[:, 1] - a[1]) - ab[1] * (seg[:, 0] - a[0])) / L
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack += [(i, m), (m, j)]
    return pts[keep]


def way_class(tags: dict) -> tuple[str, bool]:
    hw = tags.get("highway", "")
    link = hw.endswith("_link")
    return hw[:-5] if link else hw, link


def rings(parts: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """끝이 맞닿은 꺾은선들을 이어 닫힌 고리로 (멀티폴리곤 바깥·안 고리는 여러 way로 나뉘어 있다)."""
    todo = [list(p) for p in parts if len(p) >= 2]
    out = []
    while todo:
        ring = todo.pop()
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, p in enumerate(todo):
                if p[0] == ring[-1]:
                    ring += p[1:]
                elif p[-1] == ring[-1]:
                    ring += p[::-1][1:]
                elif p[-1] == ring[0]:
                    ring = p[:-1] + ring
                elif p[0] == ring[0]:
                    ring = p[::-1][:-1] + ring
                else:
                    continue
                todo.pop(i)
                changed = True
                break
        if len(ring) >= 4:
            out.append(ring)
    return out


def is_water(t: dict) -> bool:
    return t.get("natural") == "water" or t.get("waterway") == "riverbank"


def is_urban(t: dict) -> bool:
    return t.get("landuse") in URBAN


def area_polygons(osm: dict, keep) -> list[tuple[list, list]]:
    """면(물·시가지 등): (바깥 고리들, 안 고리들) 경위도."""
    out = []
    for e in osm["elements"]:
        t = e.get("tags", {})
        if not keep(t):
            continue
        if e["type"] == "way" and "geometry" in e:
            out.append(([[(p["lon"], p["lat"]) for p in e["geometry"] if p]], []))
        elif e["type"] == "relation":
            outer = [[(p["lon"], p["lat"]) for p in m["geometry"] if p] for m in e.get("members", []) if m.get("type") == "way" and m.get("role") != "inner" and m.get("geometry")]
            inner = [[(p["lon"], p["lat"]) for p in m["geometry"] if p] for m in e.get("members", []) if m.get("type") == "way" and m.get("role") == "inner" and m.get("geometry")]
            out.append((rings(outer), rings(inner)))
    return out


def lanes_per_direction(tags: dict, cls: str, oneway: bool) -> int:
    default = CLASS_INFO[cls][1]
    fwd = parse_lanes(tags.get("lanes:forward"))
    if fwd:
        return fwd
    total = parse_lanes(tags.get("lanes"))
    if total:
        return max(1, min(MAX_LANES[cls], total if oneway else total // 2))
    return 1 if tags.get("highway", "").endswith("_link") else default


def build(region: str, refresh: bool):
    osm = download(region, refresh)
    R = REGIONS[region]
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)
    to_ll = Transformer.from_crs("EPSG:5179", "EPSG:4326", always_xy=True)
    ways = []
    signals = []
    named_signals = []
    crossings = []
    places = list(EXTRA_PLACES.get(region, []))
    for e in osm["elements"]:
        t = e.get("tags", {})
        if e["type"] == "way" and "geometry" in e and t.get("highway", "").split("_link")[0] in CLASS_INFO and "nodes" in e:
            if t.get("area") == "yes" or t.get("access") == "no":
                continue
            ways.append(e)
        elif e["type"] == "node" and t.get("highway") == "traffic_signals":
            signals.append((e["lon"], e["lat"]))
            if t.get("name"):
                named_signals.append((e["lon"], e["lat"], t["name"]))
        elif e["type"] == "node" and t.get("highway") == "crossing":
            crossings.append((e["lon"], e["lat"]))
        if t.get("name") and (t.get("railway") == "station" or t.get("amenity") or t.get("tourism") or t.get("leisure") or t.get("building")):
            c = e.get("center") or ({"lon": e["lon"], "lat": e["lat"]} if "lon" in e else None)
            if c:
                kind = "역" if t.get("railway") == "station" else "건물" if t.get("building") else "명소"
                name = t["name"]
                if kind == "역" and not name.endswith("역"):
                    name += "역"
                places.append((name, kind, c["lon"], c["lat"]))

    # 여러 도로가 공유하는 OSM 점 = 교차로
    use = defaultdict(int)
    for w in ways:
        for k, nid in enumerate(w["nodes"]):
            use[nid] += 1 if 0 < k < len(w["nodes"]) - 1 else 1
    ends = set()
    for w in ways:
        ends.add(w["nodes"][0])
        ends.add(w["nodes"][-1])
    split = {nid for nid, c in use.items() if c >= 2} | ends

    # 읍내: 250m 칸 3x3에 이름 있는 건물·역(역은 2)이 4 넘게 (게임 그림의 CityScene.town과 같은 셈).
    # 제한속도가 적히지 않은 읍내 도로는 주거·상업지역 일반도로로 본다 (도로교통법 시행규칙 제19조: 50km/h)
    dens: dict[tuple[int, int], int] = defaultdict(int)
    if R["speeds"] == "rural":
        by_place = defaultdict(list)
        for name, kind, lon, lat in places:
            if kind in ("건물", "역"):
                by_place[(name, kind)].append((lon, lat))
        for (name, kind), pts_ll in by_place.items():
            px, py = to_utm.transform(float(np.mean([p[0] for p in pts_ll])), float(np.mean([p[1] for p in pts_ll])))
            dens[(int(px // 250), int(py // 250))] += 2 if kind == "역" else 1

    def in_town(x: float, y: float) -> bool:
        cx, cy = int(x // 250), int(y // 250)
        return sum(dens.get((cx + dx, cy + dy), 0) for dx in (-1, 0, 1) for dy in (-1, 0, 1)) >= 4

    node_index: dict[int, int] = {}
    node_xy: list[tuple[float, float]] = []
    node_ll: list[tuple[float, float]] = []
    deg = defaultdict(int)
    edges = []

    def node_of(nid: int, lon: float, lat: float) -> int:
        if nid not in node_index:
            node_index[nid] = len(node_xy)
            x, y = to_utm.transform(lon, lat)
            node_xy.append((x, y))
            node_ll.append((lon, lat))
        return node_index[nid]

    for w in ways:
        t = w["tags"]
        cls, link = way_class(t)
        ow = t.get("oneway", "no")
        if t.get("junction") == "roundabout":
            ow = "yes"
        oneway = ow in ("yes", "1", "true", "-1") or (cls == "motorway" and ow != "no")
        rev = ow == "-1"
        nodes = w["nodes"]
        geom = w["geometry"]
        if rev:
            nodes = nodes[::-1]
            geom = geom[::-1]
        lanes = lanes_per_direction(t, cls, oneway)
        tagged = parse_speed(t.get("maxspeed"))
        speed = tagged or ((80 if lanes >= 2 else 60) if R["speeds"] == "rural" else CLASS_INFO[cls][2])
        if link:
            speed = min(speed, 50 if cls in ("motorway", "trunk") else 40)
        town_speed = min(speed, 50) if not tagged and R["speeds"] == "rural" and cls != "trunk" else speed
        start = 0
        for k in range(1, len(nodes)):
            if nodes[k] in split or k == len(nodes) - 1:
                seg = geom[start : k + 1]
                if len(seg) >= 2:
                    a = node_of(nodes[start], seg[0]["lon"], seg[0]["lat"])
                    b = node_of(nodes[k], seg[-1]["lon"], seg[-1]["lat"])
                    if a != b:
                        xs, ys = to_utm.transform([p["lon"] for p in seg], [p["lat"] for p in seg])
                        pts = simplify(np.column_stack([xs, ys]), SIMPLIFY_TOL)
                        length = float(np.sum(np.hypot(*np.diff(pts, axis=0).T)))
                        edges.append({
                            "a": a,
                            "b": b,
                            "pts": pts,
                            "len": length,
                            "cls": CLASS_INFO[cls][0] + ("l" if link else ""),
                            "lanes": lanes,
                            "speed": speed,
                            "town_speed": town_speed,
                            "oneway": oneway,
                            "name": t.get("name", ""),
                            "ref": t.get("ref", ""),
                            "bridge": t.get("bridge", "no") not in ("no", ""),
                            "tunnel": t.get("tunnel", "no") not in ("no", ""),
                        })
                        deg[a] += 1
                        deg[b] += 1
                start = k

    xy = np.array(node_xy)
    origin = np.floor(xy.min(axis=0) / 1000) * 1000

    # 신호: OSM 신호등이 30m 안이거나, 대로·로끼리 만나는 교차로
    sig = np.zeros(len(xy), bool)
    if signals:
        sx, sy = to_utm.transform([p[0] for p in signals], [p[1] for p in signals])
        grid = defaultdict(list)
        for x, y in zip(sx, sy):
            grid[(int(x // 50), int(y // 50))].append((x, y))
        for i, (x, y) in enumerate(node_xy):
            gx, gy = int(x // 50), int(y // 50)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for (px, py) in grid.get((gx + dx, gy + dy), ()):
                        if (px - x) ** 2 + (py - y) ** 2 < SIGNAL_RADIUS**2:
                            sig[i] = True
    arterial = defaultdict(set)
    infer = {"all": ("p", "s"), "primary": ("p",), "osm": ()}[R["signals"]]
    for ed in edges:
        if ed["cls"] in infer and ed["name"]:
            arterial[ed["a"]].add(ed["name"])
            arterial[ed["b"]].add(ed["name"])
    for i, names in arterial.items():
        if len(names) >= 2:
            sig[i] = True

    # 교차로 이름: 가장 가까운 이름 있는 신호등 (45m 안)
    node_names: dict[int, str] = {}
    if named_signals:
        nx_, ny_ = to_utm.transform([p[0] for p in named_signals], [p[1] for p in named_signals])
        ngrid = defaultdict(list)
        for x, y, (_, _, name) in zip(nx_, ny_, named_signals):
            ngrid[(int(x // 50), int(y // 50))].append((x, y, name))
        for i, (x, y) in enumerate(node_xy):
            if deg[i] < 3:
                continue
            best = (NAME_RADIUS**2, "")
            gx, gy = int(x // 50), int(y // 50)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for (px, py, name) in ngrid.get((gx + dx, gy + dy), ()):
                        d2 = (px - x) ** 2 + (py - y) ** 2
                        if d2 < best[0]:
                            best = (d2, name)
            if best[1]:
                node_names[i] = best[1]

    # 마주 보는 짝: 10m마다 점을 찍어, 같은 이름·반대 방향 한 방향 도로가 옆(50m 안)에 있는지 본다
    samples = defaultdict(list)  # 칸 → (x, y, 방향x, 방향y, 도로 번호)
    per_edge: dict[int, list] = {}
    for k, ed in enumerate(edges):
        if not ed["oneway"] or ed["cls"].endswith("l") or not ed["name"]:
            continue
        pts = ed["pts"]
        seg = np.diff(pts, axis=0)
        L = np.hypot(seg[:, 0], seg[:, 1])
        cum = np.concatenate([[0.0], np.cumsum(L)])
        mine = []
        for t in np.arange(min(5.0, cum[-1] / 2), cum[-1], 10.0):
            i = int(min(max(np.searchsorted(cum, t) - 1, 0), len(seg) - 1))
            f = (t - cum[i]) / max(L[i], 1e-6)
            p = pts[i] + seg[i] * f
            d = seg[i] / max(L[i], 1e-6)
            rec = (float(p[0]), float(p[1]), float(d[0]), float(d[1]), k)
            samples[(int(p[0] // PAIR_RADIUS), int(p[1] // PAIR_RADIUS))].append(rec)
            mine.append(rec)
        per_edge[k] = mine
    for k, ed in enumerate(edges):
        if not ed["oneway"]:
            ed["sep"] = 0.0
            continue
        mine = per_edge.get(k, [])
        found = []
        for (x, y, dx, dy, _) in mine:
            best = None
            gx, gy = int(x // PAIR_RADIUS), int(y // PAIR_RADIUS)
            for ox in (-1, 0, 1):
                for oy in (-1, 0, 1):
                    for (qx, qy, ex, ey, j) in samples.get((gx + ox, gy + oy), ()):
                        if j == k or edges[j]["name"] != ed["name"] or dx * ex + dy * ey > -0.8:
                            continue
                        rx, ry = qx - x, qy - y
                        along = rx * dx + ry * dy
                        side = rx * dy - ry * dx  # 오른쪽 +
                        # 짝은 왼쪽에 있다 (한국은 오른쪽 통행)
                        if abs(along) > 12 or side > -1 or -side > PAIR_RADIUS:
                            continue
                        if best is None or -side < best:
                            best = -side
            if best is not None:
                found.append(best)
        ed["sep"] = round(float(np.median(found)), 1) if mine and len(found) >= max(1, len(mine) // 2) else -1.0

    # 고도: 교차로마다 지형, 토막 안은 두 끝 사이를 곧게 (다리는 강 위로, 터널은 산 속으로)
    terrain = Terrain()
    lls = np.array(node_ll)
    # 국도: 분리대로 나뉜 상·하행(짝 있는 한 방향 도로)은 두 차도 가운데(분리대) 줄의 지형을 함께 쓴다.
    # 차도마다 제 자리 지형을 재면 비탈을 가로지르는 곳에서 9m 떨어진 두 차도 높이가 1m 넘게 달라진다
    if R["dem"]:
        node_edges = defaultdict(list)
        for ed in edges:
            node_edges[ed["a"]].append(ed)
            node_edges[ed["b"]].append(ed)
        mx = np.array([p[0] for p in node_xy], dtype=float)
        my = np.array([p[1] for p in node_xy], dtype=float)
        for n, eds in node_edges.items():
            # 분리대 도로의 점 (교차로 점도 그 도로 차도들 방향으로)
            paired = [ed for ed in eds if ed["oneway"] and ed["sep"] > 0]
            if not paired:
                continue
            dx = dy = 0.0
            for ed in paired:
                pts = ed["pts"]
                d = pts[1] - pts[0] if ed["a"] == n else pts[-1] - pts[-2]
                dl = float(np.hypot(*d)) or 1.0
                dx += d[0] / dl
                dy += d[1] / dl
            dl = float(np.hypot(dx, dy))
            if dl < 0.5 * len(paired):  # 방향이 엇갈리면 (서로 다른 차도가 만나는 점) 그대로
                continue
            half = sum(ed["sep"] for ed in paired) / len(paired) / 2
            mx[n] -= dy / dl * half
            my[n] += dx / dl * half
        slon, slat = to_ll.transform(mx, my)
        z = terrain.sample(np.asarray(slat), np.asarray(slon))
    else:
        z = terrain.sample(lls[:, 1], lls[:, 0])

    def q(v: float) -> int:
        return int(round(v * 10))

    # 국도: 도로 토막 높이가 지형을 따라간다 (다리·터널은 양 끝 사이를 곧게)
    profiles: dict[int, list[int]] = {}
    if R["dem"]:
        todo = []
        for k, ed in enumerate(edges):
            if ed["bridge"] or ed["tunnel"] or ed["len"] < 2 * PROFILE_STEP:
                continue
            pts = ed["pts"]
            seg = np.diff(pts, axis=0)
            L = np.hypot(seg[:, 0], seg[:, 1])
            cum = np.concatenate([[0.0], np.cumsum(L)])
            u = np.linspace(0.0, cum[-1], max(3, int(cum[-1] // 20) + 1))
            px = np.interp(u, cum, pts[:, 0])
            py = np.interp(u, cum, pts[:, 1])
            if ed["oneway"] and ed["sep"] > 0:
                # 분리대 가운데 줄 (왼쪽으로 sep/2)
                i = np.clip(np.searchsorted(cum, u, side="right") - 1, 0, len(seg) - 1)
                tx = seg[i, 0] / np.maximum(L[i], 1e-6)
                ty = seg[i, 1] / np.maximum(L[i], 1e-6)
                px = px - ty * ed["sep"] / 2
                py = py + tx * ed["sep"] / 2
            todo.append((k, u, px, py))
        if todo:
            allx = np.concatenate([t[2] for t in todo])
            ally = np.concatenate([t[3] for t in todo])
            lon, lat = to_ll.transform(allx, ally)
            zall = terrain.sample(np.asarray(lat), np.asarray(lon))
            at = 0
            for k, u, px, _ in todo:
                zr = zall[at : at + len(u)]
                at += len(u)
                win = 4
                pad = np.pad(zr, win, mode="edge")
                zs = np.convolve(pad, np.ones(2 * win + 1) / (2 * win + 1), mode="valid")
                ed = edges[k]
                t = u / u[-1]
                zs = zs + (z[ed["a"]] - zs[0]) * (1 - t) + (z[ed["b"]] - zs[-1]) * t
                # 기울기 상한 (30m 지형은 비탈을 깎아 낸 도로에서 옆 산비탈이 섞인다): 앞·뒤로 자른 것의 평균, 양 끝은 다시 교차로 높이로
                g = MAX_GRADE.get(ed["cls"][0], 0.1) if not ed["cls"].endswith("l") else 0.08
                du = np.diff(u)
                zf = zs.copy()
                for i in range(1, len(zf)):
                    zf[i] = min(max(zf[i], zf[i - 1] - g * du[i - 1]), zf[i - 1] + g * du[i - 1])
                zb = zs.copy()
                for i in range(len(zb) - 2, -1, -1):
                    zb[i] = min(max(zb[i], zb[i + 1] - g * du[i]), zb[i + 1] + g * du[i])
                zs = (zf + zb) / 2
                zs = zs + (z[ed["a"]] - zs[0]) * (1 - t) + (z[ed["b"]] - zs[-1]) * t
                n = max(2, int(round(u[-1] / PROFILE_STEP)) + 1)
                profiles[k] = [q(v) for v in np.interp(np.linspace(0.0, u[-1], n), u, zs)]

    # 국도: 지형 격자와 물 덮임
    dem = None
    if R["dem"]:
        step = float(R["dem"])
        lo = np.floor((xy.min(axis=0) - 1500) / step) * step
        hi = np.ceil((xy.max(axis=0) + 1500) / step) * step
        nx = int((hi[0] - lo[0]) / step) + 1
        ny = int((hi[1] - lo[1]) / step) + 1
        gx, gy = np.meshgrid(lo[0] + np.arange(nx) * step, lo[1] + np.arange(ny) * step)
        glon, glat = to_ll.transform(gx.ravel(), gy.ravel())
        gz = terrain.sample(np.asarray(glat), np.asarray(glon)).reshape(ny, nx)
        zq = np.round(gz * 10).astype(np.int64)
        rows = []
        for j in range(ny):
            r = zq[j]
            rows.append([int(r[0])] + [int(v) for v in np.diff(r)])
        # 물·시가지: 한 칸을 3×3으로 잘게 칠한 뒤 덮인 비율
        fine = step / 3

        def pix(ring):
            xs_, ys_ = to_utm.transform([p[0] for p in ring], [p[1] for p in ring])
            return [((x - lo[0]) / fine + 1, (y - lo[1]) / fine + 1) for x, y in zip(xs_, ys_)]

        # 물: 격자 범위(경위도)로 잘라 받는다
        blon, blat = to_ll.transform([lo[0], hi[0]], [lo[1], hi[1]])
        bbox = f"{min(blat):.5f},{min(blon):.5f},{max(blat):.5f},{max(blon):.5f}"

        def coverage(polys) -> np.ndarray:
            """칸마다 면이 덮은 비율 (0~8)"""
            img = Image.new("L", (nx * 3, ny * 3), 0)
            draw = ImageDraw.Draw(img)
            for outer, inner in polys:
                for ring in outer:
                    draw.polygon(pix(ring), fill=255)
                for ring in inner:
                    draw.polygon(pix(ring), fill=0)
            m = (np.asarray(img, dtype=np.float64) / 255.0).reshape(ny, 3, nx, 3).mean(axis=(1, 3))
            return np.round(m * 8).astype(int)

        def runs_of(cover: np.ndarray) -> list[list[int]]:
            """줄마다 (값, 개수) 반복"""
            out_rows = []
            for j in range(ny):
                r = cover[j]
                runs = []
                i = 0
                while i < nx:
                    k2 = i
                    while k2 < nx and r[k2] == r[i]:
                        k2 += 1
                    runs += [int(r[i]), k2 - i]
                    i = k2
                out_rows.append(runs)
            return out_rows

        polys = area_polygons(download(region, refresh, WATER_QUERY.replace("{bbox}", bbox), "_water"), is_water)
        cover = coverage(polys)
        upolys = area_polygons(download(region, refresh, URBAN_QUERY.replace("{bbox}", bbox), "_urban"), is_urban)
        if R.get("cities"):
            q_city = CITY_AREA_QUERY.replace("{names}", "|".join(R["cities"])).replace("{bbox}", bbox)
            upolys += area_polygons(download(region, refresh, q_city, "_cities"), lambda t: t.get("boundary") == "administrative")
        ucover = coverage(upolys)
        # 제한속도가 적히지 않은 도로: 시가지(또는 이름 있는 건물이 모인 읍내)면 50km/h
        slowed = 0.0
        for ed in edges:
            if ed["town_speed"] == ed["speed"]:
                continue
            mx, my = ed["pts"][len(ed["pts"]) // 2]
            ci = int(round((mx - lo[0]) / step))
            cj = int(round((my - lo[1]) / step))
            # 넓은 길은 시가지 땅 사이로 지나서 바로 옆 칸까지 본다
            near = ucover[max(0, cj - 1) : cj + 2, max(0, ci - 1) : ci + 2]
            if (near.size and (ucover[min(cj, ny - 1), min(ci, nx - 1)] >= 4 or near.mean() >= 3)) or in_town(mx, my):
                ed["speed"] = ed["town_speed"]
                slowed += ed["len"]
        dem = {"x0": float(lo[0] - origin[0]), "y0": float(lo[1] - origin[1]), "step": step, "nx": nx, "ny": ny, "z": rows, "water": runs_of(cover), "urban": runs_of(ucover)}
        print(f"지형 격자 {nx}×{ny} ({step:.0f}m), 물 면 {len(polys)}개, 물 칸 {int((cover >= 4).sum())}, 시가지 면 {len(upolys)}개, 시가지 칸 {int((ucover >= 4).sum())}, 50km/h로 둔 도로 {slowed / 1000:.0f}km")

    out_nodes = [[q(x - origin[0]), q(y - origin[1]), round(float(z[i]), 1), int(sig[i]), deg[i]] for i, (x, y) in enumerate(node_xy)]
    out_edges = []
    for ed in edges:
        pts = ed["pts"] - origin
        flat = []
        for x, y in pts[1:-1]:
            flat += [q(x), q(y)]
        row = [ed["a"], ed["b"], flat, round(ed["len"], 1), ed["cls"], ed["lanes"], ed["speed"], int(ed["oneway"]), ed["name"], ed["ref"], int(ed["bridge"]), int(ed["tunnel"]), ed["sep"]]
        if R["dem"]:
            row.append(profiles.get(len(out_edges), 0))
        out_edges.append(row)

    # 찾을 곳: 이름이 같으면 하나만 (역은 출입구·승강장이 여러 점이라 가운데로)
    by_name = defaultdict(list)
    for name, kind, lon, lat in places:
        by_name[(name, kind)].append((lon, lat))
    out_places = []
    for (name, kind), pts_ll in sorted(by_name.items()):
        lon = float(np.mean([p[0] for p in pts_ll]))
        lat = float(np.mean([p[1] for p in pts_ll]))
        x, y = to_utm.transform(lon, lat)
        out_places.append([name, kind, q(x - origin[0]), q(y - origin[1])])

    out = {
        "region": region,
        "name": R["name"],
        "kind": R["kind"],
        "source": "OpenStreetMap contributors (ODbL), Overpass API",
        "osmTimestamp": osm.get("osm3s", {}).get("timestamp_osm_base", ""),
        "origin": [float(origin[0]), float(origin[1])],
        "scale": 0.1,
        "nodeFields": ["x", "y", "z", "signal", "degree"],
        "edgeFields": ["a", "b", "pts", "length", "cls", "lanes", "speed", "oneway", "name", "ref", "bridge", "tunnel", "sep"] + (["zs"] if R["dem"] else []),
        "classes": {"m": "도시고속도로", "t": "자동차전용·간선", "p": "대로", "s": "로", "r": "길", "ml": "연결로", "tl": "연결로", "pl": "연결로", "sl": "연결로", "rl": "연결로"},
        "nodes": out_nodes,
        "nodeNames": [[i, name] for i, name in sorted(node_names.items())],
        "edges": out_edges,
        "places": out_places,
    }
    if dem:
        out["dem"] = dem
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{region}.json"
    path.write_bytes(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    n_sig = int(sig.sum())
    n_pair = sum(1 for ed in edges if ed["sep"] > 0)
    n_one = sum(1 for ed in edges if ed["sep"] < 0)
    print(
        f"{REGIONS[region]['name']}: 교차로·끝 {len(out_nodes)}개 (신호 {n_sig}, 이름 {len(node_names)}), 도로 토막 {len(out_edges)}개"
        f" (짝 있는 한 방향 {n_pair}, 일방통행 {n_one}), 찾을 곳 {len(out_places)}곳, {path.stat().st_size / 1e6:.1f}MB"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="seoul", choices=sorted(REGIONS))
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    build(a.region, a.refresh)


if __name__ == "__main__":
    main()
