"""전국 고속도로를 게임용 주행선(노선·방향별 한 줄)으로 만든다.

입력: OpenStreetMap 고속도로(highway=motorway)와 IC·JC(motorway_junction). Overpass API로 받는다.
      지형 고도: AWS Open Data Terrain Tiles (terrarium, SRTM 기반 약 30m 해상도)
출력: game/public/roads/index.json      노선 목록
      game/public/roads/<id>.json       주행선 한 줄: 10m 간격 좌표·고도, 차로 수, 제한속도, 교량·터널, IC·JC, 주변 지형

좌표는 UTM-K(EPSG:5179) 미터 단위. 게임은 이 값을 그대로 쓴다.
도로 데이터 © OpenStreetMap contributors (ODbL).

실행: .venv\\Scripts\\python pipeline\\osm_roads.py
"""

import argparse
import io
import json
import math
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
OSM_PATH = RAW_DIR / "osm" / "kr_motorways.json"
TILE_DIR = RAW_DIR / "terrain"
OUT_DIR = ROOT / "game" / "public" / "roads"

OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
OVERPASS_QUERY = """
[out:json][timeout:600];
area["ISO3166-1"="KR"][admin_level=2]->.kr;
way["highway"="motorway"](area.kr);
out body geom;
node["highway"="motorway_junction"](area.kr);
out body;
"""
USER_AGENT = "DRIP-pipeline/0.1 (+https://github.com/jysvai/DRIP)"
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TILE_ZOOM = 12

STEP = 10.0             # 주행선 좌표 간격(m)
SMOOTH_SIGMA = 20.0     # 좌표를 매끄럽게 하는 폭(m). OSM 꺾인 점 때문에 곡률이 튀지 않게 한다.
MIN_CHAIN_KM = 5.0      # 이보다 짧은 조각은 버린다 (램프·요금소 부근 자투리)
MAX_GRADE = 0.07        # 고속도로 최대 종단경사 근사

# 지형 띠: 주행선 기준 좌우 거리(m)와 앞뒤 간격(m)
TERRAIN_STEP = 40.0
TERRAIN_OFFSETS = [-900, -600, -400, -260, -170, -110, -70, -45, 45, 70, 110, 170, 260, 400, 600, 900]

# 방향 이름을 붙일 때 쓰는 주요 지명 (위도, 경도). 주행선 끝점에서 가장 가까운 곳을 방향으로 쓴다.
PLACES = {
    "서울": (37.50, 127.03), "인천": (37.46, 126.70), "수원": (37.27, 127.01), "성남": (37.42, 127.13),
    "판교": (37.40, 127.10), "하남": (37.54, 127.21), "구리": (37.60, 127.14), "퇴계원": (37.65, 127.14),
    "일산": (37.66, 126.77), "김포": (37.62, 126.72), "파주": (37.76, 126.78), "문산": (37.86, 126.79),
    "안산": (37.32, 126.83), "시흥": (37.38, 126.80), "안양": (37.39, 126.95), "광명": (37.48, 126.86),
    "용인": (37.24, 127.18), "오산": (37.15, 127.07), "화성": (37.20, 126.83), "평택": (36.99, 127.09),
    "이천": (37.27, 127.44), "여주": (37.30, 127.64), "양평": (37.49, 127.49), "화도": (37.65, 127.30),
    "포천": (37.89, 127.20), "양주": (37.78, 127.05), "인천공항": (37.46, 126.44), "송도": (37.38, 126.66),
    "춘천": (37.88, 127.73), "홍천": (37.69, 127.89), "원주": (37.34, 127.92), "강릉": (37.75, 128.88),
    "양양": (38.08, 128.63), "속초": (38.21, 128.59), "동해": (37.52, 129.11), "삼척": (37.45, 129.17),
    "근덕": (37.36, 129.22), "제천": (37.13, 128.19), "충주": (36.99, 127.93), "청주": (36.64, 127.49),
    "세종": (36.48, 127.29), "천안": (36.81, 127.15), "아산": (36.79, 127.00), "당진": (36.89, 126.63),
    "서산": (36.78, 126.45), "대전": (36.35, 127.38), "서대전": (36.32, 127.36), "산내": (36.28, 127.47),
    "공주": (36.45, 127.12), "논산": (36.19, 127.10), "서천": (36.08, 126.69), "익산": (35.95, 126.96),
    "전주": (35.82, 127.15), "완주": (35.90, 127.16), "새만금": (35.80, 126.62), "군산": (35.97, 126.74),
    "장수": (35.65, 127.52), "고창": (35.44, 126.70), "담양": (35.32, 126.99), "장성": (35.30, 126.78),
    "광주": (35.16, 126.85), "무안": (34.99, 126.48), "목포": (34.81, 126.39), "영암": (34.80, 126.70),
    "순천": (34.95, 127.49), "광양": (34.94, 127.70), "여수": (34.76, 127.66), "진주": (35.18, 128.11),
    "함안": (35.27, 128.41), "창원": (35.23, 128.68), "마산": (35.21, 128.57), "김해": (35.23, 128.88),
    "통영": (34.85, 128.43), "부산": (35.18, 129.08), "기장": (35.24, 129.22), "양산": (35.34, 129.04),
    "울산": (35.54, 129.31), "언양": (35.56, 129.13), "밀양": (35.50, 128.75), "함양": (35.52, 127.73),
    "대구": (35.87, 128.60), "달서": (35.83, 128.53), "상매": (35.93, 128.70), "현풍": (35.69, 128.45),
    "포항": (36.02, 129.34), "경주": (35.86, 129.22), "영천": (35.97, 128.94), "상주": (36.41, 128.16),
    "영덕": (36.42, 129.37), "안동": (36.57, 128.73), "구미": (36.12, 128.34), "김천": (36.14, 128.11),
    "영주": (36.81, 128.62), "문경": (36.59, 128.19), "평창": (37.37, 128.39), "시흥(평택시흥)": (37.35, 126.75),
}


