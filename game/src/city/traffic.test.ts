import { describe, expect, it } from "vitest";
import { CityGraph, searchCityPlaces, type CityFile } from "./graph";
import { CityNet, type Turn } from "./net";
import { cityRoadFile, findCityRoute } from "./route";
import { Signals } from "./signals";
import {
  CityTraffic,
  coneGap,
  conflictGap,
  obbOverlap,
  type PlayerBody,
} from "./traffic";
import { Road } from "../road/road";
import { Traffic, type Agent, type PlayerState } from "../sim/traffic";
import { Rng } from "../sim/rng";
import { makeConfig } from "../testing/fixtures";

describe("교차로 차 사이 간격", () => {
  it("같은 쪽으로 가는 앞차는 범퍼 사이 간격", () => {
    expect(
      coneGap(0, 0, 1, 0, 4.8, 1.9, 20, 0, 1, 0, 4.8, 1.9, 60),
    ).toBeCloseTo(15.2);
  });

  it("앞을 가로지르는 차는 길이 대신 폭만큼 막는다", () => {
    expect(
      coneGap(0, 0, 1, 0, 4.8, 1.9, 15, 0, 0, 1, 4.8, 1.9, 60),
    ).toBeCloseTo(15 - 2.4 - 0.95);
    // 가로지르는 차를 보지 않으면 (교차로 안에서 서로 기다리다 막히지 않게)
    expect(
      coneGap(0, 0, 1, 0, 4.8, 1.9, 15, 0, 0, 1, 4.8, 1.9, 60, false),
    ).toBe(Infinity);
  });

  it("뒤나 옆으로 비켜 있는 차는 막지 않는다", () => {
    expect(coneGap(0, 0, 1, 0, 4.8, 1.9, -10, 0, 1, 0, 4.8, 1.9, 60)).toBe(
      Infinity,
    );
    expect(coneGap(0, 0, 1, 0, 4.8, 1.9, 20, 3.5, 1, 0, 4.8, 1.9, 60)).toBe(
      Infinity,
    );
    expect(coneGap(0, 0, 1, 0, 4.8, 1.9, 80, 0, 1, 0, 4.8, 1.9, 60)).toBe(
      Infinity,
    );
  });

  it("엇갈리는 길: 교차로에 먼저 들어간 차, 먼저 닿는 차가 먼저 간다", () => {
    // 나는 동쪽으로, 상대는 만나는 곳(20, 0) 남쪽 20m에서 북쪽으로
    const me = (
      v: number,
      entered: boolean,
      bv: number,
      bEntered: boolean,
      by = -20,
    ) =>
      conflictGap(
        0,
        0,
        1,
        0,
        4.8,
        1.9,
        v,
        entered,
        20,
        by,
        0,
        1,
        4.8,
        1.9,
        bv,
        bEntered,
        40,
      );
    // 교차로 안에 있는 상대가 오면 기다린다, 내가 먼저 들어갔으면 간다
    expect(me(10, false, 10, true)).toBeLessThan(20);
    expect(me(10, true, 10, false)).toBe(Infinity);
    // 둘 다 교차로 안: 먼저 닿는 쪽 (상대가 더 멀면 나는 간다)
    expect(me(10, true, 10, true, -40)).toBe(Infinity);
    expect(me(5, true, 12, true, -12)).toBeLessThan(20);
    // 서 있는 상대는 오지 않는 차, 서 있는 나는 상대가 오기 전에 다 건널 수 있을 때만 간다
    expect(me(10, true, 0, true)).toBe(Infinity);
    expect(me(0, true, 10, true, -30)).toBeLessThan(20);
    expect(me(0, true, 2, true, -60)).toBe(Infinity);
    // 두 차가 늘 반대로 판단한다 (둘 다 서거나 둘 다 가지 않는다)
    for (const [v, bv, by] of [
      [8, 8, -20],
      [10, 9.8, -20.3],
      [3, 12, -35],
    ]) {
      const a = conflictGap(
        0,
        0,
        1,
        0,
        4.8,
        1.9,
        v,
        true,
        20,
        by,
        0,
        1,
        4.8,
        1.9,
        bv,
        true,
        40,
      );
      const b = conflictGap(
        20,
        by,
        0,
        1,
        4.8,
        1.9,
        bv,
        true,
        0,
        0,
        1,
        0,
        4.8,
        1.9,
        v,
        true,
        40,
      );
      expect(a === Infinity).not.toBe(b === Infinity);
    }
    // 나란히 가는 차는 보지 않는다
    expect(
      conflictGap(
        0,
        0,
        1,
        0,
        4.8,
        1.9,
        10,
        true,
        10,
        3.5,
        1,
        0.05,
        4.8,
        1.9,
        10,
        true,
        40,
      ),
    ).toBe(Infinity);
  });

  it("직사각형 겹침", () => {
    expect(obbOverlap(4, 0, 1, 0, 4.8, 1.9, 1, 0, 4.8, 1.9)).toBe(true);
    expect(obbOverlap(5, 0, 1, 0, 4.8, 1.9, 1, 0, 4.8, 1.9)).toBe(false);
    expect(obbOverlap(0, 2.2, 1, 0, 4.8, 1.9, 1, 0, 4.8, 1.9)).toBe(false);
    // 45도로 돈 차는 모서리가 먼저 닿는다
    const c = Math.SQRT1_2;
    expect(obbOverlap(3.9, 0, 1, 0, 4.8, 1.9, c, c, 4.8, 1.9)).toBe(true);
    expect(obbOverlap(4.9, 0, 1, 0, 4.8, 1.9, c, c, 4.8, 1.9)).toBe(false);
  });
});

