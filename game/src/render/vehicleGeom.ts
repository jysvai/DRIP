// 차 모델을 만드는 도구: 단면을 이어 붙인 매끈한 몸체(Loft), 몸체 겉면에 붙이는 등화·그릴 무늬(decal), 기본 도형.
// 꼭짓점마다 색(color)과 재질값(surf = 거칠기, 금속성, 클리어코트, 표시)을 넣어서 재질 하나로 차 한 대를 그린다.
// 좌표: +X 앞, +Y 위, +Z 오른쪽 (vehicleModels.ts와 같다)

import * as THREE from "three";

/** 겉면 재질. paint면 color는 도색 색에 곱하는 밝기 */
export interface Surf {
  color: number;
  /** 거칠기 */
  r: number;
  /** 금속성 */
  m: number;
  /** 클리어코트 */
  c: number;
  /** 등화·유리 표시 (TAG) */
  tag: number;
  paint?: boolean;
}

/** 표시: 등화는 셰이더에서 켜고 끈다. 유리는 운전석 시점에서 숨긴다 */
export const TAG = {
  NONE: 0,
  HEAD: 1,
  TAIL: 2,
  SIG_L: 3,
  SIG_R: 4,
  BRAKE: 5,
  REVERSE: 6,
  BEACON_A: 7,
  BEACON_B: 8,
  GLOW: 9,
  DRL: 10,
  GLASS: 12,
} as const;

export function surfW(s: Surf): number {
  return s.tag + (s.paint ? 16 : 0);
}

export function paintSurf(shade = 1, c = 1): Surf {
  const g = Math.round(Math.max(0, Math.min(1, shade)) * 255);
  return { color: (g << 16) | (g << 8) | g, r: 0.36, m: 0.35, c, tag: 0, paint: true };
}

type V3 = { x: number; y: number; z: number };

const _c = new THREE.Color();

