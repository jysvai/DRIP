// 교차로 신호: 서울 간선도로에 흔한 동시신호.
//   주도로 직진(+우회전) → 주도로 좌회전(보호) → 교차도로 직진 → 교차도로 좌회전, 각 끝에 황색(3~5초)·전적색 2초.
//   맞은편이 없는 접근로(삼거리의 가지)는 직진·좌회전을 한 현시에 준다.
// 등화: 가로형 4색 [적색 | 황색 | 녹색 좌회전 화살표 | 녹색]. 우회전은 신호와 상관없이 (적색이면 일시정지 뒤) 할 수 있다.
// 교차로마다 주기 안 시작 시각(offset)을 교차로 번호로 흩뜨린다 (연동 신호는 아직 없다).

import type { CityNet, Turn } from "./net";
import { wrapAngle } from "./geom";

/** 황색 시간 기본값 (s): 50km/h 길 */
export const YELLOW = 3;
export const ALL_RED = 2;

/**
 * 황색 시간 (s): 인지·반응 1초 + 접근 속도에서 3.05m/s²로 서는 시간 (ITE 황색 시간 식), 3~5초.
 * 50km/h 3초, 60~70km/h 4초, 80km/h 5초. 빠른 국도에서 설 수도 지나갈 수도 없는 구간(딜레마 구간)이 생기지 않게
 */
export function yellowFor(kmh: number): number {
  return Math.max(YELLOW, Math.min(5, Math.round(1 + kmh / 3.6 / (2 * 3.05))));
}

type PhaseKind = "S" | "L" | "SL";

export interface Phase {
  kind: PhaseKind;
  /** 이 현시에 가는 접근로 (approaches 번호) */
  approaches: number[];
  green: number;
  /** 황색 시간 (s) */
  yellow: number;
  /** 주기 안에서 녹색이 시작하는 시각 (s) */
  start: number;
}

export interface SignalPlan {
  junction: number;
  cycle: number;
  offset: number;
  phases: Phase[];
  /** 접근로마다 들어오는 링크들 */
  approaches: number[][];
  /** 들어오는 링크 → 접근로 번호 */
  approachOf: Map<number, number>;
}

export type Go = "go" | "yellow" | "stop";

export interface Lamps {
  red: boolean;
  yellow: boolean;
  left: boolean;
  green: boolean;
}

/** 녹색 시간 (s): 도로 등급별 */
function greenFor(kind: PhaseKind, cls: string): number {
  const c = cls[0];
  if (kind === "L") return c === "p" || c === "t" ? 16 : 12;
  if (kind === "SL") return c === "p" || c === "t" ? 28 : c === "s" ? 22 : 16;
  return c === "p" || c === "t" ? 40 : c === "s" ? 32 : 22;
}

