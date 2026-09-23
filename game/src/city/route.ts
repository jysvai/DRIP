// 시내 경로: 두 곳 사이 길을 찾고(A*), 지나는 링크와 교차로 이동을 이어 한 줄 도로(RoadFile)로 만든다.
// 이어 붙인 도로는 고속도로 경로와 같은 방식으로 게임이 달린다: 링크가 조각(leg), 교차로 안 곡선이 연결로.
// 시내에만 있는 것(반대편 차로·중앙선·교차로 구간·정지선)은 RoadFile.city에 넣는다.

import type { LegInfo, RoadFile } from "../road/road";
import { Structure } from "../road/road";
import type { CityGraph, CityPlace, RoadClass } from "./graph";
import { cumLengths, pointAt, type PolyPoint } from "./geom";
import { CENTER_GAP, CITY_LANE, type CityNet, type Turn } from "./net";

type Run<T> = [number, T];

/** 시내 경로 계획 */
export interface CityRoutePlan {
  region: string;
  from: { name: string; x: number; y: number };
  to: { name: string; x: number; y: number };
  links: number[];
  /** 링크 사이 교차로 이동 (links.length - 1개) */
  movements: number[];
  /** 첫 링크의 출발 위치, 마지막 링크의 도착 위치 (u) */
  u0: number;
  u1: number;
  lengthM: number;
  timeS: number;
  /** 지나는 신호 교차로 수 */
  signals: number;
  turns: number;
}

/** 경로 위 정지선 (신호가 없는 교차로도) */
export interface CityStop {
  /** 정지선 위치 (s) */
  s: number;
  /** 교차로를 벗어나는 곳 (s) */
  sExit: number;
  junction: number;
  movement: number;
  link: number;
  turn: Turn;
  /** 이 방향으로 갈 수 있는 차로 (1 = 가장 왼쪽), 양 끝 포함 */
  lanes: [number, number];
  signal: boolean;
  name: string;
  /** 다음 도로 이름 */
  toName: string;
}

export interface CityInfo {
  region: string;
  laneWidth: number;
  /** 반대 방향 차로 수 (0: 일방통행) */
  oppLanes: Run<number>[];
  /** 우리 차도 왼쪽 끝에서 반대편 차도까지 (m) */
  median: Run<number>[];
  /** 0: 칠한 중앙선(넘을 수 있다), 1: 연석으로 쌓은 분리대 */
  medianKind: Run<number>[];
  /** 교차로 안 구간 [s0, s1, 교차로] (갈라지기·합치기 곳 포함) */
  /** 교차로 곡선 구간 [s0, s1, 교차로 번호, 갈라지기·합치기만 하는 곳이면 1] */
  boxes: [number, number, number, number][];
  stops: CityStop[];
  /**
   * 경로가 모든 차로로 이어지지 않는 교차로·갈림길 [교차로 곡선 시작 s, 경로로 가는 차로 lo, hi].
   * 도는 곳뿐 아니라 직진인데 오른쪽 차로가 다른 길로 갈라지는 곳도 (예: 3차로 중 1차로만 이어지는 갈림길)
   */
  keep?: [number, number, number][];
  /** 반대편 차도가 경로 차도보다 높은 만큼 [s, m] (분리대로 떨어진 상·하행). 반대편 차를 그 높이에 그린다 */
  oppDz?: [number, number][];
  /** 교차로 바닥이 옆으로 가며 달라지는 높이 [s, 왼쪽 6m, 왼쪽 3m, 오른쪽 3m, 오른쪽 6m (가운데보다 높은 만큼)]. 교차로 밖은 0 */
  side?: [number, number, number, number, number][];
  /** 경로 위 링크 자리 [s0, s1, 링크, u0, u1]: s0~s1이 그 링크의 u0~u1 */
  links: [number, number, number, number, number][];
}

