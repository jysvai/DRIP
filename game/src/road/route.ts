// 출발지·도착지로 전국 고속도로 경로를 찾고, 경로의 주행선 조각들을 JC 연결로로 이어 하나의 긴 도로(RoadFile)로 만든다.
// 도로망: public/roads/network.json (pipeline/network.py). 이어 붙인 도로는 게임의 물리·교통·그리기가 그대로 쓴다.

import type { LegInfo, RoadFile } from "./road";

type Run<T> = [number, T];

export interface NetRoad {
  id: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  length: number;
  speed: Run<number>[];
  /** 지도용 중심선: 원점에서 10m 단위 (x, y) 쌍, mapStep 간격 */
  p: number[];
  /** 나들목·분기점·휴게소 [s, 이름, 종류] */
  j: [number, string, string][];
}

export interface Transfer {
  a: string;
  sa: number;
  b: string;
  sb: number;
  name: string;
  kind: "JC" | "end" | "start";
}

export interface Network {
  origin: [number, number];
  mapStep: number;
  roads: NetRoad[];
  transfers: Transfer[];
}

/** 출발지·도착지로 고를 수 있는 곳 */
export interface Place {
  name: string;
  kind: "도시" | "IC" | "JC" | "TG" | "SA" | "기타";
  /** 이 이름이 있는 노선 이름들 (목록에 보여 줄 때) */
  roads: string[];
  /** 출발할 수 있는 위치 */
  starts: { road: string; s: number }[];
  /** 도착으로 칠 수 있는 위치 */
  ends: { road: string; s: number }[];
}

/** 경로의 한 조각: 주행선 road의 s0~s1을 달린다 */
export interface Leg {
  road: string;
  s0: number;
  s1: number;
  /** 이 조각으로 들어올 때 지난 JC 이름 (첫 조각은 "") */
  via: string;
}

export interface RoutePlan {
  from: Place;
  to: Place;
  legs: Leg[];
  lengthM: number;
  /** 제한속도로 달릴 때 걸리는 시간 (초) */
  timeS: number;
}

/** 갈아탄 뒤 새 주행선에서 이만큼 앞으로 들어간다 (연결로가 붙는 곳) */
const ENTRY_AFTER: Record<Transfer["kind"], number> = { JC: 450, end: 200, start: 200 };
/** 갈아탈 때 더하는 시간 (초): 연결로를 돌아 나가는 시간과, 여러 번 갈아타는 길보다 곧은 길을 좋아하게 */
const TRANSFER_PENALTY = 90;
const CONNECTOR_SPEED = 70 / 3.6;

export async function loadNetwork(base = "./roads/"): Promise<Network> {
  const res = await fetch(`${base}network.json`);
  if (!res.ok) throw new Error(`도로망을 불러오지 못했습니다 (${res.status})`);
  return (await res.json()) as Network;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** 이름 맞추기: "신갈분기점" = "신갈JC" = "신갈" */
export function baseName(name: string): string {
  return normalize(name).replace(/(ic|jct?|tg|분기점|나들목|요금소)$/, "");
}

/** 도시(주행선 끝 이름)와 나들목·분기점·휴게소 목록 */
export function buildPlaces(net: Network): Place[] {
  const map = new Map<string, Place>();
  const get = (name: string, kind: Place["kind"]) => {
    const key = `${kind === "도시" ? "도시" : "J"}:${kind === "도시" ? name : baseName(name) + (kind === "SA" ? "SA" : "")}`;
    let p = map.get(key);
    if (!p) {
      p = { name, kind, roads: [], starts: [], ends: [] };
      map.set(key, p);
    }
    return p;
  };
  for (const r of net.roads) {
    const from = get(r.from, "도시");
    from.starts.push({ road: r.id, s: 0 });
    if (!from.roads.includes(r.name)) from.roads.push(r.name);
    const to = get(r.to, "도시");
    to.ends.push({ road: r.id, s: r.length });
    if (!to.roads.includes(r.name)) to.roads.push(r.name);
    for (const [s, name, kind] of r.j) {
      if (kind === "기타") continue;
      const p = get(name, kind as Place["kind"]);
      // 휴게소는 방향마다 따로라 도착으로만 쓰고, 출발은 그 방향으로만
      p.starts.push({ road: r.id, s: Math.min(s, r.length - 1) });
      p.ends.push({ road: r.id, s });
      if (!p.roads.includes(r.name)) p.roads.push(r.name);
    }
  }
  // 끝 도시 이름은 그 근처 나들목으로도 도착할 수 있게: 도시 이름으로 시작하는 IC가 있으면 합친다
  const places = [...map.values()];
  for (const city of places.filter((p) => p.kind === "도시")) {
    for (const ic of places) {
      if (ic.kind === "IC" && baseName(ic.name) === city.name) {
        city.ends.push(...ic.ends);
        city.starts.push(...ic.starts);
      }
    }
  }
  const order: Record<Place["kind"], number> = { 도시: 0, IC: 1, JC: 2, TG: 3, SA: 4, 기타: 5 };
  return places.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, "ko"));
}

