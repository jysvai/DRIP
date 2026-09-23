import { describe, expect, it } from "vitest";
import { Road, type RoadFile } from "./road";
import { buildPlaces, findRoute, joinRoute, searchPlaces, type Network } from "./route";

const real = Object.values(import.meta.glob<Network>("../../public/roads/network.json", { eager: true, import: "default" }))[0];

/** 곧은 시험 주행선: (x0, y0)에서 heading(rad) 방향으로 length m */
function straight(id: string, x0: number, y0: number, heading: number, length: number, opts: { z?: number; lanes?: number; junctions?: [number, string, string][]; from?: string; to?: string; ref?: string } = {}): RoadFile {
  const step = 10;
  const n = Math.round(length / step) + 1;
  const dx: number[] = [];
  const dy: number[] = [];
  let qx = Math.round(x0 * 10);
  let qy = Math.round(y0 * 10);
  for (let i = 1; i < n; i++) {
    const nx = Math.round((x0 + Math.cos(heading) * i * step) * 10);
    const ny = Math.round((y0 + Math.sin(heading) * i * step) * 10);
    dx.push(nx - qx);
    dy.push(ny - qy);
    qx = nx;
    qy = ny;
  }
  const rows = Array.from({ length: Math.floor(length / 40) + 1 }, () => [5, -5]);
  return {
    id,
    ref: opts.ref ?? id,
    name: `${id}고속도로`,
    from: opts.from ?? `${id}시작`,
    to: opts.to ?? `${id}끝`,
    length,
    step,
    origin: [x0, y0],
    dx,
    dy,
    z: new Array(n).fill((opts.z ?? 50) * 10),
    lanes: [[0, opts.lanes ?? 3]],
    speed: [[0, 100]],
    speedHgv: [[0, 80]],
    minSpeed: [[0, 50]],
    structure: [[0, 0]],
    structureName: [[0, ""]],
    sectionName: [[0, ""]],
    junctions: opts.junctions ?? [],
    terrain: { step: 40, offsets: [-45, 45], rows },
  };
}

function toNet(files: RoadFile[], transfers: Network["transfers"]): Network {
  return {
    origin: [0, 0],
    mapStep: 500,
    roads: files.map((f) => ({ id: f.id, ref: f.ref, name: f.name, from: f.from, to: f.to, length: f.length, speed: f.speed, p: [], j: f.junctions.map(([s, name]) => [s, name, /JC$/.test(name) ? "JC" : "IC"] as [number, string, string]) })),
    transfers,
  };
}

// 동쪽으로 가는 A가 3km 지점 가나JC에서 북쪽으로 가는 B로 갈아탄다
const A = straight("A", 0, 0, 0, 5000, { from: "서쪽", to: "동쪽", junctions: [[1000, "하나IC", "1"], [3000, "가나JC", "2"]] });
const B = straight("B", 3100, 0, Math.PI / 2, 6000, { from: "남쪽", to: "북쪽", z: 120, lanes: 2, junctions: [[4000, "두리IC", "5"]] });
const net = toNet([A, B], [{ a: "A", sa: 3000, b: "B", sb: 0, name: "가나JC", kind: "JC" }]);
const files = new Map([
  ["A", A],
  ["B", B],
]);

describe("경로 찾기", () => {
  const places = buildPlaces(net);

  it("도시(주행선 끝)와 나들목을 장소로 만든다", () => {
    const names = places.map((p) => p.name);
    expect(names).toContain("서쪽");
    expect(names).toContain("북쪽");
    expect(names).toContain("하나IC");
    expect(searchPlaces(places, "하나")[0].name).toBe("하나IC");
  });

  it("JC에서 갈아타는 경로를 찾는다", () => {
    const from = places.find((p) => p.name === "하나IC")!;
    const to = places.find((p) => p.name === "북쪽")!;
    const r = findRoute(net, from, to)!;
    expect(r.legs.map((l) => l.road)).toEqual(["A", "B"]);
    expect(r.legs[0].s0).toBe(1000);
    expect(r.legs[0].s1).toBe(3000);
    expect(r.legs[1].via).toBe("가나JC");
    expect(r.legs[1].s0).toBeGreaterThan(300);
    expect(r.legs[1].s1).toBe(6000);
  });

  it("갈 수 없는 곳은 null", () => {
    const from = places.find((p) => p.name === "북쪽")!;
    const to = places.find((p) => p.name === "서쪽")!;
    expect(findRoute(net, from, to)).toBeNull();
  });
});