# ---------- 원본 받기 ----------

def download_osm(path: Path = OSM_PATH) -> dict:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        body = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
        last_error = None
        for url in OVERPASS_URLS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=900) as res:
                    raw = res.read()
                json.loads(raw)
                path.write_bytes(raw)
                break
            except Exception as error:  # 서버가 바쁘면 다음 미러로
                last_error = error
        else:
            raise SystemExit(f"Overpass 서버에서 받지 못했습니다: {last_error}")
    return json.loads(path.read_text(encoding="utf-8"))


# ---------- 길이·좌표 ----------

def haversine(lat1, lon1, lat2, lon2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_speed(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value.split()[0].split(";")[0])
    except ValueError:
        return None


def parse_lanes(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return max(1, min(8, int(value.split(";")[0])))
    except ValueError:
        return None


# ---------- 주행선 엮기 ----------

def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dl) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dl)
    return math.degrees(math.atan2(x, y))


def turn(b1: float, b2: float) -> float:
    return abs((b2 - b1 + 180) % 360 - 180)


class Way:
    __slots__ = ("id", "nodes", "geom", "tags", "length", "start_bearing", "end_bearing")

    def __init__(self, element: dict):
        self.id = element["id"]
        self.tags = element.get("tags", {})
        nodes = element["nodes"]
        geom = [(p["lat"], p["lon"]) for p in element["geometry"]]
        if self.tags.get("oneway") == "-1":
            nodes, geom = nodes[::-1], geom[::-1]
        self.nodes = nodes
        self.geom = geom
        self.length = sum(haversine(*geom[i], *geom[i + 1]) for i in range(len(geom) - 1))
        # 끝부분 방향은 끝에서 30m쯤 떨어진 점으로 잰다 (마지막 한 칸은 너무 짧을 수 있다)
        self.start_bearing = bearing(geom[0], self._point_from(geom, 30.0))
        self.end_bearing = bearing(self._point_from(geom[::-1], 30.0), geom[-1])

    @staticmethod
    def _point_from(geom, dist):
        acc = 0.0
        for i in range(len(geom) - 1):
            acc += haversine(*geom[i], *geom[i + 1])
            if acc >= dist:
                return geom[i + 1]
        return geom[-1]

    @property
    def refs(self) -> list[str]:
        return [r.strip() for r in self.tags.get("ref", "").split(";") if r.strip()]