/** 이름으로 찾기: 앞부분이 맞는 것 먼저 */
export function searchPlaces(places: Place[], q: string, limit = 12): Place[] {
  const n = normalize(q);
  if (!n) return [];
  const scored: [number, Place][] = [];
  for (const p of places) {
    const pn = normalize(p.name);
    let score = -1;
    if (pn === n || baseName(p.name) === n) score = 0;
    else if (pn.startsWith(n)) score = 1;
    else if (pn.includes(n)) score = 2;
    else if (p.roads.some((r) => normalize(r).includes(n))) score = 4;
    if (score >= 0) scored.push([score + (p.kind === "도시" ? 0 : 0.5) + (p.kind === "SA" ? 1 : 0), p]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

function avgSpeed(r: NetRoad): number {
  let sum = 0;
  for (let i = 0; i < r.speed.length; i++) {
    const s0 = r.speed[i][0];
    const s1 = i + 1 < r.speed.length ? r.speed[i + 1][0] : r.length;
    sum += (s1 - s0) * r.speed[i][1];
  }
  return Math.max(60, sum / Math.max(1, r.length)) / 3.6;
}

interface Node {
  road: string;
  s: number;
  /** 이 점에서 나가는 연결 */
  out: { to: number; cost: number; via: string }[];
  dest: boolean;
}

/** 가장 빠른 경로 (다익스트라). 출발 위치 여러 곳 중 아무 데서나, 도착 위치 여러 곳 중 아무 데나 */
export function findRoute(net: Network, from: Place, to: Place): RoutePlan | null {
  const roads = new Map(net.roads.map((r) => [r.id, r]));
  const speed = new Map(net.roads.map((r) => [r.id, avgSpeed(r)]));
  const nodes: Node[] = [];
  const byRoad = new Map<string, number[]>();
  const add = (road: string, s: number, dest = false): number => {
    const r = roads.get(road);
    if (!r) return -1;
    const id = nodes.length;
    nodes.push({ road, s: Math.max(0, Math.min(r.length, s)), out: [], dest });
    let list = byRoad.get(road);
    if (!list) byRoad.set(road, (list = []));
    list.push(id);
    return id;
  };
  const starts = from.starts.map((p) => add(p.road, p.s)).filter((i) => i >= 0);
  for (const p of to.ends) add(p.road, p.s, true);
  for (const t of net.transfers) {
    const b = roads.get(t.b);
    if (!b) continue;
    const a = add(t.a, t.sa);
    const entry = Math.min(b.length - 100, t.sb + ENTRY_AFTER[t.kind]);
    const bi = add(t.b, entry);
    if (a < 0 || bi < 0) continue;
    const chord = 900;
    nodes[a].out.push({ to: bi, cost: chord / CONNECTOR_SPEED + TRANSFER_PENALTY, via: t.name });
  }
  // 같은 주행선 위에서는 앞으로만 간다
  for (const [road, list] of byRoad) {
    list.sort((i, j) => nodes[i].s - nodes[j].s);
    const v = speed.get(road)!;
    for (let k = 0; k + 1 < list.length; k++) {
      const i = list[k];
      const j = list[k + 1];
      nodes[i].out.push({ to: j, cost: (nodes[j].s - nodes[i].s) / v, via: "" });
    }
  }

  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const prevVia = new Array<string>(nodes.length).fill("");
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
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
  for (const i of starts) {
    dist[i] = 0;
    push(0, i);
  }
  let goal = -1;
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    // 출발한 자리에서 바로 도착한 것은 치지 않는다 (같은 IC)
    if (nodes[i].dest && d > 0) {
      goal = i;
      break;
    }
    for (const e of nodes[i].out) {
      const nd = d + e.cost;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = i;
        prevVia[e.to] = e.via;
        push(nd, e.to);
      }
    }
  }
  if (goal < 0) return null;

  // 뒤에서부터 조각을 모은다
  const path: number[] = [];
  for (let i = goal; i >= 0; i = prev[i]) path.unshift(i);
  const legs: Leg[] = [];
  let cur: Leg | null = null;
  for (let k = 0; k < path.length; k++) {
    const n = nodes[path[k]];
    if (!cur || cur.road !== n.road) {
      if (cur) legs.push(cur);
      cur = { road: n.road, s0: n.s, s1: n.s, via: k > 0 ? prevVia[path[k]] : "" };
    } else {
      cur.s1 = n.s;
    }
  }
  if (cur) legs.push(cur);
  const kept = legs.filter((l) => l.s1 - l.s0 > 1);
  if (!kept.length) return null;
  const lengthM = kept.reduce((a, l) => a + (l.s1 - l.s0), 0) + (kept.length - 1) * 900;
  return { from, to, legs: kept, lengthM, timeS: dist[goal] - (kept.length - 1) * TRANSFER_PENALTY };
}

// ---------------- 이어 붙이기 ----------------

interface Pt {
  e: number;
  n: number;
  z: number;
}

function fileAt(f: RoadFile, s: number): Pt & { te: number; tn: number } {
  const n = f.dx.length + 1;
  const i = Math.max(0, Math.min(n - 2, Math.floor(s / f.step)));
  const pos = cumulative(f);
  const t = Math.max(0, Math.min(1, s / f.step - i));
  const e = pos.e[i] + (pos.e[i + 1] - pos.e[i]) * t;
  const nn = pos.n[i] + (pos.n[i + 1] - pos.n[i]) * t;
  const z = (f.z[i] + (f.z[Math.min(i + 1, f.z.length - 1)] - f.z[i]) * t) / 10;
  // 방향은 ±30m로
  const a = Math.max(0, i - 3);
  const b = Math.min(n - 1, i + 4);
  const de = pos.e[b] - pos.e[a];
  const dn = pos.n[b] - pos.n[a];
  const len = Math.hypot(de, dn) || 1;
  return { e, n: nn, z, te: de / len, tn: dn / len };
}

const posCache = new WeakMap<RoadFile, { e: Float64Array; n: Float64Array }>();
function cumulative(f: RoadFile) {
  let c = posCache.get(f);
  if (c) return c;
  const n = f.dx.length + 1;
  const e = new Float64Array(n);
  const nn = new Float64Array(n);
  let qx = Math.round(f.origin[0] * 10);
  let qy = Math.round(f.origin[1] * 10);
  e[0] = qx / 10;
  nn[0] = qy / 10;
  for (let i = 1; i < n; i++) {
    qx += f.dx[i - 1];
    qy += f.dy[i - 1];
    e[i] = qx / 10;
    nn[i] = qy / 10;
  }
  c = { e, n: nn };
  posCache.set(f, c);
  return c;
}

/** 두 점을 잇는 부드러운 곡선 (허밋). 곡률이 가장 작게 되는 접선 길이를 고른다 */
export function connector(p0: Pt & { te: number; tn: number }, p1: Pt & { te: number; tn: number }, step: number): Pt[] {
  const chord = Math.hypot(p1.e - p0.e, p1.n - p0.n);
  if (chord < step * 1.5) return [];
  let best: Pt[] = [];
  let bestK = Infinity;
  for (const k of [0.6, 0.8, 1.0, 1.25, 1.5]) {
    const m = chord * k;
    const dense: Pt[] = [];
    const N = Math.max(40, Math.ceil(chord / 2));
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
      const h10 = t ** 3 - 2 * t ** 2 + t;
      const h01 = -2 * t ** 3 + 3 * t ** 2;
      const h11 = t ** 3 - t ** 2;
      const sm = t * t * (3 - 2 * t);
      dense.push({
        e: h00 * p0.e + h10 * m * p0.te + h01 * p1.e + h11 * m * p1.te,
        n: h00 * p0.n + h10 * m * p0.tn + h01 * p1.n + h11 * m * p1.tn,
        z: p0.z + (p1.z - p0.z) * sm,
      });
    }
    // 곡선 길이를 step에 가장 가까운 같은 간격으로 나눠 다시 뽑는다 (양 끝점은 앞뒤 조각의 점이라 뺀다)
    const cum = [0];
    for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i].e - dense[i - 1].e, dense[i].n - dense[i - 1].n));
    const arc = cum[cum.length - 1];
    const parts = Math.max(1, Math.round(arc / step));
    const out: Pt[] = [];
    let j = 1;
    for (let k = 1; k < parts; k++) {
      const target = (arc * k) / parts;
      while (j < dense.length - 1 && cum[j] < target) j++;
      const t = (target - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
      out.push({
        e: dense[j - 1].e + (dense[j].e - dense[j - 1].e) * t,
        n: dense[j - 1].n + (dense[j].n - dense[j - 1].n) * t,
        z: dense[j - 1].z + (dense[j].z - dense[j - 1].z) * t,
      });
    }
    const kmax = maxCurvature([p0, ...out, p1]);
    // 곡률이 비슷하면 짧은 쪽
    const score = kmax + out.length * 1e-6;
    if (score < bestK) {
      bestK = score;
      best = out;
    }
  }
  return best;
}

