// 데이터 파일(public/data/*.json)의 형식과 불러오기. 한국 운전 특징·법규·교통량은 모두 여기로 들어온다.

import type { VehicleCatalog } from "../render/vehicleModels";
import { loadCatalog } from "../render/vehicleModels";

export type Dist = [number, number];

export interface DriverProfile {
  name: string;
  speedFactor: Dist;
  timeHeadway: Dist;
  minGap: Dist;
  accelScale: Dist;
  comfortDecel: Dist;
  politeness: Dist;
  changeThreshold: Dist;
  keepRightBias: Dist;
  safeDecel: Dist;
  signalUse: number;
  signalLead: Dist;
  laneChangeTime: Dist;
  designatedLaneCompliance: number;
  busLaneCompliance: number;
  passingLaneStay: Dist;
}

export interface DriverProfiles {
  status: string;
  profiles: Record<string, DriverProfile>;
  assignment: Record<string, Record<string, number>>;
  typeOverrides: Record<string, Record<string, number>>;
}

export interface TrafficDefaults {
  presets: Record<string, { vehPerKmPerLane: number }>;
  composition: Record<string, number>;
  hourlyFactor: number[];
  oppositeDensityFactor: number;
}

export interface BusLaneSection {
  ref: string;
  fromName: string;
  toName: string;
  /** 이름이 주행선 밖에 있을 때 어느 도시 쪽 끝인지 (예: 한남 → 서울) */
  fromPlace?: string;
  toPlace?: string;
  days: "weekday" | "weekend" | "all";
  hours: [number, number];
  lane: number;
}

export interface Rules {
  version: string;
  rules: {
    speeding: { enabled: boolean; toleranceKmh: number; minDurationSec: number; source: string };
    minSpeed: { enabled: boolean; minDurationSec: number; ignoreWhenLeaderSlowerKmh: number; source: string };
    turnSignal: { enabled: boolean; leadDistanceM: number; source: string };
    headway: { enabled: boolean; thresholdSec: number; criticalSec: number; criticalDurationSec: number; minSpeedKmh: number; source: string };
    hardAccel: { enabled: boolean; kmhPerSec: number; minSpeedKmh: number; source: string };
    hardBrake: { enabled: boolean; kmhPerSec: number; minSpeedKmh: number; source: string };
    passingLane: { enabled: boolean; maxDistanceM: number; source: string };
    tunnelLaneChange: { enabled: boolean; source: string };
    solidLine: { enabled: boolean; source: string };
    shoulder: { enabled: boolean; minDurationSec: number; source: string };
    busLane: { enabled: boolean; source: string; sections: BusLaneSection[] };
    designatedLanes: { enabled: boolean; source: string };
    nearMiss: { enabled: boolean; ttcSec: number; lateralGapM: number; inducedBrakeMs2: number; cooldownSec: number };
    crash: { enabled: boolean };
  };
}

/** 실제 교통 자료로 만든 파일 (pipeline/traffic_ex.py). 없으면 기본값을 쓴다 */
export interface RealTraffic {
  date: string;
  source: string;
  roads: Record<
    string,
    {
      /** 시간대(0~23)별 차로당 밀도(대/km) */
      density?: number[];
      /** 시간대별 평균 속도(km/h) */
      speed?: number[];
      /** 차종 구성비 */
      composition?: Record<string, number>;
    }
  >;
}

export interface GameConfig {
  catalog: VehicleCatalog;
  profiles: DriverProfiles;
  traffic: TrafficDefaults;
  rules: Rules;
  real: RealTraffic | null;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}을(를) 불러오지 못했습니다 (${res.status})`);
  return (await res.json()) as T;
}

export async function loadConfig(base = "./data/"): Promise<GameConfig> {
  const [catalog, profiles, traffic, rules] = await Promise.all([
    loadCatalog(base),
    json<DriverProfiles>(`${base}driver_profiles.json`),
    json<TrafficDefaults>(`${base}traffic_defaults.json`),
    json<Rules>(`${base}rules_kr.json`),
  ]);
  let real: RealTraffic | null = null;
  try {
    real = await json<RealTraffic>("./traffic/latest.json");
  } catch {
    real = null;
  }
  return { catalog, profiles, traffic, rules, real };
}

/** 편도 차로 수에 따른 지정차로 (도로교통법 시행규칙 별표9). 반환: [왼쪽 차로들, 오른쪽 차로들] */
export function designatedLanes(lanes: number): { left: number[]; right: number[] } {
  if (lanes <= 1) return { left: [1], right: [1] };
  if (lanes === 2) return { left: [2], right: [2] };
  const rest: number[] = [];
  for (let l = 2; l <= lanes; l++) rest.push(l);
  const half = Math.floor(rest.length / 2);
  return { left: rest.slice(0, half), right: rest.slice(rest.length - half) };
}
