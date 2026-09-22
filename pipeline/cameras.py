"""고속도로 과속 단속 카메라·구간단속을 게임 주행선 위치(s)로 옮긴다.

입력: 경찰청 전국무인교통단속카메라표준데이터 (공공데이터포털 15028200). 로그인·인증키 없이 받는 파일 데이터.
      도로종류가 고속국도인 것만 쓴다.
출력: game/public/data/cameras.json
      roads.<주행선 id>.fixed     [[s, 제한속도], ...]          고정식 과속 카메라
      roads.<주행선 id>.sections  [[s0, s1, 제한속도], ...]      구간단속 (시점, 종점)
      제한속도 0은 데이터에 없음 (게임은 도로 제한속도를 쓴다)

어느 방향 주행선인지: 설치장소 글("목포방향", "(구리→포천)")에 나온 곳이 그 주행선의 앞쪽에 있으면 그 방향.
글로 알 수 없으면 두 주행선 가운데 확실히 더 가까운 쪽, 그것도 아니면 양쪽 모두에 넣는다.
데이터의 방향 코드(1·2·3)는 노선마다 뜻이 달라 쓰지 않는다 (3 = 양방향만 쓴다).

실행: .venv\\Scripts\\python pipeline\\cameras.py            (받은 파일이 있으면 다시 받지 않는다)
      .venv\\Scripts\\python pipeline\\cameras.py --download
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "cameras" / "cameras_std.json"
ROADS = ROOT / "game" / "public" / "roads"
OUT = ROOT / "game" / "public" / "data" / "cameras.json"

PK = "15028200"
BASE = "https://www.data.go.kr/download"
MAX_DIST = 120.0  # 카메라와 주행선 사이 최대 거리 (m)
CLEAR = 0.7  # 가까운 주행선이 먼 쪽 거리의 이 비율보다 가까우면 그쪽으로 정한다
DEDUPE_M = 80.0  # 같은 주행선에서 이보다 가까운 고정식 카메라는 하나로 (차로별로 따로 올라온 것)
DEDUPE_SECTION_M = 1000.0  # 구간단속 시점·종점은 이 안의 것을 하나로 (차로별·기관별로 조금씩 다른 좌표)
MIN_SECTION_M = 1500.0  # 구간단속은 보통 몇 km라 이보다 짧은 짝은 다른 구간의 종점으로 본다
MAX_SECTION_M = 25_000.0
AHEAD_M = 80_000.0  # 방향 글에 나온 곳을 찾는 거리


def download() -> list[dict]:
    head = {"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest"}

    def get(url: str):
        req = urllib.request.Request(url, headers=head)
        return json.loads(urllib.request.urlopen(req, timeout=180).read().decode("utf-8"))

    cols = get(f"{BASE}/columList.json?pk={PK}&ext=CSV")
    tv = cols["tableVO"]
    rows: list[dict] = []
    page = 1
    while True:
        q = [("colNmList", c) for c in tv["colNmList"]] + [
            ("totalCount", cols["totalCount"]),
            ("svcTableNm", tv["svcTableNm"]),
            ("perPage", 10000),
            ("page", page),
        ]
        data = get(f"{BASE}/standard.json?publicDataPk={PK}&" + urllib.parse.urlencode(q))
        rows += data
        print(f"  page {page}: {len(data)}")
        if len(data) < 10000:
            break
        page += 1
    RAW.parent.mkdir(parents=True, exist_ok=True)
    RAW.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


def plain(name: str) -> str:
    """이름 맞추기용: 공백·괄호와 IC/JC/TG/분기점 꼬리를 뺀다"""
    n = re.sub(r"[\s()]", "", name)
    return re.sub(r"(IC|JCT?|TG|분기점|나들목|요금소|영업소|휴게소|방면|방향)$", "", n)


class Line:
    def __init__(self, meta: dict):
        f = json.loads((ROADS / f"{meta['id']}.json").read_text(encoding="utf-8"))
        self.id = f["id"]
        self.ref = str(f["ref"])
        self.name = f["name"]
        self.frm = plain(f["from"])
        self.to = plain(f["to"])
        self.step = f["step"]
        d = np.column_stack([f["dx"], f["dy"]]).astype(np.int64)
        q = np.vstack([np.round(np.array(f["origin"]) * 10).astype(np.int64), d]).cumsum(axis=0) / 10.0
        self.x, self.y = q[:, 0], q[:, 1]
        self.box = (self.x.min() - MAX_DIST, self.x.max() + MAX_DIST, self.y.min() - MAX_DIST, self.y.max() + MAX_DIST)
        self.junctions = [(float(s), plain(name)) for s, name, _ in f["junctions"] if name]

    def nearest(self, x: float, y: float) -> tuple[float, float]:
        """(거리, s)"""
        x0, x1, y0, y1 = self.box
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            return float("inf"), 0.0
        d2 = (self.x - x) ** 2 + (self.y - y) ** 2
        i = int(np.argmin(d2))
        return float(np.sqrt(d2[i])), i * self.step

    def place_score(self, s: float, place: str, ahead: bool) -> bool:
        """place가 s 앞쪽(ahead) 또는 뒤쪽에 있는 나들목·분기점이거나 이 주행선의 끝(앞)·시작(뒤)인지"""
        if not place:
            return False
        if ahead and (place in self.to or self.to in place):
            return True
        if not ahead and (place in self.frm or self.frm in place):
            return True
        for js, name in self.junctions:
            if not name:
                continue
            if (place in name or name in place) and (0 < js - s < AHEAD_M if ahead else 0 < s - js < AHEAD_M):
                return True
        return False


def direction_words(text: str) -> tuple[str, str]:
    """설치장소 글에서 (어디에서, 어디로)"""
    t = text.replace("-&gt;", "→").replace("->", "→").replace("⇒", "→").replace("＞", "→").replace(">", "→")
    m = re.search(r"([가-힣A-Za-z0-9]+)\s*→\s*([가-힣A-Za-z0-9]+)", t)
    if m:
        return plain(m.group(1)), plain(m.group(2))
    m = re.search(r"([가-힣]{2,})\s*(방향|방면)", t)
    if m:
        return "", plain(m.group(1))
    return "", ""


def role(r: dict) -> str:
    """fixed | start | end"""
    code = (r.get("REGLT_SCTN_LC_SE") or "").lstrip("0")
    if code == "1":
        return "start"
    if code == "2":
        return "end"
    text = r.get("ITLPC") or ""
    if re.search(r"(구간)?시점", text):
        return "start"
    if re.search(r"(구간)?종점", text):
        return "end"
    return "fixed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    args = ap.parse_args()
    rows = download() if args.download or not RAW.exists() else json.loads(RAW.read_text(encoding="utf-8"))
    hw = [r for r in rows if r.get("ROAD_KND") == "고속국도" and r.get("LATITUDE") and r.get("LONGITUDE")]
    print(f"전체 {len(rows)}대, 고속국도 {len(hw)}대")

    index = json.loads((ROADS / "index.json").read_text(encoding="utf-8"))
    lines = [Line(m) for m in index["roads"]]
    tf = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)

    placed: dict[str, dict[str, list]] = {}
    stats = Counter()
    for r in hw:
        x, y = tf.transform(float(r["LONGITUDE"]), float(r["LATITUDE"]))
        near = sorted(((ln.nearest(x, y), ln) for ln in lines), key=lambda t: t[0][0])
        near = [(d, s, ln) for (d, s), ln in near if d < MAX_DIST]
        if not near:
            stats["주행선 없음"] += 1
            continue
        # 가장 가까운 주행선과 같은 노선(번호)의 주행선만 후보로
        ref = near[0][2].ref
        cand = [c for c in near if c[2].ref == ref]
        frm, to = direction_words(r.get("ITLPC") or "")
        pick = []
        if to or frm:
            scored = [(int(c[2].place_score(c[1], to, True)) * 2 + int(c[2].place_score(c[1], frm, False)), c) for c in cand]
            best = max(sc for sc, _ in scored)
            if best > 0:
                pick = [c for sc, c in scored if sc == best]
                stats["방향: 글"] += 1
        if not pick and (r.get("ROAD_ROUTE_DRC") or "").lstrip("0") == "3":
            pick = cand
            stats["방향: 양방향"] += 1
        if not pick:
            if len(cand) == 1 or cand[0][0] < CLEAR * cand[1][0]:
                pick = [cand[0]]
                stats["방향: 가까운 쪽"] += 1
            else:
                pick = cand[:2]
                stats["방향: 모름(양쪽)"] += 1
        limit = int(r.get("LMTT_VE") or 0)
        kind = role(r)
        # 구간 길이는 km로 적은 곳과 m로 적은 곳이 섞여 있다
        lt = r.get("OVRSPD_REGLT_SCTN_LT") or ""
        length = 0.0
        if re.fullmatch(r"[\d.]+", lt):
            v = float(lt)
            length = v if v > 100 else v * 1000
        for _, s, ln in pick:
            placed.setdefault(ln.id, {"fixed": [], "start": [], "end": []})[kind].append((s, limit, length))
        stats[kind] += 1

    out: dict[str, dict] = {}
    n_fixed = n_sec = n_guess = 0
    for rid, by in placed.items():
        def dedupe(items, gap):
            items = sorted(items)
            keep = []
            for it in items:
                if keep and it[0] - keep[-1][0] < gap:
                    continue
                keep.append(it)
            return keep

        fixed = dedupe(by["fixed"], DEDUPE_M)
        starts = dedupe(by["start"], DEDUPE_SECTION_M)
        ends = dedupe(by["end"], DEDUPE_SECTION_M)
        sections = []
        used = set()
        for s0, lim, length in starts:
            best = None
            for k, (s1, _, _) in enumerate(ends):
                if k in used or not (MIN_SECTION_M < s1 - s0 < MAX_SECTION_M):
                    continue
                if length and abs((s1 - s0) - length) / length > 0.35:
                    continue
                # 길이를 알면 길이가 가장 맞는 종점, 모르면 가장 가까운 종점
                key = abs((s1 - s0) - length) if length else s1
                if best is None or key < best[0]:
                    best = (key, k)
            if best is not None:
                used.add(best[1])
                sections.append([round(s0), round(ends[best[1]][0]), lim])
            elif MIN_SECTION_M < length < MAX_SECTION_M:
                sections.append([round(s0), round(s0 + length), lim])
                n_guess += 1
        # 겹치는 구간은 먼저 시작하는 것만 남긴다
        sections.sort()
        merged = []
        for sec in sections:
            if merged and sec[0] < merged[-1][1]:
                continue
            merged.append(sec)
        sections = merged
        # 구간단속 안의 고정식은 구간단속 카메라로 본다
        fixed = [f for f in fixed if not any(a - 50 <= f[0] <= b + 50 for a, b, _ in sections)]
        entry = {}
        if fixed:
            entry["fixed"] = [[round(s), lim] for s, lim, _ in fixed]
        if sections:
            entry["sections"] = sections
        if entry:
            out[rid] = entry
            n_fixed += len(fixed)
            n_sec += len(sections)

    dates = sorted(r.get("REFERENCE_DATE") or "" for r in hw)
    result = {
        "source": "경찰청 전국무인교통단속카메라표준데이터 (공공데이터포털 15028200)",
        "referenceDate": dates[-1] if dates else "",
        "note": "고속국도 카메라를 주행선 위치(s, m)로 옮긴 것. 제한속도 0은 데이터에 없음. 방향은 설치장소 글과 거리로 정했다 (pipeline/cameras.py).",
        "roads": dict(sorted(out.items(), key=lambda kv: (int(re.sub(r"\D", "", kv[0].split("-")[0]) or 0), kv[0]))),
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(dict(stats))
    print(f"주행선 {len(out)}개에 고정식 {n_fixed}대, 구간단속 {n_sec}곳 (종점을 못 찾아 길이로 정한 곳 {n_guess}) → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
