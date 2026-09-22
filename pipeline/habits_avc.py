"""도로공사 AVC 원자료(차로별·차종별 15분 교통량·속도)에서 한국 고속도로 운전 습관을 뽑아 게임 운전 성향에 넣는다.

  python pipeline/habits_avc.py            data/raw/ex/avc15/*.json.gz 전부로 계산해서 보여 준다
  python pipeline/habits_avc.py --apply    결과를 game/public/data/driver_profiles.json에 넣는다
  python pipeline/habits_avc.py --pull     매일 수집(GitHub Actions)이 R2에 쌓은 원자료를 먼저 내려받는다 (.env의 R2_* 필요)

원자료는 `pipeline/traffic_ex.py daily`가 날마다 남긴다. 날이 많을수록(평일·주말, 여러 계절) 믿을 만하다.

뽑는 것
  - 차로 이용: 차로 수(2~5)별로 차종군(승용·버스·소형화물·대형화물)이 각 차로에 얼마나 있는지, 차로별 속도.
    1차로 = 중앙분리대 쪽 (승용차 속도가 가장 빠른 차로라 확인된다).
  - 희망속도 비율(speedFactor): 막히지 않고 한산한 15분(그 지점 승용 평균이 제한속도의 80% 이상, 그 차로 시간당 300대 이하)의
    차종군 속도 ÷ 제한속도.
    제한속도는 게임 주행선의 값(OSM)이고, 대형화물은 화물차 제한속도를 쓴다.
    15분 평균이라 차 한 대 한 대의 퍼짐(표준편차)은 이보다 크다. 표준편차는 바꾸지 않는다.
  - 지정차로 준수(designatedLaneCompliance, 대형화물): 편도 3차로 이상에서 대형화물이 앞지르기로도 못 가는 왼쪽 차로에
    있는 비율을, 승용차가 그 차로에 있는 비율로 나눠 '안 지키는 차 비율'로 본다 (안 지키는 차는 승용차처럼 차로를 쓴다고 가정).

--apply가 바꾸는 값 (나머지는 그대로)
  - 승용 계열 성향(standard, calm, aggressive, novice, taxi)의 speedFactor 평균: 성향 비율로 가중한 평균이 측정값이 되도록 같은 만큼 옮긴다.
  - bus_driver, light_commercial, truck_heavy의 speedFactor 평균
  - truck_heavy의 designatedLaneCompliance
  - 파일 맨 위 calibration에 출처·날짜·측정값을 적는다
"""

from __future__ import annotations

import argparse
import gzip
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

from traffic_ex import RAW, ROADS, locate, read_anchors

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "game" / "public" / "data" / "driver_profiles.json"
TRAFFIC_DEFAULTS = ROOT / "game" / "public" / "data" / "traffic_defaults.json"
OUT = ROOT / "data" / "processed" / "habits"

# AVC 12종 → 차종군
GROUPS = {"승용": [1], "버스": [2], "소형화물": [3], "대형화물": list(range(4, 13))}
PASSENGER_PROFILES = ("standard", "calm", "aggressive", "novice", "taxi")
FREE_FLOW = 0.8  # 그 지점(모든 차로) 승용 평균 속도가 제한속도의 이 비율 이상이고
LIGHT_15MIN = 75  # 그 차로 15분 교통량이 이 이하(시간당 300대)인 때만 희망속도로 본다 (앞차 방해가 적을 때)


