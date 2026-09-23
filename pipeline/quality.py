"""연구 데이터 품질 재검사. 게임(game/src/log/quality.ts)과 같은 기준(game/public/data/data_quality.json)으로
저장된 1초 기록·이벤트만 보고 다시 판정한다. 브라우저 코드는 고칠 수 있으므로 분석·데이터셋 공개 전에 서버 쪽에서 한 번 더 거른다.

  python pipeline/quality.py      DB의 주행마다 판정하고 걸러질 이유별 수를 보여 준다

다른 스크립트는 accepted_sessions()로 통과한 세션 id만 받아 쓴다 (compare_hotspots.py).
"""

import json
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = ROOT / "game" / "public" / "data" / "data_quality.json"


def load_rules() -> dict:
    return json.loads(RULES_PATH.read_text(encoding="utf-8"))


def assess_session(columns: list[str], samples: list[list], events: list[dict], rules: dict) -> dict:
    """quality.ts의 assessSession과 같다. events는 {"type", "detail"} 목록."""
    idx = {c: i for i, c in enumerate(columns)}

    def num(row, name):
        i = idx.get(name)
        if i is None or i >= len(row) or row[i] is None:
            return None
        return float(row[i])

    r = rules
    m = dict(driveSec=len(samples), distanceM=0.0, congestedSec=0, jamSpeedingSec=0, extremeSec=0, shoulderSec=0,
             idleSec=0, noInputSec=0, crashes=0, seriousCrashes=0, nearMisses=0)
    for row in samples:
        kmh = num(row, "speed_kmh") or 0.0
        m["distanceM"] += kmh / 3.6
        flow = num(row, "flow_kmh")
        if flow is not None and flow <= r["jamSpeeding"]["flowBelowKmh"]:
            m["congestedSec"] += 1
            if kmh >= flow + r["jamSpeeding"]["aboveFlowKmh"]:
                m["jamSpeedingSec"] += 1
        limit = num(row, "limit_kmh")
        if limit and limit > 0 and kmh >= limit + r["extremeSpeed"]["overLimitKmh"]:
            m["extremeSec"] += 1
        lane, lanes = num(row, "lane"), num(row, "lanes")
        if lane is not None and lanes is not None and (lane < 1 or lane > lanes):
            m["shoulderSec"] += 1
        if flow is not None and flow > r["idle"]["flowAboveKmh"] and kmh < r["idle"]["stoppedBelowKmh"]:
            m["idleSec"] += 1
        if not num(row, "throttle") and not num(row, "brake") and not num(row, "steer"):
            m["noInputSec"] += 1
    m["distanceM"] = math.floor(m["distanceM"] + 0.5)  # JS Math.round와 같게 (round는 .5를 짝수로)
    for e in events:
        if e["type"] == "crash":
            m["crashes"] += 1
            if float((e.get("detail") or {}).get("relSpeedKmh") or 0) >= r["crashes"]["seriousKmh"]:
                m["seriousCrashes"] += 1
        elif e["type"] == "near_miss" and (e.get("detail") or {}).get("cause") != "cut_in":
            # 게임이 일으킨 끼어들기 뒤 5초 안의 아차사고는 플레이어 잘못이 아니라서 세지 않는다
            m["nearMisses"] += 1

    def per10km(n):
        return n / max(1.0, m["distanceM"] / 10000)

    def share(n, of):
        return n / of if of > 0 else 0.0

    reasons = []
    if m["driveSec"] < r["minDriveSec"] or m["distanceM"] < r["minDistanceM"]:
        reasons.append("too_short")
    j = r["jamSpeeding"]
    if m["jamSpeedingSec"] >= j["minSec"] and share(m["jamSpeedingSec"], m["congestedSec"]) >= j["minShare"]:
        reasons.append("jam_speeding")
    if m["extremeSec"] >= r["extremeSpeed"]["minSec"]:
        reasons.append("extreme_speed")
    c = r["crashes"]
    if m["seriousCrashes"] >= c["minCount"] and per10km(m["seriousCrashes"]) >= c["per10km"]:
        reasons.append("crashes")
    c = r["contacts"]
    if m["crashes"] >= c["minCount"] and per10km(m["crashes"]) >= c["per10km"]:
        reasons.append("contacts")
    s = r["shoulder"]
    if m["shoulderSec"] >= s["minSec"] and share(m["shoulderSec"], m["driveSec"]) >= s["minShare"]:
        reasons.append("shoulder")
    if share(m["idleSec"], m["driveSec"]) >= r["idle"]["maxShare"]:
        reasons.append("idle")
    if m["driveSec"] > 0 and share(m["noInputSec"], m["driveSec"]) >= r["noInput"]["maxShare"]:
        reasons.append("no_input")
    n = r["nearMiss"]
    if m["nearMisses"] >= n["minCount"] and per10km(m["nearMisses"]) >= n["per10km"]:
        reasons.append("near_miss")
    return {"ok": not reasons, "reasons": reasons, "metrics": m}


