// public/data 파일 검사. 한국 운전 특징·법규·차종 데이터를 고친 뒤 `npm test`로 형식이 맞는지 확인한다.

import { describe, expect, it } from "vitest";
import profilesJson from "../public/data/driver_profiles.json";
import rulesJson from "../public/data/rules_kr.json";
import trafficJson from "../public/data/traffic_defaults.json";
import vehiclesJson from "../public/data/vehicles.json";
import type { DriverProfile, DriverProfiles, Rules, TrafficDefaults } from "./sim/config";
import type { VehicleCatalog } from "./render/vehicleModels";

const profiles = profilesJson as unknown as DriverProfiles;
const rules = rulesJson as unknown as Rules;
const traffic = trafficJson as unknown as TrafficDefaults;
const catalog = vehiclesJson as unknown as VehicleCatalog;

const DIST_FIELDS: (keyof DriverProfile)[] = [
  "speedFactor",
  "timeHeadway",
  "minGap",
  "accelScale",
  "comfortDecel",
  "politeness",
  "changeThreshold",
  "keepRightBias",
  "safeDecel",
  "signalLead",
  "laneChangeTime",
  "passingLaneStay",
];
const PROB_FIELDS: (keyof DriverProfile)[] = ["signalUse", "designatedLaneCompliance", "busLaneCompliance"];
const BODIES = new Set([
  "microcar", "box_micro", "hatch", "sedan", "fastback", "sedan_large", "coupe", "sports", "wagon", "suv_small", "suv_mid", "suv_large",
  "suv_coupe", "suv_boxy", "pickup", "mpv", "van", "ev_sedan", "ev_hatch_suv", "ev_crossover", "ev_suv",
  "coach", "city_bus", "double_decker", "minibus", "van_tall", "camper", "truck_light", "truck_medium", "truck_heavy", "tractor_trailer",
]);

describe("vehicles.json", () => {
  it("차종이 50가지 이상이고 id가 겹치지 않는다", () => {
    expect(catalog.types.length).toBeGreaterThanOrEqual(50);
    expect(new Set(catalog.types.map((t) => t.id)).size).toBe(catalog.types.length);
  });

  it.each(catalog.types.map((t) => [t.id, t] as const))("%s: 크기·성능·모양 값이 말이 된다", (_, t) => {
    expect(BODIES.has(t.body), `모양(body) ${t.body}`).toBe(true);
    expect(t.length).toBeGreaterThan(2.5);
    expect(t.length).toBeLessThan(20);
    expect(t.width).toBeGreaterThan(1.3);
    expect(t.width).toBeLessThanOrEqual(2.6);
    expect(t.height).toBeGreaterThan(1);
    expect(t.height).toBeLessThanOrEqual(4.2);
    expect(t.wheelbase).toBeLessThan(t.length);
    expect(t.maxSpeed).toBeGreaterThanOrEqual(80);
    expect(t.accel).toBeGreaterThan(0);
    expect(t.share).toBeGreaterThanOrEqual(0);
    const pal = Array.isArray(t.paint) ? t.paint : catalog.palettes[t.paint];
    expect(pal?.length, `색 팔레트 ${String(t.paint)}`).toBeGreaterThan(0);
    for (const c of pal) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("driver_profiles.json", () => {
  it.each(Object.entries(profiles.profiles))("%s: 모든 항목이 [평균, 표준편차] 또는 0~1 확률이다", (_, p) => {
    for (const f of DIST_FIELDS) {
      const d = p[f] as [number, number];
      expect(Array.isArray(d) && d.length === 2, `${f}`).toBe(true);
      expect(d[1], `${f} 표준편차`).toBeGreaterThanOrEqual(0);
    }
    for (const f of PROB_FIELDS) {
      const v = p[f] as number;
      expect(v, f).toBeGreaterThanOrEqual(0);
      expect(v, f).toBeLessThanOrEqual(1);
    }
    expect(p.timeHeadway[0]).toBeGreaterThan(0.3);
    expect(p.speedFactor[0]).toBeGreaterThan(0.5);
    expect(p.speedFactor[0]).toBeLessThan(1.6);
  });

  it("차종 분류·차종별 배정이 있는 운전 성향만 가리킨다", () => {
    const known = new Set(Object.keys(profiles.profiles));
    const ids = new Set(catalog.types.map((t) => t.id));
    const cats = new Set(catalog.types.map((t) => t.category));
    for (const [cat, table] of Object.entries(profiles.assignment)) {
      expect(cats.has(cat), `분류 ${cat}`).toBe(true);
      for (const [pid, w] of Object.entries(table)) {
        expect(known.has(pid), `${cat} → ${pid}`).toBe(true);
        expect(w).toBeGreaterThan(0);
      }
    }
    for (const cat of cats) expect(profiles.assignment[cat], `분류 ${cat}에 배정 없음`).toBeTruthy();
    for (const [id, table] of Object.entries(profiles.typeOverrides)) {
      expect(ids.has(id), `차종 ${id}`).toBe(true);
      for (const pid of Object.keys(table)) expect(known.has(pid), `${id} → ${pid}`).toBe(true);
    }
  });
});

describe("traffic_defaults.json", () => {
  it("시간대 24개, 차종 구성은 분류 이름과 맞는다", () => {
    expect(traffic.hourlyFactor).toHaveLength(24);
    const cats = new Set(catalog.types.map((t) => t.category));
    for (const cat of Object.keys(traffic.composition)) expect(cats.has(cat), cat).toBe(true);
    const sum = Object.values(traffic.composition).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 1);
    for (const k of ["한산", "보통", "혼잡", "정체"]) expect(traffic.presets[k].vehPerKmPerLane).toBeGreaterThan(0);
  });
});

describe("rules_kr.json", () => {
  it("규칙마다 켜기/끄기와 근거가 있다", () => {
    for (const [name, r] of Object.entries(rules.rules)) {
      expect(typeof (r as { enabled: boolean }).enabled, name).toBe("boolean");
      if (name !== "nearMiss" && name !== "crash") expect((r as { source?: string }).source, `${name} 근거`).toBeTruthy();
    }
    for (const sec of rules.rules.busLane.sections) {
      expect(["weekday", "weekend", "all"]).toContain(sec.days);
      expect(sec.hours[0]).toBeLessThan(sec.hours[1]);
    }
  });
});