/** 삼각형을 모으는 곳 */
export class Mesher {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  srf: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  vert(p: V3, n: V3, s: Surf) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    _c.setHex(s.color);
    this.col.push(_c.r, _c.g, _c.b);
    this.srf.push(s.r, s.m, s.c, surfW(s));
  }

  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, s: Surf) {
    this.vert(a, na, s);
    this.vert(b, nb, s);
    this.vert(c, nc, s);
  }

  /** 면 법선으로 삼각형 하나 */
  flat(a: V3, b: V3, c: V3, s: Surf) {
    const n = faceNormal(a, b, c);
    if (!n) return;
    this.tri(a, b, c, n, n, n, s);
  }

  /** three.js 도형을 붙인다 */
  geo(g: THREE.BufferGeometry, s: Surf, m?: THREE.Matrix4) {
    let geo = g.index ? g.toNonIndexed() : g;
    if (m) geo.applyMatrix4(m);
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    const p = geo.getAttribute("position");
    const n = geo.getAttribute("normal");
    _c.setHex(s.color);
    const w = surfW(s);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(_c.r, _c.g, _c.b);
      this.srf.push(s.r, s.m, s.c, w);
    }
    if (geo !== g) geo.dispose();
    g.dispose();
  }

  append(o: Mesher) {
    for (const k of ["pos", "nor", "col", "srf"] as const) {
      const a = this[k];
      for (const v of o[k]) a.push(v);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute("surf", new THREE.BufferAttribute(new Float32Array(this.srf), 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function faceNormal(a: V3, b: V3, c: V3): THREE.Vector3 | null {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const n = new THREE.Vector3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const l = n.length();
  if (l < 1e-9) return null;
  return n.multiplyScalar(1 / l);
}

// ---------- 몸체: 단면을 이어 붙이기 ----------

/** 단면의 점 (y, z). z는 오른쪽 반만 (0 이상) */
export type YZ = [number, number];

export interface LoftDef {
  /** 단면을 둘 x (앞 → 뒤) */
  stations: number[];
  /** 오른쪽 반 단면: 바닥 가운데(z=0) → 옆 → 지붕 가운데(z=0). 점 개수는 늘 같다 */
  section: (x: number) => YZ[];
  /** 마디 [xa, xb] 사이, 단면 변 j(점 j → j+1)의 겉면. null이면 비운다 */
  surf: (xa: number, xb: number, j: number) => Surf | null;
  capFront?: (j: number) => Surf | null;
  capRear?: (j: number) => Surf | null;
  /** 이 번호의 단면 점에서 법선을 나눈다 (모서리) */
  creases?: number[];
  /** 이 번호의 마디에서 법선을 나눈다 */
  stationCreases?: number[];
}

export class Loft {
  readonly xs: number[];
  readonly grid: YZ[][];
  readonly n: number;

  constructor(readonly def: LoftDef) {
    const xs = [...def.stations].sort((a, b) => b - a);
    this.xs = xs.filter((x, i) => i === 0 || xs[i - 1] - x > 0.004);
    this.grid = this.xs.map((x) => def.section(x));
    this.n = this.grid[0].length;
  }

  get front() {
    return this.xs[0];
  }
  get rear() {
    return this.xs[this.xs.length - 1];
  }

  /** 고리 점 k (오른쪽 반 0..n-1, 이어서 왼쪽 반) */
  private point(i: number, k: number, out: THREE.Vector3) {
    const n = this.n;
    const j = k < n ? k : 2 * n - 2 - k;
    const side = k < n ? 1 : -1;
    const p = this.grid[i][j];
    return out.set(this.xs[i], p[0], side * p[1]);
  }

  /** 겉면(외부)과, 원하면 안쪽 면(실내)을 만든다 */
  build(m: Mesher, inner?: { m: Mesher; x0: number; x1: number; surf: (xa: number, xb: number, j: number, outer: Surf | null, n: THREE.Vector3) => Surf | null }) {
    const def = this.def;
    const n = this.n;
    const K = 2 * n - 2;
    const S = this.xs.length;
    const creases = def.creases ?? [];
    const sCreases = def.stationCreases ?? [];
    const gHalf = creases.length + 1;
    const gTop = creases.filter((c) => c <= n - 2).length;
    const NG = gHalf * 2;
    const NSG = sCreases.length + 1;
    const edgeJ = (k: number) => (k < n - 1 ? k : 2 * n - 3 - k);
    const gid = (k: number) => {
      const j = edgeJ(k);
      const g = creases.filter((c) => c <= j).length;
      if (g === 0 || g === gTop) return g;
      return k < n - 1 ? g : g + gHalf;
    };
    const sgid = (i: number) => sCreases.filter((s) => s <= i).length;
    const acc = new Float32Array(S * K * NG * NSG * 3);
    const key = (i: number, k: number, g: number, sg: number) => (((i * K + (k % K)) * NG + g) * NSG + sg) * 3;
    const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const fn = new THREE.Vector3();
    const add = (i: number, k: number, g: number, sg: number, v: THREE.Vector3) => {
      const o = key(i, k, g, sg);
      acc[o] += v.x;
      acc[o + 1] += v.y;
      acc[o + 2] += v.z;
    };
    // 1) 면 법선을 모서리 꼭짓점에 모은다 (넓이 가중)
    for (let i = 0; i < S - 1; i++) {
      const sg = sgid(i);
      for (let k = 0; k < K; k++) {
        const g = gid(k);
        this.point(i, k, P[0]);
        this.point(i, (k + 1) % K, P[1]);
        this.point(i + 1, (k + 1) % K, P[2]);
        this.point(i + 1, k, P[3]);
        // 바깥 법선 = 대각선 두 개의 곱 (한 변이 점으로 줄어도 방향이 맞다)
        e1.subVectors(P[2], P[0]);
        e2.subVectors(P[1], P[3]);
        fn.crossVectors(e2, e1);
        add(i, k, g, sg, fn);
        add(i, k + 1, g, sg, fn);
        add(i + 1, k + 1, g, sg, fn);
        add(i + 1, k, g, sg, fn);
      }
    }
    const nrm = (i: number, k: number, g: number, sg: number) => {
      const o = key(i, k, g, sg);
      const v = new THREE.Vector3(acc[o], acc[o + 1], acc[o + 2]);
      const l = v.length();
      return l > 1e-12 ? v.multiplyScalar(1 / l) : v.set(0, 1, 0);
    };
    // 2) 삼각형
    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    const C = new THREE.Vector3();
    const D = new THREE.Vector3();
    const emitQuad = (target: Mesher, s: Surf, flip: boolean, i: number, k: number, g: number, sg: number) => {
      this.point(i, k, A);
      this.point(i, (k + 1) % K, B);
      this.point(i + 1, (k + 1) % K, C);
      this.point(i + 1, k, D);
      const na = nrm(i, k, g, sg);
      const nb = nrm(i, k + 1, g, sg);
      const nc = nrm(i + 1, k + 1, g, sg);
      const nd = nrm(i + 1, k, g, sg);
      if (flip) for (const v of [na, nb, nc, nd]) v.multiplyScalar(-1);
      // (A, B, D), (B, C, D): 바깥에서 보면 반시계
      const t1 = triArea(A, B, D) > 1e-8;
      const t2 = triArea(B, C, D) > 1e-8;
      if (!flip) {
        if (t1) target.tri(A, B, D, na, nb, nd, s);
        if (t2) target.tri(B, C, D, nb, nc, nd, s);
      } else {
        if (t1) target.tri(A, D, B, na, nd, nb, s);
        if (t2) target.tri(B, D, C, nb, nd, nc, s);
      }
    };
    const mid = new THREE.Vector3();
    for (let i = 0; i < S - 1; i++) {
      const sg = sgid(i);
      const xa = this.xs[i];
      const xb = this.xs[i + 1];
      for (let k = 0; k < K; k++) {
        const j = edgeJ(k);
        const s = def.surf(xa, xb, j);
        const g = gid(k);
        if (s) emitQuad(m, s, false, i, k, g, sg);
        if (inner && (xa + xb) / 2 <= inner.x0 && (xa + xb) / 2 >= inner.x1) {
          mid.copy(nrm(i, k, g, sg));
          const si = inner.surf(xa, xb, j, s, mid);
          if (si) emitQuad(inner.m, si, true, i, k, g, sg);
        }
      }
    }
    // 3) 앞뒤 마개: 오른쪽 점 j와 왼쪽 거울 점을 잇는 띠
    const cap = (i: number, front: boolean, f?: (j: number) => Surf | null) => {
      if (!f) return;
      const row = this.grid[i];
      const x = this.xs[i];
      const nn = new THREE.Vector3(front ? 1 : -1, 0, 0);
      for (let j = 0; j < n - 1; j++) {
        const s = f(j);
        if (!s) continue;
        const [y0, z0] = row[j];
        const [y1, z1] = row[j + 1];
        const a = new THREE.Vector3(x, y0, z0);
        const b = new THREE.Vector3(x, y1, z1);
        const c = new THREE.Vector3(x, y1, -z1);
        const d = new THREE.Vector3(x, y0, -z0);
        const quad = front ? [a, d, b, b, d, c] : [a, b, d, b, c, d];
        for (let t = 0; t < 6; t += 3) {
          if (triArea(quad[t], quad[t + 1], quad[t + 2]) > 1e-8) m.tri(quad[t], quad[t + 1], quad[t + 2], nn, nn, nn, s);
        }
      }
    };
    cap(0, true, def.capFront);
    cap(S - 1, false, def.capRear);
  }

  // ---- 무늬를 붙이려고 겉면을 찾는 곳: 촘촘한 단면 표를 미리 만들어 둔다 ----
  private tab: Float32Array | null = null;
  private tabDx = 0.004;
  private buf = new Float32Array(0);
  private bufA = new Float32Array(0);
  private bufB = new Float32Array(0);

  private table() {
    if (this.tab) return this.tab;
    const n = this.n;
    const len = this.front - this.rear;
    this.tabDx = Math.max(0.004, len / 1500);
    const N = Math.ceil(len / this.tabDx) + 1;
    const tab = new Float32Array(N * n * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.max(this.rear, this.front - i * this.tabDx);
      const sec = this.def.section(x);
      for (let k = 0; k < n; k++) {
        tab[(i * n + k) * 2] = sec[k][0];
        tab[(i * n + k) * 2 + 1] = sec[k][1];
      }
    }
    this.buf = new Float32Array(n * 2);
    this.bufA = new Float32Array(n * 2);
    this.bufB = new Float32Array(n * 2);
    return (this.tab = tab);
  }

  /** x의 단면 (y, z 번갈아) — 표에서 보간 */
  private sec(x: number, out: Float32Array): Float32Array {
    const tab = this.table();
    const n = this.n;
    const N = tab.length / (n * 2);
    const fi = Math.max(0, Math.min(N - 1, (this.front - x) / this.tabDx));
    const i0 = Math.min(N - 2, Math.floor(fi));
    const t = fi - i0;
    const a = i0 * n * 2;
    const b = (i0 + 1) * n * 2;
    for (let k = 0; k < n * 2; k++) out[k] = tab[a + k] + (tab[b + k] - tab[a + k]) * t;
    return out;
  }

  /** 점이 몸체 안에 있는지 */
  inside(x: number, y: number, z: number): boolean {
    if (x > this.front || x < this.rear) return false;
    return inSec(this.sec(x, this.buf), this.n, y, Math.abs(z));
  }

  /** 투영 방향으로 겉면에 닿는 점 */
  hitProj(proj: Proj, u: number, v: number): THREE.Vector3 | null {
    const n = this.n;
    if (proj === "right" || proj === "left") {
      if (u > this.front || u < this.rear) return null;
      const s = this.sec(u, this.buf);
      let best = -1;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = s[i * 2], zi = s[i * 2 + 1], yj = s[j * 2], zj = s[j * 2 + 1];
        if (yi > v !== yj > v) best = Math.max(best, zi + ((v - yi) / (yj - yi)) * (zj - zi));
      }
      return best > 0 ? new THREE.Vector3(u, v, proj === "right" ? best : -best) : null;
    }
    if (proj === "top") {
      if (u > this.front || u < this.rear) return null;
      const s = this.sec(u, this.buf);
      const z = Math.abs(v);
      let best = -Infinity;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = s[i * 2], zi = s[i * 2 + 1], yj = s[j * 2], zj = s[j * 2 + 1];
        if (zi > z !== zj > z) best = Math.max(best, yi + ((z - zi) / (zj - zi)) * (yj - yi));
      }
      return best > -Infinity ? new THREE.Vector3(u, best, v) : null;
    }
    // 앞뒤: x를 따라 훑는다
    const dir = proj === "front" ? -1 : 1;
    const x0 = proj === "front" ? this.front : this.rear;
    const span = Math.min(1.8, this.front - this.rear);
    const step = 0.02;
    const z = Math.abs(u);
    let prev = -1;
    for (let t = 0; t <= span; t += step) {
      const x = x0 + dir * t;
      if (inSec(this.sec(x, this.buf), n, v, z)) {
        if (t === 0) return new THREE.Vector3(x0, v, u);
        let lo = prev < 0 ? 0 : prev;
        let hi = t;
        for (let k = 0; k < 8; k++) {
          const mm = (lo + hi) / 2;
          if (inSec(this.sec(x0 + dir * mm, this.buf), n, v, z)) hi = mm;
          else lo = mm;
        }
        return new THREE.Vector3(x0 + dir * hi, v, u);
      }
      prev = t;
    }
    return null;
  }

  /** 겉면 위 점의 바깥 법선 */
  normalAt(p: THREE.Vector3): THREE.Vector3 {
    if (p.x >= this.front - 0.0015) return new THREE.Vector3(1, 0, 0);
    if (p.x <= this.rear + 0.0015) return new THREE.Vector3(-1, 0, 0);
    const n = this.n;
    const sg = p.z < 0 ? -1 : 1;
    const z = Math.abs(p.z);
    const s = this.sec(p.x, this.buf);
    // 가장 가까운 변
    let best = Infinity;
    let e = 0;
    let par = 0;
    for (let i = 0; i < n - 1; i++) {
      const y0 = s[i * 2], z0 = s[i * 2 + 1], y1 = s[i * 2 + 2], z1 = s[i * 2 + 3];
      const dy = y1 - y0, dz = z1 - z0;
      const l2 = dy * dy + dz * dz;
      if (l2 < 1e-10) continue;
      const t = Math.max(0, Math.min(1, ((p.y - y0) * dy + (z - z0) * dz) / l2));
      const d2 = (p.y - y0 - dy * t) ** 2 + (z - z0 - dz * t) ** 2;
      if (d2 < best) {
        best = d2;
        e = i;
        par = t;
      }
    }
    const h = 0.01;
    const A = this.sec(Math.min(this.front, p.x + h), this.bufA);
    const B = this.sec(Math.max(this.rear, p.x - h), this.bufB);
    const pt = (q: Float32Array) => [q[e * 2] + (q[e * 2 + 2] - q[e * 2]) * par, q[e * 2 + 1] + (q[e * 2 + 3] - q[e * 2 + 1]) * par];
    const [ya, za] = pt(A);
    const [yb, zb] = pt(B);
    const t1 = new THREE.Vector3(0, s[e * 2 + 2] - s[e * 2], (s[e * 2 + 3] - s[e * 2 + 1]) * sg);
    const t2 = new THREE.Vector3(2 * h, ya - yb, (za - zb) * sg);
    const nn = new THREE.Vector3().crossVectors(t1, t2);
    // 단면에서 바깥쪽 (반시계 순서의 오른쪽)
    const out = new THREE.Vector3(0, -(s[e * 2 + 3] - s[e * 2 + 1]), (s[e * 2 + 2] - s[e * 2]) * sg);
    if (nn.dot(out) < 0) nn.negate();
    if (nn.lengthSq() < 1e-12) return out.normalize();
    return nn.normalize();
  }
}

/** 오른쪽 반 단면(y, z 번갈아) + 가운데 줄로 닫은 다각형 안에 (y, z)가 있는지 */
function inSec(s: Float32Array, n: number, y: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = s[i * 2], zi = s[i * 2 + 1], yj = s[j * 2], zj = s[j * 2 + 1];
    if (yi > y !== yj > y) {
      const zc = zi + ((y - yi) / (yj - yi)) * (zj - zi);
      if (z < zc) inside = !inside;
    }
  }
  return inside;
}

function triArea(a: V3, b: V3, c: V3) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(x * x + y * y + z * z);
}

