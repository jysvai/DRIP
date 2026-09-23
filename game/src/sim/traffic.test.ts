import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import { designatedLanes } from "./config";
import { busLaneZones, trafficFor } from "./scenario";
import type { Incident } from "./incidents";
import { Traffic, type PlayerState } from "./traffic";

describe("지정차로 (도로교통법 시행규칙 별표9)", () => {
  it("편도 차로 수별 오른쪽 차로", () => {
    expect(designatedLanes(2).right).toEqual([2]);
    expect(designatedLanes(3)).toEqual({ left: [2], right: [3] });
    expect(designatedLanes(4)).toEqual({ left: [2], right: [4] });
    expect(designatedLanes(5)).toEqual({ left: [2, 3], right: [4, 5] });
  });
});

describe("Traffic", () => {
  const cfg = makeConfig();
  const road = makeRoad({ length: 12000, lanes: 3 });

  function sim(density: number, sec: number) {
    const t = new Traffic(road, cfg, 7);
    t.density = density;
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 25, len: 4.9, width: 1.86 };
    t.fill(player);
    let minGap = Infinity;
    for (let i = 0; i < sec * 20; i++) {
      player.s += player.v * 0.05;
      t.update(0.05, player, i * 0.05);
      for (let lane = 1; lane <= 3; lane++) {
        const inLane = t.agents.filter((a) => a.lane === lane && a.targetLane === lane).sort((a, b) => a.s - b.s);
        for (let k = 1; k < inLane.length; k++) {
          const gap = inLane[k].s - inLane[k].len / 2 - (inLane[k - 1].s + inLane[k - 1].len / 2);
          minGap = Math.min(minGap, gap);
        }
      }
    }
    return { t, minGap, player };
  }

  it("보통 교통에서 같은 차로 차끼리 겹치지 않는다", () => {
    const { t, minGap } = sim(15, 60);
    expect(t.agents.length).toBeGreaterThan(40);
    expect(minGap).toBeGreaterThan(-0.5);
  });

  it("혼잡하면 평균 속도가 한산할 때보다 낮다", () => {
    const avg = (d: number) => {
      const { t } = sim(d, 40);
      return t.agents.reduce((s, a) => s + a.v, 0) / t.agents.length;
    };
    expect(avg(40)).toBeLessThan(avg(6));
  });

  it("실측 흐름 속도가 느리면(막히는 시간대) 차들이 그 속도 근처로 달린다", () => {
    const t = new Traffic(road, cfg, 7);
    t.density = 12;
    t.flowSpeed = 50 / 3.6;
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 14, len: 4.9, width: 1.86 };
    t.fill(player);
    for (let i = 0; i < 30 * 20; i++) {
      player.s += player.v * 0.05;
      t.update(0.05, player, i * 0.05);
    }
    const kmh = (t.agents.reduce((s, a) => s + a.v, 0) / t.agents.length) * 3.6;
    expect(kmh).toBeLessThan(65);
    expect(kmh).toBeGreaterThan(30);
  });

  it("여러 차종이 섞여 나온다 (화물·버스 포함)", () => {
    const { t } = sim(20, 5);
    const cats = new Set(t.agents.map((a) => a.type.category));
    expect(cats.has("화물")).toBe(true);
    expect(new Set(t.agents.map((a) => a.type.id)).size).toBeGreaterThan(15);
  });

  it("반대편 차는 s가 줄어드는 쪽으로 달린다", () => {
    const t = new Traffic(road, cfg, 3);
    const player: PlayerState = { s: 3000, d: 0, v: 25, len: 4.9, width: 1.86 };
    t.fill(player);
    const before = t.opposite.map((a) => -a.s);
    t.update(1, player, 0);
    const after = t.opposite.map((a) => -a.s);
    const moved = before.filter((s, i) => after[i] !== undefined && after[i] < s).length;
    expect(moved).toBeGreaterThan(before.length * 0.8);
  });
});