def flag_participants(verdicts: list[tuple[str, str, bool]], rules: dict) -> set[str]:
    """(participant, started_at, ok) 목록에서 게임과 같은 방식(최근 window번 중 maxRejected번)으로 걸러진 참여자.
    게임은 참여자가 걸러지면 그 뒤 주행을 올리지 않으므로, 여기서는 한 번이라도 걸러진 참여자를 통째로 뺀다."""
    p = rules["participant"]
    flagged = set()
    by = {}
    for pid, _started, ok in sorted(verdicts, key=lambda v: (v[0], v[1] or "")):
        by.setdefault(pid, []).append(ok)
    for pid, oks in by.items():
        for k in range(len(oks)):
            window = oks[max(0, k + 1 - p["window"]) : k + 1]
            if window.count(False) >= p["maxRejected"]:
                flagged.add(pid)
                break
    return flagged


def judge_all(conn, rules: dict | None = None) -> dict[str, dict]:
    """DB의 모든 세션을 판정한다. 세션 id → 판정 (참여자 거르기 포함)."""
    rules = rules or load_rules()
    sessions = conn.execute("select id::text, participant_id::text, started_at::text from drip_sessions").fetchall()
    samples: dict[str, list] = {}
    columns: dict[str, list[str]] = {}
    for sid, _t0, cols, data in conn.execute("select session_id::text, t0, columns, data from drip_samples order by session_id, t0").fetchall():
        samples.setdefault(sid, []).extend(data)
        columns[sid] = list(cols)
    events: dict[str, list] = {}
    for sid, typ, detail in conn.execute("select session_id::text, type, detail from drip_events").fetchall():
        events.setdefault(sid, []).append({"type": typ, "detail": detail})
    out = {}
    for sid, pid, started in sessions:
        v = assess_session(columns.get(sid, []), samples.get(sid, []), events.get(sid, []), rules)
        out[sid] = v | {"participant": pid, "started_at": started}
    flagged = flag_participants([(v["participant"], v["started_at"], v["ok"]) for v in out.values()], rules)
    for v in out.values():
        if v["participant"] in flagged and v["ok"]:
            v["ok"] = False
            v["reasons"] = ["participant"]
    return out


def accepted_sessions(conn) -> set[str]:
    return {sid for sid, v in judge_all(conn).items() if v["ok"]}


def main() -> None:
    from db import connect

    with connect() as conn:
        verdicts = judge_all(conn)
    total = len(verdicts)
    ok = sum(v["ok"] for v in verdicts.values())
    print(f"주행 {total}번 중 통과 {ok}번, 걸러짐 {total - ok}번 (기준 {load_rules()['version']})")
    reasons = Counter(r for v in verdicts.values() for r in v["reasons"])
    for r, n in reasons.most_common():
        print(f"  {r:14} {n}")


if __name__ == "__main__":
    main()
