// 고속도로 공사 구간: 한 차로를 라바콘으로 막고, 앞에 화살표 차량을 세운다.
// 실시간 공사 정보(ITS 돌발상황)를 받기 전까지는 시간대·요일에 따른 빈도로 경로 위에 놓는다 (가정값, DATA.md).

import { LANE_WIDTH, Structure, type Road } from "../road/road";

export interface WorkZone {
  /** 라바콘이 차로 가장자리에서 비스듬히 들어오기 시작하는 곳 */
  s0: number;
  /** 차로가 다 막히는 곳 (s0 + TAPER_M) */
  sClosed: number;
  /** 막힌 구간 끝 (여기서 END_TAPER_M 동안 콘이 빠져나간다) */
  s1: number;
  lane: number;
  side: "left" | "right";
}

export const TAPER_M = 120;
export const END_TAPER_M = 40;
/** 공사 구간 임시 제한속도 (km/h) */
export const ZONE_KMH = 80;
/** 제한속도를 낮추는 범위: 테이퍼 앞 300m부터 끝까지 */
const LIMIT_BEFORE_M = 300;

/** km당 공사 구간 수. 낮(9~17시)에 가장 많고 주말에는 드물다 (가정) */
export function zoneRatePerKm(hour: number, weekend: boolean): number {
  const h = ((hour % 24) + 24) % 24;
  const base = h >= 9 && h < 17 ? 1 / 35 : h >= 21 || h < 5 ? 1 / 70 : 1 / 120;
  return base * (weekend ? 0.4 : 1);
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

/** 도로 전체에 시드로 놓은 뒤, 출발 1.2km 뒤(1km 예고가 들어가게)부터 도착 1.5km 전까지만 쓴다.
 *  그래서 같은 시드면 어디서 출발하든 같은 자리다. 터널, 나들목 근처, 차로 수가 바뀌는 곳은 피하고,
 *  놓을 곳이 안 맞으면 다음 자리에서 다시 찾는다 (그래서 km당 빈도가 지켜진다) */
export function planWorkZones(road: Road, opts: { seed: number; hour: number; weekend: boolean; startS: number; finishS: number }): WorkZone[] {
  const rng = mulberry32(opts.seed ^ 0x5eed);
  const STEP = 250;
  const rate = zoneRatePerKm(opts.hour, opts.weekend) * (STEP / 1000);
  const out: WorkZone[] = [];
  let lastEnd = -Infinity;
  let want = false;
  for (let s0 = 1000; s0 < road.length - 1000; s0 += STEP) {
    if (!want) want = rng() < rate;
    if (!want) continue;
    const len = 300 + rng() * 900;
    const s1 = s0 + TAPER_M + len;
    if (s0 - lastEnd < 5000) continue;
    if (s1 + END_TAPER_M > road.length - 500) break;
    const lanes = road.lanesAt(s0);
    let ok = lanes >= 2;
    for (let x = s0 - 200; ok && x <= s1 + 200; x += 25) {
      const xs = Math.min(road.length - 1, Math.max(0, x));
      if (road.lanesAt(xs) !== lanes || road.structureAt(xs) === Structure.Tunnel || road.onConnector(xs)) ok = false;
    }
    if (!ok || road.junctions.some((j) => j.s > s0 - 400 && j.s < s1 + 400)) continue;
    const side = rng() < 0.7 ? "right" : "left";
    out.push({ s0, sClosed: s0 + TAPER_M, s1, lane: side === "right" ? lanes : 1, side });
    lastEnd = s1;
    want = false;
  }
  return out.filter((z) => z.s0 > opts.startS + 1200 && z.s1 + END_TAPER_M < opts.finishS - 1500);
}

/** 라바콘 줄의 가로 위치 d (m, 오른쪽 +). 공사 구간 밖이면 null */
export function coneLine(road: Road, z: WorkZone, s: number): number | null {
  if (s < z.s0 || s > z.s1 + END_TAPER_M) return null;
  const left = -road.widthAt(s) / 2 + (z.lane - 1) * LANE_WIDTH;
  const right = left + LANE_WIDTH;
  // 막히는 쪽 가장자리(outer)에서 열린 차로와의 경계(inner)로
  const outer = z.side === "right" ? right : left;
  const inner = z.side === "right" ? left : right;
  let t = 1;
  if (s < z.sClosed) t = (s - z.s0) / TAPER_M;
  else if (s > z.s1) t = 1 - (s - z.s1) / END_TAPER_M;
  return outer + (inner - outer) * t;
}

/** 이 위치에서 막힌 차로 (라바콘 줄이 차로 절반 넘게 들어온 곳부터) */
export function closedLane(zones: WorkZone[], s: number): number | null {
  for (const z of zones) if (s >= z.s0 + TAPER_M / 2 && s <= z.s1) return z.lane;
  return null;
}

/** 공사 구간 임시 제한속도가 걸리면 그 값 */
export function zoneLimit(zones: WorkZone[], s: number): number | null {
  for (const z of zones) if (s >= z.s0 - LIMIT_BEFORE_M && s <= z.s1 + END_TAPER_M) return ZONE_KMH;
  return null;
}