/** 길 찾기에 쓰지 않는 도로: 도시고속도로와 그 연결로 (시내는 자동차전용도로 연결로도) */
const FORBIDDEN = new Set<RoadClass>(["m", "ml"]);
/**
 * 시내: 자동차전용도로(올림픽대로 등)는 시내 운전 연습에 맞지 않아 되도록 피한다.
 * 국도 지역에서는 그 길(6번 국도 등)이 바로 달려 볼 국도라 그대로 쓴다
 */
const CITY_CLASS_TIME: Partial<Record<RoadClass, number>> = { t: 2.5 };
const TURN_SEC: Record<Turn, number> = { S: 2, R: 8, L: 20 };
const SIGNAL_SEC = 15;
const SNAP_RADIUS = 450;
/** 가까이 큰길이 없을 때 찾는 거리 */
const SNAP_FAR = 1500;

export function routable(cls: RoadClass, rural = false): boolean {
  return !FORBIDDEN.has(cls) && (rural || cls !== "tl");
}

interface Snap {
  link: number;
  u: number;
  dist: number;
}

/**
 * 출발·도착을 붙일 수 있는 링크. 서로 오갈 수 있는 가장 큰 묶음(강한 연결 요소)으로 나갈 수 있어야 출발(leave),
 * 그 묶음에서 들어올 수 있어야 도착(reach). 지역 경계에서 잘린 도로 조각이나 한 방향 막다른 길에 붙이면 길을 찾지 못한다
 * (예: 경기 동부의 위례·광나루한강공원). 막다른 산골 길(용문사)은 끝에서 돌 수 없어 묶음 밖이지만 들어가고 나올 수 있다
 */
const reachCache = new WeakMap<CityNet, { leave: Uint8Array; reach: Uint8Array }>();
export function snapLinks(net: CityNet): { leave: Uint8Array; reach: Uint8Array } {
  const have = reachCache.get(net);
  if (have) return have;
  const main = mainLinks(net);
  const L = net.links.length;
  const rural = net.graph.kind === "rural";
  const back: number[][] = Array.from({ length: L }, () => []);
  for (let i = 0; i < L; i++) {
    if (!routable(net.links[i].cls, rural)) continue;
    for (const m of net.movementsFrom(i)) if (routable(net.links[m.to].cls, rural)) back[m.to].push(i);
  }
  const spread = (fwd: boolean) => {
    const seen = Uint8Array.from(main);
    const todo: number[] = [];
    for (let i = 0; i < L; i++) if (main[i]) todo.push(i);
    while (todo.length) {
      const i = todo.pop()!;
      const nxt = fwd ? net.movementsFrom(i).map((m) => m.to) : back[i];
      for (const j of nxt) {
        if (seen[j] || !routable(net.links[j].cls, rural)) continue;
        seen[j] = 1;
        todo.push(j);
      }
    }
    return seen;
  };
  const out = { leave: spread(false), reach: spread(true) };
  reachCache.set(net, out);
  return out;
}

const mainCache = new WeakMap<CityNet, Uint8Array>();
/** 길찾기 링크 가운데 서로 오갈 수 있는 가장 큰 묶음 (강한 연결 요소) */
export function mainLinks(net: CityNet): Uint8Array {
  const have = mainCache.get(net);
  if (have) return have;
  const L = net.links.length;
  const rural = net.graph.kind === "rural";
  const ok = (i: number) => routable(net.links[i].cls, rural);
  const next = (i: number) => net.movementsFrom(i).map((m) => m.to).filter(ok);
  // 타잔 (되부름 없이)
  const index = new Int32Array(L).fill(-1);
  const low = new Int32Array(L);
  const onStack = new Uint8Array(L);
  const comp = new Int32Array(L).fill(-1);
  const stack: number[] = [];
  const size: number[] = [];
  let counter = 0;
  for (let root = 0; root < L; root++) {
    if (index[root] >= 0 || !ok(root)) continue;
    const work: [number, number[], number][] = [[root, next(root), 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, out] = top;
      if (top[2] < out.length) {
        const w = out[top[2]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, next(w), 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] === index[v]) {
        const c = size.length;
        let n = 0;
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = c;
          n++;
          if (w === v) break;
        }
        size.push(n);
      }
    }
  }
  let big = 0;
  for (let c = 1; c < size.length; c++) if (size[c] > size[big]) big = c;
  const main = new Uint8Array(L);
  for (let i = 0; i < L; i++) main[i] = comp[i] === big && size.length ? 1 : 0;
  mainCache.set(net, main);
  return main;
}

