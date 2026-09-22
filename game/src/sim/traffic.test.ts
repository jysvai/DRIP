import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import { designatedLanes } from "./config";
import { busLaneZones, trafficFor } from "./scenario";
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
