import { describe, expect, it } from "vitest";
import { CityGraph, type CityFile } from "./graph";
import { CityNet, delaunay } from "./net";
import { convexHull } from "./geom";

// 큰 JSON을 import하면 tsc가 타입을 뽑느라 느려서 파일로 읽는다
const fs = (await import("node:fs" as string)) as { readFileSync: (p: URL, enc: string) => string };
const load = (region: string) => JSON.parse(fs.readFileSync(new URL(`../../public/city/${region}.json`, import.meta.url), "utf-8")) as CityFile;

type P3 = [number, number, number];

const area = (a: number[], b: number[], c: number[]) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;

function hullArea(pts: P3[]): number {
  const h = convexHull(pts.map((p) => [p[0], p[1]]));
  let s = 0;
  for (let k = 0; k < h.length; k++) {
    const a = h[k];
    const b = h[(k + 1) % h.length];
    s += (a[0] * b[1] - b[0] * a[1]) / 2;
  }
  return Math.abs(s);
}

describe("들로네 삼각분할", () => {
  it("오목하게 늘어선 점도 볼록 껍질을 한 겹으로 덮는다", () => {
    // 십자 교차로 모서리처럼 가운데로 파인 점들 + 가운데
    const pts: P3[] = [[0, 0, 5]];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (const off of [-7, 7]) pts.push([20 * c - off * s, 20 * s + off * c, k]);
    }
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 30 - 15;
    for (let k = 0; k < 20; k++) pts.push([rnd(), rnd(), 0]);
    const tris = delaunay(pts);
    let sum = 0;
    for (const [a, b, c] of tris) {
      const ar = area(a, b, c);
      expect(ar).toBeGreaterThan(0);
      sum += ar;
    }
    expect(sum).toBeCloseTo(hullArea(pts), 6);
    // 모든 점이 꼭짓점으로 쓰인다
    const used = new Set(tris.flat());
    for (const p of pts) expect(used.has(p)).toBe(true);
  });
});

for (const region of ["seoul", "gyeonggi_east"]) {
  describe(`${region} 교차로 바닥`, () => {
    const net = new CityNet(new CityGraph(load(region)));

    it("겹치지 않고 (겹치면 높은 쪽이 차를 덮는다) 접근로 끝마다 그 높이에 닿는다", () => {
      let plates = 0;
      let overlap = 0;
      let worstGap = 0;
      for (let jid = 0; jid < net.junctions.length; jid++) {
        if (net.junctions[jid].minor) continue;
        const sf = net.junctionSurface(jid);
        if (!sf) continue;
        plates++;
        const verts = [...new Set(sf.tris.flat())] as P3[];
        const sum = sf.tris.reduce((m, [a, b, c]) => m + area(a, b, c), 0);
        if (sum > hullArea(verts) * (1 + 1e-6) + 1e-6) overlap++;
        // 접근로 끝 모서리마다 바닥 높이 = 그 링크 높이
        for (const v of verts) worstGap = Math.max(worstGap, Math.abs(net.junctionZ(sf, v[0], v[1]) - v[2]));
      }
      console.log(region, "plates", plates, "overlap", overlap, "corner gap", worstGap.toFixed(3));
      expect(plates).toBeGreaterThan(300);
      expect(overlap).toBe(0);
      expect(worstGap).toBeLessThan(0.01);
    }, 60_000);
  });
}
