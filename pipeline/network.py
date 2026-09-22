"""전국 고속도로망: 게임 주행선들을 JC(분기점)에서 이어 경로를 찾을 수 있게 만든다.

  python pipeline/network.py   →  game/public/roads/network.json

담는 것
  roads      주행선마다 이름·번호·방향, 500m 간격 중심선(지도 그리기), 나들목·분기점·휴게소 목록
  transfers  갈아타는 곳: 주행선 A의 s_a에서 주행선 B의 s_b로 (같은 이름의 JC가 양쪽에 있고, 두 길이 1.5km 안으로 만나며,
             되돌아가는 방향이 아닐 때). 이름 없는 연결(한 주행선이 끝나는 곳에서 다른 주행선이 시작·합류)도 넣는다.

좌표는 게임과 같은 UTM-K(EPSG:5179). 지도용 점은 원점(origin)을 뺀 10m 단위 정수.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ROADS = ROOT / "game" / "public" / "roads"
OUT = ROADS / "network.json"
MAP_STEP = 500.0  # 지도용 점 간격 (m)
MEET_M = 1500.0  # JC 지점에서 다른 주행선까지 이보다 가까워야 이어진다
END_MEET_M = 800.0  # 이름 없는 연결: 끝점·시작점 사이 거리


def junction_kind(name: str, exit_no: str) -> str:
    """game/src/road/road.ts의 junctionKind와 같은 규칙"""
    if re.search(r"분기점|JCT?\b|JC$", name, re.I):
        return "JC"
    if re.search(r"요금소|톨게이트|TG$", name, re.I):
        return "TG"
    if re.search(r"휴게소|졸음쉼터|쉼터|SA$", name, re.I):
        return "SA"
    if re.search(r"나들목|IC\b|IC$", name, re.I):
        return "IC"
    if "하이패스" in name:
        return "기타"
    return "IC" if exit_no else "기타"


def short_name(name: str, kind: str) -> str:
    """road.ts의 shortJunctionName과 같은 규칙"""
    n = re.sub(r"\s*\([^)]*방향\)\s*", "", name)
    n = n.replace("분기점", "JC").replace("나들목", "IC").replace("요금소", "TG")
    n = re.sub(r"\s+(IC|JC|TG)$", r"\1", n).strip()
    if kind == "IC" and not n.endswith("IC"):
        n += "IC"
    return n


def base_name(name: str) -> str:
    """이름 맞추기용: 공백과 IC/JC/TG 꼬리를 뺀다 ("신갈분기점" = "신갈JC" = "신갈")"""
    n = re.sub(r"\s+", "", name)
    return re.sub(r"(IC|JCT?|TG|분기점|나들목|요금소)$", "", n)


class Road:
    def __init__(self, meta: dict):
        f = json.loads((ROADS / f"{meta['id']}.json").read_text(encoding="utf-8"))
        self.id = f["id"]
        self.ref = f["ref"]
        self.name = f["name"]
        self.frm = f["from"]
        self.to = f["to"]
        self.step = f["step"]
        d = np.column_stack([f["dx"], f["dy"]]).astype(np.int64)
        q = np.vstack([np.round(np.array(f["origin"]) * 10).astype(np.int64), d]).cumsum(axis=0) / 10.0
        self.x, self.y = q[:, 0], q[:, 1]
        self.length = (len(self.x) - 1) * self.step
        self.lanes = f["lanes"]
        self.speed = f["speed"]
        self.junctions = []
        for s, name, exit_no in f["junctions"]:
            if not name:
                continue
            kind = junction_kind(name, exit_no)
            self.junctions.append({"s": float(s), "name": short_name(name, kind), "kind": kind, "base": base_name(short_name(name, kind))})

    def point(self, s: float) -> tuple[float, float]:
        i = min(len(self.x) - 1, max(0, int(round(s / self.step))))
        return float(self.x[i]), float(self.y[i])

    def heading(self, s: float) -> np.ndarray:
        i = min(len(self.x) - 2, max(0, int(round(s / self.step))))
        j = min(len(self.x) - 1, i + 5)
        i = max(0, j - 10)
        v = np.array([self.x[j] - self.x[i], self.y[j] - self.y[i]])
        return v / (np.linalg.norm(v) or 1.0)

    def closest(self, x: float, y: float) -> tuple[float, float]:
        d2 = (self.x - x) ** 2 + (self.y - y) ** 2
        i = int(np.argmin(d2))
        return i * self.step, float(np.sqrt(d2[i]))

    def bbox_near(self, x: float, y: float, margin: float) -> bool:
        return bool(self.x.min() - margin <= x <= self.x.max() + margin and self.y.min() - margin <= y <= self.y.max() + margin)


def main() -> None:
    index = json.loads((ROADS / "index.json").read_text(encoding="utf-8"))
    roads = [Road(r) for r in index["roads"]]
    ox = min(float(r.x.min()) for r in roads)
    oy = min(float(r.y.min()) for r in roads)

    transfers: list[dict] = []

    def add(a: Road, sa: float, b: Road, sb: float, name: str, kind: str):
        # 같은 두 주행선 사이에 3km 안의 연결이 이미 있으면 건너뛴다
        for t in transfers:
            if t["a"] == a.id and t["b"] == b.id and abs(t["sa"] - sa) < 3000:
                return
        transfers.append({"a": a.id, "sa": round(sa, 1), "b": b.id, "sb": round(sb, 1), "name": name, "kind": kind})

    for a in roads:
        # 1) 이름이 같은 JC
        for j in a.junctions:
            if j["kind"] != "JC":
                continue
            x, y = a.point(j["s"])
            ha = a.heading(j["s"])
            for b in roads:
                if b is a or not b.bbox_near(x, y, MEET_M):
                    continue
                sb, dist = b.closest(x, y)
                if dist > MEET_M or sb > b.length - 1000:  # B에서 더 달릴 곳이 없으면 쓸모없다
                    continue
                named = any(k["base"] == j["base"] and abs(k["s"] - sb) < 3000 for k in b.junctions)
                starts_here = sb < 400  # B가 이 JC에서 시작 (시작점에는 JC 이름이 없는 경우가 많다)
                if not named and not starts_here:
                    continue
                # 방향은 조금 앞에서 잰다 (시작 부분이 연결로처럼 굽어 있을 수 있다)
                hb = b.heading(min(sb + 600, b.length))
                if float(ha @ hb) < -0.3:  # 되돌아가는 방향 (반대편 차로 등)
                    continue
                if b.ref == a.ref and float(ha @ hb) < 0.5 and dist < 60:
                    continue
                add(a, j["s"], b, sb, j["name"], "JC")
        # 2) 이름 없는 연결: A가 끝나는 곳이 B 위에 있거나, B가 A 위에서 시작
        ex, ey = a.point(a.length)
        he = a.heading(a.length)
        for b in roads:
            if b is a or not b.bbox_near(ex, ey, END_MEET_M):
                continue
            sb, dist = b.closest(ex, ey)
            if dist < END_MEET_M and float(he @ b.heading(min(sb + 600, b.length))) > 0.3 and sb < b.length - 1000:
                add(a, a.length, b, sb, "", "end")
        for b in roads:
            if b is a:
                continue
            bx, by = b.point(0)
            if not a.bbox_near(bx, by, END_MEET_M):
                continue
            sa, dist = a.closest(bx, by)
            if dist < END_MEET_M and float(a.heading(sa) @ b.heading(600)) > 0.3 and 200 < sa < a.length - 200:
                add(a, sa, b, 0.0, "", "start")

    out_roads = []
    for r in roads:
        n = max(2, int(r.length // MAP_STEP) + 1)
        ss = np.linspace(0, r.length, n)
        pts = []
        for s in ss:
            x, y = r.point(s)
            pts += [int(round((x - ox) / 10)), int(round((y - oy) / 10))]
        out_roads.append(
            {
                "id": r.id,
                "ref": r.ref,
                "name": r.name,
                "from": r.frm,
                "to": r.to,
                "length": round(r.length, 1),
                "speed": r.speed,
                "p": pts,
                "j": [[round(j["s"], 1), j["name"], j["kind"]] for j in r.junctions],
            }
        )
    out = {
        "source": index.get("source", ""),
        "origin": [round(ox, 1), round(oy, 1)],
        "mapStep": MAP_STEP,
        "roads": out_roads,
        "transfers": transfers,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kinds = {k: sum(1 for t in transfers if t["kind"] == k) for k in ("JC", "end", "start")}
    print(f"{OUT.relative_to(ROOT)}: 주행선 {len(out_roads)}개, 갈아타는 곳 {len(transfers)}곳 {kinds}, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
