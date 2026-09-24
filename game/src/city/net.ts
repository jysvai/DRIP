// 시내 도로망: 그래프(교차로·도로 토막)를 달릴 수 있는 모양으로 바꾼다.
//
//   교차로(Junction): 가까이 모인 교차점을 하나로 묶는다. 중앙분리대가 있는 큰길끼리 만나면 OSM에는 네 점(작은 사각형)으로 그려지기 때문.
//   링크(Link): 교차로에서 다음 교차로까지 한 방향 차도. 왕복 도로 한 줄은 방향마다 링크가 하나씩이고, 중심선을 차도 가운데로 옮긴다.
//   이동(Movement): 교차로에서 들어온 링크 → 나가는 링크 (직진·좌회전·우회전). 유턴은 없다.
//   정지선: 들어오는 링크 끝에서 건너는 도로 폭 절반 + 횡단보도만큼 앞. 나가는 링크도 같은 만큼 뒤에서 시작한다.
//
// 거리 u는 OSM 중심선을 따라 잰 값, 모양(geom)은 차도 가운데를 2m 간격으로 뽑은 것이다 (길이가 조금 다르다).

import { connector } from "../road/route";
import type { CityEdge, CityGraph, RoadClass } from "./graph";
import { cumLengths, headingBetween, offsetPoly, pointAt, resample, wrapAngle, type Poly, type PolyPoint } from "./geom";

/**
 * 교차로 바닥: 접근로 끝마다 양쪽 모서리 [x, y, 높이]와 가운데 점을 겹침 없이 이은 삼각형들 (들로네 삼각분할).
 * 모든 접근로 끝이 바닥 가장자리가 되므로 비탈의 교차로도 접근로와 턱 없이 이어진다
 */
export interface JunctionSurface {
  tris: [number, number, number][][];
  cx: number;
  cy: number;
  cz: number;
  /** 모서리 높이의 가장 낮은·높은 값 */
  zLo: number;
  zHi: number;
}

/** 시내 차로 폭 (m). 서울 간선도로는 3.0~3.5m */
export const CITY_LANE = 3.25;
/** 왕복 도로 가운데 중앙선(노란 겹선) 폭 */
export const CENTER_GAP = 0.5;
/** 횡단보도 폭 */
export const CROSSWALK = 4;
/** 정지선 ~ 횡단보도 사이, 횡단보도 ~ 건너는 도로 사이 */
export const STOP_GAP = 1.5;
export const XWALK_GAP = 1;
/** 이 길이보다 짧은 토막으로 이어진 교차점은 한 교차로로 묶는다 */
const CLUSTER_EDGE = 42;
/** 묶은 교차로의 크기 한도 (m) */
const CLUSTER_SPAN = 95;
/** 갈라지기·합치기만 하는 곳: 앞뒤를 이만큼 잘라 부드럽게 잇는다 */
const MINOR_CUT = 12;
const GEOM_STEP = 2;

export type Turn = "S" | "L" | "R";

export interface DirEdge {
  edge: number;
  fwd: boolean;
}