describe("경로 이어 붙이기", () => {
  const places = buildPlaces(net);
  const plan = findRoute(net, places.find((p) => p.name === "서쪽")!, places.find((p) => p.name === "북쪽")!)!;
  const f = joinRoute(plan, files);
  const road = new Road(f);

  it("점 간격이 고르고 끊긴 곳이 없다", () => {
    for (let i = 1; i < road.n; i++) {
      const d = Math.hypot(road.e[i] - road.e[i - 1], road.nn[i] - road.nn[i - 1]);
      expect(d).toBeGreaterThan(8.5);
      expect(d).toBeLessThan(11.5);
    }
    expect(f.terrain.rows.length).toBe(Math.floor(road.length / 40) + 1);
  });

  it("조각 정보로 원래 주행선 위치를 되찾는다", () => {
    expect(road.isRoute).toBe(true);
    expect(road.legs).toHaveLength(2);
    const [l0, l1] = road.legs;
    // 연결로가 완만해지도록 JC 조금 앞에서 빠져나간다
    expect(l0.s1).toBeGreaterThanOrEqual(2500);
    expect(l0.s1).toBeLessThanOrEqual(3000);
    expect(l1.s0).toBeGreaterThan(l0.s1);
    expect(road.refAt(100)).toBe("A");
    expect(road.refAt(l1.s0 + 10)).toBe("B");
    expect(road.onConnector((l0.s1 + l1.s0) / 2)).toBe(true);
    expect(road.onConnector(l1.s0 + 100)).toBe(false);
    expect(road.sourceAt(l1.s0 + 100)).toEqual({ road: "B", s: l1.src0 + 100 });
    expect(road.sectionNameAt((l0.s1 + l1.s0) / 2)).toBe("가나JC 연결로");
    expect(road.lanesAt(l1.s0 + 500)).toBe(2);
    // 나들목은 원래 위치에서 옮겨 온다
    const j = road.junctions.find((x) => x.name === "두리IC")!;
    expect(j.s).toBeCloseTo(l1.s0 + 4000 - l1.src0, 0);
  });

  it("연결로는 굽은 방향이 이어지고 높이 차는 완만한 경사로 나눈다", () => {
    const [l0, l1] = road.legs;
    for (let s = l0.s1 - 200; s < l1.s0 + 200; s += 10) {
      const p = road.sample(s);
      expect(Math.abs(p.grade)).toBeLessThan(0.07);
      expect(Math.abs(p.kappa)).toBeLessThan(1 / 80);
    }
    // 동쪽으로 들어가 북쪽으로 나온다
    expect(road.sample(l0.s1 - 100).te).toBeCloseTo(1, 2);
    expect(road.sample(l1.s0 + 100).tn).toBeCloseTo(1, 2);
    expect(road.sample(road.length).z).toBeCloseTo(120, 0);
  });

  it("갈아탈 길의 들어갈 점이 빠져나갈 점보다 뒤에 있어도 연결로가 머리핀처럼 꺾이지 않는다", () => {
    // 동쪽으로 가는 A의 3km 지점 JC. 남쪽으로 가는 C는 그보다 300m 뒤에서 시작해 A 아래로 지나간다
    const C = straight("C", 2700, -50, -Math.PI / 2, 6000, { from: "북쪽", to: "남쪽", junctions: [[3000, "셋IC", "7"]] });
    const n2 = toNet([A, C], [{ a: "A", sa: 3000, b: "C", sb: 0, name: "가다JC", kind: "JC" }]);
    const p2 = buildPlaces(n2);
    const plan2 = findRoute(n2, p2.find((p) => p.name === "서쪽")!, p2.find((p) => p.name === "남쪽")!)!;
    const r2 = new Road(joinRoute(plan2, new Map([["A", A], ["C", C]])));
    const [m0, m1] = r2.legs;
    let kmax = 0;
    for (let s = m0.s1 - 100; s < m1.s0 + 100; s += 5) kmax = Math.max(kmax, Math.abs(r2.sample(s).kappa));
    expect(1 / kmax).toBeGreaterThan(60);
    expect(r2.sample(m1.s0 + 100).tn).toBeCloseTo(-1, 2);
  });

  it("연결로 제한속도는 곡률에 맞춘다", () => {
    const [l0, l1] = road.legs;
    const v = road.speedAt((l0.s1 + l1.s0) / 2);
    expect(v).toBeGreaterThanOrEqual(40);
    expect(v).toBeLessThanOrEqual(80);
  });
});

describe("전국 도로망", () => {
  const places = buildPlaces(real);
  const find = (q: string) => searchPlaces(places, q)[0];

  it("갈아타는 곳은 모두 있는 주행선을 가리킨다", () => {
    const ids = new Set(real.roads.map((r) => r.id));
    for (const t of real.transfers) {
      expect(ids.has(t.a)).toBe(true);
      expect(ids.has(t.b)).toBe(true);
    }
  });

  it("서울에서 부산까지, 강릉까지 간다", () => {
    const busan = findRoute(real, find("서울"), find("부산"))!;
    expect(busan.lengthM / 1000).toBeGreaterThan(330);
    expect(busan.lengthM / 1000).toBeLessThan(460);
    const gangneung = findRoute(real, find("서울"), find("강릉"))!;
    expect(gangneung.legs.some((l) => l.via === "신갈JC")).toBe(true);
    expect(gangneung.lengthM / 1000).toBeLessThan(260);
  });

  it("주요 도시 사이는 모두 이어진다", () => {
    const cities = ["서울", "부산", "대전", "대구", "광주", "울산", "강릉", "목포", "인천", "전주", "포항", "춘천"];
    for (const a of cities) {
      for (const b of cities) {
        if (a === b) continue;
        expect(findRoute(real, find(a), find(b)), `${a}→${b}`).not.toBeNull();
      }
    }
  });
});
