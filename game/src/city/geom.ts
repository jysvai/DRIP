// 꺾은선 도구: 시내 도로망의 도로 중심선을 다룬다. 점은 [x0, y0, x1, y1, …] (m, x 동쪽·y 북쪽).

export type Poly = Float64Array;

export interface PolyPoint {
  x: number;
  y: number;
  /** 진행 방향 단위벡터 */
  tx: number;
  ty: number;
}

/** 점 i까지 누적 길이 */
export function cumLengths(p: Poly): Float64Array {
  const n = p.length / 2;
  const c = new Float64Array(n);
  for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  return c;
}

/** 누적 길이 u인 점과 방향 (범위 밖은 끝점) */
export function pointAt(p: Poly, cum: Float64Array, u: number, out: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 }): PolyPoint {
  const n = cum.length;
  if (n < 2) {
    out.x = p[0];
    out.y = p[1];
    return out;
  }
  const L = cum[n - 1];
  const v = Math.max(0, Math.min(L, u));
  // 이진 탐색: cum[i] <= v < cum[i+1]
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= v) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1e-9;
  const t = (v - cum[lo]) / seg;
  const ax = p[2 * lo];
  const ay = p[2 * lo + 1];
  const bx = p[2 * hi];
  const by = p[2 * hi + 1];
  out.x = ax + (bx - ax) * t;
  out.y = ay + (by - ay) * t;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  out.tx = (bx - ax) / len;
  out.ty = (by - ay) / len;
  return out;
}

/** 두 누적 길이 사이의 방향 (a→b 끝점을 잇는 방향, 라디안, 동쪽 0·반시계 +) */
export function headingBetween(p: Poly, cum: Float64Array, u0: number, u1: number): number {
  const a = pointAt(p, cum, u0, { x: 0, y: 0, tx: 1, ty: 0 });
  const b = pointAt(p, cum, u1, { x: 0, y: 0, tx: 1, ty: 0 });
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return Math.atan2(a.ty, a.tx);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** 같은 간격(step에 가장 가까운)으로 다시 뽑는다. 양 끝점은 그대로 */
export function resample(p: Poly, step: number): Poly {
  const cum = cumLengths(p);
  const L = cum[cum.length - 1];
  const parts = Math.max(1, Math.round(L / step));
  const out = new Float64Array((parts + 1) * 2);
  const q: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 };
  for (let k = 0; k <= parts; k++) {
    pointAt(p, cum, (L * k) / parts, q);
    out[2 * k] = q.x;
    out[2 * k + 1] = q.y;
  }
  return out;
}

/**
 * 오른쪽으로 off(m)만큼 옮긴 꺾은선 (점마다 앞뒤 선분의 이등분 방향, 꺾인 곳이 뾰족하면 그 길이를 2배까지만).
 * off는 점마다 다를 수 있다.
 */
export function offsetPoly(p: Poly, off: number | Float64Array): Poly {
  const n = p.length / 2;
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    const o = typeof off === "number" ? off : off[i];
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    // 앞뒤 선분 방향
    let x1 = p[2 * i] - p[2 * a];
    let y1 = p[2 * i + 1] - p[2 * a + 1];
    let x2 = p[2 * b] - p[2 * i];
    let y2 = p[2 * b + 1] - p[2 * i + 1];
    let l1 = Math.hypot(x1, y1);
    let l2 = Math.hypot(x2, y2);
    if (l1 < 1e-9) {
      x1 = x2;
      y1 = y2;
      l1 = l2;
    }
    if (l2 < 1e-9) {
      x2 = x1;
      y2 = y1;
      l2 = l1;
    }
    l1 = l1 || 1;
    l2 = l2 || 1;
    // 오른쪽 법선: (ty, -tx)
    const n1x = y1 / l1;
    const n1y = -x1 / l1;
    const n2x = y2 / l2;
    const n2y = -x2 / l2;
    let mx = n1x + n2x;
    let my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = n2x;
      my = n2y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cosHalf = Math.max(0.5, mx * n2x + my * n2y);
    out[2 * i] = p[2 * i] + (mx * o) / cosHalf;
    out[2 * i + 1] = p[2 * i + 1] + (my * o) / cosHalf;
  }
  return out;
}

/** 꺾은선 둘을 잇는다 (앞 선의 끝점과 뒤 선의 첫 점이 같으면 하나만) */
export function concat(parts: Poly[]): Poly {
  const pts: number[] = [];
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      const n = pts.length;
      if (n >= 2 && Math.abs(pts[n - 2] - p[i]) < 1e-6 && Math.abs(pts[n - 1] - p[i + 1]) < 1e-6) continue;
      pts.push(p[i], p[i + 1]);
    }
  }
  return Float64Array.from(pts);
}

/** 거꾸로 */
export function reversePoly(p: Poly): Poly {
  const n = p.length / 2;
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = p[2 * (n - 1 - i)];
    out[2 * i + 1] = p[2 * (n - 1 - i) + 1];
  }
  return out;
}

/** u0~u1 부분 (양 끝은 보간한 점) */
export function slicePoly(p: Poly, cum: Float64Array, u0: number, u1: number): Poly {
  const pts: number[] = [];
  const q: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 };
  pointAt(p, cum, u0, q);
  pts.push(q.x, q.y);
  for (let i = 0; i < cum.length; i++) if (cum[i] > u0 + 1e-6 && cum[i] < u1 - 1e-6) pts.push(p[2 * i], p[2 * i + 1]);
  pointAt(p, cum, u1, q);
  pts.push(q.x, q.y);
  return Float64Array.from(pts);
}

/** 각도 차이를 -π~π로 */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** 점 (x, y)에서 선분 a-b까지 가장 가까운 점의 비율 t (0~1)와 거리² */
export function segmentNearest(x: number, y: number, ax: number, ay: number, bx: number, by: number): { t: number; d2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  const px = ax + dx * t - x;
  const py = ay + dy * t - y;
  return { t, d2: px * px + py * py };
}

/** 점들의 볼록 껍질 (반시계, 모노톤 체인) */
export function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
