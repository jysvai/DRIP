"""게임 주행 기록을 실제 사고다발구간과 비교한다 (연구 가설 1·2).

  1. 게임 기록(drip_events, drip_samples)을 노선·방향·1km 이정 구간으로 모은다.
  2. 구간마다 주행 노출량(주행한 초·km)과 아차사고·충돌·법규 위반 수를 센다.
  3. data/processed/accident_bins_1km.csv(실제 사고)와 맞춰
     - 순위 상관 (실제 사고 수 ↔ 게임 위험 사건 비율)
     - 사고다발구간 / 그 외 구간의 게임 위험 사건 비율 비
     를 낸다.

게임 위치(주행선 id, s m)를 도로공사 이정(km)으로 바꾸려면 나들목 이정표가 필요하다:
  data/processed/road_km_anchors.csv   road_id, s_m, km, name   (build_km_anchors()가 만든다)
나들목 이정표(노선·나들목 이름·이정)는 data/raw/ic_km.csv 로 둔다 (도로공사 API 또는 공공데이터 파일).

실행: .venv\\Scripts\\python pipeline\\compare_hotspots.py [--min-seconds 30]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
ROADS = ROOT / "game" / "public" / "roads"
ACCIDENT_BINS = PROCESSED / "accident_bins_1km.csv"
ANCHORS = PROCESSED / "road_km_anchors.csv"
IC_TABLE = ROOT / "data" / "raw" / "ic_km.csv"
OUT = PROCESSED / "sim_vs_accidents.csv"

# 도로공사 사고 자료의 노선명 → 노선 번호. 같은 번호라도 이정 체계가 따로인 노선이 있어 이름도 함께 본다.
ROUTE_REF = {
    "경부선": "1", "경인선": "120", "고창담양선": "253", "광주대구선": "12", "광주외곽순환선": "500",
    "남해선": "10", "남해제1지선": "102", "남해제2지선": "104", "당진대전선": "30", "당진청주선": "32",
    "대구외곽순환선": "700", "대구포항선": "20", "대전남부순환선": "300", "동해선": "65", "무안광주선": "12",
    "부산외곽순환선": "600", "부산포항선": "65", "서울양양선": "60", "서천공주선": "151", "서해안선": "15",
    "수도권제1순환선": "100", "수도권제2순환선": "400", "순천완주선": "27", "영동선": "50", "울산선": "16",
    "익산장수선": "204", "제2경인선": "110", "제2중부선": "37", "중부내륙선": "45", "중부내륙선의 지선": "451",
    "중부선": "35", "중앙선": "55", "중앙선의 지선": "551", "청주영덕선": "30", "평택제천선": "40",
    "함양울산선": "14", "호남선": "25", "호남선의 지선": "251",
}

# 위험 사건: 가설 1은 아차사고·충돌, 가설 2는 원인별 위반
RISK_EVENTS = ["near_miss", "crash"]
# 사고 원인(도로공사 분류) ↔ 게임 사건. 진로변경은 사고 원인 분류에 없어 따로 지도로만 본다.
CAUSE_EVENTS = {
    "과속": ["speeding"],
    "안전거리미확보": ["headway_critical"],
    "주시태만": ["near_miss", "crash"],
}


def norm_name(name: str) -> str:
    """나들목 이름 비교용: 공백·괄호·IC/JC/TG 꼬리표를 뗀다."""
    name = re.sub(r"\(.*?\)", "", name)
    name = re.sub(r"\s+", "", name)
    return re.sub(r"(IC|JC|JCT|TG|나들목|분기점|요금소|휴게소)$", "", name)


def load_roads() -> dict[str, dict]:
    index = json.loads((ROADS / "index.json").read_text(encoding="utf-8"))
    out = {}
    for r in index["roads"]:
        f = json.loads((ROADS / f"{r['id']}.json").read_text(encoding="utf-8"))
        out[r["id"]] = {"ref": f["ref"], "name": f["name"], "from": f["from"], "to": f["to"], "length": f["length"], "junctions": f["junctions"]}
    return out


def build_km_anchors(roads: dict[str, dict]) -> pd.DataFrame:
    """나들목 이정표와 주행선의 나들목 이름을 맞춰 (주행선, s) ↔ 이정 기준점을 만든다."""
    if not IC_TABLE.exists():
        raise SystemExit(
            f"{IC_TABLE.relative_to(ROOT)}이 없습니다. 노선명·나들목명·이정(km) 열이 있는 표를 넣어 주세요 "
            "(pipeline/traffic_ex.py --ic-table 이 도로공사 API로 만든다)."
        )
    ic = pd.read_csv(IC_TABLE)
    ic["ref"] = ic["route"].map(ROUTE_REF)
    ic["key"] = ic["ic_name"].map(norm_name)
    rows = []
    for rid, r in roads.items():
        cand = ic[ic["ref"] == r["ref"]]
        if cand.empty:
            continue
        for s, name, _ in r["junctions"]:
            hit = cand[cand["key"] == norm_name(name)]
            if len(hit):
                rows.append({"road_id": rid, "s_m": s, "km": float(hit.iloc[0]["km"]), "name": name, "route": hit.iloc[0]["route"]})
    anchors = pd.DataFrame(rows)
    # 방향이 거꾸로 된 짝(이정이 s와 어긋나는 점)은 버린다
    keep = []
    for rid, g in anchors.groupby("road_id"):
        g = g.sort_values("s_m")
        if len(g) >= 2:
            slope = np.sign(np.polyfit(g["s_m"], g["km"], 1)[0])
            resid = g["km"] - np.polyval(np.polyfit(g["s_m"], g["km"], 1), g["s_m"])
            g = g[np.abs(resid) < 3]
            g = g.assign(direction_sign=slope)
        keep.append(g)
    anchors = pd.concat(keep) if keep else anchors
    anchors.to_csv(ANCHORS, index=False, encoding="utf-8-sig")
    return anchors


def s_to_km(anchors: pd.DataFrame, road_id: str, s: np.ndarray) -> np.ndarray:
    """기준점 사이는 선형 보간, 밖은 기울기 ±1로 늘린다."""
    g = anchors[anchors["road_id"] == road_id].sort_values("s_m")
    if len(g) < 2:
        return np.full(len(s), np.nan)
    xs = g["s_m"].to_numpy()
    ks = g["km"].to_numpy()
    km = np.interp(s, xs, ks)
    sign = np.sign(ks[-1] - ks[0]) or 1
    km = np.where(s < xs[0], ks[0] + sign * (s - xs[0]) / 1000, km)
    km = np.where(s > xs[-1], ks[-1] + sign * (s - xs[-1]) / 1000, km)
    return km


def route_direction(anchors: pd.DataFrame, road_id: str, roads: dict, bins: pd.DataFrame) -> tuple[str | None, str | None]:
    """주행선 → (사고 자료 노선명, 방향 이름). 방향은 주행선 끝 도시 이름이 사고 자료 방향 이름과 같으면 그것을 쓴다."""
    g = anchors[anchors["road_id"] == road_id]
    if g.empty:
        return None, None
    route = g["route"].mode().iloc[0]
    dirs = bins.loc[bins["route"] == route, "direction"].unique().tolist()
    to = roads[road_id]["to"]
    for d in dirs:
        if d in to or to in d:
            return route, d
    # 출발 도시가 한쪽 방향 이름과 같으면 반대쪽이 우리 방향
    frm = roads[road_id]["from"]
    others = [d for d in dirs if not (d in frm or frm in d)]
    if len(dirs) == 2 and len(others) == 1:
        return route, others[0]
    return route, None


def load_game(min_seconds: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Supabase에서 세션·사건·1초 기록을 읽는다 (서버 전용 DB 연결)."""
    from db import connect

    with connect() as c:
        sessions = pd.read_sql("select id, road_id, started_at from drip_sessions", c)
        events = pd.read_sql("select session_id, t, type, s, lane, speed_kmh from drip_events", c)
        samples = pd.read_sql("select session_id, t0, columns, data from drip_samples", c)
    rows = []
    for _, r in samples.iterrows():
        cols = list(r["columns"])
        for row in r["data"]:
            rows.append(dict(zip(cols, row)) | {"session_id": r["session_id"]})
    samp = pd.DataFrame(rows)
    if samp.empty:
        return events.merge(sessions, left_on="session_id", right_on="id"), samp
    dur = samp.groupby("session_id").size()
    good = dur[dur >= min_seconds].index
    samp = samp[samp["session_id"].isin(good)].merge(sessions, left_on="session_id", right_on="id")
    events = events[events["session_id"].isin(good)].merge(sessions, left_on="session_id", right_on="id")
    return events, samp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-seconds", type=float, default=30, help="이보다 짧은 주행은 뺀다")
    ap.add_argument("--anchors-only", action="store_true", help="이정 기준점만 만든다")
    args = ap.parse_args()

    roads = load_roads()
    anchors = pd.read_csv(ANCHORS) if ANCHORS.exists() and not args.anchors_only else build_km_anchors(roads)
    print(f"이정 기준점 {len(anchors)}개, 주행선 {anchors['road_id'].nunique()}개")
    if args.anchors_only:
        return

    bins = pd.read_csv(ACCIDENT_BINS)
    events, samples = load_game(args.min_seconds)
    if samples.empty:
        print("아직 비교할 주행 기록이 없습니다.")
        return

    # 1초 기록 → 이정 구간별 노출 시간
    parts = []
    for rid, g in samples.groupby("road_id"):
        rid = str(rid)
        route, direction = route_direction(anchors, rid, roads, bins)
        if route is None or direction is None:
            print(f"  {rid}: 노선·방향을 맞추지 못해 뺍니다")
            continue
        km = s_to_km(anchors, rid, g["s"].to_numpy(float))
        parts.append(pd.DataFrame({"route": route, "direction": direction, "km_bin": np.floor(km), "seconds": 1.0}).dropna())
    exposure = pd.concat(parts).groupby(["route", "direction", "km_bin"], as_index=False)["seconds"].sum()

    ev_parts = []
    for rid, g in events.groupby("road_id"):
        rid = str(rid)
        route, direction = route_direction(anchors, rid, roads, bins)
        if route is None or direction is None:
            continue
        km = s_to_km(anchors, rid, g["s"].to_numpy(float))
        ev_parts.append(pd.DataFrame({"route": route, "direction": direction, "km_bin": np.floor(km), "type": g["type"].to_numpy()}).dropna())
    ev = pd.concat(ev_parts) if ev_parts else pd.DataFrame(columns=["route", "direction", "km_bin", "type"])
    counts = ev.pivot_table(index=["route", "direction", "km_bin"], columns="type", aggfunc="size", fill_value=0).reset_index()

    df = exposure.merge(counts, how="left").fillna(0)
    df["km_bin"] = df["km_bin"].astype(int)
    df = df.merge(bins, on=["route", "direction", "km_bin"], how="left").fillna({"accidents": 0})
    hours = df["seconds"] / 3600
    for col in RISK_EVENTS:
        if col not in df:
            df[col] = 0
    df["risk"] = df[RISK_EVENTS].sum(axis=1)
    df["risk_per_hour"] = df["risk"] / hours.clip(lower=1 / 60)
    df["hotspot"] = df["accidents"] >= 4
    df.to_csv(OUT, index=False, encoding="utf-8-sig")

    enough = df[df["seconds"] >= 60]
    print(f"비교 구간 {len(enough)}개 (60초 이상 달린 곳), 주행 {df['seconds'].sum() / 3600:.1f}시간")
    if len(enough) >= 5:
        rho = enough["accidents"].rank().corr(enough["risk_per_hour"].rank())
        print(f"가설 1 순위 상관 (실제 사고 수 ↔ 게임 아차사고·충돌 비율): {rho:.3f}")
        hot = enough[enough["hotspot"]]
        cold = enough[~enough["hotspot"]]
        if len(hot) and len(cold):
            rr = (hot["risk"].sum() / hot["seconds"].sum()) / max(1e-9, cold["risk"].sum() / cold["seconds"].sum())
            print(f"사고다발구간 / 그 외 게임 위험 사건 비율 비: {rr:.2f} (다발 {len(hot)}곳, 그 외 {len(cold)}곳)")

        # 가설 2: 원인별 실제 사고 ↔ 같은 종류의 게임 사건
        from accident_hotspots import load_accidents

        acc = load_accidents()
        by_cause = acc.groupby(["route", "direction", "km_bin", "cause"]).size().unstack(fill_value=0).reset_index()
        m = enough.merge(by_cause, on=["route", "direction", "km_bin"], how="left").fillna(0)
        for cause, evs in CAUSE_EVENTS.items():
            cols = [e for e in evs if e in m]
            if cause not in m or not cols:
                continue
            rate = m[cols].sum(axis=1) / (m["seconds"] / 3600)
            print(f"가설 2 [{cause}] 순위 상관 (실제 사고 ↔ 게임 {'+'.join(cols)} 비율): {m[cause].rank().corr(rate.rank()):.3f}")
    print(f"결과: {OUT}")


if __name__ == "__main__":
    main()
