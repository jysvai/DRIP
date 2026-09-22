import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import type { Agent } from "../sim/traffic";
import { RuleEngine, type PlayerFrame } from "./engine";

const DT = 0.05;

function drive(engine: RuleEngine, frames: (t: number) => Partial<PlayerFrame>, sec: number, agents: Agent[] = [], t0 = 0) {
  for (let t = t0; t < t0 + sec; t += DT) {
    const f = frames(t);
    engine.update({ t, dt: DT, s: 1000 + t * 25, d: 0, speed: 25, ax: 0, width: 1.86, len: 4.9, signal: 0, hazard: false, ...f }, agents);
  }
}

describe("RuleEngine", () => {
  const cfg = makeConfig();

  it("제한속도 100에서 120km/h로 5초 달리면 과속이 한 번 기록된다", () => {
    const road = makeRoad({ lanes: 3, speed: 100 });
    const e = new RuleEngine(road, cfg.rules, []);
    const d = road.laneCenter(2, 1000);
    drive(e, (t) => ({ speed: t < 5 ? 120 / 3.6 : 90 / 3.6, d }), 7);
    expect(e.events.filter((x) => x.type === "speeding")).toHaveLength(1);
    expect(e.summary.speedingTimeSec).toBeGreaterThan(4.5);
  });

  it("방향지시등 없이 차로를 바꾸면 기록된다", () => {
    const road = makeRoad({ lanes: 3 });
    const e = new RuleEngine(road, cfg.rules, []);
    const d2 = road.laneCenter(2, 1000);
    const d3 = road.laneCenter(3, 1000);
    drive(e, (t) => ({ d: t < 2 ? d2 : d3 }), 4);
    const types = e.events.map((x) => x.type);
    expect(types).toContain("lane_change");
    expect(types).toContain("no_signal");
    expect(e.summary.laneChanges).toBe(1);
    expect(e.summary.signaledLaneChanges).toBe(0);
  });

  it("100m 넘게 미리 방향지시등을 켜면 위반이 아니다", () => {
    const road = makeRoad({ lanes: 3 });
    const e = new RuleEngine(road, cfg.rules, []);
    const d2 = road.laneCenter(2, 1000);
    const d3 = road.laneCenter(3, 1000);
    // 25m/s로 5초 = 125m 동안 켠 뒤 옮긴다
    drive(e, (t) => ({ d: t < 6 ? d2 : d3, signal: t > 1 && t < 7 ? 1 : 0 }), 8);
    const types = e.events.map((x) => x.type);
    expect(types).toContain("lane_change");
    expect(types).not.toContain("no_signal");
    expect(types).not.toContain("late_signal");
  });

  it("터널 안에서 차로를 바꾸면 기록된다", () => {
    const road = makeRoad({ lanes: 2, tunnel: [900, 1500] });
    const e = new RuleEngine(road, cfg.rules, []);
    drive(e, (t) => ({ d: t < 1 ? road.laneCenter(1, 1000) : road.laneCenter(2, 1000), signal: 1 }), 3);
    expect(e.events.map((x) => x.type)).toContain("tunnel_lane_change");
  });

  it("앞차와 1초 미만으로 붙어 가면 기록되고, 2초 미만 시간이 쌓인다", () => {
    const road = makeRoad({ lanes: 3 });
    const e = new RuleEngine(road, cfg.rules, []);
    const lead = { opposite: false, lane: 2, targetLane: 2, len: 4.8, width: 1.8, v: 25, d: road.laneCenter(2, 1000), s: 0, brakedByPlayer: 0, type: { id: "sedan_mid" } } as unknown as Agent;
    const d = road.laneCenter(2, 1000);
    for (let t = 0; t < 6; t += DT) {
      const s = 1000 + t * 25;
      lead.s = s + 4.9 + 15; // 간격 약 15m = 0.6초
      e.update({ t, dt: DT, s, d, speed: 25, ax: 0, width: 1.86, len: 4.9, signal: 0, hazard: false }, [lead]);
    }
    expect(e.events.map((x) => x.type)).toContain("headway_critical");
    expect(e.summary.headwayUnder2Sec).toBeGreaterThan(5);
  });

  it("1차로를 오래 달리면 한 번 기록된다", () => {
    const road = makeRoad({ lanes: 3, length: 20000 });
    const e = new RuleEngine(road, cfg.rules, []);
    const d = road.laneCenter(1, 1000);
    drive(e, () => ({ d }), 200);
    expect(e.events.filter((x) => x.type === "passing_lane")).toHaveLength(1);
  });

  it("버스전용차로에 들어가면 기록된다", () => {
    const road = makeRoad({ lanes: 4 });
    const e = new RuleEngine(road, cfg.rules, [{ s0: 0, s1: 5000, lane: 1 }]);
    drive(e, (t) => ({ d: t < 1 ? road.laneCenter(2, 1000) : road.laneCenter(1, 1000), signal: -1 }), 3);
    expect(e.events.map((x) => x.type)).toContain("bus_lane");
  });

  it("급감속을 잡는다", () => {
    const road = makeRoad({ lanes: 3 });
    const e = new RuleEngine(road, cfg.rules, []);
    drive(e, (t) => ({ speed: Math.max(0, 30 - Math.max(0, t - 1) * 5), d: road.laneCenter(2, 1000) }), 3);
    expect(e.events.map((x) => x.type)).toContain("hard_brake");
  });
});