describe("주행 조건", () => {
  const cfg = makeConfig();

  it("경부 버스전용차로: 평일 7~21시 오산IC까지, 한남은 주행선 밖이라 시작점부터", () => {
    const road = makeRoad({ length: 50000, lanes: 4, ref: "1", from: "서울", to: "부산", junctions: [[37556, "오산", "42"], [45000, "안성", "41"]] });
    const zones = busLaneZones(road, cfg.rules, false, 8);
    expect(zones).toEqual([{ s0: 0, s1: 37556, lane: 1 }]);
    // 반대 방향(부산→서울)은 오산부터 서울 쪽 끝까지
    const back = makeRoad({ length: 50000, lanes: 4, ref: "1", from: "부산", to: "서울", junctions: [[12444, "오산", "42"]] });
    expect(busLaneZones(back, cfg.rules, false, 8)).toEqual([{ s0: 12444, s1: 50000, lane: 1 }]);
    expect(busLaneZones(road, cfg.rules, false, 22)).toEqual([]);
    // 주말에는 신탄진까지다. 이 길에는 신탄진이 없어 주말 구간은 없다
    expect(busLaneZones(road, cfg.rules, true, 8)).toEqual([]);
    const long = makeRoad({ length: 150000, lanes: 4, ref: "1", from: "서울", to: "부산", junctions: [[37556, "오산", "42"], [133400, "신탄진IC", "31"]] });
    expect(busLaneZones(long, cfg.rules, true, 8)).toEqual([{ s0: 0, s1: 133400, lane: 1 }]);
  });

  it("다른 노선에는 버스전용차로가 없다", () => {
    const road = makeRoad({ ref: "15", junctions: [[1000, "오산", "1"]] });
    expect(busLaneZones(road, cfg.rules, false, 8)).toEqual([]);
  });

  it("시간대 자동 교통량은 출퇴근 시간이 새벽보다 많다", () => {
    const at = (hour: number) => trafficFor({ road: { id: "x" }, preset: "자동", hour }, cfg).density;
    expect(at(8)).toBeGreaterThan(at(3) * 3);
    expect(trafficFor({ road: { id: "x" }, preset: "정체", hour: 3 }, cfg).density).toBe(60);
  });
});

describe("공사 구간 합류", () => {
  const cfg = makeConfig();

  for (const [side, lane] of [
    ["right", 3],
    ["left", 1],
  ] as const) {
    it(`${lane}차로가 막히면 막히기 전에 옆 차로로 옮기고, 흐름은 이어진다`, () => {
      const road = makeRoad({ length: 12000, lanes: 3 });
      const t = new Traffic(road, cfg, 11);
      t.density = 18;
      const zone = { s0: 4000, sClosed: 4120, s1: 4800, lane, side };
      t.workZones = [zone];
      // 플레이어는 공사 구간을 따라 지나가며 주변 교통을 끌고 간다
      const player: PlayerState = { s: 2500, d: road.laneCenter(2, 2500), v: 22, len: 4.9, width: 1.86 };
      t.fill(player);
      let inside = 0;
      // 구간 앞에서 본 차 중 구간 뒤로 빠져나간 차
      const before = new Set<number>();
      const passed = new Set<number>();
      let wasInLane = 0;
      for (let i = 0; i < 180 * 20; i++) {
        player.s = Math.min(player.s + player.v * 0.05, 6000);
        t.update(0.05, player, i * 0.05);
        for (const a of t.agents) {
          if (a.lane === lane && a.s > zone.sClosed && a.s < zone.s1) inside++;
          if (a.s < zone.s0 - 300) {
            if (!before.has(a.id) && a.lane === lane) wasInLane++;
            before.add(a.id);
          }
          if (a.s > zone.s1 + 100 && before.has(a.id)) passed.add(a.id);
        }
      }
      expect(inside).toBe(0);
      expect(wasInLane).toBeGreaterThan(3);
      expect(passed.size).toBeGreaterThan(15);
    });
  }
});

describe("돌발상황", () => {
  const cfg = makeConfig();

  it("차로에 선 사고 차 두 대를 피해 옆 차로로 지나가고, 아무도 들이받지 않는다", () => {
    const road = makeRoad({ length: 12000, lanes: 3 });
    const t = new Traffic(road, cfg, 5);
    t.density = 18;
    const inc: Incident = { s: 4000, lane: 2, kind: "crash", vehicles: 2, triangleS: 3880, evacuated: true };
    t.incidents = [inc];
    const player: PlayerState = { s: 2500, d: road.laneCenter(1, 2500), v: 22, len: 4.9, width: 1.86 };
    t.fill(player);
    const passed = new Set<number>();
    let parkedSeen = 0;
    let overlap = 0;
    for (let i = 0; i < 150 * 20; i++) {
      player.s = Math.min(player.s + player.v * 0.05, 6000);
      t.update(0.05, player, i * 0.05);
      const parked = t.agents.filter((a) => a.parked);
      parkedSeen = Math.max(parkedSeen, parked.length);
      for (const a of t.agents) {
        if (a.parked) continue;
        if (a.s > inc.s + 50) passed.add(a.id);
        for (const p of parked) if (Math.abs(a.s - p.s) < (a.len + p.len) / 2 && Math.abs(a.d - p.d) < (a.width + p.width) / 2) overlap++;
      }
    }
    expect(parkedSeen).toBe(2);
    expect(overlap).toBe(0);
    expect(passed.size).toBeGreaterThan(15);
  });

  it("갓길 고장 차는 차로 흐름을 막지 않는다", () => {
    const road = makeRoad({ length: 12000, lanes: 3 });
    const t = new Traffic(road, cfg, 6);
    t.density = 14;
    t.incidents = [{ s: 4000, lane: 0, kind: "breakdown", vehicles: 1, triangleS: null, evacuated: false }];
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 25, len: 4.9, width: 1.86 };
    t.fill(player);
    t.update(0.05, player, 0);
    const car = t.agents.find((a) => a.parked)!;
    expect(car.d).toBeGreaterThan(road.widthAt(4000) / 2);
    expect(car.hazard).toBe(true);
  });
});