// ---------- 겉면에 붙이는 무늬 ----------

/** 투영 방향. front: (u=z, v=y)를 앞에서 뒤로, rear: 뒤에서 앞으로, right/left: (u=x, v=y)를 옆에서, top: (u=x, v=z)를 위에서 */
export type Proj = "front" | "rear" | "right" | "left" | "top";

/** 겉면 위의 점과 법선. 못 맞히면 null */
export function surfacePoint(body: Loft, proj: Proj, u: number, v: number, off: number): { p: THREE.Vector3; n: THREE.Vector3 } | null {
  const p = body.hitProj(proj, u, v);
  if (!p) return null;
  const n = body.normalAt(p);
  return { p: p.addScaledVector(n, off), n };
}

/** (u, v) 평면의 반시계가 바깥에서 볼 때 시계가 되는 투영 */
function flipOf(p: Proj) {
  return p === "front" || p === "left" || p === "top";
}

function cross2(a: [number, number], b: [number, number], c: [number, number]) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function mirrorProj(p: Proj): Proj {
  return p === "right" ? "left" : p === "left" ? "right" : p;
}

/** 다각형 무늬. level번 쪼개서 곡면을 따라가게 한다 */
export function decalPoly(m: Mesher, body: Loft, proj: Proj, pts: [number, number][], s: Surf, off = 0.01, level = 1) {
  const contour = pts.map(([u, v]) => new THREE.Vector2(u, v));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  let tris: [number, number][][] = faces.map((f) => f.map((i) => [contour[i].x, contour[i].y] as [number, number]));
  for (let l = 0; l < level; l++) {
    const next: [number, number][][] = [];
    for (const [a, b, c] of tris) {
      const ab: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const bc: [number, number] = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
      const ca: [number, number] = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  const cache = new Map<string, { p: THREE.Vector3; n: THREE.Vector3 } | null>();
  const sp = (u: number, v: number) => {
    const k = `${u.toFixed(5)},${v.toFixed(5)}`;
    if (!cache.has(k)) cache.set(k, surfacePoint(body, proj, u, v, off));
    return cache.get(k)!;
  };
  const flip = flipOf(proj);
  for (const t of tris) {
    // (u, v)에서 반시계로 맞춘다
    const [a, b, c] = cross2(t[0], t[1], t[2]) >= 0 ? t : [t[0], t[2], t[1]];
    const pa = sp(a[0], a[1]);
    const pb = sp(b[0], b[1]);
    const pc = sp(c[0], c[1]);
    if (!pa || !pb || !pc) continue;
    if (flip) m.tri(pa.p, pc.p, pb.p, pa.n, pc.n, pb.n, s);
    else m.tri(pa.p, pb.p, pc.p, pa.n, pb.n, pc.n, s);
  }
}

/** 폭 w의 선 무늬 (등화 띠, 문 틈, 크롬 몰딩). 길이 방향으로 seg 간격마다 나눠서 곡면을 따라간다 */
export function decalStrip(m: Mesher, body: Loft, proj: Proj, line: [number, number][], w: number, s: Surf, off = 0.008, seg = 0.06) {
  // 선을 고르게 나눈 점
  const pts: [number, number][] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [u0, v0] = line[i];
    const [u1, v1] = line[i + 1];
    const len = Math.hypot(u1 - u0, v1 - v0);
    const nseg = Math.max(1, Math.ceil(len / seg));
    for (let k = 0; k < nseg; k++) pts.push([u0 + ((u1 - u0) * k) / nseg, v0 + ((v1 - v0) * k) / nseg]);
  }
  pts.push(line[line.length - 1]);
  const side: { a: ReturnType<typeof surfacePoint>; b: ReturnType<typeof surfacePoint> }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(pts.length - 1, i + 1)];
    let tu = p1[0] - p0[0];
    let tv = p1[1] - p0[1];
    const l = Math.hypot(tu, tv) || 1;
    tu /= l;
    tv /= l;
    // 왼쪽 법선 (-tv, tu)
    const [u, v] = pts[i];
    side.push({ a: surfacePoint(body, proj, u - (tv * w) / 2, v + (tu * w) / 2, off), b: surfacePoint(body, proj, u + (tv * w) / 2, v - (tu * w) / 2, off) });
  }
  const flip = flipOf(proj);
  for (let i = 0; i < side.length - 1; i++) {
    const { a: a0, b: b0 } = side[i];
    const { a: a1, b: b1 } = side[i + 1];
    if (!a0 || !b0 || !a1 || !b1) continue;
    // 사각형 (b0, b1, a1, a0) — (u, v) 평면에서 반시계
    if (!flip) {
      m.tri(b0.p, b1.p, a1.p, b0.n, b1.n, a1.n, s);
      m.tri(b0.p, a1.p, a0.p, b0.n, a1.n, a0.n, s);
    } else {
      m.tri(b0.p, a1.p, b1.p, b0.n, a1.n, b1.n, s);
      m.tri(b0.p, a0.p, a1.p, b0.n, a0.n, a1.n, s);
    }
  }
}