/**
 * 장소에서 가까운 링크 자리 몇 곳 (양방향·중앙분리 도로 양쪽). 출발(leave)·도착(reach)으로 쓸 수 있는 링크만.
 * 자동차전용·간선(t)은 1.5km 안에 다른 길이 없을 때만 (국도 지역의 역은 국도 옆에 있기도 하다: 국수역)
 */
function snaps(net: CityNet, x: number, y: number, role: "leave" | "reach", radius = SNAP_RADIUS, allowT = false): Snap[] {
  const g = net.graph;
  const out: Snap[] = [];
  const main = snapLinks(net)[role];
  const cand = g.edgesIn(x - radius, y - radius, x + radius, y + radius);
  let best = Infinity;
  const found: { edge: number; u: number; dist: number }[] = [];
  for (const id of cand) {
    const e = g.edges[id];
    if (!routable(e.cls, g.kind === "rural") || (e.cls === "t" && !allowT) || e.cls.endsWith("l")) continue;
    if (!main[net.dirLink[id * 2]] && !main[net.dirLink[id * 2 + 1]]) continue;
    const r = g.nearestEdge(x, y, radius, (f) => f.id === id);
    if (!r) continue;
    found.push({ edge: id, u: r.u, dist: r.dist });
    best = Math.min(best, r.dist);
  }
  // 가장 가까운 것에서 60m 안의 토막들 (길 건너 반대 방향 차도까지)
  for (const f of found.sort((a, b) => a.dist - b.dist)) {
    if (f.dist > best + 60 || out.length >= 6) break;
    const e = g.edges[f.edge];
    for (const fwd of [true, false]) {
      const lid = net.dirLink[f.edge * 2 + (fwd ? 0 : 1)];
      if (lid < 0 || !main[lid]) continue;
      const l = net.links[lid];
      const sp = l.spans.find((s) => s.edge === f.edge)!;
      const u = sp.u0 + (fwd ? f.u : e.length - f.u);
      if (!out.some((o) => o.link === lid)) out.push({ link: lid, u, dist: f.dist });
    }
  }
  // 국도 지역의 명소는 큰길에서 멀 수 있다 (예: 두물머리는 좁은 마을길 끝)
  if (!out.length && radius < SNAP_FAR) return snaps(net, x, y, role, SNAP_FAR, allowT);
  if (!out.length && !allowT) return snaps(net, x, y, role, SNAP_RADIUS, true);
  return out;
}

const placeCache = new WeakMap<CityNet, Map<string, boolean>>();
/** 차로 가고 나올 수 있는 곳인지 (산봉우리·지역 밖으로만 이어진 동네는 찾기 목록에서 뺀다) */
export function drivable(net: CityNet, p: { name: string; x: number; y: number }): boolean {
  let m = placeCache.get(net);
  if (!m) placeCache.set(net, (m = new Map()));
  const key = `${p.name}|${Math.round(p.x)}|${Math.round(p.y)}`;
  let ok = m.get(key);
  if (ok === undefined) m.set(key, (ok = snaps(net, p.x, p.y, "leave").length > 0 && snaps(net, p.x, p.y, "reach").length > 0));
  return ok;
}

function linkSpeed(net: CityNet, id: number): number {
  const l = net.links[id];
  const kmh = Math.max(20, l.speed) * 0.8;
  return kmh / 3.6 / ((net.graph.kind === "rural" ? 1 : CITY_CLASS_TIME[l.cls]) ?? 1);
}

