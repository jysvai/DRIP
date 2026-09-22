// 실제 돌발상황 (국가교통정보센터 ITS, pipeline/events_its.py --export)을 이번 주행의 공사 구간·선 차로 바꾼다.
// 경로 주행이면 조각(leg)마다 원래 주행선의 사건을 잘라 붙인다 (cameras.ts와 같은 방식).
// 게임의 공사 구간은 가장자리 차로(1차로 또는 오른쪽 끝)만 막을 수 있어, 가운데 차로 공사는 가까운 가장자리로 옮긴다.

import type { Road } from "../road/road";
import { CRASH_GAP_M, type Incident } from "./incidents";
import { END_TAPER_M, TAPER_M, type WorkZone } from "./workzones";

export type RealEventKind = "work" | "crash" | "breakdown";

/** events/latest.json: 주행선 id마다 [s, 종류, 막힌 차로들(0 = 갓길), 시작 YYYYMMDDHHmm, 안내문] */
export interface RealEventData {
  source: string;
  fetchedAt: string;
  roads: Record<string, [number, RealEventKind, number[], string, string][]>;
}

/** 실제 공사는 길이를 알 수 없어 이만큼 막는다 (가정) */
export const REAL_WORK_M = 600;

export function realEventsFor(road: Road, data: RealEventData | null): { workZones: WorkZone[]; incidents: Incident[] } | null {
  if (!data) return null;
  const events: [number, RealEventKind, number[]][] = [];
  const legs = road.isRoute ? road.legs : [{ road: road.id, s0: 0, s1: road.length, src0: 0, src1: road.length }];
  for (const leg of legs) {
    for (const [src, kind, lanes] of data.roads[leg.road] ?? []) {
      if (src < leg.src0 || src > leg.src1) continue;
      events.push([leg.s0 + (src - leg.src0), kind, lanes]);
    }
  }
  events.sort((a, b) => a[0] - b[0]);
  const workZones: WorkZone[] = [];
  const incidents: Incident[] = [];
  for (const [s, kind, blocked] of events) {
    if (s < TAPER_M + 50 || s > road.length - REAL_WORK_M - 100) continue;
    const lanes = road.lanesAt(s);
    if (kind === "work") {
      // 막힌 차로가 왼쪽 절반이면 1차로, 아니면(모르면) 오른쪽 끝을 막는다
      const lane = blocked.find((l) => l > 0) ?? lanes;
      const side = lane <= lanes / 2 && lanes >= 2 ? "left" : "right";
      const z: WorkZone = { s0: s - TAPER_M, sClosed: s, s1: s + REAL_WORK_M, lane: side === "left" ? 1 : lanes, side };
      // 겹치는 공사는 하나로
      const prev = workZones[workZones.length - 1];
      if (prev && z.s0 < prev.s1 + END_TAPER_M + 300) continue;
      if (lanes >= 2) workZones.push(z);
    } else {
      const lane = blocked.length ? Math.min(Math.max(0, blocked[0]), lanes) : 0;
      const vehicles = kind === "crash" ? 2 : 1;
      incidents.push({ s, lane, kind, vehicles, triangleS: kind === "breakdown" ? s - (vehicles - 1) * CRASH_GAP_M - 100 : null, evacuated: true });
    }
  }
  return { workZones, incidents };
}

/** 안내용: "09/22 06:40 기준" */
export function realEventsStamp(data: RealEventData): string {
  const m = data.fetchedAt.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}/${m[2]} ${m[3]}:${m[4]} 기준` : "";
}