/** 좌우 대칭으로 두 번 붙인다. front/rear/top은 u(=z)를 뒤집고, right/left는 반대쪽 면에 붙인다 */
export function decalPolyPair(m: Mesher, body: Loft, proj: Proj, pts: [number, number][], s: Surf | [Surf, Surf], off = 0.01, level = 1) {
  const [sr, sl] = Array.isArray(s) ? s : [s, s];
  if (proj === "right" || proj === "left") {
    decalPoly(m, body, proj, pts, sr, off, level);
    decalPoly(m, body, mirrorProj(proj), pts, sl, off, level);
  } else if (proj === "top") {
    decalPoly(m, body, proj, pts, sr, off, level);
    decalPoly(m, body, proj, pts.map(([u, v]) => [u, -v] as [number, number]), sl, off, level);
  } else {
    decalPoly(m, body, proj, pts, sr, off, level);
    decalPoly(m, body, proj, pts.map(([u, v]) => [-u, v] as [number, number]), sl, off, level);
  }
}

export function decalStripPair(m: Mesher, body: Loft, proj: Proj, line: [number, number][], w: number, s: Surf | [Surf, Surf], off = 0.008, seg = 0.06) {
  const [sr, sl] = Array.isArray(s) ? s : [s, s];
  if (proj === "right" || proj === "left") {
    decalStrip(m, body, proj, line, w, sr, off, seg);
    decalStrip(m, body, mirrorProj(proj), line, w, sl, off, seg);
  } else if (proj === "top") {
    decalStrip(m, body, proj, line, w, sr, off, seg);
    decalStrip(m, body, proj, line.map(([u, v]) => [u, -v] as [number, number]), w, sl, off, seg);
  } else {
    decalStrip(m, body, proj, line, w, sr, off, seg);
    decalStrip(m, body, proj, line.map(([u, v]) => [-u, v] as [number, number]), w, sl, off, seg);
  }
}