describe("한국 운전 버릇", () => {
  const cfg = makeConfig();
  const road = makeRoad({ length: 12000, lanes: 3 });

  function run(seed: number, sec: number, density = 15) {
    const t = new Traffic(road, cfg, seed);
    t.density = density;
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 27, len: 4.9, width: 1.86 };
    t.fill(player);
    for (let i = 0; i < sec * 20; i++) {
      player.s += player.v * 0.05;
      t.update(0.05, player, i * 0.05);
    }
    return { t, player };
  }

  it("옆 차로 차가 플레이어 바로 앞으로 끼어든다 (6~35m, 비슷한 속도로)", () => {
    const { t, player } = run(11, 20);
    let r = null;
    for (let i = 0; i < 200 && !r; i++) {
      player.s += player.v * 0.05;
      t.update(0.05, player, 20 + i * 0.05);
      r = t.cutIn(player);
    }
    expect(r).not.toBeNull();
    expect(r!.gapM).toBeGreaterThanOrEqual(6);
    expect(r!.gapM).toBeLessThanOrEqual(35);
    expect(r!.dvKmh).toBeGreaterThan(-4 * 3.6 - 0.01);
    expect(r!.dvKmh).toBeLessThan(6 * 3.6 + 0.01);
    if (r!.dvKmh > 3 * 3.6) expect(r!.gapM).toBeLessThanOrEqual(15);
    expect(r!.agent.targetLane).toBe(2);
    expect(Math.abs(r!.fromLane - 2)).toBe(1);
    // 짧게 (2초 안팎) 들어온다
    expect(r!.agent.lcDuration).toBeLessThan(2.2);
  });

  it("들어올 차가 없으면 끼어들지 않는다", () => {
    const t = new Traffic(road, cfg, 3);
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 27, len: 4.9, width: 1.86 };
    expect(t.cutIn(player)).toBeNull();
  });

  it("차선을 무는 차는 옆면이 옆 차로로 넘어오고, 보통 차는 차로 안에 있다", () => {
    const t = new Traffic(road, cfg, 5);
    t.density = 12;
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 27, len: 4.9, width: 1.86 };
    t.fill(player);
    const riders = t.agents.filter((a) => a.s > player.s && !a.parked).slice(0, 16);
    for (const a of t.agents) a.lineBias = 0;
    riders.forEach((a, i) => (a.lineBias = i % 2 ? 1.2 : -1.2));
    for (let i = 0; i < 30 * 20; i++) {
      player.s += player.v * 0.05;
      t.update(0.05, player, i * 0.05);
    }
    const off = (a: (typeof t.agents)[number]) => Math.abs(a.d - road.laneCenter(a.lane, a.s)) + a.width / 2 - 3.6 / 2;
    // 차로를 바꾸는 중이 아니고, 길 밖 쪽(1차로 왼쪽·3차로 오른쪽)으로 무는 차가 아닌 것
    const inward = (a: (typeof t.agents)[number]) => !((a.lineBias < 0 && a.lane === 1) || (a.lineBias > 0 && a.lane === 3));
    const still = riders.filter((a) => t.agents.includes(a) && a.targetLane === a.lane && a.laneTime > 8 && inward(a));
    expect(still.length).toBeGreaterThan(2);
    for (const a of still) expect(off(a)).toBeGreaterThan(0);
    for (const a of t.agents.filter((a) => !a.lineBias && a.targetLane === a.lane && !a.parked)) expect(off(a)).toBeLessThan(0);
  });

  it("급가속 버릇이 있는 차가 버릇 없는 차보다 급가속·급감속이 잦다", () => {
    const t = new Traffic(road, cfg, 9);
    t.density = 20;
    const player: PlayerState = { s: 3000, d: road.laneCenter(2, 3000), v: 27, len: 4.9, width: 1.86 };
    t.fill(player);
    t.agents.forEach((a, i) => {
      a.surgeRate = i % 2 ? 3 : 0;
      a.lineBias = 0;
    });
    const n = { 3: { all: 0, acc: 0, brk: 0 }, 0: { all: 0, acc: 0, brk: 0 } } as Record<number, { all: number; acc: number; brk: number }>;
    for (let i = 0; i < 90 * 20; i++) {
      player.s += player.v * 0.05;
      t.update(0.05, player, i * 0.05);
      for (const a of t.agents) {
        const c = n[a.surgeRate];
        if (!c || a.parked) continue;
        c.all++;
        if (a.acc > 1.5) c.acc++;
        if (a.acc < -2.5) c.brk++;
      }
    }
    // 급가속(1.5m/s² 넘게)은 여러 배, 급감속(2.5m/s² 넘게)도 더 잦다
    expect(n[3].acc / n[3].all).toBeGreaterThan((2.5 * n[0].acc) / n[0].all);
    expect(n[3].brk / n[3].all).toBeGreaterThan((1.2 * n[0].brk) / n[0].all);
  });
});
