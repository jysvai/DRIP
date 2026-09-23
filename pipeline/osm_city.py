"""시내 도로망: 서울의 간선도로(도시고속도로·대로·로)를 교차로에서 끊은 그래프로 만든다. 게임이 두 곳 사이 길을 찾아 달린다.

입력: OpenStreetMap (Overpass API)
      - 도로: highway=motorway·trunk·primary·secondary·tertiary와 그 연결로(_link)
      - 신호등(highway=traffic_signals), 횡단보도(highway=crossing)
      - 찾을 곳: 지하철역, 이름 있는 큰 건물(○○타워·빌딩·센터…), 대학·병원·관공서, 공원·명소
      지형 고도: AWS Terrain Tiles (osm_roads.py와 같은 것)
출력: game/public/city/<region>.json

  python pipeline/osm_city.py              서울 (받은 OSM은 data/raw/osm/city_seoul.json에 두고 다시 쓴다)
  python pipeline/osm_city.py --refresh    OSM을 새로 받는다

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
from pyproj import Transformer

from osm_roads import OVERPASS_URLS, USER_AGENT, Terrain, parse_lanes, parse_speed

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "osm"
OUT_DIR = ROOT / "game" / "public" / "city"

REGIONS = {
    "seoul": {"name": "서울", "area": '["name"="서울특별시"]["admin_level"="4"]'},
}

CLASSES = "motorway|trunk|primary|secondary|tertiary"
QUERY = """
[out:json][timeout:900];
area{area}->.a;
way["highway"~"^({classes})(_link)?$"](area.a);
out body geom;
node["highway"~"^(traffic_signals|crossing)$"](area.a);
out body;
(
  nwr["railway"="station"](area.a);
  nwr["amenity"~"^(university|hospital|townhall|library)$"]["name"](area.a);
  nwr["tourism"~"^(attraction|museum)$"]["name"](area.a);
  nwr["leisure"="park"]["name"](area.a);
  nwr["building"]["name"~"(타워|빌딩|센터|플라자|스퀘어|몰|호텔|병원|청사)"](area.a);
);
out center tags;
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
EXTRA_PLACES = [
    ("삼원타워", "건물", 127.0317054, 37.4987814),  # 서울 강남구 테헤란로 124
]


def download(region: str, refresh: bool) -> dict:
    path = RAW / f"city_{region}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    path.parent.mkdir(parents=True, exist_ok=True)
    q = QUERY.format(area=REGIONS[region]["area"], classes=CLASSES)
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
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)
    ways = []
    signals = []
    named_signals = []
    crossings = []
    places = list(EXTRA_PLACES)
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
        speed = parse_speed(t.get("maxspeed")) or CLASS_INFO[cls][2]
        if link:
            speed = min(speed, 50 if cls in ("motorway", "trunk") else 40)
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
    for ed in edges:
        if ed["cls"] in ("p", "s") and ed["name"]:
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
    z = terrain.sample(lls[:, 1], lls[:, 0])

    def q(v: float) -> int:
        return int(round(v * 10))

    out_nodes = [[q(x - origin[0]), q(y - origin[1]), round(float(z[i]), 1), int(sig[i]), deg[i]] for i, (x, y) in enumerate(node_xy)]
    out_edges = []
    for ed in edges:
        pts = ed["pts"] - origin
        flat = []
        for x, y in pts[1:-1]:
            flat += [q(x), q(y)]
        out_edges.append([ed["a"], ed["b"], flat, round(ed["len"], 1), ed["cls"], ed["lanes"], ed["speed"], int(ed["oneway"]), ed["name"], ed["ref"], int(ed["bridge"]), int(ed["tunnel"]), ed["sep"]])

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
        "name": REGIONS[region]["name"],
        "source": "OpenStreetMap contributors (ODbL), Overpass API",
        "osmTimestamp": osm.get("osm3s", {}).get("timestamp_osm_base", ""),
        "origin": [float(origin[0]), float(origin[1])],
        "scale": 0.1,
        "nodeFields": ["x", "y", "z", "signal", "degree"],
        "edgeFields": ["a", "b", "pts", "length", "cls", "lanes", "speed", "oneway", "name", "ref", "bridge", "tunnel", "sep"],
        "classes": {"m": "도시고속도로", "t": "자동차전용·간선", "p": "대로", "s": "로", "r": "길", "ml": "연결로", "tl": "연결로", "pl": "연결로", "sl": "연결로", "rl": "연결로"},
        "nodes": out_nodes,
        "nodeNames": [[i, name] for i, name in sorted(node_names.items())],
        "edges": out_edges,
        "places": out_places,
    }
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
