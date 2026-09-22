// 차종(vehicles.json)마다 플레이어 차 물리값을 만든다. 크기·무게·엔진·변속기·브레이크가 차종에 맞게 달라진다.
// 무게는 차체 모양별 대표값(공차 + 운전자·짐 조금), 엔진 힘은 차종 표의 발진 가속도(accel)에 맞춘다.

import type { VehicleType } from "../render/vehicleModels";
import { DEFAULT_CAR, type CarSpec } from "./player";

/** 차체 모양별 대표 무게 (kg) */
const MASS: Record<string, number> = {
  microcar: 1000,
  box_micro: 1100,
  hatch: 1350,
  sedan: 1500,
  fastback: 1520,
  sedan_large: 1750,
  coupe: 1750,
  sports: 1550,
  wagon: 1700,
  suv_small: 1450,
  suv_mid: 1750,
  suv_large: 2100,
  suv_coupe: 2200,
  suv_boxy: 2500,
  pickup: 2200,
  mpv: 2200,
  van: 2350,
  ev_sedan: 1950,
  ev_hatch_suv: 2050,
  ev_crossover: 2100,
  ev_suv: 2650,
  camper: 4800,
  van_tall: 3300,
  minibus: 5800,
  city_bus: 12000,
  coach: 14000,
  double_decker: 17000,
  truck_light: 2900,
  truck_medium: 7000,
  truck_heavy: 16000,
  tractor_trailer: 32000,
};

/** 앞 투영면적 × 공기저항계수 (m²) */
function dragArea(t: VehicleType): number {
  const area = t.width * t.height * 0.85;
  const cd = /sports|coupe|ev_sedan|fastback/.test(t.body) ? 0.27 : t.heavy || /truck|bus|coach|van_tall|camper|tractor/.test(t.body) ? 0.65 : /suv|van|mpv|pickup|box/.test(t.body) ? 0.36 : 0.3;
  return area * cd;
}

export type Powertrain = "gasoline" | "diesel_light" | "diesel_heavy" | "electric";

export function powertrainOf(t: VehicleType): Powertrain {
  if (t.ev) return "electric";
  if (t.heavy || /coach|city_bus|double_decker|minibus|truck_medium|truck_heavy|tractor/.test(t.body)) return "diesel_heavy";
  if (/truck_light|van_tall|pickup|van$|camper/.test(t.body)) return "diesel_light";
  return "gasoline";
}

export interface PlayerSpec extends CarSpec {
  /** 최고속도 제한 (m/s). 대형 화물·승합은 속도제한장치(화물 90, 승합 110km/h) */
  governor: number;
  /** 자동변속 [낮은 rpm, 높은 rpm]: 가속 페달을 적게 밟으면 앞쪽, 많이 밟으면 뒤쪽 rpm에서 올린다 */
  shiftRpm: [number, number];
  powertrain: Powertrain;
  /** 법규 판정용 차종 구분 */
  vehicleClass: "car" | "bus" | "truck";
}

export function vehicleClassOf(t: VehicleType): PlayerSpec["vehicleClass"] {
  if (/coach|city_bus|double_decker|minibus/.test(t.body) || t.id.startsWith("bus_")) return "bus";
  if (t.heavy || /truck|tractor|dump|mixer|tanker|car_carrier/.test(t.body + t.id)) return "truck";
  return "car";
}