/** 링크 안 구간 (u 기준): 도로 토막 하나 */
export interface LinkSpan {
  u0: number;
  u1: number;
  edge: number;
  lanes: number;
  speed: number;
  cls: RoadClass;
  name: string;
  /** 한 줄로 그린 왕복 도로 (왼쪽이 중앙선) */
  twoWay: boolean;
  sep: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface Link {
  id: number;
  edges: DirEdge[];
  fromNode: number;
  toNode: number;
  /** 시작·끝 교차로 (-1이면 교차로가 아닌 끝) */
  from: number;
  to: number;
  /** OSM 중심선 길이 */
  length: number;
  spans: LinkSpan[];
  name: string;
  cls: RoadClass;
  /** 끝 쪽 차로 수·시작 쪽 차로 수 */
  lanes: number;
  lanesStart: number;
  speed: number;
  /** 같은 도로 반대 방향 링크 (한 줄로 그린 왕복 도로) */
  reverse: number;
  /** 끝에서 정지선까지, 시작에서 교차로를 벗어난 곳까지 (u) */
  stopDist: number;
  startDist: number;
  /** 들어가는 쪽·나오는 쪽 방향 (rad) */
  headIn: number;
  headOut: number;
}

export interface Junction {
  id: number;
  nodes: number[];
  x: number;
  y: number;
  z: number;
  signal: boolean;
  name: string;
  /** 갈라지기·합치기만 하는 곳 (정지선·신호 없음) */
  minor: boolean;
  inbound: number[];
  outbound: number[];
  movements: number[];
}

export interface Movement {
  id: number;
  junction: number;
  from: number;
  to: number;
  turn: Turn;
  /** 방향 변화 (rad, 왼쪽 +) */
  angle: number;
  /** 쓰는 차로 (1 = 가장 왼쪽), 양 끝 포함 */
  fromLanes: [number, number];
  toLanes: [number, number];
}

/** 링크 모양: 차도 가운데 선 (2m 간격), 누적 길이, 높이 */
export interface LinkGeom {
  pts: Poly;
  cum: Float64Array;
  z: Float64Array;
  length: number;
  /** u(OSM 중심선 거리) → 이 모양 위 거리 */
  scale: number;
}

/** 왕복 도로 한 방향 차도 가운데가 OSM 중심선에서 오른쪽으로 떨어진 거리 */
export function twoWayOffset(lanes: number): number {
  return CENTER_GAP / 2 + (lanes * CITY_LANE) / 2;
}

/** 도로 토막이 교차로 한가운데에서 차지하는 폭의 절반 (왕복 도로는 양쪽 차도 전체) */
function halfSpan(e: CityEdge): number {
  return e.oneway ? (e.lanes * CITY_LANE) / 2 : e.lanes * CITY_LANE + CENTER_GAP / 2;
}

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]];
      a = this.parent[a];
    }
    return a;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

export class CityNet {
  readonly junctions: Junction[] = [];
  readonly links: Link[] = [];
  readonly movements: Movement[] = [];
  /** 그래프 점 → 교차로 번호 (-1) */
  readonly nodeJunction: Int32Array;
  /** 도로 토막·방향 → 링크 번호 (fwd: edge*2, 거꾸로: edge*2+1) */
  readonly dirLink: Int32Array;
  private geoms = new Map<number, LinkGeom>();
  private paths = new Map<string, { pts: Poly; cum: Float64Array; z: Float64Array }>();
  private surfaces = new Map<number, JunctionSurface | null>();

  constructor(readonly graph: CityGraph) {
    const g = graph;
    const N = g.nodes.length;
    this.nodeJunction = new Int32Array(N).fill(-1);
    this.dirLink = new Int32Array(g.edges.length * 2).fill(-1);
    this.cluster();
    this.buildLinks();
    this.classify();
    this.buildMovements();
    for (const l of this.links) {
      l.stopDist = this.cutDist(l, true);
      l.startDist = this.cutDist(l, false);
    }
  }

  // ---------------- 교차로 묶기 ----------------

