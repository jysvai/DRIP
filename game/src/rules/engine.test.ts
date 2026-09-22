import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import type { Agent } from "../sim/traffic";
import { TAPER_M, type WorkZone } from "../sim/workzones";
import type { Incident } from "../sim/incidents";
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

describe("공사 구간", () => {
  const cfg = makeConfig();
  const road = makeRoad({ lanes: 3, speed: 100 });
  const zone: WorkZone = { s0: 3000, sClosed: 3000 + TAPER_M, s1: 3800, lane: 3, side: "right" };

  it("공사 구간에서는 임시 제한속도 80으로 과속을 본다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    e.workZones = [zone];
    expect(e.limitAt(2000)).toBe(100);
    expect(e.limitAt(2800)).toBe(80);
    const v = 95 / 3.6;
    // 95km/h로 들어갔다가 6초 뒤 75km/h로 줄인다 (제한 100 도로였다면 과속이 아니다)
    drive(e, (t) => ({ s: 2750 + t * v, speed: t < 6 ? v : 75 / 3.6, d: road.laneCenter(2, 3000) }), 8);
    const ev = e.events.filter((x) => x.type === "speeding");
    expect(ev).toHaveLength(1);
    expect(ev[0].limitKmh).toBe(80);
  });

  it("막히는 차로에서 빠져나온 곳을 남은 거리와 함께 남긴다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    e.workZones = [zone];
    const v = 25;
    // 막히는 차로(3)로 달리다 테이퍼 끝 약 400m 전에 2차로로
    drive(e, (t) => ({ s: 2000 + t * v, speed: v, d: t < 28 ? road.laneCenter(3, 2000) : road.laneCenter(2, 2000), signal: t > 22 && t < 29 ? -1 : 0 }), 32);
    const ev = e.events.filter((x) => x.type === "work_zone_merge");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail.closedLane).toBe(3);
    expect(ev[0].detail.beforeClosedM).toBeGreaterThan(350);
    expect(ev[0].detail.beforeClosedM).toBeLessThan(450);
  });

  it("다른 차로에서 바꾸면 남기지 않는다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    e.workZones = [zone];
    drive(e, (t) => ({ s: 2000 + t * 25, d: t < 28 ? road.laneCenter(1, 2000) : road.laneCenter(2, 2000), signal: t > 22 && t < 29 ? 1 : 0 }), 32);
    expect(e.events.filter((x) => x.type === "work_zone_merge")).toHaveLength(0);
  });
});

describe("악천후 감속", () => {
  const cfg = makeConfig();
  const road = makeRoad({ lanes: 3, speed: 100 });

  it("젖은 노면이면 제한속도 80으로 과속을 보고, 카메라는 표지판 속도로 찍는다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    e.weatherFactor = 0.8;
    e.enforcement = { fixed: [{ s: 1100, limit: 0 }], sections: [] };
    expect(e.limitAt(1000)).toBe(80);
    const v = 95 / 3.6;
    drive(e, (t) => ({ s: 1000 + t * v, speed: t < 6 ? v : 75 / 3.6, d: road.laneCenter(2, 1000) }), 8);
    const ev = e.events.filter((x) => x.type === "speeding");
    expect(ev).toHaveLength(1);
    expect(ev[0].limitKmh).toBe(80);
    expect(e.events.filter((x) => x.type === "camera_speeding")).toHaveLength(0);
  });

  it("안개로 절반 감속이면 최저속도도 절반으로 본다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    e.weatherFactor = 0.5;
    const v = 40 / 3.6;
    drive(e, (t) => ({ s: 1000 + t * v, speed: t < 15 ? v : 20 / 3.6, d: road.laneCenter(2, 1000) }), 20);
    expect(e.events.filter((x) => x.type === "min_speed")).toHaveLength(0);
    expect(e.events.filter((x) => x.type === "speeding")).toHaveLength(0);
  });
});

describe("돌발상황", () => {
  const cfg = makeConfig();
  const road = makeRoad({ lanes: 3, speed: 100 });

  it("선 차 옆을 지나면 속도·옆 간격·미리 빠져나온 거리를 남긴다", () => {
    const e = new RuleEngine(road, cfg.rules, []);
    const inc: Incident = { s: 2500, lane: 3, kind: "breakdown", vehicles: 1, triangleS: 2400, evacuated: true };
    e.incidents = [inc];
    const v = 25;
    // 3차로로 달리다 약 500m 앞에서 2차로로
    drive(e, (t) => ({ s: 1000 + t * v, speed: v, d: t < 40 ? road.laneCenter(3, 1000) : road.laneCenter(2, 1000), signal: t > 34 && t < 41 ? -1 : 0 }), 70);
    const ev = e.events.filter((x) => x.type === "incident_pass");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail.blockedLane).toBe(3);
    expect(ev[0].detail.leftLaneBeforeM).toBeGreaterThan(400);
    expect(ev[0].detail.sideGapM).toBeGreaterThan(1);
    expect(ev[0].detail.sideGapM).toBeLessThan(2.5);
  });
});