// ---------- 기본 도형 ----------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

function mat(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, "YZX");
  _q.setFromEuler(_e);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** 가운데 좌표와 크기로 상자 (ry: y축 회전) */
export function box(m: Mesher, sx: number, sy: number, sz: number, x: number, y: number, z: number, s: Surf, ry = 0, rz = 0) {
  m.geo(new THREE.BoxGeometry(sx, sy, sz), s, mat(x, y, z, 0, ry, rz));
}

/** 모서리를 깎은 상자 */
export function cbox(m: Mesher, sx: number, sy: number, sz: number, r: number, x: number, y: number, z: number, s: Surf, ry = 0, rz = 0) {
  r = Math.min(r, sx / 2 - 0.001, sy / 2 - 0.001, sz / 2 - 0.001);
  if (r <= 0.002) return box(m, sx, sy, sz, x, y, z, s, ry, rz);
  const hx = sx / 2;
  const hy = sy / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hx + r, -hy);
  shape.lineTo(hx - r, -hy);
  shape.quadraticCurveTo(hx, -hy, hx, -hy + r);
  shape.lineTo(hx, hy - r);
  shape.quadraticCurveTo(hx, hy, hx - r, hy);
  shape.lineTo(-hx + r, hy);
  shape.quadraticCurveTo(-hx, hy, -hx, hy - r);
  shape.lineTo(-hx, -hy + r);
  shape.quadraticCurveTo(-hx, -hy, -hx + r, -hy);
  const depth = Math.max(0.001, sz - 2 * r);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: r, bevelSize: 0, bevelOffset: 0, bevelSegments: 1, curveSegments: 2 });
  g.translate(0, 0, -depth / 2);
  m.geo(g, s, mat(x, y, z, 0, ry, rz));
}