  private cluster() {
    const g = this.graph;
    const N = g.nodes.length;
    const isJ = (n: number) => g.nodes[n].degree >= 3;
    const uf = new UnionFind(N);
    // 묶음의 경계 상자 (크기 한도를 넘지 않게)
    const box = new Map<number, [number, number, number, number]>();
    const boxOf = (n: number) => box.get(uf.find(n)) ?? [g.nodes[n].x, g.nodes[n].y, g.nodes[n].x, g.nodes[n].y];
    const short = g.edges.filter((e) => e.length < CLUSTER_EDGE && e.a !== e.b && isJ(e.a) && isJ(e.b) && e.cls !== "m").sort((a, b) => a.length - b.length);
    for (const e of short) {
      const ra = uf.find(e.a);
      const rb = uf.find(e.b);
      if (ra === rb) continue;
      const A = boxOf(e.a);
      const B = boxOf(e.b);
      const u: [number, number, number, number] = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])];
      if (Math.hypot(u[2] - u[0], u[3] - u[1]) > CLUSTER_SPAN) continue;
      uf.union(ra, rb);
      box.set(uf.find(ra), u);
    }
    const byRoot = new Map<number, number[]>();
    for (let n = 0; n < N; n++) {
      if (!isJ(n)) continue;
      const r = uf.find(n);
      let list = byRoot.get(r);
      if (!list) byRoot.set(r, (list = []));
      list.push(n);
    }
    for (const nodes of byRoot.values()) {
      const id = this.junctions.length;
      let x = 0;
      let y = 0;
      let z = 0;
      let signal = false;
      let name = "";
      for (const n of nodes) {
        const p = g.nodes[n];
        x += p.x;
        y += p.y;
        z += p.z;
        signal ||= p.signal;
        if (!name && p.name) name = p.name;
        this.nodeJunction[n] = id;
      }
      this.junctions.push({ id, nodes, x: x / nodes.length, y: y / nodes.length, z: z / nodes.length, signal, name, minor: false, inbound: [], outbound: [], movements: [] });
    }
  }

  // ---------------- 링크 ----------------

  private allowed(e: CityEdge, fwd: boolean): boolean {
    return fwd || !e.oneway;
  }

  private tail(d: DirEdge): number {
    const e = this.graph.edges[d.edge];
    return d.fwd ? e.a : e.b;
  }

  private head(d: DirEdge): number {
    const e = this.graph.edges[d.edge];
    return d.fwd ? e.b : e.a;
  }

  /** 교차로 안에서만 이어지는 토막 (두 끝이 같은 교차로) */
  private internal(e: CityEdge): boolean {
    const ja = this.nodeJunction[e.a];
    return ja >= 0 && ja === this.nodeJunction[e.b];
  }

  private buildLinks() {
    const g = this.graph;
    const used = new Uint8Array(g.edges.length * 2);
    const breakpoint = (n: number) => this.nodeJunction[n] >= 0 || g.nodes[n].degree !== 2;
    const slot = (d: DirEdge) => d.edge * 2 + (d.fwd ? 0 : 1);
    for (const e of g.edges) {
      if (this.internal(e) || e.a === e.b) continue;
      for (const fwd of [true, false]) {
        const d0 = { edge: e.id, fwd };
        if (!this.allowed(e, fwd) || used[slot(d0)] || !breakpoint(this.tail(d0))) continue;
        const chain: DirEdge[] = [d0];
        used[slot(d0)] = 1;
        let h = this.head(d0);
        const start = this.tail(d0);
        while (!breakpoint(h) && h !== start) {
          const last = chain[chain.length - 1];
          const other = g.nodes[h].edges.find((id) => id !== last.edge);
          if (other === undefined) break;
          const f = g.edges[other];
          const nf = f.a === h;
          const nd = { edge: f.id, fwd: nf };
          if (!this.allowed(f, nf) || used[slot(nd)] || this.internal(f)) break;
          chain.push(nd);
          used[slot(nd)] = 1;
          h = this.head(nd);
        }
        this.addLink(chain);
      }
    }
    // 같은 도로 반대 방향 짝 (한 줄로 그린 왕복 도로)
    for (const l of this.links) {
      const first = l.edges[0];
      const rev = this.dirLink[first.edge * 2 + (first.fwd ? 1 : 0)];
      l.reverse = rev;
    }
  }

  private addLink(chain: DirEdge[]) {
    const g = this.graph;
    const id = this.links.length;
    const spans: LinkSpan[] = [];
    let u = 0;
    for (const d of chain) {
      const e = g.edges[d.edge];
      spans.push({ u0: u, u1: u + e.length, edge: e.id, lanes: e.lanes, speed: e.speed, cls: e.cls, name: e.name, twoWay: !e.oneway, sep: e.sep, bridge: e.bridge, tunnel: e.tunnel });
      u += e.length;
      this.dirLink[d.edge * 2 + (d.fwd ? 0 : 1)] = id;
    }
    const lastE = g.edges[chain[chain.length - 1].edge];
    const firstE = g.edges[chain[0].edge];
    const fromNode = this.tail(chain[0]);
    const toNode = this.head(chain[chain.length - 1]);
    const link: Link = {
      id,
      edges: chain,
      fromNode,
      toNode,
      from: this.nodeJunction[fromNode],
      to: this.nodeJunction[toNode],
      length: Math.max(1, u),
      spans,
      name: lastE.name || firstE.name,
      cls: lastE.cls,
      lanes: lastE.lanes,
      lanesStart: firstE.lanes,
      speed: lastE.speed,
      reverse: -1,
      stopDist: 0,
      startDist: 0,
      headIn: 0,
      headOut: 0,
    };
    const raw = this.rawPoly(link);
    const cum = cumLengths(raw);
    const L = cum[cum.length - 1];
    link.headIn = headingBetween(raw, cum, Math.max(0, L - 20), L);
    link.headOut = headingBetween(raw, cum, 0, Math.min(L, 20));
    this.links.push(link);
    if (link.from >= 0) this.junctions[link.from].outbound.push(id);
    if (link.to >= 0) this.junctions[link.to].inbound.push(id);
  }

  /** OSM 중심선을 이어 붙인 꺾은선 (옮기기 전) */
  private rawPoly(l: Link): Poly {
    const g = this.graph;
    const pts: number[] = [];
    for (const d of l.edges) {
      const p = g.edges[d.edge].pts;
      const n = p.length / 2;
      for (let k = 0; k < n; k++) {
        const i = d.fwd ? k : n - 1 - k;
        if (pts.length && k === 0) continue;
        pts.push(p[2 * i], p[2 * i + 1]);
      }
    }
    return Float64Array.from(pts);
  }

  // ---------------- 교차로 종류·이동 ----------------

  private classify() {
    const g = this.graph;
    for (const j of this.junctions) {
      const names = new Set<string>();
      let arms = 0;
      for (const id of [...j.inbound, ...j.outbound]) {
        const l = this.links[id];
        if (l.cls.endsWith("l")) continue;
        arms++;
        names.add(l.name || `#${l.edges[0].edge}`);
      }
      // 이름 하나뿐(같은 도로가 갈라지거나 합쳐질 뿐)이면 교차로가 아니다
      j.minor = names.size <= 1 || arms <= 2;
      if (j.minor) j.signal = false;
      if (!j.name) {
        // 이름 있는 신호등이 없으면 만나는 도로 이름으로 (예: 테헤란로·강남대로 교차로)
        const list = [...names].filter((n) => !n.startsWith("#")).slice(0, 2);
        j.name = list.length >= 2 ? `${list[0]}·${list[1]} 교차로` : "";
      }
      void g;
    }
  }

  /** 교차로 안 토막으로 a에서 b로 갈 수 있는지 (한 방향 도로는 그 방향으로만) */
  private reachable(j: Junction, a: number, b: number): boolean {
    if (a === b) return true;
    const g = this.graph;
    const seen = new Set<number>([a]);
    const queue = [a];
    while (queue.length) {
      const n = queue.shift()!;
      for (const id of g.nodes[n].edges) {
        const e = g.edges[id];
        if (!this.internal(e) || this.nodeJunction[e.a] !== j.id) continue;
        const next = e.a === n ? e.b : !e.oneway ? e.a : -1;
        if (next < 0 || seen.has(next)) continue;
        if (next === b) return true;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  }

  private buildMovements() {
    for (const j of this.junctions) {
      for (const i of j.inbound) {
        const li = this.links[i];
        for (const o of j.outbound) {
          const lo = this.links[o];
          if (o === li.reverse || !this.reachable(j, li.toNode, lo.fromNode)) continue;
          const angle = wrapAngle(lo.headOut - li.headIn);
          if (Math.abs(angle) > (150 * Math.PI) / 180) continue;
          const turn: Turn = angle > (35 * Math.PI) / 180 ? "L" : angle < (-35 * Math.PI) / 180 ? "R" : "S";
          const n = li.lanes;
          const m = lo.lanesStart;
          let fromLanes: [number, number];
          let toLanes: [number, number];
          if (turn === "L") {
            const k = n >= 4 && m >= 2 ? 2 : 1;
            fromLanes = [1, k];
            toLanes = [1, k];
          } else if (turn === "R") {
            fromLanes = [n, n];
            toLanes = [m, m];
          } else {
            const k = Math.min(n, m);
            // 차로가 줄면 오른쪽 차로는 우회전 전용으로 보고 왼쪽부터 잇는다
            fromLanes = [1, k];
            toLanes = [1, k];
          }
          const mv: Movement = { id: this.movements.length, junction: j.id, from: i, to: o, turn, angle, fromLanes, toLanes };
          this.movements.push(mv);
          j.movements.push(mv.id);
        }
        this.splitLanes(j, i);
        this.coverLanes(j, i);
      }
    }
  }

  /**
   * 어느 이동에도 들지 않는 차로가 없게: 예를 들어 편도 4차로에서 직진이 1~2차로, 우회전이 4차로면 3차로 차는
   * 갈 곳이 없어 정지선에서 끝없이 옆 차로를 기다린다. 가장 가까운 이동(같으면 직진)에 붙인다
   */
  private coverLanes(j: Junction, inbound: number) {
    const mvs = j.movements.map((id) => this.movements[id]).filter((m) => m.from === inbound);
    if (!mvs.length) return;
    const n = this.links[inbound].lanes;
    for (let lane = 1; lane <= n; lane++) {
      if (mvs.some((m) => lane >= m.fromLanes[0] && lane <= m.fromLanes[1])) continue;
      let best = mvs[0];
      let bestD = Infinity;
      for (const m of mvs) {
        const d = lane < m.fromLanes[0] ? m.fromLanes[0] - lane : lane - m.fromLanes[1];
        const score = d + (m.turn === "S" ? 0 : 0.5);
        if (score < bestD) {
          bestD = score;
          best = m;
        }
      }
      best.fromLanes = [Math.min(best.fromLanes[0], lane), Math.max(best.fromLanes[1], lane)];
    }
  }

  /**
   * 한 도로가 곧게 여러 갈래로 나뉘면(램프가 오른쪽으로 빠지는 곳 등) 갈래마다 놓인 쪽의 차로에서 나간다:
   * 가장 왼쪽 갈래는 왼쪽 차로부터, 가장 오른쪽 갈래는 오른쪽 차로까지, 가운데는 그 사이
   */
  private splitLanes(j: Junction, inbound: number) {
    const straight = j.movements.map((id) => this.movements[id]).filter((m) => m.from === inbound && m.turn === "S");
    if (straight.length < 2) return;
    straight.sort((a, b) => b.angle - a.angle);
    const n = this.links[inbound].lanes;
    straight.forEach((m, rank) => {
      const k = m.fromLanes[1] - m.fromLanes[0] + 1;
      const first = 1 + Math.round((rank / (straight.length - 1)) * (n - k));
      m.fromLanes = [first, first + k - 1];
    });
  }

  /** 링크에서 나갈 수 있는 이동 */
  movementsFrom(link: number): Movement[] {
    const l = this.links[link];
    if (l.to < 0) return [];
    return this.junctions[l.to].movements.map((id) => this.movements[id]).filter((m) => m.from === link);
  }

  /**
   * 링크 끝(atEnd) 또는 시작에서 교차로 쪽으로 잘라낼 거리: 그 점에서 만나는 다른 도로(방향이 30° 넘게 다른 것) 폭 절반 중 가장 넓은 것
   * + 여유 + 횡단보도 + 정지선 앞 간격. 갈라지기·합치기만 하는 곳은 짧게, 교차로가 아닌 끝은 0.
   */
  private cutDist(l: Link, atEnd: boolean): number {
    const g = this.graph;
    const node = atEnd ? l.toNode : l.fromNode;
    const jid = this.nodeJunction[node];
    if (jid < 0) return 0;
    const j = this.junctions[jid];
    const cap = l.length * 0.42;
    if (j.minor) return Math.min(MINOR_CUT, cap);
    const own = new Set(l.edges.map((d) => d.edge));
    const axis = atEnd ? l.headIn : l.headOut;
    let half = 0;
    for (const id of g.nodes[node].edges) {
      if (own.has(id)) continue;
      const e = g.edges[id];
      // 그 점에서 나가는 방향
      const p = e.pts;
      const fromA = e.a === node;
      const n = p.length / 2;
      const i0 = fromA ? 0 : n - 1;
      const i1 = fromA ? 1 : n - 2;
      const h = Math.atan2(p[2 * i1 + 1] - p[2 * i0 + 1], p[2 * i1] - p[2 * i0]);
      const rel = Math.abs(wrapAngle(h - axis));
      const skew = Math.min(rel, Math.PI - rel);
      if (skew < (30 * Math.PI) / 180) continue;
      half = Math.max(half, halfSpan(e) / Math.max(0.5, Math.sin(skew)));
    }
    if (half === 0) return Math.min(MINOR_CUT, cap);
    return Math.max(3, Math.min(cap, half + XWALK_GAP + CROSSWALK + STOP_GAP));
  }

  // ---------------- 모양 ----------------

  /** 링크 모양 (처음 부를 때 만든다) */
  geom(id: number): LinkGeom {
    const have = this.geoms.get(id);
    if (have) return have;
    const l = this.links[id];
    const g = this.graph;
    const raw = this.rawPoly(l);
    const rawCum = cumLengths(raw);
    const L = rawCum[rawCum.length - 1];
    const res = resample(raw, GEOM_STEP);
    const n = res.length / 2;
    // 점마다 옮길 거리 (왕복 도로는 오른쪽으로 차도 가운데까지). 바뀌는 곳은 ±12m로 부드럽게
    const off = new Float64Array(n);
    const z = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const u = (L * k) / Math.max(1, n - 1);
      const sp = l.spans.find((x) => u <= x.u1 + 1e-6) ?? l.spans[l.spans.length - 1];
      off[k] = sp.twoWay ? twoWayOffset(sp.lanes) : 0;
      // 높이: 토막의 높이 굴곡 (없으면 양 끝 교차점 높이 사이를 곧게)
      const e = g.edges[sp.edge];
      const d = l.edges.find((x) => x.edge === sp.edge)!;
      const t = Math.max(0, Math.min(1, sp.u1 > sp.u0 ? (u - sp.u0) / (sp.u1 - sp.u0) : 0));
      z[k] = g.edgeZ(e, (d.fwd ? t : 1 - t) * e.length);
    }
    const w = Math.round(12 / GEOM_STEP);
    // 양 끝으로 갈수록 창을 양쪽 같게 줄인다 (한쪽만 잘린 창은 끝 높이를 안쪽으로 끌어 교차점에서 이웃 링크와 층이 진다)
    const smooth = (src: Float64Array, win: number) => {
      const out = new Float64Array(src.length);
      for (let k = 0; k < src.length; k++) {
        let sum = 0;
        let cnt = 0;
        const r = Math.min(win, k, src.length - 1 - k);
        for (let q = k - r; q <= k + r; q++) {
          sum += src[q];
          cnt++;
        }
        out[k] = sum / cnt;
      }
      return out;
    };
    const pts = offsetPoly(res, smooth(off, w));
    const cum = cumLengths(pts);
    const geo: LinkGeom = { pts, cum, z: smooth(z, Math.round(20 / GEOM_STEP)), length: cum[cum.length - 1], scale: cum[cum.length - 1] / Math.max(1, L) };
    this.geoms.set(id, geo);
    return geo;
  }

  /** 링크 위 u(OSM 거리) 자리 (차도 가운데) */
  pointOnLink(id: number, u: number, out?: PolyPoint): PolyPoint & { z: number } {
    const geo = this.geom(id);
    const s = u * geo.scale;
    const p = pointAt(geo.pts, geo.cum, s, out) as PolyPoint & { z: number };
    const f = Math.max(0, Math.min(geo.z.length - 1, (s / Math.max(1e-6, geo.length)) * (geo.z.length - 1)));
    const i = Math.floor(f);
    p.z = geo.z[i] + (geo.z[Math.min(i + 1, geo.z.length - 1)] - geo.z[i]) * (f - i);
    return p;
  }

  /** u 위치의 구간 (차로 수·제한속도·이름) */
  spanAt(id: number, u: number): LinkSpan {
    const l = this.links[id];
    return l.spans.find((x) => u <= x.u1 + 1e-6) ?? l.spans[l.spans.length - 1];
  }

  /** 교차로 바닥 (그림과 차가 같은 높이를 쓴다). 접근로가 모자라면 null */
  junctionSurface(jid: number): JunctionSurface | null {
    if (this.surfaces.has(jid)) return this.surfaces.get(jid)!;
    const j = this.junctions[jid];
    const pts: [number, number, number][] = [];
    const q: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 };
    const add = (lid: number, inbound: boolean) => {
      const l = this.links[lid];
      const u = inbound ? l.length - l.stopDist : l.startDist;
      const p = this.pointOnLink(lid, u, q);
      const w = this.spanAt(lid, u).lanes * CITY_LANE;
      const left = -w / 2 - 0.3;
      const right = w / 2 + 0.25;
      pts.push([p.x + p.ty * left, p.y - p.tx * left, p.z], [p.x + p.ty * right, p.y - p.tx * right, p.z]);
    };
    for (const id of j.inbound) add(id, true);
    for (const id of j.outbound) add(id, false);
    let sf: JunctionSurface | null = null;
    if (pts.length >= 3) {
      const [a, gx, gy] = fitPlane(pts);
      const cx = pts.reduce((m, h) => m + h[0], 0) / pts.length;
      const cy = pts.reduce((m, h) => m + h[1], 0) / pts.length;
      const C: [number, number, number] = [cx, cy, a + gx * cx + gy * cy];
      // 모서리들과 가운데를 겹침 없이 삼각형으로 잇는다 (바닥이 두 겹이면 높은 쪽이 차를 덮는다). 겹친 점은 하나로
      const uniq: [number, number, number][] = [];
      for (const p of [C, ...pts]) if (!uniq.some((u) => Math.hypot(p[0] - u[0], p[1] - u[1]) < 0.05)) uniq.push(p);
      const tris = delaunay(uniq);
      const zs = pts.map((p) => p[2]);
      if (tris.length) sf = { tris, cx, cy, cz: C[2], zLo: Math.min(...zs), zHi: Math.max(...zs) };
    }
    this.surfaces.set(jid, sf);
    return sf;
  }

  /** (x, y)가 교차로 바닥 위인지 (가장자리 10cm까지) */
  onJunction(sf: JunctionSurface, x: number, y: number): boolean {
    for (const [a, b, c] of sf.tris) {
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
      const l2 = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
      if (Math.min(1 - l1 - l2, l1, l2) * Math.sqrt(Math.abs(det)) >= -0.1) return true;
    }
    return false;
  }

  /** 교차로 바닥 높이 (바닥 밖은 가장 가까운 삼각형 평면을 늘여서) */
  junctionZ(sf: JunctionSurface, x: number, y: number): number {
    let best = -Infinity;
    let z = sf.cz;
    for (const [a, b, c] of sf.tris) {
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / det;
      const l2 = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / det;
      const l0 = 1 - l1 - l2;
      const inside = Math.min(l0, l1, l2);
      if (inside > best) {
        best = inside;
        z = l0 * a[2] + l1 * b[2] + l2 * c[2];
        if (inside >= -1e-9) break;
      }
    }
    return z;
  }

  /**
   * 이동 경로: 들어오는 링크 정지선에서 나가는 링크 시작까지 부드러운 곡선 (양 끝 포함, 약 1m 간격).
   * dFrom·dTo: 차도 가운데에서 오른쪽으로 옮긴 거리 (차로 하나를 따라갈 때)
   */
  movementPath(mvId: number, dFrom = 0, dTo = 0): { pts: Poly; cum: Float64Array; z: Float64Array } {
    const key = `${mvId}|${dFrom.toFixed(2)}|${dTo.toFixed(2)}`;
    const have = this.paths.get(key);
    if (have) return have;
    const mv = this.movements[mvId];
    const a = this.links[mv.from];
    const b = this.links[mv.to];
    const pa = this.pointOnLink(a.id, a.length - a.stopDist);
    const pb = this.pointOnLink(b.id, b.startDist);
    const p0 = { e: pa.x + pa.ty * dFrom, n: pa.y - pa.tx * dFrom, z: pa.z, te: pa.tx, tn: pa.ty };
    const p1 = { e: pb.x + pb.ty * dTo, n: pb.y - pb.tx * dTo, z: pb.z, te: pb.tx, tn: pb.ty };
    const mid = connector(p0, p1, 1);
    const n = mid.length + 2;
    const pts = new Float64Array(n * 2);
    const z = new Float64Array(n);
    const all = [p0, ...mid, p1];
    // 큰 교차로는 그린 바닥 높이를 따라간다 (갈라지기·합치기만 하는 곳은 두 끝 사이를 곧게)
    const sf = this.junctions[mv.junction].minor ? null : this.junctionSurface(mv.junction);
    all.forEach((p, i) => {
      pts[2 * i] = p.e;
      pts[2 * i + 1] = p.n;
      z[i] = sf && i > 0 && i < all.length - 1 ? this.junctionZ(sf, p.e, p.n) : p.z;
    });
    const out = { pts, cum: cumLengths(pts), z };
    this.paths.set(key, out);
    return out;
  }

  /** 교차로에 들어오는 링크들을 방향이 비슷한 것끼리 묶은 접근로 (신호 순서용). 시계 방향 순 */
  approaches(jid: number): number[][] {
    const j = this.junctions[jid];
    const groups: { head: number; links: number[] }[] = [];
    for (const id of j.inbound) {
      const l = this.links[id];
      const g = groups.find((x) => Math.abs(wrapAngle(x.head - l.headIn)) < (40 * Math.PI) / 180);
      if (g) g.links.push(id);
      else groups.push({ head: l.headIn, links: [id] });
    }
    // 시계 방향 (방위각 순)
    groups.sort((x, y) => wrapAngle(Math.PI / 2 - x.head) - wrapAngle(Math.PI / 2 - y.head));
    return groups.map((x) => x.links);
  }
}