function rank(cls: string): number {
  return { t: 4, p: 3, s: 2, r: 1 }[cls[0]] ?? 0;
}

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export class Signals {
  private plans = new Map<number, SignalPlan | null>();

  constructor(private net: CityNet) {}

  /** 교차로 신호 계획 (신호가 없으면 null) */
  plan(jid: number): SignalPlan | null {
    if (this.plans.has(jid)) return this.plans.get(jid)!;
    const p = this.build(jid);
    this.plans.set(jid, p);
    return p;
  }

  private build(jid: number): SignalPlan | null {
    const net = this.net;
    const j = net.junctions[jid];
    if (!j.signal || j.minor) return null;
    const approaches = net.approaches(jid);
    if (!approaches.length) return null;
    const approachOf = new Map<number, number>();
    approaches.forEach((links, a) => links.forEach((l) => approachOf.set(l, a)));
    const head = (a: number) => net.links[approaches[a][0]].headIn;
    const best = (a: number) => Math.max(...approaches[a].map((l) => rank(net.links[l].cls)));
    const cls = (a: number) => approaches[a].map((l) => net.links[l].cls).sort((x, y) => rank(y) - rank(x))[0];
    const yellow = (axis: number[]) => yellowFor(Math.max(...axis.flatMap((a) => approaches[a].map((l) => net.links[l].speed))));
    // 맞은편 접근로끼리 짝 (방향 차이 180°±40°)
    const axes: number[][] = [];
    const used = new Set<number>();
    for (let a = 0; a < approaches.length; a++) {
      if (used.has(a)) continue;
      used.add(a);
      let mate = -1;
      for (let b = a + 1; b < approaches.length; b++) {
        if (used.has(b)) continue;
        if (Math.abs(Math.abs(wrapAngle(head(a) - head(b))) - Math.PI) < (40 * Math.PI) / 180) {
          mate = b;
          break;
        }
      }
      if (mate >= 0) used.add(mate);
      axes.push(mate >= 0 ? [a, mate] : [a]);
    }
    // 주도로(등급 높은 축) 먼저
    axes.sort((x, y) => Math.max(...y.map(best)) - Math.max(...x.map(best)) || y.length - x.length);
    const hasLeft = (a: number) => approaches[a].some((l) => net.movementsFrom(l).some((m) => m.turn === "L"));
    const phases: Phase[] = [];
    let t = 0;
    for (const axis of axes) {
      const top = axis.map(cls).sort((x, y) => rank(y) - rank(x))[0];
      const y = yellow(axis);
      if (axis.length === 1) {
        const g = greenFor("SL", top);
        phases.push({ kind: "SL", approaches: axis, green: g, yellow: y, start: t });
        t += g + y + ALL_RED;
        continue;
      }
      const gs = greenFor("S", top);
      phases.push({ kind: "S", approaches: axis, green: gs, yellow: y, start: t });
      t += gs + y + ALL_RED;
      const lefts = axis.filter(hasLeft);
      if (lefts.length) {
        const gl = greenFor("L", top);
        phases.push({ kind: "L", approaches: lefts, green: gl, yellow: y, start: t });
        t += gl + y + ALL_RED;
      }
    }
    return { junction: jid, cycle: t, offset: hash(jid) * t, phases, approaches, approachOf };
  }

  /** 주기 안 시각 */
  private local(p: SignalPlan, t: number): number {
    const x = (t + p.offset) % p.cycle;
    return x < 0 ? x + p.cycle : x;
  }

  /** 지금 현시와 그 안에서 흐른 시간 */
  private current(p: SignalPlan, t: number): { phase: Phase; into: number } {
    const x = this.local(p, t);
    let cur = p.phases[0];
    for (const ph of p.phases) if (ph.start <= x) cur = ph;
    return { phase: cur, into: x - cur.start };
  }

  /** 이 현시에 이 접근로의 이 방향이 가는지 */
  private allows(ph: Phase, approach: number, turn: Turn): boolean {
    if (!ph.approaches.includes(approach)) return false;
    if (ph.kind === "SL") return true;
    if (ph.kind === "S") return turn === "S" || turn === "R";
    return turn === "L";
  }

  /**
   * 들어오는 링크 link에서 turn 방향으로 지금 가도 되는지. 신호가 없는 교차로는 "go".
   * 우회전은 녹색이 아니어도 "stop"이 아니라 신호를 본 값 그대로 돌려준다 (적색 우회전은 부르는 쪽이 일시정지·양보로 다룬다).
   */
  go(jid: number, link: number, turn: Turn, t: number): Go {
    const p = this.plan(jid);
    if (!p) return "go";
    const a = p.approachOf.get(link);
    if (a === undefined) return "go";
    const { phase, into } = this.current(p, t);
    if (!this.allows(phase, a, turn)) return "stop";
    if (into < phase.green) return "go";
    if (into < phase.green + phase.yellow) return "yellow";
    return "stop";
  }

  /** 이 방향이 다음에 녹색이 될 때까지 남은 시간 (지금 녹색이면 0) */
  waitFor(jid: number, link: number, turn: Turn, t: number): number {
    const p = this.plan(jid);
    if (!p) return 0;
    const a = p.approachOf.get(link);
    if (a === undefined) return 0;
    const x = this.local(p, t);
    let best = Infinity;
    for (const ph of p.phases) {
      if (!this.allows(ph, a, turn)) continue;
      if (x >= ph.start && x < ph.start + ph.green) return 0;
      const d = (ph.start - x + p.cycle) % p.cycle;
      best = Math.min(best, d);
    }
    return best;
  }

  /** 접근로 신호등에 켜진 등 */
  lamps(jid: number, approach: number, t: number): Lamps {
    const out: Lamps = { red: true, yellow: false, left: false, green: false };
    const p = this.plan(jid);
    if (!p) return out;
    const { phase, into } = this.current(p, t);
    if (!phase.approaches.includes(approach)) return out;
    const amber = into >= phase.green && into < phase.green + phase.yellow;
    const red = into >= phase.green + phase.yellow;
    if (red) return out;
    if (amber) return { red: false, yellow: true, left: false, green: false };
    if (phase.kind === "L") return { red: true, yellow: false, left: true, green: false };
    return { red: false, yellow: false, left: phase.kind === "SL", green: true };
  }
}
