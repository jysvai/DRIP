import { describe, expect, it } from "vitest";
import { CityGraph, searchCityPlaces, type CityFile } from "./graph";
import { CityNet } from "./net";
import { cityRoadFile, findCityRoute } from "./route";
import { Road } from "../road/road";
import { Signals } from "./signals";

// 큰 JSON을 import하면 tsc가 타입을 뽑느라 느려서 파일로 읽는다
const fs = (await import("node:fs" as string)) as { readFileSync: (p: URL, enc: string) => string };
const file = JSON.parse(fs.readFileSync(new URL("../../public/city/gyeonggi_east.json", import.meta.url), "utf-8")) as CityFile;

describe("경기 동부 국도", () => {
  const graph = new CityGraph(file);
  const net = new CityNet(graph);
  const place = (n: string) => searchCityPlaces(graph.places, n, 20).find((p) => p.name === n) ?? null;

  it("지형 격자·물·도로 높이 굴곡이 있다", () => {
    const dem = graph.dem!;
    expect(graph.kind).toBe("rural");
    expect(dem).not.toBeNull();
    // 산과 강: 높이 폭이 크다
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = dem.y0; y < dem.y0 + dem.ny * dem.step; y += 500) {
      for (let x = dem.x0; x < dem.x0 + dem.nx * dem.step; x += 500) {
        const z = dem.height(x, y);
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
    }
    console.log("dem", dem.nx, dem.ny, "z", lo.toFixed(0), hi.toFixed(0));
    expect(hi - lo).toBeGreaterThan(300);
    // 두물머리는 물가
    const dm = place("양평 두물머리")!;
    let wet = 0;
    for (let dx = -400; dx <= 400; dx += 50) for (let dy = -400; dy <= 400; dy += 50) wet = Math.max(wet, dem.water(dm.x + dx, dm.y + dy));
    expect(wet).toBeGreaterThan(0.5);
    // 도로 토막 높이가 두 끝 사이를 곧게 가지 않는 것이 있다
    const bent = graph.edges.filter((e) => e.zs && e.zs.length > 3).length;
    console.log("edges", graph.edges.length, "with profile", bent, "places", graph.places.length);
    expect(bent).toBeGreaterThan(1000);
  }, 60_000);

  it("제한속도가 적히지 않은 시가지 길은 50km/h (서울 천호대로), 국도 경로는 6번 국도(경강로)를 탄다", () => {
    const chd = graph.edges.filter((e) => e.name === "천호대로");
    expect(chd.length).toBeGreaterThan(20);
    expect(chd.filter((e) => e.speed <= 60).length / chd.length).toBeGreaterThan(0.8);
    const plan = findCityRoute(net, place("강동역")!, place("양평역")!)!;
    const onTrunk = plan.links.filter((id) => net.links[id].cls === "t").reduce((m, id) => m + net.links[id].length, 0);
    expect(onTrunk).toBeGreaterThan(15000);
    // 갈림길(신호 없는 작은 교차로)에서 일부 차로로만 이어지는 곳도 차로 안내에 들어간다
    const city = cityRoadFile(net, plan).file.city!;
    const minorBoxes = new Set(city.boxes.filter((b) => b[3] === 1).map((b) => b[0]));
    expect(city.keep!.some(([s0]) => minorBoxes.has(s0))).toBe(true);
    // 80km/h 국도 신호 교차로는 황색 5초 (설 수도 지날 수도 없는 구간이 없게)
    const signals = new Signals(net);
    const jOf = (l: (typeof net.links)[number]) => net.nodeJunction[l.toNode];
    const fast = plan.links.map((id) => net.links[id]).find((l) => l.speed >= 80 && jOf(l) >= 0 && signals.plan(jOf(l)));
    expect(fast).toBeDefined();
    expect(Math.max(...signals.plan(jOf(fast!))!.phases.map((p) => p.yellow))).toBe(5);
  }, 60_000);

  const pairs: [string, string][] = [
    ["강동역", "양평 두물머리"],
    ["강동역", "양평역"],
    ["구리역", "양수역"],
    ["덕소역", "양평군청"],
    ["양평역", "용문역"],
  ];
  for (const [a, b] of pairs) {
    it(`${a} → ${b}: 국도로 길을 찾고, 오르내림·굽음이 달릴 만하다`, () => {
      const pa = place(a);
      const pb = place(b);
      expect(pa, a).not.toBeNull();
      expect(pb, b).not.toBeNull();
      const plan = findCityRoute(net, pa!, pb!)!;
      expect(plan).not.toBeNull();
      const { file: rf } = cityRoadFile(net, plan);
      const road = new Road(rf);
      // 20m 구간 오르내림: 거의 다 국도 기울기 안 (교차로 안 짧은 곳만 더 가파를 수 있다)
      const w = Math.max(1, Math.round(20 / road.step));
      const grades: number[] = [];
      for (let i = w; i < road.n; i += w) grades.push(Math.abs(road.sample(i * road.step).z - road.sample((i - w) * road.step).z) / (w * road.step));
      grades.sort((x, y) => x - y);
      const p99 = grades[Math.floor(grades.length * 0.99)];
      const gmax = grades[grades.length - 1];
      let kmax = 0;
      for (let i = 0; i < road.n; i++) kmax = Math.max(kmax, Math.abs(road.kappa[i]));
      console.log(
        a,
        b,
        "km",
        (plan.lengthM / 1000).toFixed(1),
        "min",
        (plan.timeS / 60).toFixed(0),
        "signals",
        plan.signals,
        "grade p99",
        p99.toFixed(3),
        "max",
        gmax.toFixed(3),
        "Rmin",
        (1 / kmax).toFixed(1),
      );
      expect(p99).toBeLessThan(0.12);
      expect(gmax).toBeLessThan(0.22);
      expect(kmax).toBeLessThan(1 / 5);
      expect(road.length).toBeGreaterThan(5000);
    }, 60_000);
  }
});