/** 옆모양(x 앞, y 위) 다각형을 폭 w로 뽑아낸 것 */
export function profile(m: Mesher, pts: [number, number][], w: number, s: Surf, zc = 0, bevel = 0.03) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.01, w - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, zc - depth / 2);
  m.geo(g, s);
}

export function cyl(m: Mesher, r: number, len: number, x: number, y: number, z: number, axis: "x" | "y" | "z", s: Surf, seg = 12, r2 = r) {
  const g = new THREE.CylinderGeometry(r2, r, len, seg);
  if (axis === "x") g.rotateZ(-Math.PI / 2);
  if (axis === "z") g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  m.geo(g, s);
}

export function ellipsoid(m: Mesher, rx: number, ry: number, rz: number, x: number, y: number, z: number, s: Surf, seg = 10, ringsN = 6) {
  const g = new THREE.SphereGeometry(1, seg, ringsN);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  m.geo(g, s);
}

/** 평면 사각형 (법선 n 쪽을 본다) */
export function quad(m: Mesher, c: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3, w: number, h: number, s: Surf) {
  const r = new THREE.Vector3().crossVectors(up, n).normalize().multiplyScalar(w / 2);
  const u = up.clone().normalize().multiplyScalar(h / 2);
  const a = c.clone().sub(r).sub(u);
  const b = c.clone().add(r).sub(u);
  const cc = c.clone().add(r).add(u);
  const d = c.clone().sub(r).add(u);
  m.tri(a, b, cc, n, n, n, s);
  m.tri(a, cc, d, n, n, n, s);
}

export const util = {
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  clamp: (x: number, a: number, b: number) => Math.max(a, Math.min(b, x)),
  smooth: (t: number) => {
    const u = Math.max(0, Math.min(1, t));
    return u * u * (3 - 2 * u);
  },
};
