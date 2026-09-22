"""한국도로공사 공공데이터로 게임 교통과 이정 기준점을 만든다.

  python pipeline/traffic_ex.py anchors                 VDS 위치 → 주행선 s ↔ 이정(km) 기준점
                                                        (data/processed/road_km_anchors.csv, 사고 다발 구간 비교에 쓴다)
  python pipeline/traffic_ex.py daily [--date YYYYMMDD] 전날 AVC 15분 자료 → 주행선별 시간대 밀도·속도·차종 구성
                                                        (game/public/traffic/latest.json, data/processed/traffic/날짜.json)
  --key test                                            포털 예시 키로 시험 (매일 수집은 .env의 EX_API_KEY)
  --upload                                              원자료를 R2(raw/ex/…)에도 올린다 (.env의 R2_* 필요)
원자료는 data/raw/ex/avc15/날짜.json.gz에 남는다 (운전 습관 분석: pipeline/habits_avc.py)

좌표: 게임 도로는 UTM-K(EPSG:5179), VDS는 GRS80 중부원점(EPSG:5186), AVC는 위경도.
방향: 도로공사 E = 종점 쪽(이정 증가), S = 기점 쪽(이정 감소). 경부선은 기점이 부산이라 E = 서울 방향.
차종: AVC 12종(국토교통부 차종 분류) 1 승용·미니트럭, 2 버스, 3~12 화물(소형~6축 세미트레일러). 12종 표를 AVC에 그대로
쓰는지는 포털에 적혀 있지 않아 확인이 필요하다.
"""

from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer

from ex_api import ExApi

ROOT = Path(__file__).resolve().parents[1]
ROADS = ROOT / "game" / "public" / "roads"
RAW = ROOT / "data" / "raw" / "ex"
ANCHORS = ROOT / "data" / "processed" / "road_km_anchors.csv"
ARCHIVE = ROOT / "data" / "processed" / "traffic"
LATEST = ROOT / "game" / "public" / "traffic" / "latest.json"
DEFAULTS = ROOT / "game" / "public" / "data" / "traffic_defaults.json"
KST = timezone(timedelta(hours=9))

SNAP_M = 120  # 주행선에서 이보다 먼 VDS는 다른 길(나란한 국도·램프)로 본다
PASSENGER = ("승용", "SUV", "전기차", "택시")


# ---------------- 게임 도로 ----------------