/** 점 사이 방향 변화로 잰 가장 큰 곡률 (1/m) */
function maxCurvature(pts: { e: number; n: number }[]): number {
  let kmax = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const h1 = Math.atan2(pts[i].n - pts[i - 1].n, pts[i].e - pts[i - 1].e);
    const h2 = Math.atan2(pts[i + 1].n - pts[i].n, pts[i + 1].e - pts[i].e);
    let dh = h2 - h1;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const len = (Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n) + Math.hypot(pts[i + 1].e - pts[i].e, pts[i + 1].n - pts[i].n)) / 2;
    kmax = Math.max(kmax, Math.abs(dh) / Math.max(1, len));
  }
  return kmax;
}

function sliceRuns<T>(runs: Run<T>[], s0: number, s1: number, shift: number, fallback: T): Run<T>[] {
  let first = fallback;
  for (const r of runs) if (r[0] <= s0) first = r[1];
  const out: Run<T>[] = [[shift, first]];
  for (const r of runs) if (r[0] > s0 && r[0] < s1) out.push([r[0] - s0 + shift, r[1]]);
  return out;
}


/** 경로 조각들의 주행선 파일을 받아 하나로 이어 붙인 RoadFile을 만든다 */
export function joinRoute(plan: RoutePlan, files: Map<string, RoadFile>): RoadFile {
  const step = 10;
  const pts: Pt[] = [];
  const legsOut: LegInfo[] = [];
  const lanes: Run<number>[] = [];
  const speed: Run<number>[] = [];
  const speedHgv: Run<number>[] = [];
  const minSpeed: Run<number>[] = [];
  const structure: Run<number>[] = [];
  const structureName: Run<string>[] = [];
  const sectionName: Run<string>[] = [];
  const refs: Run<string>[] = [];
  const junctions: [number, string, string][] = [];
  // 지형: 조각마다 원래 주행선의 지형 줄을, 연결로는 앞뒤를 섞어서
  const terrainAt: ((s: number) => number[])[] = [];
  const terrainSpan: [number, number][] = [];
  const first = files.get(plan.legs[0].road)!;
  const offsets = first.terrain.offsets;
  /** 연결로 앞뒤 점 번호: [앞 조각의 끝 점, 뒤 조각의 첫 점] */
  const joints: [number, number][] = [];

  const terrainRow = (f: RoadFile, s: number): number[] => {
    const rows = f.terrain.rows;
    if (!rows.length) return offsets.map(() => -2);
    const x = Math.max(0, Math.min(rows.length - 1.000001, s / f.terrain.step));
    const i = Math.floor(x);
    const t = x - i;
    const a = rows[i];
    const b = rows[Math.min(i + 1, rows.length - 1)];
    return a.map((v, k) => v + (b[k] - v) * t);
  };

  plan.legs.forEach((leg, li) => {
    const f = files.get(leg.road)!;
    const pos = cumulative(f);
    const i0 = Math.round(leg.s0 / f.step);
    const i1 = Math.round(leg.s1 / f.step);
    // 앞 조각과 잇는 연결로
    if (li > 0) {
      const prevLeg = plan.legs[li - 1];
      const pf = files.get(prevLeg.road)!;
      const a = fileAt(pf, Math.round(prevLeg.s1 / pf.step) * pf.step);
      const b = fileAt(f, i0 * f.step);
      const conn = connector(a, b, step);
      joints.push([pts.length - 1, pts.length + conn.length]);
      const cs0 = pts.length * step;
      const ra = terrainRow(pf, prevLeg.s1);
      const rb = terrainRow(f, i0 * f.step);
      const connLen = conn.length;
      pts.push(...conn);
      const cs1 = pts.length * step;
      const name = leg.via ? `${leg.via} 연결로` : "연결로";
      // 연결로 제한속도: 가장 급한 곳의 옆 가속도가 약 2.5m/s²가 되게 (최대 80km/h)
      const r = 1 / Math.max(1e-6, maxCurvature([a, ...conn, b]));
      const limit = Math.max(40, Math.min(80, Math.floor((Math.sqrt(2.5 * r) * 3.6) / 10) * 10));
      lanes.push([cs0, 2]);
      speed.push([cs0, limit]);
      speedHgv.push([cs0, Math.min(limit, 70)]);
      minSpeed.push([cs0, 0]);
      structure.push([cs0, 0]);
      structureName.push([cs0, ""]);
      sectionName.push([cs0, name]);
      refs.push([cs0, f.ref]);
      if (connLen) {
        terrainSpan.push([cs0, cs1]);
        terrainAt.push((s) => {
          const t = (s - cs0) / Math.max(1, cs1 - cs0);
          return ra.map((v, k) => v + (rb[k] - v) * t);
        });
      }
    }
    const base = pts.length * step;
    for (let i = i0; i <= i1; i++) pts.push({ e: pos.e[i], n: pos.n[i], z: (f.z[i] ?? f.z[f.z.length - 1]) / 10 });
    const src0 = i0 * f.step;
    const src1 = i1 * f.step;
    const end = base + (src1 - src0);
    legsOut.push({ road: f.id, ref: f.ref, name: f.name, from: f.from, to: f.to, s0: base, s1: end, src0, src1, via: leg.via });
    lanes.push(...sliceRuns(f.lanes, src0, src1, base, 2));
    speed.push(...sliceRuns(f.speed, src0, src1, base, 100));
    speedHgv.push(...sliceRuns(f.speedHgv, src0, src1, base, 80));
    minSpeed.push(...sliceRuns(f.minSpeed, src0, src1, base, 50));
    structure.push(...sliceRuns(f.structure, src0, src1, base, 0));
    structureName.push(...sliceRuns(f.structureName, src0, src1, base, ""));
    const sec = sliceRuns(f.sectionName, src0, src1, base, f.name);
    if (!sec[0][1]) sec[0][1] = f.name;
    sectionName.push(...sec);
    refs.push([base, f.ref]);
    for (const [s, name, ex] of f.junctions) {
      if (s >= src0 - 1 && s <= src1 + 1) junctions.push([s - src0 + base, name, ex]);
    }
    terrainSpan.push([base, end]);
    terrainAt.push((s) => terrainRow(f, s - base + src0));
  });

  smoothJoints(pts, joints, step);

  // 좌표 → 0.1m 정수 차분
  const q = pts.map((p) => [Math.round(p.e * 10), Math.round(p.n * 10)]);
  const dx: number[] = [];
  const dy: number[] = [];
  for (let i = 1; i < q.length; i++) {
    dx.push(q[i][0] - q[i - 1][0]);
    dy.push(q[i][1] - q[i - 1][1]);
  }
  const length = (pts.length - 1) * step;
  const tstep = first.terrain.step;
  const rows: number[][] = [];
  for (let s = 0; s <= length + 1e-6; s += tstep) {
    let k = terrainSpan.findIndex(([a, b]) => s >= a - 1e-6 && s <= b + 1e-6);
    if (k < 0) k = s <= 0 ? 0 : terrainSpan.length - 1;
    rows.push(terrainAt[k](Math.min(Math.max(s, terrainSpan[k][0]), terrainSpan[k][1])).map((v) => Math.round(v)));
  }
  const firstLeg = legsOut[0];
  return {
    id: `route:${plan.from.name}-${plan.to.name}`,
    ref: firstLeg.ref,
    name: `${plan.from.name} → ${plan.to.name}`,
    from: plan.from.name,
    to: plan.to.name,
    length,
    step,
    origin: [q[0][0] / 10, q[0][1] / 10],
    dx,
    dy,
    z: pts.map((p) => Math.round(p.z * 10)),
    lanes: dedupe(lanes),
    speed: dedupe(speed),
    speedHgv: dedupe(speedHgv),
    minSpeed: dedupe(minSpeed),
    structure: dedupe(structure),
    structureName: dedupe(structureName),
    sectionName: dedupe(sectionName),
    junctions,
    terrain: { step: tstep, offsets, rows },
    refs: dedupe(refs),
    legs: legsOut,
  };
}

