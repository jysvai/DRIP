import { describe, expect, it } from "vitest";
import { CityGraph, searchCityPlaces, type CityFile } from "./graph";
import { CityNet } from "./net";
import { cityRoadFile, findCityRoute } from "./route";
import { Road } from "../road/road";

// 2MB JSON을 import하면 tsc가 타입을 뽑느라 느려서 파일로 읽는다
const fs = (await import("node:fs" as string)) as { readFileSync: (p: URL, enc: string) => string };
const seoul = JSON.parse(fs.readFileSync(new URL("../../public/city/seoul.json", import.meta.url), "utf-8")) as CityFile;

describe("서울 시내 도로망", () => {
  const graph = new CityGraph(seoul);
  const net = new CityNet(graph);

  it("교차로·링크·이동을 만든다", () => {
    const real = net.junctions.filter((j) => !j.minor);
    console.log("junctions", net.junctions.length, "real", real.length, "signal", real.filter((j) => j.signal).length, "links", net.links.length, "movements", net.movements.length);
    const multi = net.junctions.filter((j) => j.nodes.length > 1);
    console.log("clustered", multi.length, "max nodes", Math.max(...net.junctions.map((j) => j.nodes.length)));
    expect(real.length).toBeGreaterThan(1000);
  });

  it("곧게 갈라지는 곳은 갈래가 놓인 쪽 차로에서 나간다 (오른쪽 램프는 오른쪽 차로)", () => {
    let splits = 0;
    for (const j of net.junctions) {
      for (const i of j.inbound) {
        const ss = j.movements.map((id) => net.movements[id]).filter((m) => m.from === i && m.turn === "S");
        if (ss.length < 2) continue;
        splits++;
        ss.sort((a, b) => b.angle - a.angle);
        const n = net.links[i].lanes;
        expect(ss[0].fromLanes[0]).toBe(1);
        expect(ss[ss.length - 1].fromLanes[1]).toBe(n);
      }
    }
    expect(splits).toBeGreaterThan(100);
  });

  it("강동역 → 삼원타워 길을 찾아 한 줄 도로로 만든다", () => {
    const a = searchCityPlaces(graph.places, "강동역")[0];
    const b = searchCityPlaces(graph.places, "삼원타워")[0];
    expect(a?.name).toBe("강동역");
    expect(b?.name).toBe("삼원타워");
    const t0 = performance.now();
    const plan = findCityRoute(net, a, b)!;
    console.log("route ms", Math.round(performance.now() - t0));
    expect(plan).not.toBeNull();
    const names: string[] = [];
    plan.links.forEach((id) => {
      const n = net.links[id].name;
      if (names[names.length - 1] !== n) names.push(n);
    });
    console.log("km", (plan.lengthM / 1000).toFixed(1), "min", (plan.timeS / 60).toFixed(1), "signals", plan.signals, "turns", plan.turns, names.join(" → "));
    const { file, finishS } = cityRoadFile(net, plan);
    const road = new Road(file);
    console.log("road len", road.length, "finish", finishS, "stops", file.city!.stops.length, file.city!.stops.map((s) => `${s.turn}${s.signal ? "*" : ""}:${s.name}`).slice(0, 40).join(", "));
    expect(road.length).toBeGreaterThan(5000);
    // 곡률이 지나치게 크지 않다 (교차로 곡선 반지름 6m 이상)
    let kmax = 0;
    for (let i = 0; i < road.n; i++) kmax = Math.max(kmax, Math.abs(road.kappa[i]));
    console.log("kmax", kmax.toFixed(3), "Rmin", (1 / kmax).toFixed(1));
    // 점 간격이 고르다
    for (let i = 1; i < road.n; i++) {
      const d = Math.hypot(road.e[i] - road.e[i - 1], road.nn[i] - road.nn[i - 1]);
      expect(Math.abs(d - road.step)).toBeLessThan(0.03);
    }
  });
});

describe("메뉴의 자주 달리는 시내 길", () => {
  const graph = new CityGraph(seoul);
  const net = new CityNet(graph);
  const pairs: [string, string][] = [
    ["강남역", "잠실역"],
    ["서울역", "경복궁"],
    ["여의도역", "홍대입구역"],
    ["건대입구역", "왕십리역"],
    ["시청역", "이태원역"],
  ];
  for (const [from, to] of pairs) {
    it(`${from} → ${to}`, () => {
      const a = searchCityPlaces(graph.places, from).find((p) => p.name === from)!;
      const b = searchCityPlaces(graph.places, to).find((p) => p.name === to)!;
      expect(a && b).toBeTruthy();
      const plan = findCityRoute(net, a, b)!;
      expect(plan).not.toBeNull();
      const { file, finishS } = cityRoadFile(net, plan);
      const road = new Road(file);
      expect(road.length).toBeGreaterThan(1000);
      expect(finishS).toBeGreaterThan(road.length * 0.9);
      // 점 간격: 원래 선이 꺾인 곳에서는 현이 호보다 조금 짧다 (2m에 5cm까지)
      let worst = 0;
      let kmax = 0;
      for (let i = 1; i < road.n; i++) {
        const d = Math.hypot(road.e[i] - road.e[i - 1], road.nn[i] - road.nn[i - 1]);
        worst = Math.max(worst, Math.abs(d - road.step));
        kmax = Math.max(kmax, Math.abs(road.kappa[i]));
      }
      expect(worst).toBeLessThan(0.05);
      // 가장 급한 곳도 반지름 7m 넘게
      expect(kmax).toBeLessThan(1 / 7);
    });
  }
});