describe("무인 단속 카메라", () => {
  const cfg = makeConfig();
  const road = makeRoad({ lanes: 3, speed: 100 });

  it("고정식 카메라를 제한속도 +10km/h 넘게 지나면 적발, 그 아래면 아니다", () => {
    for (const [kmh, caught] of [
      [125, true],
      [108, false],
    ] as const) {
      const e = new RuleEngine(road, cfg.rules, []);
      e.enforcement = { fixed: [{ s: 1500, limit: 0 }], sections: [] };
      const v = kmh / 3.6;
      drive(e, (t) => ({ s: 1000 + t * v, speed: v, d: road.laneCenter(2, 1000) }), 30);
      expect(e.events.filter((x) => x.type === "camera_speeding")).toHaveLength(caught ? 1 : 0);
    }
  });

  it("구간단속은 평균 속도로 본다: 중간에 빨리 달려도 평균이 낮으면 괜찮다", () => {
    const run = (fast: number, slow: number) => {
      const e = new RuleEngine(road, cfg.rules, []);
      e.enforcement = { fixed: [], sections: [{ s0: 2000, s1: 6000, limit: 100 }] };
      let s = 1000;
      let avg = 0;
      for (let t = 0; t < 400 && s < 6500; t += DT) {
        const v = (s < 4000 ? fast : slow) / 3.6;
        s += v * DT;
        e.update({ t, dt: DT, s, d: road.laneCenter(2, s), speed: v, ax: 0, width: 1.86, len: 4.9, signal: 0, hazard: false }, []);
        if (s > 3000 && s < 3050) avg = e.sectionState(s, t)?.avgKmh ?? 0;
      }
      return { e, avg };
    };
    const ok = run(130, 80); // 앞 절반 130, 뒤 절반 80 → 평균 약 99
    expect(ok.e.events.filter((x) => x.type === "section_speeding")).toHaveLength(0);
    expect(ok.avg).toBeGreaterThan(120);
    const bad = run(125, 120);
    const ev = bad.e.events.filter((x) => x.type === "section_speeding");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail.avgKmh).toBeGreaterThan(115);
  });

  it("구간 가운데에서 시작하면 그 구간은 재지 않는다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    e.enforcement = { fixed: [], sections: [{ s0: 500, s1: 3000, limit: 100 }] };
    const v = 150 / 3.6;
    drive(e, (t) => ({ s: 1000 + t * v, speed: v, d: road.laneCenter(2, 1000) }), 60);
    expect(e.events.filter((x) => x.type === "section_speeding")).toHaveLength(0);
  });
});
