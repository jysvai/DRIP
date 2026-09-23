// 시내 도로 그래프 (pipeline/osm_city.py가 만든 public/city/<region>.json): 교차로(node)와 그 사이 도로 토막(edge), 찾을 곳.
// 좌표는 파일 원점(UTM-K) 기준 m. 절대 좌표는 x + origin[0], y + origin[1].

import type { Poly } from "./geom";
import { segmentNearest } from "./geom";

type EdgeRow = [number, number, number[], number, string, number, number, number, string, string, number, number, number?];

export interface CityFile {
  region: string;
  name: string;
  source: string;
  osmTimestamp: string;
  origin: [number, number];
  scale: number;
  nodes: [number, number, number, number, number][];
  nodeNames?: [number, string][];
  edges: EdgeRow[];
  places: [string, string, number, number][];
}

export interface CityNode {
  x: number;
  y: number;
  z: number;
  signal: boolean;
  degree: number;
  name: string;
  /** 이 점에 닿은 도로 토막 */
  edges: number[];
}

/** 도로 등급: m 도시고속도로, t 자동차전용·간선, p 대로, s 로, r 길. 끝에 l이 붙으면 연결로 */
export type RoadClass = "m" | "t" | "p" | "s" | "r" | "ml" | "tl" | "pl" | "sl" | "rl";

export interface CityEdge {
  id: number;
  a: number;
  b: number;
  /** 양 끝점을 포함한 중심선 */
  pts: Poly;
  length: number;
  cls: RoadClass;
  /** 한 방향 차로 수 */
  lanes: number;
  speed: number;
  oneway: boolean;
  name: string;
  ref: string;
  bridge: boolean;
  tunnel: boolean;
  /** 마주 보는 짝: >0 짝(반대 방향 한 방향 도로)의 중심선까지 거리(m), 0 한 줄로 그린 왕복 도로, -1 짝 없는 일방통행 */
  sep: number;
}

export interface CityPlace {
  name: string;
  kind: string;
  x: number;
  y: number;
}

const CELL = 100;

export class CityGraph {
  readonly region: string;
  readonly name: string;
  readonly source: string;
  readonly origin: [number, number];
  readonly nodes: CityNode[];
  readonly edges: CityEdge[];
  readonly places: CityPlace[];
  private grid = new Map<number, number[]>();

  constructor(f: CityFile) {
    this.region = f.region;
    this.name = f.name;
    this.source = f.source;
    this.origin = f.origin;
    const sc = f.scale || 0.1;
    const names = new Map(f.nodeNames ?? []);
    this.nodes = f.nodes.map(([x, y, z, sig, deg], i) => ({ x: x * sc, y: y * sc, z, signal: !!sig, degree: deg, name: names.get(i) ?? "", edges: [] }));
    this.edges = f.edges.map((r, id) => {
      const [a, b, flat, length, cls, lanes, speed, oneway, name, ref, bridge, tunnel, sep] = r;
      const na = this.nodes[a];
      const nb = this.nodes[b];
      const pts = new Float64Array(flat.length + 4);
      pts[0] = na.x;
      pts[1] = na.y;
      for (let i = 0; i < flat.length; i++) pts[i + 2] = flat[i] * sc;
      pts[pts.length - 2] = nb.x;
      pts[pts.length - 1] = nb.y;
      return { id, a, b, pts, length, cls: cls as RoadClass, lanes: Math.max(1, lanes), speed, oneway: !!oneway, name, ref, bridge: !!bridge, tunnel: !!tunnel, sep: sep ?? (oneway ? -1 : 0) };
    });
    for (const e of this.edges) {
      this.nodes[e.a].edges.push(e.id);
      if (e.b !== e.a) this.nodes[e.b].edges.push(e.id);
      // 칸 색인: 선분이 지나는 칸마다
      const p = e.pts;
      const seen = new Set<number>();
      for (let i = 0; i + 3 < p.length; i += 2) {
        const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
        for (let k = 0; k <= steps; k++) {
          const x = p[i] + ((p[i + 2] - p[i]) * k) / steps;
          const y = p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / steps;
          const key = this.key(Math.floor(x / CELL), Math.floor(y / CELL));
          if (seen.has(key)) continue;
          seen.add(key);
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(e.id);
        }
      }
    }
    this.places = f.places.map(([name, kind, x, y]) => ({ name, kind, x: x * sc, y: y * sc }));
  }

  static async load(region: string, base = "./city/"): Promise<CityGraph> {
    const res = await fetch(`${base}${region}.json`);
    if (!res.ok) throw new Error(`시내 도로망을 불러오지 못했습니다 (${region}, ${res.status})`);
    return new CityGraph((await res.json()) as CityFile);
  }

  private key(cx: number, cy: number): number {
    return (cx + 5000) * 100000 + (cy + 5000);
  }

  /** 사각형 안(과 걸친) 도로 토막 */
  edgesIn(x0: number, y0: number, x1: number, y1: number): number[] {
    const out = new Set<number>();
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.grid.get(this.key(cx, cy));
        if (list) for (const id of list) out.add(id);
      }
    }
    return [...out];
  }

  /** 가장 가까운 도로 토막 위 점 (filter를 통과하는 것만, radius m 안) */
  nearestEdge(x: number, y: number, radius: number, filter: (e: CityEdge) => boolean = () => true): { edge: CityEdge; u: number; dist: number } | null {
    let best: { edge: CityEdge; u: number; dist: number } | null = null;
    for (const id of this.edgesIn(x - radius, y - radius, x + radius, y + radius)) {
      const e = this.edges[id];
      if (!filter(e)) continue;
      const p = e.pts;
      let acc = 0;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        const r = segmentNearest(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]);
        const d = Math.sqrt(r.d2);
        if (d <= radius && (!best || d < best.dist)) best = { edge: e, u: acc + r.t * len, dist: d };
        acc += len;
      }
    }
    return best;
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** 이름으로 찾기: 같은 이름, 앞부분이 맞는 것, 들어 있는 것 순. 역은 "역"을 빼고 찾아도 된다 */
export function searchCityPlaces(places: CityPlace[], q: string, limit = 12): CityPlace[] {
  const n = normalize(q);
  if (!n) return [];
  const scored: [number, CityPlace][] = [];
  for (const p of places) {
    const pn = normalize(p.name);
    let score = -1;
    if (pn === n || pn === `${n}역`) score = 0;
    else if (pn.startsWith(n)) score = 1;
    else if (pn.includes(n)) score = 2;
    if (score < 0) continue;
    // 역·명소를 조금 앞에, 이름이 짧은 것을 앞에
    scored.push([score + (p.kind === "역" ? 0 : p.kind === "명소" ? 0.2 : 0.4) + pn.length * 0.002, p]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}