// 2MB JSON을 import하면 tsc가 타입을 뽑느라 느려서 파일로 읽는다
const fs = (await import("node:fs" as string)) as {
  readFileSync: (p: URL, enc: string) => string;
};
const seoul = JSON.parse(
  fs.readFileSync(
    new URL("../../public/city/seoul.json", import.meta.url),
    "utf-8",
  ),
) as CityFile;

describe("시내 교통 (강동역 → 삼원타워)", () => {
  const graph = new CityGraph(seoul);
  const net = new CityNet(graph);
  const plan = findCityRoute(
    net,
    searchCityPlaces(graph.places, "강동역")[0],
    searchCityPlaces(graph.places, "삼원타워")[0],
  )!;
  const road = new Road(cityRoadFile(net, plan).file);
  const signals = new Signals(net);
  const stops = road.city!.stops;

  /** 경로 s 근처에 서 있는 관찰자 둘레로 sec초 돌린다 (관찰자는 중앙선 위의 아주 작은 몸체라 차들이 비키거나 기다리지 않는다) */
  function run(s0: number, sec: number) {
    const hour = 8 * 3600;
    let time = 0;
    const traffic = new Traffic(road, makeConfig(), 11);
    traffic.density = 15;
    const ct = new CityTraffic(
      net,
      signals,
      road,
      traffic,
      () => hour + time,
      new Rng(34),
    );
    traffic.city = ct;
    traffic.setRegion(300, 900);
    let s = s0;
    while (road.inJunction(s)) s += 20;
    const player: PlayerState = { s, d: 60, v: 0, len: 4.8, width: 1.9 };
    const w = road.toWorld(s, -road.widthAt(s) / 2);
    const [ox, oy] = net.graph.origin;
    const body: PlayerBody = {
      s,
      x: w.e - ox,
      y: w.n - oy,
      hx: Math.cos(w.heading),
      hy: Math.sin(w.heading),
      v: 0,
      len: 0.1,
      w: 0.1,
    };
    traffic.fill(player);

    const cars = (ct as unknown as { cars: { a: Agent; committed: boolean }[] })
      .cars;
    const fates = (ct as unknown as { fates: Map<Agent, { turn: Turn }> })
      .fates;
    const dt = 1 / 30;
    const prev = new Map<Agent, number>();
    const stopped = new Map<Agent, number>();
    const r = {
      crossings: 0,
      redRuns: 0,
      freeMax: 0,
      overlaps: 0,
      samples: 0,
      longestStop: 0,
    };
    for (let i = 0; i < sec * 30; i++) {
      time = i * dt;
      traffic.update(dt, player, time);
      ct.update(dt, time, body);
      for (const a of traffic.agents) {
        if (a.pose) continue;
        const front = a.s + a.len / 2;
        const was = prev.get(a);
        prev.set(a, front);
        if (was === undefined) continue;
        const st = stops.find((x) => x.signal && was < x.s && front >= x.s);
        if (!st) continue;
        r.crossings++;
        const turn = fates.get(a)?.turn ?? st.turn;
        if (
          turn !== "R" &&
          signals.go(st.junction, st.link, turn, hour + time) === "stop"
        )
          r.redRuns++;
      }
      if (i % 30) continue;
      // 정지선을 넘은 차가 교차로 안이나 건너편에서 오래 서 있으면 막힌 것
      for (const f of cars) {
        if (!f.committed || f.a.v > 0.1) stopped.delete(f.a);
        else {
          const since = stopped.get(f.a) ?? time;
          stopped.set(f.a, since);
          r.longestStop = Math.max(r.longestStop, time - since);
        }
      }
      const pose: [number, number, number, number, number, number][] = [];
      ct.forEachFree((x, y, hx, hy, a) => {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        pose.push([x, y, hx, hy, a.len, a.width]);
      });
      r.freeMax = Math.max(r.freeMax, pose.length);
      for (let p = 0; p < pose.length; p++)
        for (let q = p + 1; q < pose.length; q++) {
          const [ax, ay, ahx, ahy, al, aw] = pose[p];
          const [bx, by, bhx, bhy, bl, bw] = pose[q];
          r.samples++;
          if (
            obbOverlap(
              bx - ax,
              by - ay,
              ahx,
              ahy,
              al * 0.9,
              aw * 0.9,
              bhx,
              bhy,
              bl * 0.9,
              bw * 0.9,
            )
          )
            r.overlaps++;
        }
    }
    return r;
  }

  // 강동역 큰 교차로, 긴 교차로(천호대로), 중간 교차로들
  for (const s0 of [700, 2100, 4000, 8500])
    it(`s=${s0}: 신호에 서고 교차로를 건너며, 교차로가 막혀 멈추지 않는다`, () => {
      const r = run(s0, 300);
      console.log(s0, JSON.stringify(r));
      expect(r.freeMax).toBeGreaterThan(3);
      expect(r.crossings).toBeGreaterThan(10);
      expect(r.longestStop).toBeLessThan(75);
      expect(r.overlaps / Math.max(1, r.samples)).toBeLessThan(0.002);
      expect(r.redRuns).toBeLessThanOrEqual(Math.ceil(r.crossings * 0.03));
    }, 60_000);

  it("고가·지하차도로 위아래를 지나는 차와는 (평면으로 겹쳐도) 부딪히지 않는다", () => {
    let time = 0;
    const traffic = new Traffic(road, makeConfig(), 11);
    traffic.density = 15;
    const ct = new CityTraffic(
      net,
      signals,
      road,
      traffic,
      () => 8 * 3600 + time,
      new Rng(34),
    );
    traffic.city = ct;
    traffic.setRegion(300, 900);
    const s = 700;
    const player: PlayerState = { s, d: 60, v: 0, len: 4.8, width: 1.9 };
    const w = road.toWorld(s, 0);
    const [ox, oy] = net.graph.origin;
    const far: PlayerBody = {
      s,
      x: w.e - ox,
      y: w.n - oy,
      hx: 1,
      hy: 0,
      v: 0,
      len: 0.1,
      w: 0.1,
    };
    traffic.fill(player);
    const cars = (ct as unknown as { cars: { a: Agent }[] }).cars;
    for (let i = 0; i < 30 * 60 && !cars.some((f) => f.a.pose); i++) {
      time = i / 30;
      traffic.update(1 / 30, player, time);
      ct.update(1 / 30, time, far);
    }
    const q = cars.find((f) => f.a.pose)!.a.pose!;
    const at = (z?: number): PlayerBody => ({
      s,
      x: q.e - ox,
      y: q.n - oy,
      z,
      hx: Math.cos(q.heading),
      hy: Math.sin(q.heading),
      v: 0,
      len: 4.8,
      w: 1.9,
    });
    expect(ct.hit(at(q.z))).not.toBeNull();
    expect(ct.hit(at(undefined))).not.toBeNull();
    expect(ct.hit(at(q.z + 7))).toBeNull();
    expect(ct.hit(at(q.z - 7))).toBeNull();
  }, 60_000);
});
