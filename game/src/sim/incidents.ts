// 돌발상황: 고장으로 선 차(갓길이나 차로), 사고로 선 차 두 대. 비상등을 켜고, 운전자에 따라 뒤에 안전삼각대를 세운다.
// 고속도로 2차사고(선 차를 뒤차가 들이받는 사고)는 치사율이 일반 사고의 약 6배라, 선 차를 어떻게 지나가는지를 기록한다.
// 실시간 돌발상황(ITS)을 받기 전까지는 가정한 빈도로 경로 위에 놓는다 (DATA.md).

import { Structure, type Road } from "../road/road";
import type { WorkZone } from "./workzones";

export type IncidentKind = "breakdown" | "crash";

export interface Incident {
  /** 선 차(사고면 앞차) 위치 */
  s: number;
  /** 막힌 차로. 0이면 오른쪽 갓길 */
  lane: number;
  kind: IncidentKind;
  /** 선 차 수 (사고는 2대) */
  vehicles: number;
  /** 운전자가 세운 안전삼각대 위치 (세우지 않았으면 null) */
  triangleS: number | null;
  /** 운전자가 가드레일 밖으로 대피했는지 (아니면 차 옆에 서 있다) */
  evacuated: boolean;
}

/** 사고 차 두 대 사이 간격 (m) */
export const CRASH_GAP_M = 9;

/** km당 돌발상황 수 (가정): 갓길 고장, 차로 고장, 차로 사고 */
export function incidentRatePerKm(night: boolean): { shoulder: number; lane: number; crash: number } {
  // 밤에는 고장 차가 늦게 치워지고 사고도 치사율이 높지만 교통량이 적어 수는 비슷하게 둔다
  return { shoulder: 1 / 90, lane: 1 / 260, crash: night ? 1 / 260 : 1 / 320 };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 도로 전체에 시드로 놓고 출발 1.5km 뒤~도착 1.5km 전만 쓴다 (같은 시드면 어디서 출발하든 같은 자리).
 *  연결로, 나들목 ±300m, 차로 수가 바뀌는 곳, 공사 구간 ±1.5km는 피하고 서로 4km 이상 떨어뜨린다 */
export function planIncidents(
  road: Road,
  opts: { seed: number; night: boolean; startS: number; finishS: number; workZones?: WorkZone[] },
): Incident[] {
  const rng = mulberry32(opts.seed ^ 0x1c1d);
  const rate = incidentRatePerKm(opts.night);
  const STEP = 250;
  const total = (rate.shoulder + rate.lane + rate.crash) * (STEP / 1000);
  const out: Incident[] = [];
  let last = -Infinity;
  let want = false;
  for (let s = 1500; s < road.length - 1500; s += STEP) {
    if (!want) want = rng() < total;
    if (!want) continue;
    if (s - last < 4000) continue;
    const lanes = road.lanesAt(s);
    let ok = lanes >= 2;
    for (let x = s - 300; ok && x <= s + 100; x += 25) if (road.lanesAt(x) !== lanes || road.onConnector(x)) ok = false;
    if (!ok || road.junctions.some((j) => Math.abs(j.s - s) < 300)) continue;
    if (opts.workZones?.some((z) => s > z.s0 - 1500 && s < z.s1 + 1500)) continue;
    const r = rng() * (rate.shoulder + rate.lane + rate.crash);
    const kind: IncidentKind = r < rate.shoulder + rate.lane ? "breakdown" : "crash";
    // 갓길이 없는 터널 안에서는 차로에 선다
    const tunnel = road.structureAt(s) === Structure.Tunnel;
    let lane: number;
    if (kind === "breakdown" && r < rate.shoulder && !tunnel) lane = 0;
    else lane = rng() < 0.65 ? lanes : rng() < 0.5 ? 1 : 1 + Math.floor(rng() * lanes);
    // 삼각대: 고장이면 절반, 사고면 셋 중 하나 (가정). 뒤에서 알아볼 수 있게 낮 100m, 밤 200m쯤
    const setTriangle = rng() < (kind === "breakdown" ? 0.5 : 0.33);
    const back = (opts.night ? 200 : 100) * (0.6 + rng() * 0.6);
    const vehicles = kind === "crash" ? 2 : 1;
    const tail = s - (vehicles - 1) * CRASH_GAP_M;
    out.push({ s, lane, kind, vehicles, triangleS: setTriangle ? tail - back : null, evacuated: rng() < 0.4 });
    last = s;
    want = false;
  }
  return out.filter((i) => i.s > opts.startS + 1500 && i.s < opts.finishS - 1500);
}

/** 선 차들의 s (앞차부터) */
export function incidentVehicleS(i: Incident): number[] {
  return Array.from({ length: i.vehicles }, (_, k) => i.s - k * CRASH_GAP_M);
}

/** 막힌 차로가 시작되는 곳 (맨 뒤 차 꽁무니 조금 앞) */
export function incidentBlockS(i: Incident): number {
  return i.s - (i.vehicles - 1) * CRASH_GAP_M - 6;
}

/** 안내용 말: "2차로 사고 차량", "갓길 고장 차량" */
export function incidentLabel(i: Incident): string {
  const where = i.lane === 0 ? "갓길" : `${i.lane}차로`;
  return `${where} ${i.kind === "crash" ? "사고" : "고장"} 차량`;
}
