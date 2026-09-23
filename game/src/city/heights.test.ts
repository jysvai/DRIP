import { describe, expect, it } from "vitest";
import { CityGraph, type CityFile, type CityEdge } from "./graph";
import { CityNet } from "./net";
import { drivable } from "./route";

// 도로 높이 (pipeline/city_heights.py): 링크 끝 높이, 고가·지하차도 위아래 간격, 기울기
const fs = (await import("node:fs" as string)) as { readFileSync: (p: URL, enc: string) => string };
const load = (region: string) => JSON.parse(fs.readFileSync(new URL(`../../public/city/${region}.json`, import.meta.url), "utf-8")) as CityFile;

/** 교차점을 나누지 않고 겹쳐 지나가는 두 토막과 그 자리 높이 */
function crossings(g: CityGraph): { e: CityEdge; f: CityEdge; ze: number; zf: number }[] {
  const out: { e: CityEdge; f: CityEdge; ze: number; zf: number }[] = [];
  const seen = new Set<string>();
  const along = (p: Float64Array, idx: number, t: number) => {
    let acc = 0;
    for (let m = 0; m < idx; m += 2) acc += Math.hypot(p[m + 2] - p[m], p[m + 3] - p[m + 1]);
    return acc + t * Math.hypot(p[idx + 2] - p[idx], p[idx + 3] - p[idx + 1]);
  };
  for (const e of g.edges) {
    const p = e.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [ax, ay, bx, by] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      for (const id of g.edgesIn(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
        if (id <= e.id) continue;
        const f = g.edges[id];
        if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
        const q = f.pts;
        for (let k = 0; k + 3 < q.length; k += 2) {
          const [cx, cy, dx, dy] = [q[k], q[k + 1], q[k + 2], q[k + 3]];
          const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
          if (Math.abs(den) < 1e-9) continue;
          const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
          const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1 || seen.has(`${e.id},${f.id}`)) continue;
          seen.add(`${e.id},${f.id}`);
          out.push({ e, f, ze: g.edgeZ(e, along(p, i, t)), zf: g.edgeZ(f, along(q, k, u)) });
        }
      }
    }
  }
  return out;
}

/** 토막 위 u 자리 */
function pointOn(e: CityEdge, u: number): [number, number] {
  const p = e.pts;
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    if (acc + len >= u || i + 5 >= p.length) {
      const t = len > 0 ? Math.min(1, (u - acc) / len) : 0;
      return [p[i] + (p[i + 2] - p[i]) * t, p[i + 1] + (p[i + 3] - p[i + 1]) * t];
    }
    acc += len;
  }
  return [p[0], p[1]];
}

for (const region of ["seoul", "gyeonggi_east"]) {
  describe(`${region} 도로 높이`, () => {
    const graph = new CityGraph(load(region));
    const net = new CityNet(graph);

    it("링크는 양 끝 교차점 높이에서 시작하고 끝난다 (이웃 링크와 층이 지지 않는다)", () => {
      let worst = 0;
      for (const l of net.links) {
        const z = net.geom(l.id).z;
        worst = Math.max(worst, Math.abs(z[0] - graph.nodes[l.fromNode].z), Math.abs(z[z.length - 1] - graph.nodes[l.toNode].z));
      }
      expect(worst).toBeLessThan(0.06); // 높이 굴곡은 0.1m 정수
    });

    it("고가는 밑 길 위로, 지하차도는 윗길 밑으로 지나간다", () => {
      let structural = 0;
      let clash = 0;
      for (const { e, f, ze, zf } of crossings(graph)) {
        const se = e.bridge || e.tunnel;
        const sf = f.bridge || f.tunnel;
        if (se === sf) continue; // 둘 다 다리거나 둘 다 땅 위 길은 층을 알 수 없는 것이 섞여 있다
        structural++;
        if (Math.abs(ze - zf) < 4.5) clash++;
      }
      expect(structural).toBeGreaterThan(region === "seoul" ? 1500 : 400);
      expect(clash / structural).toBeLessThan(0.01);
    }, 60_000);

    it("나란히 가는 고가·지하도로가 밑·윗길과 같은 높이로 겹치지 않는다", () => {
      // 국회대로 밑 신월여의지하도로, 정릉로 위 내부순환로: 다리·터널 안은 양 끝 사이를 이어 땅 위 길 높이와 같아진다
      const half = (e: CityEdge) => e.lanes * (e.oneway ? 1.6 : 3.2);
      let total = 0;
      let clash = 0;
      for (const e of graph.edges) {
        if (!e.bridge && !e.tunnel) continue;
        for (let u = 5; u < e.length; u += 10) {
          const p = graph.edgeZ(e, u);
          const [x, y] = pointOn(e, u);
          total += 10;
          const r = graph.nearestEdge(x, y, 40, (f) => !f.bridge && !f.tunnel && f.a !== e.a && f.a !== e.b && f.b !== e.a && f.b !== e.b);
          if (r && r.dist < half(e) + half(r.edge) - 1 && Math.abs(graph.edgeZ(r.edge, r.u) - p) < 4.5) clash += 10;
        }
      }
      expect(clash / total).toBeLessThan(region === "seoul" ? 0.015 : 0.008); // 이전: 서울 4.3%, 국도 0.9%
    }, 60_000);

    it("30m 지형에 섞인 건물 높이로 길이 가파르게 솟지 않는다", () => {
      let total = 0;
      let steep = 0;
      for (const e of graph.edges) {
        const n = Math.max(1, Math.round(e.length / 20));
        for (let k = 0; k < n; k++) {
          const u0 = (e.length * k) / n;
          const u1 = (e.length * (k + 1)) / n;
          total += u1 - u0;
          if (Math.abs(graph.edgeZ(e, u1) - graph.edgeZ(e, u0)) > 0.16 * (u1 - u0) + 0.1) steep += u1 - u0;
        }
      }
      // 서울은 등급별 기울기 상한(8~13%), 국도는 산길이라 그 1.5배까지
      expect(steep / total).toBeLessThan(region === "seoul" ? 0.001 : 0.01);
    });

    it("역은 모두 차로 가고 나올 수 있다", () => {
      const stations = graph.places.filter((p) => p.kind === "역");
      const stuck = stations.filter((p) => !drivable(net, p)).map((p) => p.name);
      expect(stuck).toEqual([]);
    });
  });
}