class RoadGeom:
    """게임 주행선 하나의 중심선 (10m 간격 점)."""

    def __init__(self, meta: dict):
        f = json.loads((ROADS / f"{meta['id']}.json").read_text(encoding="utf-8"))
        self.id: str = meta["id"]
        self.ref: str = f["ref"]
        self.name: str = f["name"]
        self.frm: str = f["from"]
        self.to: str = f["to"]
        self.step: float = f["step"]
        self.length: float = f["length"]
        d = np.column_stack([f["dx"], f["dy"]]).astype(float) / 10.0  # 0.1m 단위
        xy = np.vstack([[0.0, 0.0], np.cumsum(d, axis=0)]) + np.array(f["origin"], float)
        self.x = xy[:, 0]
        self.y = xy[:, 1]

    def project(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """점들을 중심선에 내린 (s, 거리). 점 하나씩 가장 가까운 꼭짓점을 찾는다."""
        s = np.empty(len(x))
        dist = np.empty(len(x))
        for i, (px, py) in enumerate(zip(x, y)):
            d2 = (self.x - px) ** 2 + (self.y - py) ** 2
            j = int(np.argmin(d2))
            s[i] = j * self.step
            dist[i] = float(np.sqrt(d2[j]))
        return s, dist


def load_roads() -> list[RoadGeom]:
    index = json.loads((ROADS / "index.json").read_text(encoding="utf-8"))
    return [RoadGeom(r) for r in index["roads"]]


def km_value(v: str) -> float:
    return float(str(v).lower().replace("km", "").strip() or "nan")


def cache(name: str, fetch, refresh: bool = False):
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / name
    if p.exists() and not refresh:
        return json.loads(p.read_text(encoding="utf-8"))
    data = fetch()
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


# ---------------- 이정 기준점 ----------------


def build_anchors(api: ExApi, refresh: bool) -> list[dict]:
    """주행선 근처 VDS를 노선 코드별로 묶어, 이정이 s를 따라 고르게 늘거나 주는 묶음만 기준점으로 쓴다.
    노선 번호로 고르지 않는 까닭: 한 번호에 코드가 여럿이고(남해선 0100·0101·0102), 두 노선이 겹치는 구간도 있다."""
    import csv

    roads = load_roads()
    vds = cache("vds_list.json", api.vds_list, refresh)
    # 노선명은 VDS 목록 것을 쓴다 (노선 목록 API의 코드↔이름은 몇 곳이 어긋나 있다: 0140 → 밀양울산선, VDS는 고창담양선)
    names: dict[str, Counter] = defaultdict(Counter)
    for v in vds:
        names[v.get("routeNo", "")][v.get("routeName") or ""] += 1
    cd_name = {cd: c.most_common(1)[0][0] for cd, c in names.items()}
    to5179 = Transformer.from_crs(5186, 5179, always_xy=True)
    pts = []
    for v in vds:
        if v.get("equipmentBelongingCode") not in (None, "", "00"):  # 본선 VDS만
            continue
        try:
            x, y = to5179.transform(float(v["grs80x"]), float(v["grs80y"]))
            pts.append((x, y, km_value(v["shift"]), v["directionCode"], v["routeNo"], v["vdsId"]))
        except (KeyError, ValueError, TypeError):  # 좌표·이정이 빈 VDS
            continue
    px = np.array([p[0] for p in pts])
    py = np.array([p[1] for p in pts])
    pkm = np.array([p[2] for p in pts])
    pdir = np.array([p[3] for p in pts])
    pcd = np.array([p[4] for p in pts])
    pid = np.array([p[5] for p in pts])
    cell = 250.0

    def keys(x, y):
        return np.floor(x / cell).astype(np.int64) * 1_000_000 + np.floor(y / cell).astype(np.int64)

    rows: list[dict] = []
    for road in roads:
        # 도로 꼭짓점이 지나는 칸과 그 이웃 칸에 있는 VDS만 후보로
        rk = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                rk.update(keys(road.x + dx * cell, road.y + dy * cell).tolist())
        cand = np.nonzero(np.isin(keys(px, py), np.fromiter(rk, np.int64)))[0]
        if len(cand) == 0:
            print(f"  {road.id} {road.name}: 근처 VDS 없음 (민자 구간 등)")
            continue
        s, dist = road.project(px[cand], py[cand])
        near = dist < SNAP_M
        cand, s = cand[near], s[near]
        found = []
        for cd in np.unique(pcd[cand]):
            m = pcd[cand] == cd
            order = np.argsort(s[m])
            ss_all, km_all = s[m][order], pkm[cand][m][order]
            dir_all, id_all = pdir[cand][m][order], pid[cand][m][order]
            # 순환선처럼 이정이 중간에 처음으로 돌아가는 곳에서 끊어 구간마다 따로 본다
            jump = np.abs(np.diff(km_all)) - np.diff(ss_all) / 1000.0 > 5.0
            cuts = np.concatenate([[0], np.nonzero(jump)[0] + 1, [len(ss_all)]])
            kept = 0
            sign = 0.0
            for a0, a1 in zip(cuts[:-1], cuts[1:]):
                ss, km, dirs, ids = ss_all[a0:a1], km_all[a0:a1], dir_all[a0:a1], id_all[a0:a1]
                if len(ss) < 4 or np.ptp(ss) < 2000 or np.std(km) == 0:
                    continue  # 교차로에서 스치는 다른 노선
                r = np.corrcoef(ss, km)[0, 1]
                if abs(r) < 0.9:
                    continue
                sign = 1.0 if r > 0 else -1.0
                # 이 주행선이 이정이 느는 쪽이면 E 방향 VDS, 아니면 S 방향 VDS만 쓴다
                mine = dirs == ("E" if sign > 0 else "S")
                ss, km, ids = ss[mine], km[mine], ids[mine]
                if len(ss) < 3:
                    continue
                # 이정 - (±s)가 주변과 크게 다르면(잘못 붙은 점) 버린다
                off = km - sign * ss / 1000.0
                med = np.array([np.median(off[max(0, i - 4) : i + 5]) for i in range(len(off))])
                ok = np.abs(off - med) < 1.5
                for a, b, c in zip(ss[ok], km[ok], ids[ok]):
                    rows.append(
                        {
                            "road_id": road.id,
                            "s_m": round(float(a), 1),
                            "km": round(float(b), 2),
                            "name": c,
                            "route": cd_name.get(cd, ""),
                            "route_cd": cd,
                            "direction": "E" if sign > 0 else "S",
                            "direction_sign": int(sign),
                        }
                    )
                kept += int(ok.sum())
            if kept:
                found.append(f"{cd_name.get(cd, cd)} {kept}개 {'E' if sign > 0 else 'S'}")
        print(f"  {road.id} {road.name} {road.frm}→{road.to}: {', '.join(found) or '맞는 VDS 없음'}")

    ANCHORS.parent.mkdir(parents=True, exist_ok=True)
    with ANCHORS.open("w", newline="", encoding="utf-8-sig") as fp:
        w = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"{ANCHORS.relative_to(ROOT)}: {len(rows)}개, 주행선 {len({r['road_id'] for r in rows})}개")
    return rows


