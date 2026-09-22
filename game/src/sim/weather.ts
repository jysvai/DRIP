// 날씨: 맑음·흐림·비·폭우·안개. 가시거리(안개), 노면 마찰(물리), 법정 감속(판정), 주변 차의 반응(교통)을 한곳에서 정한다.
// 기상청 실황을 붙이기 전까지는 메뉴에서 고른다.

import type { Rules, WeatherResponse } from "./config";

export type WeatherKind = "clear" | "cloudy" | "rain" | "heavy_rain" | "fog";

export interface Weather {
  kind: WeatherKind;
  label: string;
  /** 가시거리 (m). 안개(Fog) 거리와 법정 감속(100m 이내면 50%)에 쓴다 */
  visibilityM: number;
  /** 흐린 정도 0~1: 햇빛이 약해지고 하늘이 잿빛이 된다 */
  overcast: number;
  /** 빗줄기 세기 0~1 (화면·소리) */
  rain: number;
  /** 노면이 젖었는지 (법정 20% 감속) */
  wet: boolean;
  /** 노면 마찰 배율 (마른 노면 1), 승용·대형차(화물·버스).
   *  한국교통안전공단 50km/h 제동 시험: 승용 9.9m→18.1m(0.55배), 화물 15.4m→24.3m(0.63배), 버스 17.3m→28.9m(0.60배) */
  grip: number;
  gripHeavy: number;
}

export const WEATHERS: Record<WeatherKind, Weather> = {
  clear: { kind: "clear", label: "맑음", visibilityM: 20000, overcast: 0, rain: 0, wet: false, grip: 1, gripHeavy: 1 },
  cloudy: { kind: "cloudy", label: "흐림", visibilityM: 8000, overcast: 0.7, rain: 0, wet: false, grip: 1, gripHeavy: 1 },
  rain: { kind: "rain", label: "비", visibilityM: 700, overcast: 0.85, rain: 0.5, wet: true, grip: 0.55, gripHeavy: 0.62 },
  heavy_rain: { kind: "heavy_rain", label: "폭우", visibilityM: 90, overcast: 1, rain: 1, wet: true, grip: 0.5, gripHeavy: 0.57 },
  fog: { kind: "fog", label: "짙은 안개", visibilityM: 80, overcast: 0.9, rain: 0, wet: false, grip: 0.9, gripHeavy: 0.92 },
};

export const WEATHER_KINDS = Object.keys(WEATHERS) as WeatherKind[];

export function weatherOf(kind: string | null | undefined): Weather {
  return WEATHERS[(kind ?? "clear") as WeatherKind] ?? WEATHERS.clear;
}

/**
 * 법정 감속 배율 (도로교통법 시행규칙 제19조 제2항): 가시거리 100m 이내면 최고속도의 50%, 노면이 젖었으면 20%를 줄인다.
 * 규칙을 끄면 1
 */
export function legalFactor(w: Weather, rules: Rules): number {
  const r = rules.rules.weather;
  if (!r?.enabled) return 1;
  if (w.visibilityM <= r.lowVisibilityM) return 1 - r.lowVisibilityReduction;
  if (w.wet) return 1 - r.wetReduction;
  return 1;
}

/** 이 속도에서 노면 마찰 배율. 폭우에는 물이 고여 빠를수록 타이어가 뜬다 (수막현상, 70km/h부터 130km/h까지 35% 더 줄어든다고 가정) */
export function gripAt(w: Weather, kmh: number, heavy = false): number {
  const g = heavy ? w.gripHeavy : w.grip;
  if (w.rain < 0.8) return g;
  const t = Math.max(0, Math.min(1, (kmh - 70) / 60));
  return g * (1 - 0.35 * t);
}

/** 주변 차가 이 날씨에 속도·차간시간을 얼마나 바꾸는지 (driver_profiles.json weather) */
export function trafficResponse(w: Weather, table: Partial<Record<WeatherKind, WeatherResponse>> | undefined): WeatherResponse {
  return table?.[w.kind] ?? { speedScale: 1, headwayScale: 1 };
}
