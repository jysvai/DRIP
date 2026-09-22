// 고속도로 단속 카메라 (경찰청 무인교통단속카메라 표준데이터, pipeline/cameras.py)를 이번 주행의 도로 위치(s)로 옮긴다.
// 경로 주행이면 조각(leg)마다 원래 주행선의 카메라를 잘라 붙인다.

import type { Road } from "../road/road";
import type { CameraData } from "./config";

/** 고정식 과속 카메라. limit 0은 데이터에 없음 (도로 제한속도를 쓴다) */
export interface SpeedCamera {
  s: number;
  limit: number;
}

/** 구간단속: s0(시점)에서 s1(종점)까지 평균 속도 */
export interface EnforcementSection {
  s0: number;
  s1: number;
  limit: number;
}

export interface Enforcement {
  fixed: SpeedCamera[];
  sections: EnforcementSection[];
}

export function enforcementFor(road: Road, data: CameraData | null): Enforcement {
  const out: Enforcement = { fixed: [], sections: [] };
  if (!data) return out;
  if (!road.isRoute) {
    const e = data.roads[road.id];
    if (!e) return out;
    out.fixed = (e.fixed ?? []).map(([s, limit]) => ({ s, limit }));
    out.sections = (e.sections ?? []).map(([s0, s1, limit]) => ({ s0, s1, limit }));
    return out;
  }
  for (const leg of road.legs) {
    const e = data.roads[leg.road];
    if (!e) continue;
    const at = (src: number) => leg.s0 + (src - leg.src0);
    for (const [s, limit] of e.fixed ?? []) if (s >= leg.src0 && s <= leg.src1) out.fixed.push({ s: at(s), limit });
    // 구간단속은 시점·종점을 둘 다 지나는 조각에서만 (중간에 들어오면 단속되지 않는다)
    for (const [s0, s1, limit] of e.sections ?? []) if (s0 >= leg.src0 && s1 <= leg.src1) out.sections.push({ s0: at(s0), s1: at(s1), limit });
  }
  out.fixed.sort((a, b) => a.s - b.s);
  out.sections.sort((a, b) => a.s0 - b.s0);
  return out;
}
