// public/data 파일 검사. 한국 운전 특징·법규·차종 데이터를 고친 뒤 `npm test`로 형식이 맞는지 확인한다.

import { describe, expect, it } from "vitest";
import roadIndexJson from "../public/roads/index.json";
import profilesJson from "../public/data/driver_profiles.json";
import rulesJson from "../public/data/rules_kr.json";
import trafficJson from "../public/data/traffic_defaults.json";
import vehiclesJson from "../public/data/vehicles.json";
import type { DriverProfile, DriverProfiles, RealTraffic, Rules, TrafficDefaults } from "./sim/config";
import type * as THREE from "three";
import { buildVehicleModel, createVehicleObject, type VehicleCatalog, type VehicleModel, type VehicleType } from "./render/vehicleModels";

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

describe("차 모델", () => {
  // 차종마다 한 번만 만든다
  const models = new Map<string, VehicleModel>();
  const modelOf = (t: VehicleType) => {
    let m = models.get(t.id);
    if (!m) models.set(t.id, (m = buildVehicleModel(t, 1)));
    return m;
  };
  const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  const types = catalog.types.map((t) => [t.id, t] as const);

  it.each(types)("%s: 차체 기하에 필요한 속성이 모두 있고 NaN이 없다", (_, t) => {
    const m = modelOf(t);
    for (const g of [m.body, m.mid, m.interior]) {
      const n = g.getAttribute("position").count;
      expect(n).toBeGreaterThan(0);
      for (const name of ["normal", "color", "surf"]) expect(g.getAttribute(name)?.count, name).toBe(n);
      const pos = g.getAttribute("position").array;
      for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) throw new Error(`position[${i}] = ${pos[i]}`);
    }
  });

  it.each(types)("%s: 차체가 차 크기 안에 들어가고 중간 거리 모델이 더 가볍다", (_, t) => {
    const m = modelOf(t);
    m.body.computeBoundingBox();
    const b = m.body.boundingBox!;
    // 거울·범퍼가 조금 튀어나올 수 있다 (버스 토끼귀 거울은 앞으로 더)
    const bus = ["coach", "city_bus", "double_decker"].includes(t.body);
    expect(b.max.x - b.min.x).toBeLessThan(t.length + (bus ? 0.6 : 0.3));
    expect(b.max.x - b.min.x).toBeGreaterThan(t.length * 0.9);
    expect(b.max.z - b.min.z).toBeLessThan(t.width + 0.8);
    expect(b.max.y).toBeLessThan(t.height + 0.35);
    expect(b.min.y).toBeGreaterThan(-0.05);
    expect(tris(m.mid)).toBeLessThan(tris(m.body));
  });

  it.each(types)("%s: 바퀴가 좌우 짝을 이루고 앞바퀴가 조향한다", (_, t) => {
    const m = modelOf(t);
    const ws = m.wheels;
    expect(ws.length).toBeGreaterThanOrEqual(4);
    expect(ws.length % 2).toBe(0);
    for (const w of ws) {
      expect(Math.abs(w.x)).toBeLessThan(t.length / 2);
      expect(w.r).toBeGreaterThan(0.2);
      expect(w.r).toBeLessThan(0.6);
      expect(Math.abs(w.z) + w.w / 2, "바퀴가 차 폭 안").toBeLessThanOrEqual(t.width / 2 + 0.06);
      // 반대쪽에 같은 바퀴가 있다
      expect(ws.some((o) => Math.abs(o.x - w.x) < 1e-6 && Math.abs(o.z + w.z) < 1e-6 && o.r === w.r)).toBe(true);
    }
    const steer = ws.filter((w) => w.steer);
    expect(steer.length).toBeGreaterThanOrEqual(2);
    const front = Math.max(...ws.map((w) => w.x));
    for (const w of steer) expect(w.x, "조향 바퀴는 앞쪽").toBeGreaterThan(front - 1.6);
  });

  it.each(types)("%s: 운전석은 차 안 왼쪽이고 거울 세 개가 제자리에 있다", (_, t) => {
    const c = modelOf(t).cabin;
    expect(Math.abs(c.eye.x)).toBeLessThan(t.length / 2);
    expect(c.eye.y).toBeGreaterThan(c.floorY);
    expect(c.eye.y).toBeLessThan(Math.min(c.roofY, t.height));
    expect(c.eye.z, "왼쪽 운전석").toBeLessThan(0);
    expect(Math.abs(c.eye.z)).toBeLessThan(t.width / 2);
    expect(c.dash.x0).toBeGreaterThan(c.dash.x1);
    expect(c.dash.x1).toBeGreaterThan(c.eye.x);
    expect(c.glass).toHaveLength(3);
    for (const g of c.glass) {
      expect(g.w).toBeGreaterThan(0.05);
      expect(g.h).toBeGreaterThan(0.03);
    }
    expect(c.glass[1].c.z, "왼쪽 사이드미러").toBeLessThan(0);
    expect(c.glass[2].c.z, "오른쪽 사이드미러").toBeGreaterThan(0);
    expect(c.mirrorL.z).toBeLessThan(0);
    expect(c.mirrorR.z).toBeGreaterThan(0);
  });

  it("같은 씨앗이면 같은 모양, 미리보기 차는 World 없이 만든다", () => {
    const t = catalog.types[0];
    expect(buildVehicleModel(t, 7).body.getAttribute("position").count).toBe(buildVehicleModel(t, 7).body.getAttribute("position").count);
    const o = createVehicleObject(t, "#c0392b");
    const m = o.userData.model as VehicleModel;
    expect(o.userData.wheels).toHaveLength(m.wheels.length);
    expect(o.children).toHaveLength(1 + m.wheels.length);
  });

  it.each(types)("%s: 전조등·제동등·방향지시등 위치가 차 앞뒤에 있다", (_, t) => {
    const m = modelOf(t);
    expect(m.headLights.length).toBeGreaterThanOrEqual(2);
    expect(m.brakeLights.length).toBeGreaterThanOrEqual(2);
    expect(m.signalLeft.length).toBeGreaterThanOrEqual(1);
    expect(m.signalRight.length).toBeGreaterThanOrEqual(1);
    for (const p of m.headLights) expect(p.x, "전조등은 앞쪽").toBeGreaterThan(t.length * 0.4);
    for (const p of m.brakeLights) expect(p.x, "제동등은 뒤쪽").toBeLessThan(-t.length * 0.3);
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

// 수집기가 아직 파일을 만들지 않았으면 비어 있다
const latestFiles = import.meta.glob<RealTraffic>("../public/traffic/latest.json", { eager: true, import: "default" });
const latest = Object.values(latestFiles)[0];

describe.runIf(!!latest)("traffic/latest.json (수집기가 만든 전날 교통)", () => {
  const real = latest!;
  const roadIds = new Set(roadIndexJson.roads.map((r) => r.id));
  const cats = new Set(catalog.types.map((t) => t.category));

  it("날짜와 주행선이 있고, 주행선 id는 게임에 있는 것이다", () => {
    expect(real.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(real.roads).length).toBeGreaterThan(0);
    for (const id of Object.keys(real.roads)) expect(roadIds.has(id), id).toBe(true);
  });

  it.each(Object.entries(real.roads))("%s: 시간대 24개, 밀도·속도·구성이 말이 된다", (_, r) => {
    expect(r.density).toHaveLength(24);
    for (const d of r.density!) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(150);
    }
    for (const v of r.speed ?? []) expect(v).toBeLessThan(160);
    if (r.composition) {
      for (const k of Object.keys(r.composition)) expect(cats.has(k), k).toBe(true);
      expect(Object.values(r.composition).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 1);
    }
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
