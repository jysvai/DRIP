// 주행 조건: 버스전용차로 구간, 교통량. 규칙·교통 데이터 파일을 이 주행선에 맞춘다.

import type { Road } from "../road/road";
import type { GameConfig, Rules } from "./config";
import type { BusLaneZone } from "./traffic";

/** 메뉴에서 고른 것 중 교통에 필요한 부분 */
export interface ScenarioSettings {
  road: { id: string };
  preset: string;
  hour: number;
}

/** 버스전용차로 구간: 규칙 파일의 나들목 이름을 이 주행선의 위치로 바꾼다.
 *  이름이 주행선 밖에 있으면(예: 한남은 OSM 고속도로 구간 밖) fromPlace/toPlace 도시 쪽 끝을 쓴다. */
export function busLaneZones(road: Road, rules: Rules, weekend: boolean, hour: number): BusLaneZone[] {
  const r = rules.rules.busLane;
  const out: BusLaneZone[] = [];
  if (!r.enabled) return out;
  for (const sec of r.sections) {
    if (sec.ref !== road.ref) continue;
    if (sec.days === "weekday" && weekend) continue;
    if (sec.days === "weekend" && !weekend) continue;
    if (hour < sec.hours[0] || hour >= sec.hours[1]) continue;
    const a = road.junctions.find((j) => j.name.startsWith(sec.fromName));
    const b = road.junctions.find((j) => j.name.startsWith(sec.toName));
    if (!a && !b) continue;
    const endFor = (place: string | undefined, other: number) => {
      if (place && road.from.includes(place)) return 0;
      if (place && road.to.includes(place)) return road.length;
      return other < road.length / 2 ? 0 : road.length;
    };
    const sa = a ? a.s : endFor(sec.fromPlace, b!.s);
    const sb = b ? b.s : endFor(sec.toPlace, a!.s);
    out.push({ s0: Math.min(sa, sb), s1: Math.max(sa, sb), lane: sec.lane });
  }
  return out;
}

/** 차로당 밀도(대/km)와 차종 구성 */
export function trafficFor(settings: ScenarioSettings, cfg: GameConfig): { density: number; composition: Record<string, number>; source: string } {
  const t = cfg.traffic;
  const real = cfg.real?.roads[settings.road.id];
  if (settings.preset === "실제" && real?.density) {
    return { density: real.density[settings.hour], composition: real.composition ?? t.composition, source: `실제(${cfg.real!.date})` };
  }
  if (settings.preset === "자동") {
    return { density: t.presets["보통"].vehPerKmPerLane * t.hourlyFactor[settings.hour], composition: real?.composition ?? t.composition, source: "시간대" };
  }
  const p = t.presets[settings.preset] ?? t.presets["보통"];
  return { density: p.vehPerKmPerLane, composition: t.composition, source: settings.preset };
}