export function specFor(t: VehicleType): PlayerSpec {
  const pt = powertrainOf(t);
  let mass = MASS[t.body] ?? t.length * t.width * t.height * 90;
  if (t.body === "truck_heavy") mass += ((t.axles ?? 3) - 3) * 4000 + (t.length - 9) * 900;
  if (t.body === "suv_small" && t.length < 3.8) mass = 1150;
  if (t.ev && !t.body.startsWith("ev")) mass += 250; // 배터리
  const heavy = pt === "diesel_heavy";

  // 축간거리: 트랙터는 트레일러 축까지 이어진 긴 차로 본다
  let wb = t.wheelbase;
  if (t.body === "tractor_trailer") wb = Math.max(wb, t.length * 0.6);
  // 무게중심: 승용은 앞 42%, 뒤 엔진 버스는 뒤쪽, 화물은 짐칸 쪽
  const front = /coach|city_bus|double_decker/.test(t.body) ? 0.58 : heavy ? 0.52 : pt === "electric" ? 0.48 : 0.42;
  const lf = wb * front;
  const lr = wb - lf;
  const grip = heavy ? 0.72 : pt === "diesel_light" ? 0.88 : 1;
  const cf = (DEFAULT_CAR.cf / DEFAULT_CAR.mass) * mass * grip;
  const cr = (DEFAULT_CAR.cr / DEFAULT_CAR.mass) * mass * grip * (heavy ? 1.15 : 1);
  const inertia = (mass * (wb * wb * 1.3 + t.width * t.width)) / 12;

  // 엔진: 차종 발진 가속도와 무게에 맞춰 토크를 키우고 줄인다.
  // 기준 승용 1550kg·3.0m/s², 소형 디젤 2900kg·1.8m/s², 대형 디젤 32톤·0.7m/s²(약 2,500Nm)
  const k =
    pt === "diesel_heavy"
      ? (mass / 32000) * (t.accel / 0.7) * (2500 / 2100)
      : pt === "diesel_light"
        ? (mass / 2900) * (t.accel / 1.8)
        : ((mass * t.accel) / (DEFAULT_CAR.mass * 3.0)) * (pt === "electric" ? 0.9 : 0.85);
  let torqueCurve: [number, number][];
  let gears: number[];
  let finalDrive: number;
  let idleRpm: number;
  let redline: number;
  let shiftRpm: [number, number];
  let wheelRadius = pt === "diesel_light" ? 0.34 : t.height > 1.8 ? 0.37 : 0.33;
  switch (pt) {
    case "electric":
      // 모터: 낮은 회전에서 최대 토크, 1단 감속기
      torqueCurve = [
        [0, 330 * k],
        [4500, 330 * k],
        [9000, 190 * k],
        [15000, 110 * k],
      ];
      gears = [1];
      finalDrive = 9.0;
      idleRpm = 0;
      redline = 16000;
      shiftRpm = [16000, 16000];
      break;
    case "diesel_light":
      torqueCurve = [
        [800, 160 * k],
        [1500, 270 * k],
        [2750, 270 * k],
        [3800, 210 * k],
        [4200, 170 * k],
      ];
      gears = [4.7, 2.6, 1.6, 1.15, 0.85, 0.68];
      finalDrive = 4.1;
      idleRpm = 750;
      redline = 4200;
      shiftRpm = [1500, 3600];
      break;
    case "diesel_heavy":
      // 대형 디젤: 1000~1500rpm에서 큰 토크, 12단
      wheelRadius = 0.52;
      torqueCurve = [
        [600, 900 * k],
        [1000, 2000 * k],
        [1500, 2100 * k],
        [2000, 1800 * k],
        [2300, 1400 * k],
      ];
      gears = [14.9, 11.6, 9.0, 7.0, 5.4, 4.2, 3.2, 2.5, 1.95, 1.5, 1.2, 1.0];
      finalDrive = 3.4;
      idleRpm = 600;
      redline = 2300;
      shiftRpm = [1100, 1800];
      break;
    default:
      torqueCurve = DEFAULT_CAR.torqueCurve.map(([r, n]) => [r, n * k] as [number, number]);
      gears = DEFAULT_CAR.gears;
      finalDrive = DEFAULT_CAR.finalDrive;
      idleRpm = DEFAULT_CAR.idleRpm;
      redline = t.body === "sports" ? 7500 : DEFAULT_CAR.redline;
      shiftRpm = [2000, redline - 800];
  }
  const cls = vehicleClassOf(t);
  const legal = cls === "truck" && t.heavy ? 90 : cls === "bus" && t.heavy ? 110 : Infinity;
  return {
    mass,
    inertia,
    lf,
    lr,
    cf,
    cr,
    mu: heavy ? 0.8 : 0.95,
    maxSteer: heavy ? 0.55 : 0.6,
    torqueCurve,
    idleRpm,
    redline,
    gears,
    finalDrive,
    wheelRadius,
    dragArea: dragArea(t),
    rolling: heavy ? 0.0065 : 0.011,
    maxBrakeDecel: heavy ? 6.2 : pt === "diesel_light" ? 8.2 : t.body === "sports" ? 10.5 : 9.3,
    length: t.length,
    width: t.width,
    governor: Math.min(t.maxSpeed, legal) / 3.6,
    shiftRpm,
    powertrain: pt,
    vehicleClass: cls,
  };
}
