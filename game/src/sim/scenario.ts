// 주행 조건: 버스전용차로 구간, 교통량. 규칙·교통 데이터 파일을 이 주행선에 맞춘다.

import type { Road } from "../road/road";
import type { GameConfig, Rules } from "./config";
import type { BusLaneZone } from "./traffic";

/** 메뉴에서 고른 것 중 교통에 필요한 부분 */
export interface ScenarioSettings {
  road: { id: string };
  preset: string;
  hour: number;
  /** 출발 위치 (km). 실제 교통은 이 근처 측정 지점 값을 쓴다 */
  startKm?: number;
}

/** 출발 위치에서 30km 안에 있는 가장 가까운 측정 지점 */
const SITE_RANGE_M = 30000;

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
    const s0 = (settings.startKm ?? 0) * 1000;
    let site: NonNullable<typeof real.sites>[number] | null = null;
    for (const x of real.sites ?? []) {
      if (!x.density || Math.abs(x.s - s0) > SITE_RANGE_M) continue;
      if (!site || Math.abs(x.s - s0) < Math.abs(site.s - s0)) site = x;
    }
    const density = (site?.density ?? real.density)[settings.hour];
    const where = site ? ` ${(site.s / 1000).toFixed(0)}km 지점` : "";
    return { density, composition: real.composition ?? t.composition, source: `실제(${cfg.real!.date}${where})` };
  }
  // 실제 교통이 없는 주행선에서 '실제'를 고르면 시간대 반영으로
  if (settings.preset === "자동" || settings.preset === "실제") {
    return { density: t.presets["보통"].vehPerKmPerLane * t.hourlyFactor[settings.hour], composition: real?.composition ?? t.composition, source: "시간대" };
  }
  const p = t.presets[settings.preset] ?? t.presets["보통"];
  return { density: p.vehPerKmPerLane, composition: t.composition, source: settings.preset };
}

/** 시각(0~23시)의 해 고도·방위와 밝기. 봄·가을 기준 (해 뜨는 6시 20분, 지는 18시 40분 무렵) */
export function sunFor(hour: number): { elevation: number; azimuth: number; daylight: number; night: number } {
  const x = (hour + 0.5 - 6.3) / 12.4; // 해 뜰 때 0, 질 때 1
  const elevation = 55 * Math.sin(x * Math.PI);
  // 해가 6° 아래로 지면(시민박명 끝) 밤
  const night = Math.max(0, Math.min(1, (6 - elevation) / 12));
  const daylight = Math.max(0.06, Math.min(1, (elevation + 6) / 21));
  // 방위: 90 = 동, 0 = 남, -90 = 서 (world.setSun 기준)
  return { elevation, azimuth: 90 - x * 180, daylight, night };
}
