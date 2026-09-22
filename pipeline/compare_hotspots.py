"""게임 주행 기록을 실제 사고다발구간과 비교한다 (연구 가설 1·2).

  1. 게임 기록(drip_events, drip_samples)을 노선·방향·1km 이정 구간으로 모은다.
  2. 구간마다 주행 노출량(주행한 초·km)과 아차사고·충돌·법규 위반 수를 센다.
  3. data/processed/accident_bins_1km.csv(실제 사고)와 맞춰
     - 순위 상관 (실제 사고 수 ↔ 게임 위험 사건 비율)
     - 사고다발구간 / 그 외 구간의 게임 위험 사건 비율 비
     를 낸다.

게임 위치(주행선 id, s m)를 도로공사 이정(km)으로 바꾸는 기준점:
  data/processed/road_km_anchors.csv   road_id, s_m, km, route, route_cd, direction
  (python pipeline/traffic_ex.py anchors 가 VDS 위치로 만든다)

실행: .venv\\Scripts\\python pipeline\\compare_hotspots.py [--min-seconds 30]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
ROADS = ROOT / "game" / "public" / "roads"
ACCIDENT_BINS = PROCESSED / "accident_bins_1km.csv"
ANCHORS = PROCESSED / "road_km_anchors.csv"
OUT = PROCESSED / "sim_vs_accidents.csv"

# VDS 목록의 노선명 → 사고 자료의 노선명 (같은 것은 그대로)
ACCIDENT_ROUTE = {
    "남해선(순천-부산)": "남해선", "남해선(영암-순천)": "남해선", "동해선(부산-포항)": "부산포항선", "동해선(삼척-속초)": "동해선",
    "남해1지선": "남해제1지선", "남해2지선": "남해제2지선", "호남지선": "호남선의 지선", "대전남부선": "대전남부순환선",
    "중부내륙지선": "중부내륙선의 지선", "중앙선지선": "중앙선의 지선", "부산외곽선": "부산외곽순환선",
}

# 위험 사건: 가설 1은 아차사고·충돌, 가설 2는 원인별 위반
RISK_EVENTS = ["near_miss", "crash"]
# 사고 원인(도로공사 분류) ↔ 게임 사건. 진로변경은 사고 원인 분류에 없어 따로 지도로만 본다.
CAUSE_EVENTS = {
    "과속": ["speeding"],
    "안전거리미확보": ["headway_critical"],
    "주시태만": ["near_miss", "crash"],
}


def load_roads() -> dict[str, dict]:
    index = json.loads((ROADS / "index.json").read_text(encoding="utf-8"))
    out = {}
    for r in index["roads"]:
        f = json.loads((ROADS / f"{r['id']}.json").read_text(encoding="utf-8"))
        out[r["id"]] = {"ref": f["ref"], "name": f["name"], "from": f["from"], "to": f["to"], "length": f["length"], "junctions": f["junctions"]}
    return out


def segments(anchors: pd.DataFrame, road_id: str) -> list[tuple[str, np.ndarray, np.ndarray]]:
    """주행선의 (사고 자료 노선명, s[], km[]) 구간들. 순환선처럼 이정이 처음으로 돌아가는 곳에서 끊는다."""
    out = []
    for route, g in anchors[anchors["road_id"] == road_id].groupby("route"):
        g = g.sort_values("s_m")
        xs, ks = g["s_m"].to_numpy(float), g["km"].to_numpy(float)
        jump = np.abs(np.diff(ks)) - np.diff(xs) / 1000.0 > 5.0
        cuts = np.concatenate([[0], np.nonzero(jump)[0] + 1, [len(xs)]])
        for a, b in zip(cuts[:-1], cuts[1:]):
            if b - a >= 2:
                out.append((ACCIDENT_ROUTE.get(str(route), str(route)), xs[a:b], ks[a:b]))
    return out


def s_to_km(xs: np.ndarray, ks: np.ndarray, s: np.ndarray, margin: float = 1000.0) -> np.ndarray:
    """기준점 사이는 선형 보간, 양끝 밖 margin m까지는 기울기 ±1로 늘리고 그보다 멀면 NaN."""
    km = np.interp(s, xs, ks)
    sign = np.sign(ks[-1] - ks[0]) or 1
    km = np.where(s < xs[0], ks[0] + sign * (s - xs[0]) / 1000, km)
    km = np.where(s > xs[-1], ks[-1] + sign * (s - xs[-1]) / 1000, km)
    return np.where((s < xs[0] - margin) | (s > xs[-1] + margin), np.nan, km)


def direction_name(route: str, road: dict, bins: pd.DataFrame) -> str | None:
    """사고 자료의 방향 이름(도착 도시). 주행선 끝 도시와 같으면 그것, 출발 도시가 한쪽 방향이면 다른 쪽."""
    dirs = bins.loc[bins["route"] == route, "direction"].unique().tolist()
    to, frm = road["to"], road["from"]
    for d in dirs:
        if d in to or to in d:
            return d
    others = [d for d in dirs if not (d in frm or frm in d)]
    if len(dirs) == 2 and len(others) == 1:
        return others[0]
    return None


def to_bins(anchors: pd.DataFrame, roads: dict, bins: pd.DataFrame, rid: str, s: np.ndarray) -> pd.DataFrame:
    """주행선 위치들 → (노선, 방향, 1km 이정 구간). 두 노선이 겹치는 곳은 양쪽에 모두 넣는다."""
    parts = []
    for route, xs, ks in segments(anchors, rid):
        direction = direction_name(route, roads[rid], bins)
        if direction is None:
            continue
        km = s_to_km(xs, ks, s)
        idx = np.nonzero(~np.isnan(km))[0]
        parts.append(pd.DataFrame({"i": idx, "route": route, "direction": direction, "km_bin": np.floor(km[idx])}))
    return pd.concat(parts) if parts else pd.DataFrame(columns=["i", "route", "direction", "km_bin"])


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
    args = ap.parse_args()

    roads = load_roads()
    if not ANCHORS.exists():
        raise SystemExit(f"{ANCHORS.relative_to(ROOT)}이 없습니다. 먼저 python pipeline/traffic_ex.py anchors")
    anchors = pd.read_csv(ANCHORS)
    print(f"이정 기준점 {len(anchors)}개, 주행선 {anchors['road_id'].nunique()}개")

    bins = pd.read_csv(ACCIDENT_BINS)
    events, samples = load_game(args.min_seconds)
    if samples.empty:
        print("아직 비교할 주행 기록이 없습니다.")
        return

    # 1초 기록 → 이정 구간별 노출 시간
    parts = []
    for rid, g in samples.groupby("road_id"):
        b = to_bins(anchors, roads, bins, str(rid), g["s"].to_numpy(float))
        if b.empty:
            print(f"  {rid}: 노선·방향을 맞추지 못해 뺍니다")
            continue
        parts.append(b.assign(seconds=1.0))
    if not parts:
        print("이정을 맞출 수 있는 주행 기록이 없습니다.")
        return
    exposure = pd.concat(parts).groupby(["route", "direction", "km_bin"], as_index=False)["seconds"].sum()

    ev_parts = []
    for rid, g in events.groupby("road_id"):
        b = to_bins(anchors, roads, bins, str(rid), g["s"].to_numpy(float))
        if not b.empty:
            ev_parts.append(b.assign(type=g["type"].to_numpy()[b["i"].to_numpy(int)]))
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