def extract_chains(ways: list[Way]) -> list[list[Way]]:
    """같은 노선번호의 일방통행 조각들을 이어서, 가장 긴 연속 주행선부터 차례로 뽑는다."""
    remaining = {w.id: w for w in ways}
    chains = []
    while remaining:
        # 다음 조각 후보: 끝 노드를 공유하거나 25m 안에서 시작하는 조각. 되돌아가는 연결(U턴)은 뺀다.
        grid = defaultdict(list)
        for w in remaining.values():
            grid[(round(w.geom[0][0] * 1000), round(w.geom[0][1] * 1000))].append(w)
        successors: dict[int, list[Way]] = {}
        has_incoming = set()
        for w in remaining.values():
            end = w.geom[-1]
            cands = []
            gx, gy = round(end[0] * 1000), round(end[1] * 1000)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for nxt in grid.get((gx + dx, gy + dy), []):
                        if nxt.id == w.id or turn(w.end_bearing, nxt.start_bearing) > 75:
                            continue
                        if nxt.nodes[0] == w.nodes[-1] or haversine(*end, *nxt.geom[0]) < 25:
                            cands.append(nxt)
            successors[w.id] = cands
            for nxt in cands:
                has_incoming.add(nxt.id)

        best: dict[int, tuple[float, list[int]]] = {}

        def longest_from(way: Way, stack: set[int]) -> tuple[float, list[int]]:
            if way.id in best:
                return best[way.id]
            stack.add(way.id)
            tail = (0.0, [])
            for nxt in successors[way.id]:
                if nxt.id in stack:  # 순환 도로는 한 바퀴에서 끊는다
                    continue
                cand = longest_from(nxt, stack)
                if cand[0] > tail[0]:
                    tail = cand
            stack.discard(way.id)
            result = (way.length + tail[0], [way.id] + tail[1])
            best[way.id] = result
            return result

        starts = list(remaining.values())  # 순환 도로는 들어오는 연결이 없는 조각이 없으므로 전부 후보로 본다
        top = (0.0, [])
        for w in starts:
            cand = longest_from(w, set())
            if cand[0] > top[0]:
                top = cand
        if top[0] < 500:
            break
        chains.append([remaining[i] for i in top[1]])
        for i in top[1]:
            remaining.pop(i, None)
    return chains


def link_chains(chains: list[list[Way]], all_ways: list[Way]) -> list[list[Way]]:
    """같은 노선의 주행선이 중간에 끊긴 곳을 잇는다.

    끊긴 곳은 보통 다른 노선번호가 붙은 조각이거나 태그가 빠진 조각이다. 먼저 전체 고속도로 조각으로 3km 안에서 길을 찾고,
    못 찾으면 방향이 거의 같고 1.2km 안일 때만 직선으로 잇는다.
    """
    by_node = defaultdict(list)
    for w in all_ways:
        by_node[w.nodes[0]].append(w)

    def path_between(a: Way, b: Way) -> list[Way] | None:
        frontier = [(a, [], 0.0)]
        seen = {a.id}
        while frontier:
            cur, path, dist = frontier.pop(0)
            for nxt in by_node.get(cur.nodes[-1], []):
                if nxt.id in seen or turn(cur.end_bearing, nxt.start_bearing) > 75:
                    continue
                if nxt.id == b.id:
                    return path
                if dist + nxt.length > 3000:
                    continue
                seen.add(nxt.id)
                frontier.append((nxt, path + [nxt], dist + nxt.length))
        return None

    chains = [list(c) for c in chains]
    merged = True
    while merged:
        merged = False
        for i, a in enumerate(chains):
            for j, b in enumerate(chains):
                if i == j:
                    continue
                end, start = a[-1], b[0]
                gap = haversine(*end.geom[-1], *start.geom[0])
                if gap > 3000 or turn(end.end_bearing, start.start_bearing) > 45:
                    continue
                middle = path_between(end, start)
                if middle is None:
                    toward = bearing(end.geom[-1], start.geom[0]) if gap > 1 else end.end_bearing
                    if gap > 1200 or turn(end.end_bearing, toward) > 30:
                        continue
                    middle = []
                chains[i] = a + middle + b
                del chains[j]
                merged = True
                break
            if merged:
                break
    return chains