def num(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return x if x > 0 else 0.0


def step_value(table: list, s: float) -> float:
    """[[s, 값], ...] 계단 표에서 s 위치의 값"""
    v = table[0][1]
    for s0, x in table:
        if s0 > s:
            break
        v = x
    return float(v)


def designated_right(lanes: int) -> list[int]:
    """별표9: 1차로를 뺀 차로를 반으로 나눠 오른쪽 (홀수면 가운데는 왼쪽)"""
    rest = list(range(2, lanes + 1))
    return rest[(len(rest) + 1) // 2 :]


def analyze(files: list[Path]) -> dict:
    anchors = read_anchors()
    roads: dict[str, dict] = {}

    def road(rid: str) -> dict:
        if rid not in roads:
            f = json.loads((ROADS / f"{rid}.json").read_text(encoding="utf-8"))
            roads[rid] = {"speed": f["speed"], "hgv": f.get("speedHgv") or f["speed"]}
        return roads[rid]

    lane_vol = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # [차로 수][차종군][차로]
    lane_spd = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    lane_spd_w = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    ratio_sum = defaultdict(float)
    ratio_w = defaultdict(float)
    ratio_vals = defaultdict(list)
    dates = []
    for path in files:
        raw = json.loads(gzip.decompress(path.read_bytes()))
        dates.append(path.name.split(".")[0])
        # 지점마다 그날 자료가 있는 차로 수, 15분마다 지점 전체(모든 차로) 승용 평균 속도
        lanes_at: dict[tuple, set] = defaultdict(set)
        car_at: dict[tuple, list[float]] = defaultdict(lambda: [0.0, 0.0])
        for r in raw:
            if sum(num(r.get(f"trfv{i}")) for i in range(1, 13)) > 0:
                lanes_at[(r.get("avcId"), r.get("drctClssCd"))].add(int(r.get("crgwNo") or 0))
            v, s = num(r.get("trfv1")), num(r.get("avgSped1"))
            if v > 0 and s > 0:
                acc = car_at[(r.get("avcId"), r.get("drctClssCd"), r.get("totlHhmm"))]
                acc[0] += v * s
                acc[1] += v
        located: dict[tuple, tuple | None] = {}
        for r in raw:
            key = (r.get("avcId"), r.get("drctClssCd"))
            n = len(lanes_at.get(key, ()))
            lane = int(r.get("crgwNo") or 0)
            if n == 0 or not 1 <= lane <= n:
                continue
            vol = {g: sum(num(r.get(f"trfv{c}")) for c in cls) for g, cls in GROUPS.items()}
            if sum(vol.values()) <= 0:
                continue
            spd = {}
            for g, cls in GROUPS.items():
                w = sum(num(r.get(f"trfv{c}")) for c in cls if num(r.get(f"avgSped{c}")) > 0)
                spd[g] = sum(num(r.get(f"trfv{c}")) * num(r.get(f"avgSped{c}")) for c in cls) / w if w > 0 else 0.0
            for g in GROUPS:
                lane_vol[n][g][lane] += vol[g]
                if spd[g] > 0:
                    lane_spd[n][g][lane] += vol[g] * spd[g]
                    lane_spd_w[n][g][lane] += vol[g]

            # 제한속도 대비 속도 (막히지 않을 때)
            if key not in located:
                cd = r.get("routeNo", "")
                km = num(r.get("avcDstnc")) if str(r.get("avcId", "")).startswith(cd) else num(r.get("roadDstnc"))
                located[key] = locate(anchors, cd, r.get("drctClssCd", ""), km)
            hit = located[key]
            car = car_at.get((*key, r.get("totlHhmm")))
            if not hit or not car or car[1] <= 0:
                continue
            rd = road(hit[0])
            limit = step_value(rd["speed"], hit[1])
            if car[0] / car[1] < FREE_FLOW * limit or sum(vol.values()) > LIGHT_15MIN:
                continue
            for g in GROUPS:
                if spd[g] <= 0 or vol[g] <= 0:
                    continue
                lim = step_value(rd["hgv"], hit[1]) if g == "대형화물" else limit
                ratio_sum[g] += vol[g] * spd[g] / lim
                ratio_w[g] += vol[g]
                ratio_vals[g].append(spd[g] / lim)

    usage = {}
    for n in sorted(lane_vol):
        usage[n] = {}
        for g in GROUPS:
            tot = sum(lane_vol[n][g].values())
            if tot <= 0:
                continue
            usage[n][g] = {
                "share": [round(lane_vol[n][g][i] / tot, 3) for i in range(1, n + 1)],
                "speed": [round(lane_spd[n][g][i] / lane_spd_w[n][g][i], 1) if lane_spd_w[n][g][i] > 0 else None for i in range(1, n + 1)],
                "volume": round(tot),
            }

    # 지정차로: 차로 수별 '안 지키는 대형화물 비율'을 대형화물 교통량으로 가중 평균
    noncomp, weight = 0.0, 0.0
    for n, u in usage.items():
        if n < 3 or "대형화물" not in u or "승용" not in u:
            continue
        lowest = min(designated_right(n))
        forbidden = [i for i in range(1, n + 1) if i < lowest - 1]
        heavy = sum(u["대형화물"]["share"][i - 1] for i in forbidden)
        car = sum(u["승용"]["share"][i - 1] for i in forbidden)
        if car > 0:
            noncomp += min(1.0, heavy / car) * u["대형화물"]["volume"]
            weight += u["대형화물"]["volume"]

    speed_factor = {
        g: {"mean": round(ratio_sum[g] / ratio_w[g], 3), "sd_15min": round(float(np.std(ratio_vals[g])), 3), "intervals": len(ratio_vals[g])}
        for g in GROUPS
        if ratio_w[g] > 0
    }
    passing = {n: u["승용"]["share"][0] for n, u in usage.items() if n >= 3 and "승용" in u}
    return {
        "dates": sorted(dates),
        "source": "한국도로공사 AVC 15분 원시자료 (data.ex.co.kr)",
        "laneUsage": usage,
        "speedFactor": speed_factor,
        "designatedLaneCompliance": round(1 - noncomp / weight, 3) if weight else None,
        "passingLaneCarShare": passing,
    }


def apply(result: dict) -> list[str]:
    prof = json.loads(PROFILES.read_text(encoding="utf-8"))
    ps = prof["profiles"]
    sf = result["speedFactor"]
    changes = []

    def set_mean(name: str, value: float):
        old = ps[name]["speedFactor"][0]
        ps[name]["speedFactor"][0] = round(value, 3)
        changes.append(f"{name}.speedFactor {old} → {ps[name]['speedFactor'][0]}")

    if "승용" in sf:
        # 승용 계열 성향의 현재 가중 평균 (분류 구성비 × 성향 배정)
        comp = json.loads(TRAFFIC_DEFAULTS.read_text(encoding="utf-8"))["composition"]
        num_, den = 0.0, 0.0
        for cat in ("승용", "SUV", "전기차", "택시"):
            table = prof["assignment"].get(cat, {})
            tot = sum(table.values()) or 1
            for pid, w in table.items():
                if pid in PASSENGER_PROFILES:
                    num_ += comp.get(cat, 0) * w / tot * ps[pid]["speedFactor"][0]
                    den += comp.get(cat, 0) * w / tot
        shift = sf["승용"]["mean"] - num_ / den
        for pid in PASSENGER_PROFILES:
            set_mean(pid, ps[pid]["speedFactor"][0] + shift)
    for group, pid in (("버스", "bus_driver"), ("소형화물", "light_commercial"), ("대형화물", "truck_heavy")):
        if group in sf and pid in ps:
            set_mean(pid, sf[group]["mean"])
    if result["designatedLaneCompliance"] is not None and "truck_heavy" in ps:
        old = ps["truck_heavy"]["designatedLaneCompliance"]
        ps["truck_heavy"]["designatedLaneCompliance"] = result["designatedLaneCompliance"]
        changes.append(f"truck_heavy.designatedLaneCompliance {old} → {result['designatedLaneCompliance']}")

    prof["calibration"] = {
        "source": result["source"],
        "dates": result["dates"],
        "changed": changes,
        "measured": {
            "speedFactor": result["speedFactor"],
            "designatedLaneCompliance": result["designatedLaneCompliance"],
            "passingLaneCarShare": result["passingLaneCarShare"],
        },
        "by": "pipeline/habits_avc.py --apply",
    }
    prof["status"] = "일부 측정값 (calibration 참고), 나머지 가정값"
    PROFILES.write_text(json.dumps(prof, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changes


def pull() -> None:
    """R2 raw/ex/avc15/의 원자료 중 로컬에 없는 것을 받는다."""
    from storage import bucket, client

    c, b = client(), bucket()
    dest = RAW / "avc15"
    dest.mkdir(parents=True, exist_ok=True)
    got = 0
    for page in c.get_paginator("list_objects_v2").paginate(Bucket=b, Prefix="raw/ex/avc15/"):
        for obj in page.get("Contents", []):
            path = dest / obj["Key"].rsplit("/", 1)[-1]
            if not path.exists():
                c.download_file(b, obj["Key"], str(path))
                got += 1
    print(f"R2에서 원자료 {got}일치를 받았습니다")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="driver_profiles.json에 넣는다")
    ap.add_argument("--pull", action="store_true", help="R2에 쌓인 원자료를 먼저 받는다")
    args = ap.parse_args()
    if args.pull:
        pull()
    files = sorted((RAW / "avc15").glob("*.json.gz"))
    if not files:
        raise SystemExit("data/raw/ex/avc15/에 원자료가 없습니다. 먼저 python pipeline/traffic_ex.py daily")
    result = analyze(files)
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"avc_{result['dates'][0]}_{result['dates'][-1]}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"AVC 원자료 {len(files)}일 ({', '.join(result['dates'])})")
    for n, u in result["laneUsage"].items():
        print(f"\n편도 {n}차로 — 차로별 비율 (1차로 = 왼쪽) / 속도 km/h")
        for g, x in u.items():
            share = " ".join(f"{v * 100:4.0f}%" for v in x["share"])
            speed = " ".join(f"{v:5.0f}" if v else "    -" for v in x["speed"])
            print(f"  {g:5s} {share}   {speed}")
    print("\n희망속도 ÷ 제한속도 (막히지 않고 한산한 15분)")
    for g, x in result["speedFactor"].items():
        print(f"  {g:5s} {x['mean']:.3f}  (15분 평균의 표준편차 {x['sd_15min']:.3f}, {x['intervals']}개)")
    print(f"\n대형화물 지정차로 준수 추정: {result['designatedLaneCompliance']}")
    print("승용차 1차로(앞지르기 차로) 비율:", {f"편도{n}": f"{v * 100:.0f}%" for n, v in result["passingLaneCarShare"].items()})
    print(f"\n결과: {out.relative_to(ROOT)}")
    if args.apply:
        for c in apply(result):
            print("  " + c)
        print(f"{PROFILES.relative_to(ROOT)}에 넣었습니다. 게임 폴더에서 npm test로 형식을 확인하세요.")


if __name__ == "__main__":
    main()