/** 두 곳 사이 가장 빠른 길 (시내 도로만). 못 찾으면 null */
export function findCityRoute(net: CityNet, from: CityPlace | { name: string; x: number; y: number }, to: CityPlace | { name: string; x: number; y: number }): CityRoutePlan | null {
  const starts = snaps(net, from.x, from.y, "leave");
  const goals = snaps(net, to.x, to.y, "reach");
  if (!starts.length || !goals.length) return null;
  const L = net.links.length;
  const rural = net.graph.kind === "rural";
  // 상태: 링크에 들어선 순간 (u=0). 출발 링크는 출발 자리에서
  const dist = new Float64Array(L).fill(Infinity);
  const prev = new Int32Array(L).fill(-1);
  const prevMv = new Int32Array(L).fill(-1);
  const entryU = new Float64Array(L);
  const startOf = new Map<number, Snap>();
  const goalOf = new Map<number, Snap>();
  for (const g of goals) goalOf.set(g.link, g);
  // 남은 거리를 가장 빠른 속도로 간다고 본 시간 (국도 90km/h 구간보다 빠르게 잡아야 가장 빠른 길을 놓치지 않는다)
  const vmax = 100 / 3.6;
  const h = (id: number) => {
    const l = net.links[id];
    const p = net.graph.nodes[l.toNode];
    return Math.hypot(p.x - to.x, p.y - to.y) / vmax;
  };
  const heap: [number, number][] = [];
  const push = (f: number, i: number) => {
    heap.push([f, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  for (const s of starts) {
    if (!routable(net.links[s.link].cls, rural)) continue;
    const g0 = s.dist / 5; // 출발점에서 먼 도로는 조금 덜 좋게
    if (g0 < dist[s.link]) {
      dist[s.link] = g0;
      entryU[s.link] = s.u;
      startOf.set(s.link, s);
      push(g0 + h(s.link), s.link);
    }
  }
  const GOAL = -2;
  let goalCost = Infinity;
  let goalLink = -1;
  const done = new Uint8Array(L);
  while (heap.length) {
    const [f, i] = pop();
    if (f >= goalCost) break;
    if (i === GOAL || done[i]) continue;
    done[i] = 1;
    const l = net.links[i];
    const v = linkSpeed(net, i);
    const g0 = dist[i];
    const u0 = entryU[i];
    // 이 링크 위에 도착점이 있으면
    const goal = goalOf.get(i);
    if (goal && goal.u >= u0 - 1) {
      const c = g0 + Math.max(0, goal.u - u0) / v + goal.dist / 5;
      if (c < goalCost) {
        goalCost = c;
        goalLink = i;
      }
    }
    const through = g0 + Math.max(0, l.length - u0) / v;
    for (const mv of net.movementsFrom(i)) {
      const next = mv.to;
      if (!routable(net.links[next].cls, rural)) continue;
      const j = net.junctions[mv.junction];
      const pen = j.minor ? 0 : TURN_SEC[mv.turn] + (j.signal ? SIGNAL_SEC : 3);
      const tun = net.links[next].spans.some((s) => s.tunnel) ? 20 : 0;
      const nd = through + pen + tun;
      if (nd < dist[next] && !startOf.has(next)) {
        dist[next] = nd;
        prev[next] = i;
        prevMv[next] = mv.id;
        entryU[next] = 0;
        push(nd + h(next), next);
      }
    }
  }
  if (goalLink < 0) return null;
  const links: number[] = [];
  const movements: number[] = [];
  for (let i = goalLink; i >= 0; i = prev[i]) {
    links.unshift(i);
    if (prevMv[i] >= 0) movements.unshift(prevMv[i]);
  }
  const s0 = startOf.get(links[0])!;
  const g1 = goalOf.get(goalLink)!;
  let lengthM = 0;
  let signals = 0;
  let turns = 0;
  links.forEach((id, k) => {
    const l = net.links[id];
    const a = k === 0 ? s0.u : 0;
    const b = k === links.length - 1 ? g1.u : l.length;
    lengthM += Math.max(0, b - a);
  });
  for (const m of movements) {
    const mv = net.movements[m];
    const j = net.junctions[mv.junction];
    if (j.signal) signals++;
    if (!j.minor && mv.turn !== "S") turns++;
  }
  return {
    region: net.graph.region,
    from: { name: from.name, x: from.x, y: from.y },
    to: { name: to.name, x: to.x, y: to.y },
    links,
    movements,
    u0: s0.u,
    u1: g1.u,
    lengthM,
    timeS: goalCost,
    signals,
    turns,
  };
}

// ---------------- 한 줄 도로로 ----------------

const STEP = 2;

interface Pt {
  x: number;
  y: number;
  z: number;
}

/** 경로의 도로 이름 (없으면 등급 이름) */
function streetName(name: string, cls: RoadClass): string {
  if (name) return name;
  return cls.startsWith("p") ? "대로" : cls.startsWith("s") ? "시내 도로" : cls.startsWith("t") ? "자동차전용도로" : "이면도로";
}

/**
 * 경로를 한 줄 도로로. 링크는 정지선까지(첫 링크는 출발 자리부터, 마지막 링크는 도착 자리까지),
 * 교차로 안은 CityNet.movementPath 곡선으로 잇고, 전체를 2m 간격으로 다시 뽑는다.
 */
export function cityRoadFile(net: CityNet, plan: CityRoutePlan): { file: RoadFile; finishS: number } {
  const g: CityGraph = net.graph;
  const [ox, oy] = g.origin;
  // 1) 점들과 점마다 붙일 값 (조각 번호: 링크는 k, 교차로는 -1-k)
  const pts: Pt[] = [];
  const tag: number[] = [];
  const q: PolyPoint & { z?: number } = { x: 0, y: 0, tx: 1, ty: 0 };
  const cuts: { a: number; b: number }[] = [];
  const add = (p: Pt, t: number) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.2) {
      tag[tag.length - 1] = t;
      return;
    }
    pts.push(p);
    tag.push(t);
  };
  plan.links.forEach((id, k) => {
    const l = net.links[id];
    let a = k === 0 ? plan.u0 : l.startDist;
    let b = k === plan.links.length - 1 ? plan.u1 : l.length - l.stopDist;
    if (b < a + 1) {
      const mid = (a + b) / 2;
      a = Math.max(0, mid - 0.5);
      b = Math.min(l.length, mid + 0.5);
    }
    cuts.push({ a, b });
    const geo = net.geom(id);
    const sa = a * geo.scale;
    const sb = b * geo.scale;
    const n = Math.max(1, Math.ceil((sb - sa) / 1));
    for (let i = 0; i <= n; i++) {
      const s = sa + ((sb - sa) * i) / n;
      pointAt(geo.pts, geo.cum, s, q);
      const f = Math.max(0, Math.min(geo.z.length - 1, (s / Math.max(1e-6, geo.length)) * (geo.z.length - 1)));
      const zi = Math.floor(f);
      const z = geo.z[zi] + (geo.z[Math.min(zi + 1, geo.z.length - 1)] - geo.z[zi]) * (f - zi);
      add({ x: q.x, y: q.y, z }, k);
    }
    if (k < plan.movements.length) {
      const path = net.movementPath(plan.movements[k]);
      const m = path.pts.length / 2;
      for (let i = 1; i < m - 1; i++) add({ x: path.pts[2 * i], y: path.pts[2 * i + 1], z: path.z[i] }, -1 - k);
    }
  });

  // 2) 2m 간격으로 다시 뽑기
  const flat = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => {
    flat[2 * i] = p.x;
    flat[2 * i + 1] = p.y;
  });
  const cum = cumLengths(flat);
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.round(total / STEP) + 1);
  const step = total / (n - 1);
  const out: Pt[] = [];
  const outTag: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const t = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    const tt = Math.max(0, Math.min(1, t));
    out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * tt, y: pts[j].y + (pts[j + 1].y - pts[j].y) * tt, z: pts[j].z + (pts[j + 1].z - pts[j].z) * tt });
    outTag.push(tt < 0.5 ? tag[j] : tag[j + 1]);
  }
  // 높이는 ±2m로만 살짝 고른다 (교차로 바닥과 링크가 만나는 꺾임). 더 넓게 고르면 비탈 꼭대기에서 차가 그린 길보다 가라앉는다
  const zs = out.map((p) => p.z);
  const W = 1;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) {
      sum += zs[k];
      cnt++;
    }
    out[i].z = sum / cnt;
  }

  // 반대편 차도 높이 차: 분리대로 떨어진 상·하행(짝 있는 일방) 차도는 높이가 따로라 20m마다 건너편 차도를 찾아 잰다
  const oppDz: [number, number][] = [];
  for (let i = 0; i < n; i += 10) {
    let dz = 0;
    if (outTag[i] >= 0) {
      const p = out[i];
      const a = out[Math.max(0, i - 1)];
      const b = out[Math.min(n - 1, i + 1)];
      const hl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const tx = (b.x - a.x) / hl;
      const ty = (b.y - a.y) / hl;
      const own = net.graph.nearestEdge(p.x, p.y, 4);
      if (own && own.edge.oneway && own.edge.sep > 0) {
        // 건너편 차도 가운데: 왼쪽으로 sep
        const qx = p.x - ty * own.edge.sep;
        const qy = p.y + tx * own.edge.sep;
        const other = net.graph.nearestEdge(qx, qy, 6, (e) => e.oneway && e.id !== own.edge.id && !e.bridge === !own.edge.bridge);
        if (other) {
          const lid = net.dirLink[other.edge.id * 2];
          const sp = lid >= 0 ? net.links[lid].spans.find((x) => x.edge === other.edge.id) : undefined;
          if (sp) {
            const o = net.pointOnLink(lid, sp.u0 + other.u, q);
            // 건너편이 반대로 가는 차도일 때만
            if (o.tx * tx + o.ty * ty < -0.5) dz = o.z - p.z;
          }
        }
      }
    }
    oppDz.push([i * step, Math.round(dz * 100) / 100]);
  }

  // 교차로 바닥이 옆으로 가며 달라지는 높이 (비탈의 교차로에서 옆 차로 차가 바닥에 묻히거나 뜨지 않게)
  const side: [number, number, number, number, number][] = [];
  const zero = (s: number): [number, number, number, number, number] => [s, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const tg = outTag[i];
    if (tg >= 0) continue;
    const mvId = plan.movements[-1 - tg];
    const jn = mvId !== undefined ? net.movements[mvId].junction : -1;
    const sf = jn >= 0 && !net.junctions[jn].minor ? net.junctionSurface(jn) : null;
    if (!sf) continue;
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(n - 1, i + 1)];
    const hl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const rx = (b.y - a.y) / hl;
    const ry = -(b.x - a.x) / hl;
    const p = out[i];
    const zc = net.junctionZ(sf, p.x, p.y);
    const row = zero(i * step);
    for (const [near, far, sign] of [[2, 1, -1], [3, 4, 1]]) {
      // 바닥 밖으로 나가면 바로 안쪽 값을 그대로 쓴다 (바닥 밖을 늘려 짐작하면 크게 틀린다)
      let dz = 0;
      for (const [col, d] of [[near, 3], [far, 6]]) {
        const x = p.x + rx * d * sign;
        const y = p.y + ry * d * sign;
        if (net.onJunction(sf, x, y)) dz = net.junctionZ(sf, x, y) - zc;
        row[col] = Math.round(dz * 100) / 100;
      }
    }
    if (!side.length || side[side.length - 1][0] < i * step - step * 1.5) side.push(zero(Math.max(0, (i - 1) * step)));
    side.push(row);
    if (i + 1 >= n || outTag[i + 1] >= 0) side.push(zero(Math.min((n - 1) * step, (i + 1) * step)));
  }

  // 3) 조각별 s 범위
  const ranges = new Map<number, [number, number]>();
  outTag.forEach((t, i) => {
    const r = ranges.get(t);
    const s = i * step;
    if (!r) ranges.set(t, [s, s]);
    else r[1] = s;
  });

  // 4) 구간 값
  const lanes: Run<number>[] = [];
  const speed: Run<number>[] = [];
  const structure: Run<number>[] = [];
  const structureName: Run<string>[] = [];
  const sectionName: Run<string>[] = [];
  const oppLanes: Run<number>[] = [];
  const median: Run<number>[] = [];
  const medianKind: Run<number>[] = [];
  const legs: LegInfo[] = [];
  const boxes: [number, number, number, number][] = [];
  const stops: CityStop[] = [];
  const keep: [number, number, number][] = [];
  const linkMap: [number, number, number, number, number][] = [];
  plan.links.forEach((id, k) => {
    const l = net.links[id];
    const r = ranges.get(k) ?? [0, 0];
    const { a, b } = cuts[k];
    const sOf = (u: number) => r[0] + ((u - a) / Math.max(1e-6, b - a)) * (r[1] - r[0]);
    for (const sp of l.spans) {
      if (sp.u1 <= a || sp.u0 >= b) continue;
      const s = Math.max(r[0], sOf(sp.u0));
      lanes.push([s, sp.lanes]);
      speed.push([s, sp.speed]);
      structure.push([s, sp.tunnel ? Structure.Tunnel : sp.bridge ? Structure.Bridge : Structure.Normal]);
      structureName.push([s, ""]);
      sectionName.push([s, streetName(sp.name, sp.cls)]);
      if (sp.twoWay) {
        oppLanes.push([s, sp.lanes]);
        median.push([s, CENTER_GAP]);
        medianKind.push([s, 0]);
      } else if (sp.sep > 0) {
        const gap = Math.max(CENTER_GAP, sp.sep - sp.lanes * CITY_LANE);
        oppLanes.push([s, sp.lanes]);
        median.push([s, Math.round(gap * 10) / 10]);
        medianKind.push([s, gap > 4 ? 1 : 0]);
      } else {
        oppLanes.push([s, 0]);
        median.push([s, 0]);
        medianKind.push([s, 1]);
      }
    }
    linkMap.push([r[0], r[1], id, a, b]);
    const mvIn = k > 0 ? net.movements[plan.movements[k - 1]] : null;
    const jIn = mvIn ? net.junctions[mvIn.junction] : null;
    const next = k < plan.movements.length ? net.movements[plan.movements[k]] : null;
    const jNext = next ? net.junctions[next.junction] : null;
    legs.push({
      road: `L${id}`,
      ref: "",
      name: streetName(l.name, l.cls),
      from: jIn?.name ?? plan.from.name,
      to: jNext && !jNext.minor ? jNext.name || "교차로" : k === plan.links.length - 1 ? plan.to.name : "",
      s0: r[0],
      s1: r[1],
      src0: a,
      src1: b,
      via: jIn && !jIn.minor ? jIn.name || "교차로" : "",
    });
    if (next && jNext) {
      const box = ranges.get(-1 - k);
      const bs0 = r[1];
      const bs1 = box ? box[1] + step : r[1];
      const to = net.links[next.to];
      // 교차로 곡선: 들어오는 쪽 반은 들어오는 도로, 나가는 쪽 반은 나가는 도로의 차로 수·반대편
      // (차로 번호를 그대로 이어 가게: 1차로에서 좌회전하면 나가는 도로 1차로로)
      const mid = (bs0 + bs1) / 2;
      lanes.push([bs0, l.lanes]);
      lanes.push([mid, to.lanesStart]);
      // 교차로 안 제한속도는 들어온 도로와 나갈 도로 중 낮은 쪽 (회전 속도는 곡률로 알아서 줄인다)
      speed.push([bs0, Math.min(l.speed, to.speed)]);
      structure.push([bs0, Structure.Normal]);
      structureName.push([bs0, ""]);
      sectionName.push([bs0, jNext.minor ? streetName(l.name, l.cls) : jNext.name || `${streetName(to.name, to.cls)} 교차로`]);
      oppLanes.push([bs0, 0]);
      median.push([bs0, 0]);
      medianKind.push([bs0, 0]);
      boxes.push([bs0, bs1, jNext.id, jNext.minor ? 1 : 0]);
      if (next.fromLanes[0] > 1 || next.fromLanes[1] < l.lanes) keep.push([bs0, next.fromLanes[0], next.fromLanes[1]]);
      if (!jNext.minor) {
        stops.push({
          s: bs0,
          sExit: bs1,
          junction: jNext.id,
          movement: next.id,
          link: id,
          turn: next.turn,
          lanes: next.fromLanes,
          signal: jNext.signal,
          name: jNext.name,
          toName: streetName(to.name, to.cls),
        });
      }
    }
  });

  // 5) RoadFile (좌표는 1cm 단위: 2m 간격이라 0.1m로 자르면 점 간격이 3%씩 흔들린다)
  const q10 = out.map((p) => [Math.round((p.x + ox) * 100), Math.round((p.y + oy) * 100)]);
  const dx: number[] = [];
  const dy: number[] = [];
  for (let i = 1; i < q10.length; i++) {
    dx.push(q10[i][0] - q10[i - 1][0]);
    dy.push(q10[i][1] - q10[i - 1][1]);
  }
  const length = (n - 1) * step;
  // 도착: 마지막 링크의 도착 자리
  const lastRange = ranges.get(plan.links.length - 1) ?? [length, length];
  const file: RoadFile = {
    id: `city:${plan.region}:${plan.from.name}-${plan.to.name}`,
    ref: "",
    name: `${plan.from.name} → ${plan.to.name}`,
    from: plan.from.name,
    to: plan.to.name,
    length,
    step,
    origin: [q10[0][0] / 100, q10[0][1] / 100],
    unit: 0.01,
    dx,
    dy,
    zUnit: 0.001,
    z: out.map((p) => Math.round(p.z * 1000)),
    lanes: dedupe(lanes),
    speed: dedupe(speed),
    speedHgv: dedupe(speed),
    minSpeed: [[0, 0]],
    structure: dedupe(structure),
    structureName: dedupe(structureName),
    sectionName: dedupe(sectionName),
    junctions: [],
    terrain: { step: 20, offsets: [], rows: [] },
    refs: [[0, ""]],
    legs,
    city: {
      region: plan.region,
      laneWidth: CITY_LANE,
      oppLanes: dedupe(oppLanes),
      median: dedupe(median),
      medianKind: dedupe(medianKind),
      boxes,
      stops,
      keep,
      oppDz,
      side,
      links: linkMap,
    },
  };
  return { file, finishS: Math.min(length - 1, lastRange[1]) };
}

function dedupe<T>(runs: Run<T>[]): Run<T>[] {
  const sorted = runs.map((r, i) => [r, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]);
  const out: Run<T>[] = [];
  for (const [r] of sorted) {
    if (out.length && Math.abs(out[out.length - 1][0] - r[0]) < 1e-6) out[out.length - 1] = [out[out.length - 1][0], r[1]];
    else if (out.length && out[out.length - 1][1] === r[1]) continue;
    else out.push([Math.round(r[0] * 10) / 10, r[1]]);
  }
  if (out.length) out[0][0] = 0;
  return out;
}
