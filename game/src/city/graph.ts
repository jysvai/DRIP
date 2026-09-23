// 시내·국도 도로 그래프 (pipeline/osm_city.py가 만든 public/city/<region>.json): 교차로(node)와 그 사이 도로 토막(edge), 찾을 곳.
// 국도 지역(kind "rural")은 지형 격자(dem)·물 덮임이 함께 온다. 도로 토막 높이 굴곡(zs)은 두 지역 모두 (고가·지하차도, 국도는 지형)
// 좌표는 파일 원점(UTM-K) 기준 m. 절대 좌표는 x + origin[0], y + origin[1].

import type { Poly } from "./geom";
import { segmentNearest } from "./geom";

type EdgeRow = [number, number, number[], number, string, number, number, number, string, string, number, number, number?, (number[] | 0)?];

/** 지형 격자: (x0, y0)부터 step m 간격 nx×ny. z는 0.1m 정수를 행마다 앞 값과의 차로, water는 행마다 (덮임 0~8, 개수) 반복 */
export interface DemFile {
  x0: number;
  y0: number;
  step: number;
  nx: number;
  ny: number;
  z: number[][];
  water: number[][];
  /** 시가지(주거·상업·공업 용도 땅)에 덮인 정도, water와 같은 꼴 */
  urban?: number[][];
}

export interface CityFile {
  region: string;
  name: string;
  /** city: 시내, rural: 국도 (없으면 시내) */
  kind?: "city" | "rural";
  dem?: DemFile;
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
  /** 높이 굴곡 (a에서 b까지 고른 간격, m). 없으면 양 끝 높이 사이를 곧게 */
  zs: Float32Array | null;
}

/** 국도 지역의 지형 격자 */
export class Dem {
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly nx: number;
  readonly ny: number;
  private z: Float32Array;
  private w: Uint8Array;
  private u: Uint8Array;

  constructor(f: DemFile) {
    this.x0 = f.x0;
    this.y0 = f.y0;
    this.step = f.step;
    this.nx = f.nx;
    this.ny = f.ny;
    this.z = new Float32Array(f.nx * f.ny);
    this.w = new Uint8Array(f.nx * f.ny);
    this.u = new Uint8Array(f.nx * f.ny);
    for (let j = 0; j < f.ny; j++) {
      const row = f.z[j];
      let v = 0;
      for (let i = 0; i < f.nx; i++) {
        v = i === 0 ? row[0] : v + row[i];
        this.z[j * f.nx + i] = v / 10;
      }
      unrun(f.water[j], this.w, j * f.nx);
      if (f.urban) unrun(f.urban[j], this.u, j * f.nx);
    }
  }

  private sample(arr: Float32Array | Uint8Array, x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.nx - 1.000001, (x - this.x0) / this.step));
    const fy = Math.max(0, Math.min(this.ny - 1.000001, (y - this.y0) / this.step));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = j * this.nx + i;
    const a = arr[k] + (arr[k + 1] - arr[k]) * tx;
    const b = arr[k + this.nx] + (arr[k + this.nx + 1] - arr[k + this.nx]) * tx;
    return a + (b - a) * ty;
  }

  /** 땅 높이 (m). 격자 밖은 가장자리 값 */
  height(x: number, y: number): number {
    return this.sample(this.z, x, y);
  }

  /** 물(강·호수)에 덮인 정도 0~1 */
  water(x: number, y: number): number {
    return this.sample(this.w, x, y) / 8;
  }

  /** 시가지에 덮인 정도 0~1 */
  urban(x: number, y: number): number {
    return this.sample(this.u, x, y) / 8;
  }

  /** 땅 기울기 (m/m) */
  slope(x: number, y: number): number {
    const h = this.step;
    const gx = (this.height(x + h, y) - this.height(x - h, y)) / (2 * h);
    const gy = (this.height(x, y + h) - this.height(x, y - h)) / (2 * h);
    return Math.hypot(gx, gy);
  }
}

/** (값, 개수) 반복을 풀어 out[at..]에 쓴다 */
function unrun(runs: number[], out: Uint8Array, at: number) {
  for (let k = 0; k + 1 < runs.length; k += 2) for (let c = 0; c < runs[k + 1]; c++) out[at++] = runs[k];
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
  readonly kind: "city" | "rural";
  readonly dem: Dem | null;
  readonly source: string;
  readonly origin: [number, number];
  readonly nodes: CityNode[];
  readonly edges: CityEdge[];
  readonly places: CityPlace[];
  private grid = new Map<number, number[]>();

  constructor(f: CityFile) {
    this.region = f.region;
    this.name = f.name;
    this.kind = f.kind ?? "city";
    this.dem = f.dem ? new Dem(f.dem) : null;
    this.source = f.source;
    this.origin = f.origin;
    const sc = f.scale || 0.1;
    const names = new Map(f.nodeNames ?? []);
    this.nodes = f.nodes.map(([x, y, z, sig, deg], i) => ({ x: x * sc, y: y * sc, z, signal: !!sig, degree: deg, name: names.get(i) ?? "", edges: [] }));
    this.edges = f.edges.map((r, id) => {
      const [a, b, flat, length, cls, lanes, speed, oneway, name, ref, bridge, tunnel, sep, zs] = r;
      const na = this.nodes[a];
      const nb = this.nodes[b];
      const pts = new Float64Array(flat.length + 4);
      pts[0] = na.x;
      pts[1] = na.y;
      for (let i = 0; i < flat.length; i++) pts[i + 2] = flat[i] * sc;
      pts[pts.length - 2] = nb.x;
      pts[pts.length - 1] = nb.y;
      const prof = zs ? Float32Array.from(zs, (v) => v / 10) : null;
      return { id, a, b, pts, length, cls: cls as RoadClass, lanes: Math.max(1, lanes), speed, oneway: !!oneway, name, ref, bridge: !!bridge, tunnel: !!tunnel, sep: sep ?? (oneway ? -1 : 0), zs: prof };
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

  /** 도로 토막 위 u(a에서 m) 높이 */
  edgeZ(e: CityEdge, u: number): number {
    const t = e.length > 0 ? Math.max(0, Math.min(1, u / e.length)) : 0;
    const zs = e.zs;
    if (!zs || zs.length < 2) return this.nodes[e.a].z + (this.nodes[e.b].z - this.nodes[e.a].z) * t;
    const f = t * (zs.length - 1);
    const i = Math.min(zs.length - 2, Math.floor(f));
    return zs[i] + (zs[i + 1] - zs[i]) * (f - i);
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
  /** 토막 e에서 (x, y)의 radius 안에 드는 선분마다 가장 가까운 자리 (굽이진 산길은 한 토막의 여러 곳이 가깝다) */
  forEachNear(e: CityEdge, x: number, y: number, radius: number, fn: (u: number, dist: number) => void) {
    const p = e.pts;
    let acc = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const r = segmentNearest(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]);
      if (r.d2 <= radius * radius) fn(acc + r.t * len, Math.sqrt(r.d2));
      acc += len;
    }
  }

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