/** 들로네 삼각분할: 점들의 볼록 껍질을 겹침 없이 덮는 반시계 삼각형들 (점이 몇십 개뿐이라 하나씩 넣는다) */
export function delaunay(ps: [number, number, number][]): [number, number, number][][] {
  const n = ps.length;
  if (n < 3) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ps) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const big = Math.max(x1 - x0, y1 - y0, 1) * 50;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const P: number[][] = [...ps, [mx - big, my - big], [mx + big, my - big], [mx, my + big]];
  const ccw = (a: number, b: number, c: number) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
  const tri = (a: number, b: number, c: number): number[] => (ccw(a, b, c) >= 0 ? [a, b, c] : [a, c, b]);
  // (x, y)가 반시계 삼각형의 외접원 안인지
  const inCircle = ([a, b, c]: number[], x: number, y: number) => {
    const ax = P[a][0] - x;
    const ay = P[a][1] - y;
    const bx = P[b][0] - x;
    const by = P[b][1] - y;
    const cx = P[c][0] - x;
    const cy = P[c][1] - y;
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 0;
  };
  let tris: number[][] = [[n, n + 1, n + 2]];
  for (let i = 0; i < n; i++) {
    const [x, y] = P[i];
    const bad = tris.filter((t) => inCircle(t, x, y));
    const edges = new Map<string, [number, number]>();
    for (const t of bad) {
      for (let k = 0; k < 3; k++) {
        const u = t[k];
        const v = t[(k + 1) % 3];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [u, v]);
      }
    }
    tris = tris.filter((t) => !bad.includes(t));
    for (const [u, v] of edges.values()) tris.push(tri(u, v, i));
  }
  return tris.filter((t) => t.every((k) => k < n) && ccw(t[0], t[1], t[2]) > 1e-6).map((t) => t.map((k) => ps[k]));
}

/** 점들에 가장 잘 맞는 평면 z = a + b·x + c·y (최소제곱). 점이 한 줄로 서 있으면 평평하게 */
export function fitPlane(p: [number, number, number][]): [number, number, number] {
  const n = p.length;
  const mx = p.reduce((m, q) => m + q[0], 0) / n;
  const my = p.reduce((m, q) => m + q[1], 0) / n;
  const mz = p.reduce((m, q) => m + q[2], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  for (const [x, y, z] of p) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxz += dx * (z - mz);
    syz += dy * (z - mz);
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-6) return [mz, 0, 0];
  const b = (sxz * syy - syz * sxy) / det;
  const c = (syz * sxx - sxz * sxy) / det;
  return [mz - b * mx - c * my, b, c];
}