/** 연결로는 앞뒤 높이 차가 커도 경사가 MAX_GRADE를 넘지 않게, 필요하면 앞뒤 조각까지 늘려 고르게 오르내린다 */
const MAX_GRADE = 0.05;
function smoothJoints(pts: Pt[], joints: [number, number][], step: number) {
  const SMOOTH = 8; // 경사가 꺾이는 곳을 ±80m로 부드럽게
  for (let k = 0; k < joints.length; k++) {
    const [a, b] = joints[k];
    // 앞뒤 연결로 가운데까지만 건드린다
    const loBound = k > 0 ? Math.ceil((joints[k - 1][1] + a) / 2) : 0;
    const hiBound = k + 1 < joints.length ? Math.floor((b + joints[k + 1][0]) / 2) : pts.length - 1;
    const dz = Math.abs(pts[b].z - pts[a].z);
    const need = dz / MAX_GRADE / step;
    const ext = Math.max(0, Math.ceil((need - (b - a)) / 2)) + SMOOTH;
    const lo = Math.max(loBound, a - ext);
    const hi = Math.min(hiBound, b + ext);
    if (hi - lo < 2) continue;
    const z0 = pts[lo].z;
    const z1 = pts[hi].z;
    for (let i = lo + 1; i < hi; i++) pts[i].z = z0 + ((z1 - z0) * (i - lo)) / (hi - lo);
    // 꺾이는 곳 다듬기
    const s0 = Math.max(loBound, lo - SMOOTH);
    const s1 = Math.min(hiBound, hi + SMOOTH);
    const src = pts.slice(s0, s1 + 1).map((p) => p.z);
    for (let i = s0 + 1; i < s1; i++) {
      let sum = 0;
      let cnt = 0;
      for (let j = Math.max(s0, i - SMOOTH); j <= Math.min(s1, i + SMOOTH); j++) {
        sum += src[j - s0];
        cnt++;
      }
      pts[i].z = sum / cnt;
    }
  }
}

/** 같은 값이 이어지거나 같은 위치에 두 번 들어간 것을 정리 */
function dedupe<T>(runs: Run<T>[]): Run<T>[] {
  const out: Run<T>[] = [];
  for (const r of runs) {
    if (out.length && Math.abs(out[out.length - 1][0] - r[0]) < 1e-6) out[out.length - 1] = r;
    else if (out.length && out[out.length - 1][1] === r[1]) continue;
    else out.push(r);
  }
  return out;
}

/** 경로에 필요한 주행선 파일을 받아 이어 붙인다 */
export async function loadRoute(plan: RoutePlan, base = "./roads/"): Promise<RoadFile> {
  const ids = [...new Set(plan.legs.map((l) => l.road))];
  const files = new Map<string, RoadFile>();
  await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(`${base}${id}.json`);
      if (!res.ok) throw new Error(`도로 데이터를 불러오지 못했습니다 (${id}, ${res.status})`);
      files.set(id, (await res.json()) as RoadFile);
    }),
  );
  return joinRoute(plan, files);
}