def read_anchors() -> dict[tuple[str, str], dict]:
    """(주행선, 노선 코드)별 기준점: {direction, s[], km[]} (이정 오름차순)"""
    import csv

    if not ANCHORS.exists():
        raise SystemExit(f"{ANCHORS.relative_to(ROOT)}이 없습니다. 먼저 `python pipeline/traffic_ex.py anchors`")
    out: dict[tuple[str, str], dict] = {}
    with ANCHORS.open(encoding="utf-8-sig") as fp:
        for r in csv.DictReader(fp):
            a = out.setdefault((r["road_id"], r["route_cd"]), {"direction": r["direction"], "s": [], "km": []})
            a["s"].append(float(r["s_m"]))
            a["km"].append(float(r["km"]))
    for a in out.values():
        order = np.argsort(a["km"])
        a["s"] = np.array(a["s"])[order]
        a["km"] = np.array(a["km"])[order]
    return out


# ---------------- 전날 교통 ----------------


def num(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return x if x > 0 else 0.0


def fill_hours(values: list[float | None]) -> list[float] | None:
    """빈 시간대는 앞뒤 시간대로 채운다 (자정을 넘어 이어진다)."""
    known = [(h, v) for h, v in enumerate(values) if v is not None]
    if not known:
        return None
    hs = np.array([h for h, _ in known], float)
    vs = np.array([v for _, v in known], float)
    xs = np.concatenate([hs - 24, hs, hs + 24])
    ys = np.concatenate([vs, vs, vs])
    return [round(float(np.interp(h, xs, ys)), 2) for h in range(24)]


def locate(anchors: dict[tuple[str, str], dict], cd: str, direction: str, km: float) -> tuple[str, float] | None:
    """(노선 코드, 방향, 이정) → (주행선, s)"""
    for (rid, acd), a in anchors.items():
        if acd != cd or a["direction"] != direction:
            continue
        if a["km"][0] - 1.0 <= km <= a["km"][-1] + 1.0:
            return rid, float(np.interp(km, a["km"], a["s"]))
    return None


def daily(api: ExApi, date: str, upload: bool) -> dict:
    anchors = read_anchors()
    defaults = json.loads(DEFAULTS.read_text(encoding="utf-8"))["composition"]
    codes = sorted({cd for _, cd in anchors})
    raw: list[dict] = []
    for cd in codes:
        rows = api.avc_15min(date, cd)
        raw += rows
        print(f"  {cd}: {len(rows)}행")
    if not raw:
        raise SystemExit(f"{date} AVC 자료가 없습니다 (전날까지만 나온다)")

    # 원자료는 운전 습관 분석(pipeline/habits_avc.py)에 쓰려고 남긴다
    packed = gzip.compress(json.dumps(raw, ensure_ascii=False).encode("utf-8"))
    (RAW / "avc15").mkdir(parents=True, exist_ok=True)
    (RAW / "avc15" / f"{date}.json.gz").write_bytes(packed)
    if upload:
        from storage import bucket, client

        key = f"raw/ex/avc15/{date}.json.gz"
        client().put_object(Bucket=bucket(), Key=key, Body=packed)
        print(f"R2에 원자료 저장: {key}")

    # 지점(AVC·방향)마다 시간대별 교통량·속도, 하루 차종 합계
    sites: dict[tuple, dict] = {}
    for r in raw:
        vol = [num(r.get(f"trfv{i}")) for i in range(1, 13)]
        total = sum(vol) + num(r.get("ucsdKncrTrfv"))
        if total <= 0:
            continue  # 자료 없는 행 (0으로만 채워진 행이 13% 정도)
        cd = r.get("routeNo", "")
        avc = r.get("avcId", "")
        # 다른 노선 AVC가 섞여 나오면 그 AVC 이정은 자기 노선 기준이라 콘존 시작 이정을 쓴다
        km = num(r.get("avcDstnc")) if avc.startswith(cd) else num(r.get("roadDstnc"))
        key = (cd, r.get("drctClssCd", ""), avc)
        site = sites.setdefault(key, {"km": km, "lanes": set(), "q": np.zeros(24), "qv": np.zeros(24), "cls": np.zeros(12)})
        hour = int(str(r.get("totlHhmm", "0000")).zfill(4)[:2])
        speed_w = sum(v * num(r.get(f"avgSped{i + 1}")) for i, v in enumerate(vol))
        speed_n = sum(v for i, v in enumerate(vol) if num(r.get(f"avgSped{i + 1}")) > 0)
        site["lanes"].add(r.get("crgwNo"))
        site["q"][hour] += total
        if speed_n > 0:
            site["qv"][hour] += total * (speed_w / speed_n)
        site["cls"] += np.array(vol)

    per_road: dict[str, list[dict]] = defaultdict(list)
    missed = 0
    for (cd, direction, avc), site in sites.items():
        hit = locate(anchors, cd, direction, site["km"])
        if not hit:
            missed += 1
            continue
        rid, s = hit
        lanes = max(1, len(site["lanes"]))
        dens: list[float | None] = []
        spd: list[float | None] = []
        for h in range(24):
            q = site["q"][h]
            if q <= 0 or site["qv"][h] <= 0:
                dens.append(None)
                spd.append(None)
                continue
            v = site["qv"][h] / q
            spd.append(v)
            dens.append(min(150.0, q / lanes / max(v, 5.0)))  # 차로 하나, 1km당 대수 = 교통량 / 속도
        per_road[rid].append({"avc": avc, "s": round(s), "km": round(site["km"], 2), "lanes": lanes, "density": dens, "speed": spd, "cls": site["cls"]})

    passenger_share = sum(defaults.get(k, 0) for k in PASSENGER)
    special = defaults.get("특수", 0)
    roads_out: dict[str, dict] = {}
    for rid, ss in per_road.items():
        density = fill_hours([_median([x["density"][h] for x in ss]) for h in range(24)])
        speed = fill_hours([_median([x["speed"][h] for x in ss]) for h in range(24)])
        if density is None:
            continue
        cls = np.sum([x["cls"] for x in ss], axis=0)
        tot = cls.sum()
        comp = None
        if tot > 0:
            car, bus, truck = cls[0] / tot, cls[1] / tot, cls[2:].sum() / tot
            comp = {k: round(car * (1 - special) * defaults.get(k, 0) / passenger_share, 4) for k in PASSENGER}
            comp["버스"] = round(bus * (1 - special), 4)
            comp["화물"] = round(truck * (1 - special), 4)
            comp["특수"] = special
        roads_out[rid] = {
            "density": density,
            "speed": speed,
            "composition": comp,
            "sites": [
                {"s": x["s"], "km": x["km"], "lanes": x["lanes"], "density": fill_hours(x["density"]), "speed": fill_hours(x["speed"])}
                for x in sorted(ss, key=lambda x: x["s"])
                if any(v is not None for v in x["density"])
            ],
        }
    day = f"{date[:4]}-{date[4:6]}-{date[6:]}"
    out = {
        "date": day,
        "source": "한국도로공사 고속도로 공공데이터 포털 AVC 15분 원시자료 (data.ex.co.kr)",
        "note": "density: 차로 하나 1km당 대수(교통량÷속도, 지점 중앙값), speed: km/h, composition: AVC 12종을 게임 분류로 나눔",
        "roads": roads_out,
    }
    for path in (LATEST, ARCHIVE / f"{day}.json"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{day}: AVC 지점 {len(sites)}곳 중 {len(sites) - missed}곳을 주행선 {len(roads_out)}개에 붙임 → {LATEST.relative_to(ROOT)}")
    return out


def _median(xs: list[float | None]) -> float | None:
    v = [x for x in xs if x is not None]
    return float(np.median(v)) if v else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["anchors", "daily"])
    ap.add_argument("--date", help="YYYYMMDD (기본: 어제, 한국 시간)")
    ap.add_argument("--key", help="EX_API_KEY 대신 쓸 키 (시험: test)")
    ap.add_argument("--refresh", action="store_true", help="저장해 둔 VDS 목록을 다시 받는다")
    ap.add_argument("--upload", action="store_true", help="원자료를 R2에도 올린다")
    args = ap.parse_args()
    api = ExApi(args.key)
    if args.command == "anchors":
        build_anchors(api, args.refresh)
    else:
        date = args.date or (datetime.now(KST) - timedelta(days=1)).strftime("%Y%m%d")
        daily(api, date, args.upload)
    print(f"API 호출 {api.calls}번")


if __name__ == "__main__":
    main()