def smooth(values: np.ndarray, sigma_pts: float) -> np.ndarray:
    if sigma_pts <= 0:
        return values
    radius = int(3 * sigma_pts)
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma_pts) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(values, (radius, radius), mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def runs(values: list, s: np.ndarray) -> list:
    """점마다의 값을 [시작 거리(m), 값] 목록으로 줄인다."""
    out = []
    for i, v in enumerate(values):
        if not out or out[-1][1] != v:
            out.append([round(float(s[i]), 1), v])
    return out


# ---------- 지형 고도 ----------

class Terrain:
    def __init__(self, zoom: int = TILE_ZOOM):
        self.zoom = zoom
        self.cache: dict[tuple[int, int], np.ndarray | None] = {}
        TILE_DIR.mkdir(parents=True, exist_ok=True)

    def tile_xy(self, lat: np.ndarray, lon: np.ndarray):
        n = 2 ** self.zoom
        x = (lon + 180.0) / 360.0 * n
        lat_r = np.radians(lat)
        y = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * n
        return x, y

    def fetch(self, tiles: set[tuple[int, int]]):
        todo = [t for t in tiles if t not in self.cache]

        def load(t):
            path = TILE_DIR / f"{self.zoom}_{t[0]}_{t[1]}.png"
            if not path.exists():
                url = TILE_URL.format(z=self.zoom, x=t[0], y=t[1])
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                    with urllib.request.urlopen(req, timeout=60) as res:
                        path.write_bytes(res.read())
                except Exception:
                    return t, None
            rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB"), dtype=np.float64)
            return t, rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768

        with ThreadPoolExecutor(max_workers=16) as pool:
            for t, arr in pool.map(load, todo):
                self.cache[t] = arr

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        x, y = self.tile_xy(lat, lon)
        tx, ty = np.floor(x).astype(int), np.floor(y).astype(int)
        keys = tx.astype(np.int64) * 100000 + ty
        uniq = np.unique(keys)
        self.fetch({(int(k // 100000), int(k % 100000)) for k in uniq})
        out = np.zeros(len(lat))
        px = np.clip((x - tx) * 255, 0, 254.999)
        py = np.clip((y - ty) * 255, 0, 254.999)
        for k in uniq:
            arr = self.cache.get((int(k // 100000), int(k % 100000)))
            if arr is None:
                continue
            m = keys == k
            x0, y0 = px[m].astype(int), py[m].astype(int)
            fx, fy = px[m] - x0, py[m] - y0
            top = arr[y0, x0] * (1 - fx) + arr[y0, x0 + 1] * fx
            bottom = arr[y0 + 1, x0] * (1 - fx) + arr[y0 + 1, x0 + 1] * fx
            out[m] = top * (1 - fy) + bottom * fy
        return np.maximum(out, 0.0)  # 바다는 0


def road_profile(ground: np.ndarray, structure: np.ndarray) -> np.ndarray:
    """지형 고도에서 도로 종단면을 만든다. 교량·터널 구간은 양 끝을 직선으로 잇고, 매끄럽게 한 뒤 경사를 제한한다."""
    z = ground.copy()
    n = len(z)
    i = 0
    while i < n:
        if structure[i] == 0:
            i += 1
            continue
        j = i
        while j < n and structure[j] != 0:
            j += 1
        a = z[i - 1] if i > 0 else z[j] if j < n else z[i]
        b = z[j] if j < n else a
        z[i:j] = np.linspace(a, b, j - i + 2)[1:-1]
        i = j
    z = smooth(z, 150.0 / STEP)
    # 경사 제한: 앞뒤로 한 번씩 훑어서 한 칸 차이가 MAX_GRADE*STEP을 넘지 않게
    limit = MAX_GRADE * STEP
    for _ in range(3):
        for k in range(1, n):
            z[k] = min(max(z[k], z[k - 1] - limit), z[k - 1] + limit)
        for k in range(n - 2, -1, -1):
            z[k] = min(max(z[k], z[k + 1] - limit), z[k + 1] + limit)
        z = smooth(z, 60.0 / STEP)
    return z


# ---------- 주행선 하나 만들기 ----------

def nearest_place(lat: float, lon: float) -> str:
    return min(PLACES, key=lambda k: haversine(lat, lon, *PLACES[k]))


def build_chain(chain: list[Way], junctions: dict[int, dict], to_utm: Transformer, to_ll: Transformer,
                terrain: Terrain | None) -> dict:
    lat, lon, attrs, node_at = [], [], [], {}
    for w in chain:
        t = w.tags
        attr = (
            parse_lanes(t.get("lanes")),
            parse_speed(t.get("maxspeed")),
            parse_speed(t.get("maxspeed:hgv")),
            parse_speed(t.get("minspeed")),
            1 if t.get("tunnel") in ("yes", "building_passage", "culvert") else 2 if t.get("bridge") else 0,
            t.get("name:ko") or t.get("name") or "",
            t.get("tunnel:name") or t.get("bridge:name") or "",
        )
        start = 1 if lat else 0
        for k in range(start, len(w.geom)):
            if w.nodes[k] in junctions:
                node_at[w.nodes[k]] = len(lat)
            lat.append(w.geom[k][0])
            lon.append(w.geom[k][1])
            attrs.append(attr)

    x, y = to_utm.transform(np.array(lon), np.array(lat))
    seg = np.hypot(np.diff(x), np.diff(y))
    s_raw = np.concatenate([[0.0], np.cumsum(seg)])
    fine = np.arange(0.0, float(s_raw[-1]), STEP / 2)
    xs = smooth(np.interp(fine, s_raw, x), SMOOTH_SIGMA / (STEP / 2))
    ys = smooth(np.interp(fine, s_raw, y), SMOOTH_SIGMA / (STEP / 2))
    # 매끄럽게 하면 굽은 곳이 조금 짧아지므로, 실제 길이로 다시 재서 정확히 STEP 간격으로 뽑는다
    s_smooth = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))])
    s = np.arange(0.0, float(s_smooth[-1]), STEP)
    raw_at = np.interp(s, s_smooth, fine)  # 새 점이 원본 선의 몇 m 지점인지
    xs, ys = np.interp(s, s_smooth, xs), np.interp(s, s_smooth, ys)
    idx = np.clip(np.searchsorted(s_raw, raw_at, side="right") - 1, 0, len(attrs) - 1)

    lanes_raw = [attrs[i][0] for i in idx]
    # 차로 수가 빠진 곳은 앞뒤 값으로 채운다
    last = next((v for v in lanes_raw if v), 2)
    lanes = []
    for v in lanes_raw:
        last = v or last
        lanes.append(last)
    # 요금소 부근처럼 차로가 잠깐 확 늘어나는 곳은 주변 중앙값+1로 누른다
    window = int(600 / STEP)
    padded = np.pad(np.array(lanes), (window, window), mode="edge")
    typical = np.median(np.lib.stride_tricks.sliding_window_view(padded, 2 * window + 1), axis=1)
    lanes = [int(min(l, t + 1)) for l, t in zip(lanes, typical)]
    # 150m보다 짧게 바뀌는 차로 수는 앞 값으로 덮는다
    min_run = int(150 / STEP)
    i = 0
    while i < len(lanes):
        j = i
        while j < len(lanes) and lanes[j] == lanes[i]:
            j += 1
        if i > 0 and j - i < min_run:
            lanes[i:j] = [lanes[i - 1]] * (j - i)
        i = j

    speed = [attrs[i][1] or 100 for i in idx]
    hgv = [attrs[i][2] or (80 if (attrs[i][1] or 100) <= 100 else 90) for i in idx]
    minspeed = [attrs[i][3] or 50 for i in idx]
    struct = np.array([attrs[i][4] for i in idx])
    names = [attrs[i][5] for i in idx]
    struct_names = [attrs[i][6] if attrs[i][4] else "" for i in idx]

    lon_s, lat_s = to_ll.transform(xs, ys)
    if terrain:
        ground = terrain.sample(np.array(lat_s), np.array(lon_s))
    else:
        ground = np.zeros(len(s))
    z = road_profile(ground, struct)

    # 주변 지형 띠
    terrain_rows = []
    if terrain:
        hx = np.gradient(xs)
        hy = np.gradient(ys)
        norm = np.hypot(hx, hy)
        nx, ny = hy / norm, -hx / norm  # 진행 방향의 오른쪽
        ts = np.arange(0.0, s[-1], TERRAIN_STEP)
        ti = np.clip((ts / STEP).astype(int), 0, len(s) - 1)
        grid_x = xs[ti][:, None] + nx[ti][:, None] * np.array(TERRAIN_OFFSETS)[None, :]
        grid_y = ys[ti][:, None] + ny[ti][:, None] * np.array(TERRAIN_OFFSETS)[None, :]
        glon, glat = to_ll.transform(grid_x.ravel(), grid_y.ravel())
        gz = terrain.sample(np.array(glat), np.array(glon)).reshape(grid_x.shape)
        terrain_rows = np.round(gz - z[ti][:, None]).astype(int).tolist()

    jlist = []
    for node_id, raw_i in node_at.items():
        j = junctions[node_id]
        # 원본 점 번호 → 거리
        sj = float(np.interp(s_raw[min(raw_i, len(s_raw) - 1)], raw_at, s))
        jlist.append([round(sj, 1), j.get("name:ko") or j.get("name") or "", j.get("ref") or ""])
    jlist.sort()

    qx = np.round(xs * 10).astype(np.int64)
    qy = np.round(ys * 10).astype(np.int64)
    name_counts = Counter(n for n in names if n)
    main_name = name_counts.most_common(1)[0][0] if name_counts else ""
    return {
        "length": round(float(s[-1]), 1),
        "step": STEP,
        # 좌표는 0.1m 단위 정수로 바꾸고 앞 점과의 차이만 적는다. x[0]=origin, x[i]=x[i-1]+dx[i-1]/10
        "origin": [int(qx[0]) / 10, int(qy[0]) / 10],
        "dx": np.diff(qx).tolist(),
        "dy": np.diff(qy).tolist(),
        "z": np.round(z * 10).astype(int).tolist(),
        "lanes": runs(lanes, s),
        "speed": runs(speed, s),
        "speedHgv": runs(hgv, s),
        "minSpeed": runs(minspeed, s),
        "structure": runs([int(v) for v in struct], s),
        "structureName": runs(struct_names, s),
        "sectionName": runs(names, s),
        "junctions": jlist,
        "terrain": {"step": TERRAIN_STEP, "offsets": TERRAIN_OFFSETS, "rows": terrain_rows},
        "_meta": {
            "main_name": main_name,
            "start": [float(lat_s[0]), float(lon_s[0])],
            "end": [float(lat_s[-1]), float(lon_s[-1])],
        },
    }


def main():
    sys.setrecursionlimit(100000)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-terrain", action="store_true", help="지형 고도 없이 평지로 만든다 (빠른 확인용)")
    parser.add_argument("--only", help="이 노선번호만 만든다 (예: 1)")
    args = parser.parse_args()

    data = download_osm()
    ways = [Way(e) for e in data["elements"] if e["type"] == "way" and e.get("tags", {}).get("oneway") != "no"]
    junctions = {e["id"]: e.get("tags", {}) for e in data["elements"] if e["type"] == "node"}

    by_ref = defaultdict(list)
    for w in ways:
        for r in w.refs:
            by_ref[r].append(w)

    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)
    to_ll = Transformer.from_crs("EPSG:5179", "EPSG:4326", always_xy=True)
    terrain = None if args.no_terrain else Terrain()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for ref in sorted(by_ref, key=lambda r: (len(r), r)):
        if args.only and ref != args.only:
            continue
        chains = link_chains(extract_chains(by_ref[ref]), ways)
        chains = [c for c in chains if sum(w.length for w in c) >= MIN_CHAIN_KM * 1000]
        chains.sort(key=lambda c: -sum(w.length for w in c))
        for n, chain in enumerate(chains):
            road = build_chain(chain, junctions, to_utm, to_ll, terrain)
            meta = road.pop("_meta")
            start_place = nearest_place(*meta["start"])
            end_place = nearest_place(*meta["end"])
            road_id = f"r{ref}-{n}"
            road.update({"id": road_id, "ref": ref, "name": meta["main_name"], "from": start_place, "to": end_place})
            (OUT_DIR / f"{road_id}.json").write_text(json.dumps(road, ensure_ascii=False, separators=(",", ":")),
                                                   encoding="utf-8")
            lanes_hist = Counter()
            for i, (s0, v) in enumerate(road["lanes"]):
                s1 = road["lanes"][i + 1][0] if i + 1 < len(road["lanes"]) else road["length"]
                lanes_hist[v] += s1 - s0
            index.append({
                "id": road_id,
                "ref": ref,
                "name": meta["main_name"],
                "from": start_place,
                "to": end_place,
                "lengthKm": round(road["length"] / 1000, 1),
                "lanes": lanes_hist.most_common(1)[0][0],
                "junctions": len(road["junctions"]),
                "tunnels": sum(1 for _, v in road["structure"] if v == 1),
                "bridges": sum(1 for _, v in road["structure"] if v == 2),
            })
            print(f"{road_id:9s} {meta['main_name']:14s} {start_place}→{end_place} {road['length']/1000:6.1f}km "
                  f"IC·JC {len(road['junctions'])}")

    index.sort(key=lambda r: (int(r["ref"]) if r["ref"].isdigit() else 9999, r["id"]))
    (OUT_DIR / "index.json").write_text(
        json.dumps({"source": "© OpenStreetMap contributors (ODbL)", "osmTimestamp": data["osm3s"]["timestamp_osm_base"],
                    "roads": index}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n주행선 {len(index)}개, 총 {sum(r['lengthKm'] for r in index):.0f}km → {OUT_DIR}")


if __name__ == "__main__":
    main()
