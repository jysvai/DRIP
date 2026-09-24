// 시내 교통.
//   경로를 따라 달리는 차와 반대편 차는 고속도로와 같은 Traffic(sim/traffic.ts)이 움직이고, 여기서는 신호·교차로를 알려 준다
//   (stopFor: 적색 신호 정지선과 교차로를 막은 차, laneEnd: 다음 교차로에서 갈 곳이 없는 차로).
//   경로를 벗어나는 차(경로가 도는 교차로에서 다른 차로에 있는 차, 오른쪽 끝 차로에서 우회전하는 차)와 교차로를 건너는 차는
//   도로망 위(월드 좌표)의 길을 따라 따로 움직인다(자유 차). 자유 차가 경로 도로나 그 반대편 차도로 들어오면 경로 차로 넘긴다.
//   교통량은 도로 등급별 차로당 시간 교통량(어림)에 메뉴의 교통 설정·시간대 배율을 곱한다. 실제 사고 자료는 쓰지 않는다.

import type { Road } from "../road/road";
import type { Agent, Traffic, TrafficCity } from "../sim/traffic";
import { idm } from "../sim/traffic";
import type { Rng } from "../sim/rng";
import { CITY_LANE, type CityNet, type Movement, type Turn } from "./net";
import type { CityStop } from "./route";
import type { Signals } from "./signals";
import {
  concat,
  cumLengths,
  offsetPoly,
  pointAt,
  slicePoly,
  wrapAngle,
  type Poly,
  type PolyPoint,
} from "./geom";

const LW = CITY_LANE;
/** 교차로를 건너는 차: 차로당 시간 교통량 (대/시, 보통 날 낮 어림), 도로 등급 첫 글자별 */
const FLOW: Record<string, number> = { t: 650, p: 560, s: 400, r: 240 };
/** 건너는 차를 만드는 신호 교차로: 플레이어 뒤·앞 (m) */
const FEED_BEHIND = 40;
const FEED_AHEAD = 320;
/** 건너는 차가 나타나는 곳: 정지선 뒤 (m) */
const SPAWN_BACK = 130;
/** 교차로를 지나 이만큼 달리면 사라진다 (m) */
const EXIT_RUN = 110;
const MAX_FREE = 70;
/**
 * 교차로 안에서 이만큼(s) 넘게 서 있으면 서로 길을 막은 것(교착)으로 보고, 교차로를 빠져나갈 때까지 다른 차에 양보하지 않고 비집고 지나간다.
 * (플레이어 차는 그래도 피한다)
 */
const GRIDLOCK_SEC = 15;
/** 교차로 곡선에서 회전 속도 (m/s) */
const TURN_V: Record<Turn, number> = { L: 8, R: 6, S: 99 };
/** 건너는 차의 방향 비율 (그 차로에서 갈 수 있는 것 중에서) */
const TURN_SHARE: Record<Turn, number> = { S: 0.7, L: 0.15, R: 0.15 };
/** 적색 우회전: 정지선에 서서 살피는 시간 (s) */
const RTOR_WAIT = 1.8;
/** 경로를 따라 오른쪽 끝 차로를 달리는 차가 직진 교차로에서 우회전해 빠지는 비율 */
const RIGHT_LEAVE = 0.25;

/** 서울 시내 차종 구성 (어림: 고속도로보다 택시·버스가 많고 화물이 적다) */
export const CITY_COMPOSITION: Record<string, number> = {
  승용: 0.46,
  SUV: 0.22,
  전기차: 0.07,
  택시: 0.12,
  버스: 0.06,
  화물: 0.07,
};

interface Path {
  pts: Poly;
  cum: Float64Array;
  len: number;
  /** 높이: [경로 위 거리, 높이] 몇 점 사이를 곧게 */
  z: [number, number][];
}

interface Free {
  a: Agent;
  path: Path;
  /** 차 가운데의 경로 위 거리 */
  u: number;
  /** 정지선 (경로 위 거리, 없으면 -1)과 넘었는지 */
  stopU: number;
  committed: boolean;
  jid: number;
  /** 들어오는 링크와 그 차로 가운데 */
  link: number;
  dFrom: number;
  /** 나가는 링크와 그 차로 가운데 (같으면 같은 차로로 들어간다) */
  to: number;
  dTo: number;
  turn: Turn;
  /** 교차로 곡선 구간 */
  mvStart: number;
  mvEnd: number;
  v0: number;
  handoff: { opposite: boolean; s: number; lane: number } | null;
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** 교차로 안에서 서 있은 시간 (s) */
  stuck: number;
  /** 교착을 풀려고 다른 차를 무시하고 지나가는 중 */
  ghost: boolean;
  /** 플레이어와 맞닿은 채 둘 다 서 버려서, 플레이어도 무시하고 먼저 빠져나간다 */
  letGo: boolean;
  /** 교차로를 넘은 뒤 플레이어 때문에 둘 다 서 있은 시간 (s) */
  playerWait: number;
  /** 정지선에 닿기 전 다른 차에 막혀 서 있은 시간 */
  idle: number;
}

/** 부딪힘을 볼 몸체 (도로망 좌표) */
interface Body {
  x: number;
  y: number;
  hx: number;
  hy: number;
  v: number;
  len: number;
  w: number;
  ref: unknown;
  /** 교차로(정지선 너머)에 들어간 차: 아직 들어가지 않은 차보다 먼저 간다 */
  entered: boolean;
  /** 교차로 밖에서 서 있는 차 (신호 대기): 코가 조금 나와 있어도 건너는 길을 막은 것으로 보지 않는다 */
  waiting: boolean;
}

export interface PlayerBody {
  s: number;
  x: number;
  y: number;
  /** 차도 높이 (m). 고가·지하차도로 위아래를 지나는 차와는 부딪히지 않는다 */
  z?: number;
  hx: number;
  hy: number;
  v: number;
  len: number;
  w: number;
}

const inLanes = (k: number, r: [number, number]) => k >= r[0] && k <= r[1];
const mirror = (t: Turn): Turn => (t === "L" ? "R" : t === "R" ? "L" : "S");

export class CityTraffic implements TrafficCity {
  /** 경로 밖을 달리는 차 (TrafficView에 같이 넘긴다) */
  readonly free: Agent[] = [];
  private cars: Free[] = [];
  private stops: CityStop[];
  private routeLinks: [number, number, number, number, number][];
  /** 경로 링크 → routeLinks 번호, 경로 링크의 반대 방향 링크 → routeLinks 번호 */
  private byLink = new Map<number, number>();
  private byReverse = new Map<number, number>();
  private opposing = new Map<CityStop, number>();
  private fates = new Map<
    Agent,
    {
      st: CityStop;
      lane: number;
      roll: number;
      mv: number;
      turn: Turn;
      leave: boolean;
    }
  >();
  private lastS = new Map<Agent, number>();
  private boxStuck = new Map<Agent, number>();
  private primed = new Set<number>();
  private lanePolys = new Map<string, { pts: Poly; cum: Float64Array }>();
  private bodies: Body[] = [];
  private tw = { e: 0, n: 0, z: 0, heading: 0 };
  private q: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 };
  private q2: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 };
  private readonly ox: number;
  private readonly oy: number;
  /** 교통량 배율 (보통 날 낮 = 1) */
  scale = 1;
  /**
   * 갈림길: 경로 링크 i 끝의 작은 교차로(신호·정지선 없는 곳)에서 경로로 이어지지 않는 차로 → 그 차로가 가는 다른 갈래.
   * 이 차로의 차는 차로가 끝나는 것이 아니라 그 갈래로 빠져나간다 (예: 3차로 중 1차로만 고가로 올라가는 곳)
   */
  private splits = new Map<number, Map<number, Movement>>();
  /** 갈림길에서 경로가 가는 이동 (경로 링크 번호 → 이동) */
  private splitMv = new Map<number, Movement>();
  /** 차로 번호를 나갈 도로 것으로 바꾸는 곳: 교차로·갈림길 곡선 가운데 s와 그 이동 (s 순) */
  private remaps: { mid: number; mv: Movement }[] = [];

  constructor(
    private net: CityNet,
    private signals: Signals,
    private road: Road,
    private traffic: Traffic,
    private clock: () => number,
    private rng: Rng,
  ) {
    const c = road.city!;
    this.stops = c.stops;
    this.routeLinks = c.links;
    c.links.forEach((e, i) => {
      this.byLink.set(e[2], i);
      const r = net.links[e[2]].reverse;
      if (r >= 0) this.byReverse.set(r, i);
    });
    [this.ox, this.oy] = net.graph.origin;
    for (let i = 0; i + 1 < c.links.length; i++) {
      const from = net.movementsFrom(c.links[i][2]);
      const mv = from.find((m) => m.to === c.links[i + 1][2]);
      if (!mv || !net.junctions[mv.junction].minor) continue;
      this.splitMv.set(i, mv);
      const lanes = new Map<number, Movement>();
      for (let lane = 1; lane <= net.links[c.links[i][2]].lanes; lane++) {
        if (inLanes(lane, mv.fromLanes)) continue;
        const alt = from.find((m) => m.id !== mv.id && inLanes(lane, m.fromLanes));
        if (alt) lanes.set(lane, alt);
      }
      if (lanes.size) this.splits.set(i, lanes);
    }
    for (const st of this.stops) this.remaps.push({ mid: (st.s + st.sExit) / 2, mv: net.movements[st.movement] });
    // 갈림길 곡선도: 오른쪽으로 빠지는 갈래로 가는 3차로는 나갈 도로 1차로가 된다
    for (const [bs0, bs1, , minor] of c.boxes) {
      if (!minor) continue;
      const i = this.routeLinks.findIndex((e) => Math.abs(e[1] - bs0) < 0.5);
      const mv = this.splitMv.get(i);
      if (mv) this.remaps.push({ mid: (bs0 + bs1) / 2, mv });
    }
    this.remaps.sort((a, b) => a.mid - b.mid);
  }

  /** s가 든 경로 링크 번호 (링크 뒤 교차로 곡선도 그 링크 것으로) */
  private routeIndex(s: number): number {
    const L = this.routeLinks;
    let lo = 0;
    let hi = L.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (L[mid][0] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ---------------- 경로 차에 알려 주는 것 ----------------

  /** 곡선 가운데가 s보다 뒤인 첫 차로 번호 바꾸는 곳 */
  private remapIndex(s: number): number {
    let lo = 0;
    let hi = this.remaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.remaps[mid].mid <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 정지선이 s 이상인 첫 교차로 번호 */
  private stopIndex(s: number): number {
    let lo = 0;
    let hi = this.stops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.stops[mid].s < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 반대편 차 (s가 줄어드는 쪽으로 온다): 교차로 끝이 front 이하인 가장 가까운 교차로 */
  private oppStop(front: number): CityStop | null {
    let lo = 0;
    let hi = this.stops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.stops[mid].sExit <= front) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? this.stops[lo - 1] : null;
  }

  /** 경로가 나가는 도로에서 교차로로 들어오는 링크 (반대편 차가 오는 길). 없으면 -1 */
  private opposingLink(st: CityStop): number {
    const have = this.opposing.get(st);
    if (have !== undefined) return have;
    const net = this.net;
    const out = net.links[net.movements[st.movement].to];
    const want = out.headOut + Math.PI;
    let id = -1;
    let best = 0.7;
    for (const l of net.junctions[st.junction].inbound) {
      const d = Math.abs(wrapAngle(net.links[l].headIn - want));
      if (d < best) {
        best = d;
        id = l;
      }
    }
    this.opposing.set(st, id);
    return id;
  }

  /** 경로 차가 이 교차로에서 어디로 가는지: 경로대로, 또는 벗어나기 (차로를 바꾸면 다시 정한다) */
  private fate(a: Agent, st: CityStop) {
    const lane = a.targetLane;
    let f = this.fates.get(a);
    if (f && f.st === st && f.lane === lane) return f;
    const roll = f && f.st === st ? f.roll : this.rng.next();
    let mv = st.movement;
    let turn = st.turn;
    let leave = false;
    const from = this.net.movementsFrom(st.link);
    if (inLanes(lane, st.lanes)) {
      const lanes = this.road.lanesAt(Math.max(0, st.s - 3));
      if (st.turn !== "R" && lane === lanes && roll < RIGHT_LEAVE) {
        const r = from.find(
          (m) => m.turn === "R" && inLanes(lane, m.fromLanes),
        );
        if (r) {
          mv = r.id;
          turn = "R";
          leave = true;
        }
      }
    } else {
      const alt = (["S", "R", "L"] as Turn[])
        .map((t) =>
          from.find((m) => m.turn === t && inLanes(lane, m.fromLanes)),
        )
        .find((m) => !!m);
      if (alt) {
        mv = alt.id;
        turn = alt.turn;
        leave = true;
      }
    }
    f = { st, lane, roll, mv, turn, leave };
    this.fates.set(a, f);
    return f;
  }

  /** 신호: 서야 하면 정지선까지 거리, 가도 되면 Infinity. 적색 우회전은 정지선에 선 뒤 나갈 길로 오는 차가 없을 때 간다 */
  private light(
    a: Agent,
    jid: number,
    link: number,
    turn: Turn,
    to: number,
    dist: number,
    time: number,
  ): number {
    if (dist < -0.3) {
      a.hold = -1;
      return Infinity;
    }
    const go = this.signals.go(jid, link, turn, this.clock());
    if (go === "go") {
      a.hold = -1;
      return Infinity;
    }
    if (go === "yellow")
      return (a.v * a.v) / (2 * 3.5) < dist ? Math.max(0.1, dist) : Infinity;
    if (turn === "R") {
      const hold = a.hold ?? -1;
      if (hold < 0 && a.v < 0.5 && dist < 3) a.hold = time;
      if (hold >= 0 && time - hold > RTOR_WAIT && this.mergeClear(a, to))
        return Infinity;
    }
    return Math.max(0.1, dist);
  }

  /**
   * 적색 우회전: 나갈 링크 들머리로 4초 안에 닿을 차(파란불에 건너오는 차, 맞은편에서 좌회전하는 차)가 없는지.
   * 지난 걸음에 모은 몸체로 본다
   */
  private mergeClear(self: Agent, to: number): boolean {
    if (to < 0) return true;
    const l = this.net.links[to];
    const p = this.net.pointOnLink(
      to,
      Math.min(l.length, l.startDist + 3),
      this.q2,
    );
    for (const b of this.bodies) {
      if (b.ref === self || b.v < 1.5) continue;
      const rx = p.x - b.x;
      const ry = p.y - b.y;
      const d = Math.hypot(rx, ry);
      if (d > 45 || d / b.v > 4) continue;
      if (rx * b.hx + ry * b.hy > 0.5 * d) return false;
    }
    return true;
  }

  stopFor(a: Agent, time: number): number {
    if (a.pose) return Infinity;
    let best = Infinity;
    if (!a.opposite) {
      const front = a.s + a.len / 2;
      const st = this.stops[this.stopIndex(front - 0.3)];
      if (st && st.s - front < 150) {
        const f = this.fate(a, st);
        if (st.signal)
          best = this.light(
            a,
            st.junction,
            st.link,
            f.turn,
            this.net.movements[f.mv].to,
            st.s - 0.5 - front,
            time,
          );
      }
    } else {
      const front = -a.s - a.len / 2;
      const st = this.oppStop(front + 0.3);
      if (st && st.signal && front - st.sExit < 150) {
        const lin = this.opposingLink(st);
        if (lin >= 0)
          best = this.light(
            a,
            st.junction,
            lin,
            mirror(st.turn),
            this.net.links[st.link].reverse,
            front - (st.sExit + 0.5),
            time,
          );
      }
    }
    return Math.min(best, this.blockedAhead(a));
  }

  laneEnd(lane: number, s: number): number {
    const road = this.road;
    // 교차로 곡선 위: 곡선 가운데에서 차로 번호를 나갈 도로 것으로 바꾸므로 보지 않는다
    if (road.inBox(s)) return Infinity;
    const st = this.stops[this.stopIndex(s)];
    const lim = st ? Math.min(600, st.s - s) : 600;
    for (let ds = 0; ds <= lim; ds += 25) {
      const at = Math.min(road.length - 1, s + ds);
      if (road.lanesAt(at) >= lane) continue;
      // 갈림길 곡선에서 줄어드는 차로가 다른 갈래로 가면 (거기서 빠져나간다) 또는 경로 갈래로 이어지면 (곡선 가운데에서 번호가 바뀐다) 끝나는 것이 아니다
      const i = this.routeIndex(at);
      const mv = this.splitMv.get(i);
      if (at > this.routeLinks[i][1] && (this.splits.get(i)?.has(lane) || (mv && inLanes(lane, mv.fromLanes)))) return Infinity;
      return ds;
    }
    if (st && st.s - s < 600) {
      const ok =
        inLanes(lane, st.lanes) ||
        this.net.movementsFrom(st.link).some((m) => inLanes(lane, m.fromLanes));
      if (!ok) return Math.max(0, st.s - s);
    }
    return Infinity;
  }

  /**
   * 경로 차 바로 앞(40m 안)에 경로 밖 차가 있으면 그 간격 (방금 빠져나간 차, 교차로를 건너는 차).
   * 교차로 안에 들어간 차는 같은 쪽으로 가는 차만 본다 (건너는 길끼리 서로 기다리다 막히지 않게)
   */
  private blockedAhead(a: Agent): number {
    if (!this.cars.length) return Infinity;
    const road = this.road;
    const s = Math.max(0, Math.min(road.length - 1, a.opposite ? -a.s : a.s));
    const w = road.toWorld(s, a.d, this.tw);
    const sign = a.opposite ? -1 : 1;
    return this.gapAhead(
      w.e - this.ox,
      w.n - this.oy,
      Math.cos(w.heading) * sign,
      Math.sin(w.heading) * sign,
      a.len,
      a.width,
      40,
      !road.inBox(s),
      a.v,
    );
  }

  /**
   * (x, y)에서 (hx, hy) 쪽 range m 안의 경로 밖 차까지 간격 (차 앞 범퍼 기준).
   * crossing이 false면 같은 쪽으로 가는 차만 앞차로 보고, 엇갈리는 차는 만나는 곳에 먼저 닿는 쪽이 간다 (속도 v)
   */
  gapAhead(
    x: number,
    y: number,
    hx: number,
    hy: number,
    len: number,
    width: number,
    range = 60,
    crossing = true,
    v = 0,
  ): number {
    let best = Infinity;
    for (const f of this.cars) {
      if (!f.committed && f.a.v < 0.5 && Math.abs(f.hx * hx + f.hy * hy) < 0.7)
        continue;
      let g = coneGap(
        x,
        y,
        hx,
        hy,
        len,
        width,
        f.x,
        f.y,
        f.hx,
        f.hy,
        f.a.len,
        f.a.width,
        range,
        crossing,
      );
      if (!crossing)
        g = Math.min(
          g,
          conflictGap(
            x,
            y,
            hx,
            hy,
            len,
            width,
            v,
            true,
            f.x,
            f.y,
            f.hx,
            f.hy,
            f.a.len,
            f.a.width,
            f.a.v,
            f.committed,
            range,
          ),
        );
      if (g < best) best = g;
    }
    return best;
  }

  /**
   * 자동 운전: 경로 도로 lane 차로를 따라 앞 range m 안에 들어와 있는, 같은 쪽으로 가는 자유 차까지 간격
   * (합류하거나 차로가 모이는 곳에서 앞으로 들어오는 차. 가운데가 내 가운데보다 앞선 차만)
   */
  /** laneGap이 찾은 차의 (내 길 방향) 속도 */
  laneGapV = 0;

  laneGap(s: number, lane: number, len: number, width: number, range = 30): number {
    if (!this.cars.length) return Infinity;
    const road = this.road;
    for (let x = len / 2 + 1; x <= range; x += 2) {
      const ss = s + x;
      if (ss >= road.length - 1) break;
      const w = road.toWorld(ss, road.laneCenter(Math.max(1, Math.min(lane, road.lanesAt(ss))), ss), this.tw);
      const px = w.e - this.ox;
      const py = w.n - this.oy;
      const hx = Math.cos(w.heading);
      const hy = Math.sin(w.heading);
      let best = Infinity;
      for (const f of this.cars) {
        if (f.hx * hx + f.hy * hy < 0.7) continue;
        const rx = f.x - px;
        const ry = f.y - py;
        const along = rx * hx + ry * hy;
        if (x + along < 0) continue;
        const g = Math.max(0.1, x + along - f.a.len / 2 - len / 2);
        if (g < best && Math.abs(along) < f.a.len / 2 + 1 && Math.abs(ry * hx - rx * hy) < (width + f.a.width) / 2 + 0.3) {
          best = g;
          this.laneGapV = f.a.v * (f.hx * hx + f.hy * hy);
        }
      }
      if (best < Infinity) return best;
    }
    return Infinity;
  }

  /**
   * 자동 운전: 교차로에 이미 들어간 차(늦게 건너는 화물차 등)와 길이 엇갈리면 만나는 곳 앞까지 간격.
   * 내가 닿기 전에 상대가 다 지나가면 보지 않는다. 나도 들어갔으면 만나는 곳에 먼저 닿는 쪽이 간다 (자유 차와 같은 규칙).
   * 아직 들어가지 않은 차는 신호를 지키므로 보지 않는다
   */
  yieldGap(
    x: number,
    y: number,
    hx: number,
    hy: number,
    len: number,
    width: number,
    v: number,
    entered: boolean,
    range = 40,
  ): number {
    let best = Infinity;
    for (const f of this.cars) {
      if (!f.committed) continue;
      const det = hx * f.hy - hy * f.hx;
      const sn = Math.abs(det);
      if (sn < 0.26) continue;
      const rx = f.x - x;
      const ry = f.y - y;
      const t = (rx * f.hy - ry * f.hx) / det;
      const s = (rx * hy - ry * hx) / det;
      const mine = len / 2 + f.a.width / (2 * sn);
      const theirs = f.a.len / 2 + width / (2 * sn);
      if (t < mine || t > range || s < -theirs) continue;
      const tm = arrive(t - mine, v);
      // 상대 꽁무니가 만나는 곳을 빠져나가는 때 (지금 속도, 적어도 2m/s로 본다)
      if (tm > (s + theirs) / Math.max(2, f.a.v) + 0.5) continue;
      if (entered && Math.abs(s) >= theirs) {
        const tb = arrive(s - theirs, f.a.v);
        if (f.a.v < 0.5 || !(tb < tm - 0.3 || (Math.abs(tb - tm) <= 0.3 && x > f.x))) continue;
      }
      best = Math.min(best, Math.max(0.1, t - mine - 0.5));
    }
    return best;
  }

  // ---------------- 한 걸음 ----------------

  update(dt: number, time: number, player: PlayerBody) {
    this.unjam(dt);
    this.remapLanes();
    this.leaveRoute();
    this.leaveAtSplits();
    this.feed(dt, player.s);
    this.stepFree(dt, time, player);
  }

  /**
   * 교차로·갈림길 곡선 안에 25초 넘게 서 있는 경로 차는 뺀다 (어떤 이유로든 서로 기다리는 교착이 나도 길이 영영 막히지 않게).
   * 곡선 밖 신호 대기 줄은 건드리지 않는다
   */
  private unjam(dt: number) {
    const road = this.road;
    for (const a of this.traffic.agents) {
      if (a.parked || a.opposite) continue;
      const inBox = road.inJunction(Math.max(0, Math.min(road.length - 1, a.s)));
      // 차로 끝(교차로 안만 좁게 그려진 곳 등)에서 옆 차로로 끼어들지 못하고 서 있는 차도 20초 뒤 뺀다
      if (a.v < 0.3 && (inBox || this.laneEnd(a.lane, a.s) < 20)) {
        const t = (this.boxStuck.get(a) ?? 0) + dt;
        this.boxStuck.set(a, t);
        if (t > (inBox ? 25 : 20)) a.gone = true;
      } else if (this.boxStuck.size) this.boxStuck.delete(a);
    }
    if (this.boxStuck.size > 200) {
      const live = new Set(this.traffic.agents);
      for (const a of this.boxStuck.keys()) if (!live.has(a)) this.boxStuck.delete(a);
    }
  }

  /** 교차로 곡선 가운데를 지나면 차로 번호를 나갈 도로 것으로 (예: 편도 4차로 끝 차로에서 우회전 → 나갈 도로 2차로) */
  private remapLanes() {
    const road = this.road;
    for (const a of this.traffic.agents) {
      const prev = this.lastS.get(a);
      this.lastS.set(a, a.s);
      if (prev === undefined || a.s <= prev) continue;
      for (let k = this.remapIndex(prev); k < this.remaps.length; k++) {
        const { mid, mv } = this.remaps[k];
        if (mid > a.s) break;
        const lane = Math.max(
          mv.toLanes[0],
          Math.min(mv.toLanes[1], mv.toLanes[0] + (a.lane - mv.fromLanes[0])),
        );
        const lanes = road.lanesAt(a.s);
        const to = Math.max(1, Math.min(lanes, lane));
        if (to !== a.lane || a.targetLane !== a.lane) {
          a.lineNow += (a.lane - to) * LW;
          a.lane = a.targetLane = to;
          a.lcProgress = 0;
          a.pendingLane = 0;
          a.signal = 0;
        }
      }
    }
    if (this.lastS.size > this.traffic.agents.length * 2 + 50) {
      const live = new Set(this.traffic.agents);
      for (const a of this.lastS.keys()) if (!live.has(a)) this.lastS.delete(a);
      for (const a of this.fates.keys())
        if (!live.has(a) && !a.opposite) this.fates.delete(a);
    }
  }

  /** 갈림길에 닿은 차가 경로로 이어지지 않는 차로에 있으면 그 차로의 갈래로 빠져나간다 */
  private leaveAtSplits() {
    if (!this.splits.size) return;
    let out: Set<Agent> | null = null;
    for (const a of this.traffic.agents) {
      if (a.parked || a.pose || a.targetLane !== a.lane) continue;
      const front = a.s + a.len / 2;
      const i = this.routeIndex(front);
      const e = this.routeLinks[i];
      if (front < e[1] - 1 || front > e[1] + 6) continue;
      const alt = this.splits.get(i)?.get(a.lane);
      if (!alt || this.cars.length >= MAX_FREE) continue;
      const back = 8;
      const l = this.net.links[e[2]];
      const car = this.makeFree(a, alt, a.lane, l.length - l.stopDist - back, a.v, -1);
      if (!car) continue;
      car.u = back - (e[1] - a.s);
      car.committed = true;
      a.yaw = 0;
      a.lineNow = 0;
      this.addFree(car);
      (out ??= new Set()).add(a);
    }
    if (out) this.traffic.agents = this.traffic.agents.filter((a) => !out!.has(a));
  }

  /** 경로를 벗어나기로 한 차가 정지선을 넘으면 자유 차로 */
  private leaveRoute() {
    let out: Set<Agent> | null = null;
    for (const a of this.traffic.agents) {
      if (a.parked) continue;
      const f = this.fates.get(a);
      if (!f || !f.leave || f.lane !== a.lane) continue;
      const front = a.s + a.len / 2;
      if (front < f.st.s || front > f.st.s + 6) continue;
      if (this.cars.length >= MAX_FREE) continue;
      const back = 8;
      const l = this.net.links[f.st.link];
      const car = this.makeFree(
        a,
        this.net.movements[f.mv],
        a.lane,
        l.length - l.stopDist - back,
        a.v,
        -1,
      );
      if (!car) continue;
      car.u = back - (f.st.s - a.s);
      car.committed = true;
      a.yaw = 0;
      a.lineNow = 0;
      this.addFree(car);
      (out ??= new Set()).add(a);
    }
    if (out)
      this.traffic.agents = this.traffic.agents.filter((a) => !out!.has(a));
  }

  /** 앞뒤 신호 교차로의 다른 접근로에 건너는 차를 만든다 */
  private feed(dt: number, playerS: number) {
    if (this.scale <= 0) return;
    for (
      let k = this.stopIndex(playerS - FEED_BEHIND);
      k < this.stops.length;
      k++
    ) {
      const st = this.stops[k];
      if (st.s > playerS + FEED_AHEAD) break;
      if (!st.signal) continue;
      const plan = this.signals.plan(st.junction);
      if (!plan) continue;
      const skip = new Set([st.link, this.opposingLink(st)]);
      const first = !this.primed.has(st.junction);
      this.primed.add(st.junction);
      for (const group of plan.approaches) {
        if (group.some((l) => skip.has(l))) continue;
        for (const lid of group) {
          const l = this.net.links[lid];
          const rate = ((FLOW[l.cls[0]] ?? 240) * this.scale) / 3600;
          for (let lane = 1; lane <= l.lanes; lane++) {
            if (first) this.prefill(st, lid, lane, rate);
            else if (this.cars.length < MAX_FREE && this.rng.next() < rate * dt)
              this.spawnCross(st, lid, lane, SPAWN_BACK, 8);
          }
        }
      }
    }
  }

  /** 처음 가까워진 교차로: 접근로 차로마다 몇 대를 미리 둔다 (1분쯤 쌓인 만큼) */
  private prefill(st: CityStop, lid: number, lane: number, rate: number) {
    const n = Math.min(5, Math.floor(rate * 45 + this.rng.next()));
    let back = 4 + this.rng.next() * 6;
    for (
      let i = 0;
      i < n && back < SPAWN_BACK && this.cars.length < MAX_FREE;
      i++
    ) {
      this.spawnCross(st, lid, lane, back, 0);
      back += 7.5 + this.rng.next() * 18;
    }
  }

  private spawnCross(
    st: CityStop,
    lid: number,
    lane: number,
    back: number,
    v: number,
  ) {
    const net = this.net;
    const l = net.links[lid];
    const stopU = l.length - l.stopDist;
    const u0 = Math.max(l.startDist + 2, stopU - back);
    if (stopU - u0 < 3) return;
    const opts = net
      .movementsFrom(lid)
      .filter((m) => inLanes(lane, m.fromLanes));
    if (!opts.length) return;
    let sum = 0;
    for (const m of opts) sum += TURN_SHARE[m.turn];
    let r = this.rng.next() * sum;
    let mv = opts[0];
    for (const m of opts) {
      r -= TURN_SHARE[m.turn];
      if (r <= 0) {
        mv = m;
        break;
      }
    }
    const car = this.makeFree(
      this.traffic.create(),
      mv,
      lane,
      u0,
      v,
      st.junction,
    );
    if (!car) return;
    // 나타날 자리에 이미 차가 있으면 그만둔다 (달려서 나타나는 차는 설 수 있는 거리까지)
    for (const f of this.cars) {
      const need = (f.a.len + car.a.len) / 2 + 3 + (v * v) / 4;
      if ((f.x - car.x) ** 2 + (f.y - car.y) ** 2 < need * need) return;
    }
    this.addFree(car);
  }

  private addFree(car: Free) {
    this.cars.push(car);
    this.free.push(car.a);
  }

  /** 차로 가운데 선 (차도 가운데에서 오른쪽으로 d) */
  private lanePoly(link: number, d: number) {
    const key = `${link}|${d.toFixed(2)}`;
    let p = this.lanePolys.get(key);
    if (!p) {
      const pts = offsetPoly(this.net.geom(link).pts, d);
      p = { pts, cum: cumLengths(pts) };
      if (this.lanePolys.size > 600) this.lanePolys.clear();
      this.lanePolys.set(key, p);
    }
    return p;
  }

  /**
   * 자유 차의 길: 들어오는 링크 차로(uFrom부터 정지선까지) → 교차로 곡선 → 나가는 링크 차로 EXIT_RUN m.
   * jid ≥ 0이면 정지선에서 신호를 본다
   */
  private makeFree(
    a: Agent,
    mv: Movement,
    lane: number,
    uFrom: number,
    v: number,
    jid: number,
  ): Free | null {
    const net = this.net;
    const A = net.links[mv.from];
    const B = net.links[mv.to];
    const ga = net.geom(A.id);
    const gb = net.geom(B.id);
    const n = A.lanes;
    const m = B.lanesStart;
    const k = Math.max(1, Math.min(n, lane));
    const dFrom = -(n * LW) / 2 + (k - 0.5) * LW;
    const k2 = Math.max(
      mv.toLanes[0],
      Math.min(mv.toLanes[1], mv.toLanes[0] + (k - mv.fromLanes[0])),
    );
    const dTo = -(m * LW) / 2 + (Math.min(k2, m) - 0.5) * LW;
    const sStop = (A.length - A.stopDist) * ga.scale;
    const sFrom = Math.max(0, Math.min(sStop - 1, uFrom * ga.scale));
    const pa = this.lanePoly(A.id, dFrom);
    const part1 = slicePoly(pa.pts, pa.cum, sFrom, sStop);
    const mp = net.movementPath(mv.id, dFrom, dTo);
    const sStart = B.startDist * gb.scale;
    const sEnd = Math.min(gb.length, sStart + EXIT_RUN);
    if (sEnd - sStart < 5) return null;
    const pb = this.lanePoly(B.id, dTo);
    const part3 = slicePoly(pb.pts, pb.cum, sStart, sEnd);
    const pts = concat([part1, mp.pts, part3]);
    const cum = cumLengths(pts);
    const len = cum[cum.length - 1];
    const len1 = cumLengths(part1)[part1.length / 2 - 1];
    const len2 = mp.cum[mp.cum.length - 1];
    // 높이: 접근로·나갈 길은 10m마다 그 링크 높이, 교차로 안은 이동 경로 높이 (비탈에서 차가 뜨거나 묻히지 않게)
    const zAt = (id: number, u: number) => net.pointOnLink(id, u).z;
    const z: [number, number][] = [];
    const n1 = Math.max(1, Math.ceil((sStop - sFrom) / 10));
    for (let k = 0; k < n1; k++)
      z.push([(len1 * k) / n1, zAt(A.id, (sFrom + ((sStop - sFrom) * k) / n1) / ga.scale)]);
    for (let i = 0; i < mp.z.length; i++) z.push([len1 + mp.cum[i], mp.z[i]]);
    const len3 = len - len1 - len2;
    const n3 = Math.max(1, Math.ceil((sEnd - sStart) / 10));
    for (let k = 1; k <= n3; k++)
      z.push([len1 + len2 + (len3 * k) / n3, zAt(B.id, (sStart + ((sEnd - sStart) * k) / n3) / gb.scale)]);
    const path: Path = { pts, cum, len, z };
    // 경로 도로(또는 그 반대편)로 들어가면 넘길 곳
    let handoff: Free["handoff"] = null;
    const ri = this.byLink.get(B.id);
    const oi = this.byReverse.get(B.id);
    if (ri !== undefined) {
      const e = this.routeLinks[ri];
      const s =
        e[0] +
        ((B.startDist - e[3]) / Math.max(1e-6, e[4] - e[3])) * (e[1] - e[0]);
      if (s >= e[0] - 1 && s <= e[1])
        handoff = { opposite: false, s: Math.max(e[0], s), lane: k2 };
    } else if (oi !== undefined) {
      const e = this.routeLinks[oi];
      const L = net.links[e[2]];
      const uL = L.length - B.startDist;
      const s =
        e[0] + ((uL - e[3]) / Math.max(1e-6, e[4] - e[3])) * (e[1] - e[0]);
      if (s >= e[0] && s <= e[1] + 1)
        handoff = { opposite: true, s: Math.min(e[1], s), lane: k2 };
    }
    a.v = v;
    a.lane = a.targetLane = k;
    a.pendingLane = 0;
    a.lcProgress = 0;
    a.hold = -1;
    a.signal = 0;
    a.pose = { e: 0, n: 0, z: 0, heading: 0, kappa: 0 };
    const car: Free = {
      a,
      path,
      u: 0,
      stopU: jid >= 0 ? len1 : -1,
      committed: jid < 0,
      jid,
      link: A.id,
      dFrom,
      to: B.id,
      dTo,
      turn: mv.turn,
      mvStart: len1,
      mvEnd: len1 + len2,
      v0:
        (Math.min(A.speed, B.speed) / 3.6) *
        Math.max(0.8, Math.min(1.15, a.speedFactor)),
      handoff,
      x: 0,
      y: 0,
      hx: 1,
      hy: 0,
      stuck: 0,
      ghost: false,
      letGo: false,
      playerWait: 0,
      idle: 0,
    };
    this.poseOf(car);
    return car;
  }

  private zOf(p: Path, u: number): number {
    const z = p.z;
    if (z.length < 2) return z[0][1];
    let lo = 1;
    let hi = z.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (z[mid][0] < u) lo = mid + 1;
      else hi = mid;
    }
    const [u0, z0] = z[lo - 1];
    const [u1, z1] = z[lo];
    const t = u1 > u0 ? Math.max(0, Math.min(1, (u - u0) / (u1 - u0))) : 0;
    return z0 + (z1 - z0) * t;
  }

  private poseOf(f: Free) {
    const p = f.path;
    const u = Math.max(0, Math.min(p.len, f.u));
    // 앞뒤 끝 가까이(바퀴 자리)가 길 위에 오게 놓는다. 가운데 접선으로 놓으면 돌 때 긴 차 꽁무니가 바깥 차로로 휘둘린다
    const k = f.a.len * 0.45;
    const r = this.onPath(p, u - k, this.q);
    const rx = r.x;
    const ry = r.y;
    const t0 = Math.atan2(r.ty, r.tx);
    const fr = this.onPath(p, u + k, this.q2);
    const n = Math.hypot(fr.x - rx, fr.y - ry) || 1;
    f.hx = (fr.x - rx) / n;
    f.hy = (fr.y - ry) / n;
    f.x = (rx + fr.x) / 2;
    f.y = (ry + fr.y) / 2;
    const h = Math.atan2(f.hy, f.hx);
    const pose = f.a.pose!;
    pose.e = f.x + this.ox;
    pose.n = f.y + this.oy;
    pose.z = this.zOf(p, u);
    pose.heading = h;
    pose.kappa = wrapAngle(Math.atan2(fr.ty, fr.tx) - t0) / Math.max(1, 2 * k);
  }

  /** 길 위 u 자리 (길 끝 너머는 끝 방향으로 곧게 늘인다) */
  private onPath(p: Path, u: number, out: PolyPoint): PolyPoint {
    const q = pointAt(p.pts, p.cum, u, out);
    const over = u < 0 ? u : u > p.len ? u - p.len : 0;
    q.x += q.tx * over;
    q.y += q.ty * over;
    return q;
  }

  /**
   * 내 길 앞(1.5초 거리, 적어도 8m)이 플레이어 차체나 1초 뒤 플레이어 자리에 닿으면 그 앞까지 간격.
   * 합류하는 곳·차로가 모이는 곳에서 나란히 가던 플레이어를 옆에서 덮치지 않는다
   */
  private pathMeets(f: Free, pb: PlayerBody): number {
    const a = f.a;
    const reach = Math.max(8, a.v * 1.5);
    const dx = pb.x - f.x;
    const dy = pb.y - f.y;
    if (dx * dx + dy * dy > (reach + a.len + 10) ** 2) return Infinity;
    // 플레이어가 통째로 내 뒤에 있으면 내가 먼저 (뒤차가 기다린다)
    if (dx * f.hx + dy * f.hy + pb.len / 2 < -a.len / 2) return Infinity;
    const lead = Math.max(0, pb.v);
    for (let i = 1; i <= 8; i++) {
      const d = (reach * i) / 8;
      const u = f.u + a.len / 2 + d;
      if (u > f.path.len) break;
      const q = pointAt(f.path.pts, f.path.cum, u, this.q2);
      const rx = q.x - pb.x;
      const ry = q.y - pb.y;
      const along = rx * pb.hx + ry * pb.hy;
      if (
        Math.abs(ry * pb.hx - rx * pb.hy) < (pb.w + a.width) / 2 + 0.2 &&
        along > -pb.len / 2 - 0.5 &&
        along < pb.len / 2 + 0.5 + lead
      )
        return Math.max(0.1, d - 1);
    }
    return Infinity;
  }

  /** 이번 걸음에 볼 몸체: 플레이어, 가까운 경로 차(반대편 포함), 자유 차 */
  private collect(player: PlayerBody): Body[] {
    const out = this.bodies;
    out.length = 0;
    const road = this.road;
    // 플레이어는 서 있어도 늘 피한다 (부딪히면 플레이어 기록에 남는다)
    const pIn = road.inJunction(
      Math.max(0, Math.min(road.length - 1, player.s)),
    );
    out.push({
      x: player.x,
      y: player.y,
      hx: player.hx,
      hy: player.hy,
      v: player.v,
      len: player.len,
      w: player.w,
      ref: "player",
      entered: pIn,
      waiting: false,
    });
    const add = (a: Agent, opp: boolean) => {
      const s = opp ? -a.s : a.s;
      if (Math.abs(s - player.s) > 220) return;
      const sr = Math.max(0, Math.min(road.length - 1, s));
      const w = road.toWorld(sr, a.d, this.tw);
      const sign = opp ? -1 : 1;
      const inBox = road.inJunction(sr);
      out.push({
        x: w.e - this.ox,
        y: w.n - this.oy,
        hx: Math.cos(w.heading) * sign,
        hy: Math.sin(w.heading) * sign,
        v: a.v,
        len: a.len,
        w: a.width,
        ref: a,
        entered: inBox,
        waiting: !inBox && a.v < 0.5,
      });
    };
    for (const a of this.traffic.agents) add(a, false);
    for (const a of this.traffic.opposite) add(a, true);
    for (const f of this.cars)
      out.push({
        x: f.x,
        y: f.y,
        hx: f.hx,
        hy: f.hy,
        v: f.a.v,
        len: f.a.len,
        w: f.a.width,
        ref: f.a,
        entered: f.committed,
        waiting: !f.committed && f.a.v < 0.5,
      });
    return out;
  }

  private stepFree(dt: number, time: number, player: PlayerBody) {
    const bodies = this.collect(player);
    if (!this.cars.length) return;
    for (const f of this.cars) {
      const a = f.a;
      let gap = Infinity;
      let vl = 0;
      let byPlayer = false;
      let byBody = false;
      if (f.ghost && !f.letGo && f.u > f.mvEnd + a.len) f.ghost = false;
      for (const b of bodies) {
        if (
          b.ref === a ||
          (f.ghost && b.ref !== "player") ||
          (f.letGo && b.ref === "player")
        )
          continue;
        if (b.waiting && Math.abs(b.hx * f.hx + b.hy * f.hy) < 0.7) continue;
        // 정지선을 넘은 차는 같은 쪽으로 가는 차(와 플레이어)만 앞차로 본다. 길이 엇갈리는 차는 교차로에 먼저 들어간 차, 만나는 곳에 먼저 닿는 차가 먼저
        let g = coneGap(
          f.x,
          f.y,
          f.hx,
          f.hy,
          a.len,
          a.width,
          b.x,
          b.y,
          b.hx,
          b.hy,
          b.len,
          b.w,
          50,
          !f.committed || b.ref === "player",
        );
        g = Math.min(
          g,
          conflictGap(
            f.x,
            f.y,
            f.hx,
            f.hy,
            a.len,
            a.width,
            a.v,
            f.committed,
            b.x,
            b.y,
            b.hx,
            b.hy,
            b.len,
            b.w,
            b.v,
            b.entered,
            40,
          ),
        );
        if (g < gap) {
          gap = g;
          vl = Math.max(0, b.v * (b.hx * f.hx + b.hy * f.hy));
          byPlayer = b.ref === "player";
          byBody = true;
        }
      }
      // 같은 접근로 차로의 앞차: 길이 꺾여 있어도 정지선까지 남은 거리로 본다
      if (f.u < f.mvStart) {
        const toStop = f.mvStart - f.u;
        for (const o of this.cars) {
          if (
            o === f ||
            o.link !== f.link ||
            Math.abs(o.dFrom - f.dFrom) > 0.5 ||
            o.u >= o.mvStart
          )
            continue;
          const ahead = toStop - (o.mvStart - o.u);
          if (ahead <= 0) continue;
          const g = ahead - (a.len + o.a.len) / 2;
          if (g < gap) {
            gap = g;
            vl = o.a.v;
            byPlayer = false;
            byBody = false;
          }
        }
      }
      // 같은 차로로 들어가는 차 (두 줄 회전이 한 차로로 모일 때, 적색 우회전과 직진): 교차로를 넘은 차끼리는 들어가는 곳에 가까운 차가 먼저
      if (f.committed) {
        const rem = f.path.len - f.u;
        for (const o of this.cars) {
          if (
            o === f ||
            !o.committed ||
            o.to !== f.to ||
            Math.abs(o.dTo - f.dTo) > 0.5
          )
            continue;
          const ahead = rem - (o.path.len - o.u);
          if (ahead <= 0) continue;
          const g = ahead - (a.len + o.a.len) / 2;
          if (g < gap) {
            gap = g;
            vl = o.a.v;
            byPlayer = false;
            byBody = false;
          }
        }
      }
      // 합류: 내 길이 플레이어 쪽으로 모이면 나란히 가던 플레이어가 먼저
      if (!f.letGo) {
        const g = this.pathMeets(f, player);
        if (g < gap) {
          gap = g;
          vl = Math.max(0, player.v * (player.hx * f.hx + player.hy * f.hy));
          byPlayer = true;
          byBody = true;
        }
      }
      // 정지선.파란불이어도 건너편 나갈 자리가 막혀 있으면 들어가지 않는다 (교차로를 막지 않게)
      if (!f.committed && f.stopU >= 0) {
        const dist = f.stopU - (f.u + a.len / 2);
        if (dist < -0.3) f.committed = true;
        else {
          let g = this.light(a, f.jid, f.link, f.turn, f.to, dist, time);
          if (
            g === Infinity &&
            dist < 25 &&
            (this.exitBlocked(f, bodies) || this.pathBlocked(f, bodies))
          )
            g = Math.max(0.1, dist);
          if (g < gap) {
            gap = g;
            vl = 0;
            byPlayer = false;
            byBody = false;
          }
        }
      }
      // 원하는 속도: 교차로 곡선에서는 회전 속도로 (25m 앞부터 줄인다)
      const front = f.u + a.len / 2;
      let v0 = f.v0;
      if (front > f.mvStart - 25 && f.u < f.mvEnd)
        v0 = Math.min(
          v0,
          TURN_V[f.turn] + Math.max(0, f.mvStart - front) * 0.3,
        );
      const acc = idm(a.v, v0, gap, a.v - vl, a);
      a.acc = acc;
      a.v = Math.max(0, a.v + acc * dt);
      f.u += a.v * dt;
      a.brake = acc < -0.9 || a.v < 0.3;
      if (f.committed && f.u < f.mvEnd && a.v < 0.3) {
        f.stuck += dt;
        if (f.stuck > GRIDLOCK_SEC) f.ghost = true;
        // 그래도 못 빠져나가면 (정지선의 플레이어와 서로 기다리는 교착) 플레이어도 보지 않고, 끝내 서 있으면 지운다
        if (f.stuck > GRIDLOCK_SEC * 2) f.letGo = true;
      } else if (a.v > 1) f.stuck = 0;
      // 서 있는 플레이어와 코를 맞댄 채 서로 기다리면 (교차로 안, 또는 플레이어 바로 앞에 나타난 차) 6초 뒤 먼저 비켜 간다
      const inFront =
        !f.committed &&
        coneGap(player.x, player.y, player.hx, player.hy, player.len, player.w, f.x, f.y, f.hx, f.hy, a.len, a.width, 10) < 8;
      if ((byPlayer || inFront) && a.v < 0.3 && player.v < 0.5) {
        f.playerWait += dt;
        if (f.playerWait > 6) f.letGo = f.ghost = true;
      } else f.playerWait = 0;
      // 정지선에 닿기 전인데 (신호 대기 줄이 아니라) 다른 차에 막혀 20초 넘게 서 있으면 (겹쳐 그려진 옆길에서 경로 차와 서로 기다리는 교착) 비켜 간다
      if (!f.committed && byBody && a.v < 0.3) {
        f.idle += dt;
        if (f.idle > 20) f.letGo = f.ghost = true;
      } else if (a.v > 1) f.idle = 0;
      // 방향지시등: 교차로 40m 앞부터 곡선을 다 돌 때까지
      a.signal =
        f.turn !== "S" && front > f.mvStart - 40 && f.u < f.mvEnd
          ? f.turn === "L"
            ? -1
            : 1
          : 0;
      this.poseOf(f);
    }
    // 끝난 차: 경로 도로로 들어왔으면 경로 차로 넘기고, 길 끝이나 멀어지면 지운다
    let removed = false;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const f = this.cars[i];
      const far = (f.x - player.x) ** 2 + (f.y - player.y) ** 2 > 450 * 450;
      const handed = !!f.handoff && f.u > f.mvEnd + 3 && this.handOff(f);
      if (handed || far || f.u >= f.path.len - f.a.len / 2 || f.stuck > GRIDLOCK_SEC * 4) {
        this.cars.splice(i, 1);
        if (!handed) f.a.pose = null;
        removed = true;
      }
    }
    if (removed) {
      const live = new Set(this.cars.map((f) => f.a));
      for (let i = this.free.length - 1; i >= 0; i--)
        if (!live.has(this.free[i])) this.free.splice(i, 1);
    }
  }

  /**
   * 교차로를 지나갈 길 위에 서 있는 차가 있는지 (정지선을 넘어 코를 내민 플레이어, 교차로 안에 멈춘 차).
   * 들어가면 교차로 안에 서게 되므로 들어가지 않는다 (도로교통법 제25조 제5항)
   */
  private pathBlocked(f: Free, bodies: Body[]): boolean {
    const a = f.a;
    for (let u = f.stopU + 1; u < f.mvEnd; u += 2) {
      const q = pointAt(f.path.pts, f.path.cum, u, this.q2);
      for (const b of bodies) {
        if (b.ref === a || b.v > 0.5 || b.waiting) continue;
        const dx = q.x - b.x;
        const dy = q.y - b.y;
        if (
          Math.abs(dx * b.hx + dy * b.hy) < b.len / 2 + 0.5 &&
          Math.abs(dy * b.hx - dx * b.hy) < (b.w + a.width) / 2 + 0.2
        )
          return true;
      }
    }
    return false;
  }

  /** 교차로를 빠져나간 바로 그 자리(나갈 차로 들머리)에 서 있거나 기어가는 차가 있는지 */
  private exitBlocked(f: Free, bodies: Body[]): boolean {
    const a = f.a;
    const q = pointAt(
      f.path.pts,
      f.path.cum,
      Math.min(f.path.len, f.mvEnd + a.len / 2 + 1),
      this.q2,
    );
    for (const b of bodies) {
      if (b.ref === a || b.v > 2 || b.hx * q.tx + b.hy * q.ty < 0.7) continue;
      const dx = b.x - q.x;
      const dy = b.y - q.y;
      if (
        Math.abs(dx * q.tx + dy * q.ty) < (a.len + b.len) / 2 + 1 &&
        Math.abs(dx * q.ty - dy * q.tx) < (a.width + b.w) / 2
      )
        return true;
    }
    return false;
  }

  /** 자유 차를 경로 차(같은 방향이나 반대편)로 넘긴다. 그 차로에 자리가 없으면 false */
  private handOff(f: Free): boolean {
    const h = f.handoff!;
    const road = this.road;
    const a = f.a;
    const s = h.s + (f.u - f.mvEnd) * (h.opposite ? -1 : 1);
    if (s < 1 || s > road.length - 2 || road.inJunction(s)) return false;
    const lanes = h.opposite ? road.oppLanesAt(s) : road.lanesAt(s);
    if (h.lane < 1 || h.lane > lanes) return false;
    const list = h.opposite ? this.traffic.opposite : this.traffic.agents;
    const coord = h.opposite ? -s : s;
    for (const o of list)
      if (
        (o.lane === h.lane || o.targetLane === h.lane) &&
        Math.abs(o.s - coord) < (o.len + a.len) / 2 + 4
      )
        return false;
    a.pose = null;
    a.opposite = h.opposite;
    a.s = coord;
    a.lane = a.targetLane = h.lane;
    a.lcProgress = 0;
    a.pendingLane = 0;
    a.signal = 0;
    a.yaw = 0;
    a.lineNow = 0;
    a.hold = -1;
    a.d = h.opposite
      ? this.traffic.oppD(h.lane, s)
      : road.laneCenter(h.lane, s);
    list.push(a);
    return true;
  }

  /** 플레이어와 겹친 자유 차 (없으면 null) */
  hit(p: PlayerBody): Agent | null {
    const phx = p.hx;
    const phy = p.hy;
    for (const f of this.cars) {
      if (f.letGo) continue;
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      if (dx * dx + dy * dy > 100) continue;
      if (p.z !== undefined && f.a.pose && Math.abs(f.a.pose.z - p.z) > 3) continue;
      if (
        obbOverlap(dx, dy, phx, phy, p.len, p.w, f.hx, f.hy, f.a.len, f.a.width)
      )
        return f.a;
    }
    return null;
  }

  /** 플레이어와 맞닿아 둘 다 선 차를 먼저 보낸다 (다른 차도 플레이어도 보지 않고 제 길을 간다) */
  letGo(a: Agent) {
    const f = this.cars.find((c) => c.a === a);
    if (f) f.letGo = f.ghost = true;
  }

  /** 자유 차의 속도 벡터 (도로망 좌표) */
  velocityOf(a: Agent): [number, number] {
    const f = this.cars.find((c) => c.a === a);
    return f ? [f.hx * a.v, f.hy * a.v] : [0, 0];
  }

  /** 충돌 뒤 다시 출발할 때 둘레를 비운다 */
  clearAround(x: number, y: number, r: number) {
    const keep = this.cars.filter(
      (f) => (f.x - x) ** 2 + (f.y - y) ** 2 > r * r,
    );
    for (const f of this.cars) if (!keep.includes(f)) f.a.pose = null;
    this.cars = keep;
    this.free.length = 0;
    for (const f of keep) this.free.push(f.a);
  }

  /** 소리용: 자유 차의 자리·속도 (도로망 좌표) */
  forEachFree(
    fn: (x: number, y: number, hx: number, hy: number, a: Agent) => void,
  ) {
    for (const f of this.cars) fn(f.x, f.y, f.hx, f.hy, f.a);
  }
}

/**
 * (x, y)에서 (hx, hy) 쪽으로 가는 차(길이 len, 폭 w) 앞 range m 안에 다른 몸체가 길을 막으면 범퍼 사이 간격, 아니면 Infinity.
 * 다른 몸체는 방향에 따라 차 진행 방향으로 비친 길이·폭을 쓴다 (가로지르는 차는 길이가 폭이 된다)
 */
export function coneGap(
  x: number,
  y: number,
  hx: number,
  hy: number,
  len: number,
  w: number,
  bx: number,
  by: number,
  bhx: number,
  bhy: number,
  blen: number,
  bw: number,
  range: number,
  crossing = true,
): number {
  const rx = bx - x;
  const ry = by - y;
  const ahead = rx * hx + ry * hy;
  if (ahead <= 0 || ahead > range) return Infinity;
  const cs = bhx * hx + bhy * hy;
  if (!crossing && cs < 0.7) return Infinity;
  const lat = Math.abs(rx * hy - ry * hx);
  const c = Math.abs(cs);
  const sn = Math.abs(bhx * hy - bhy * hx);
  if (lat > w / 2 + sn * (blen / 2) + c * (bw / 2) + 0.3) return Infinity;
  return ahead - len / 2 - (c * (blen / 2) + sn * (bw / 2));
}

/**
 * 길이 엇갈리는 두 차: 기다려야 하면 만나는 곳 앞까지 간격, 아니면 Infinity.
 * - 상대가 이미 만나는 곳을 막고 있으면 기다리고, 나도 이미 그 안이면 서로 기다리다 멈추지 않게 그냥 간다
 * - 교차로에 이미 들어간 차(entered)가 아직 들어가지 않은 차보다 먼저 간다 (도로교통법 제26조)
 * - 둘 다 들어갔거나 둘 다 아니면 만나는 곳에 먼저 닿는 쪽이 간다. 서 있는 상대는 오지 않는 차로 본다.
 *   거의 같은 시각이면 자리(x, y)로 정해서 두 차가 서로 반대로 판단한다
 */
export function conflictGap(
  x: number,
  y: number,
  hx: number,
  hy: number,
  len: number,
  w: number,
  v: number,
  entered: boolean,
  bx: number,
  by: number,
  bhx: number,
  bhy: number,
  blen: number,
  bw: number,
  bv: number,
  bEntered: boolean,
  range: number,
): number {
  const det = hx * bhy - hy * bhx;
  const sn = Math.abs(det);
  // 나란하거나 마주 보고 가는 차 (15도 안)는 앞차·옆차로 본다
  if (sn < 0.26) return Infinity;
  const rx = bx - x;
  const ry = by - y;
  // 두 진행 방향이 만나는 곳까지 내 거리 t, 상대 거리 s
  const t = (rx * bhy - ry * bhx) / det;
  const s = (rx * hy - ry * hx) / det;
  const mine = len / 2 + bw / (2 * sn);
  const theirs = blen / 2 + w / (2 * sn);
  if (t < -mine || t > range || s < -theirs) return Infinity;
  if (Math.abs(t) < mine) return Infinity;
  const gap = Math.max(0.1, t - mine - 0.5);
  if (Math.abs(s) < theirs) return gap;
  if (entered !== bEntered) return bEntered ? gap : Infinity;
  if (bv < 0.5) return Infinity;
  const tb = arrive(s - theirs, bv);
  // 서 있는 차는 상대가 오기 전에 만나는 곳을 다 건널 수 있을 때만 출발한다 (상대는 서 있는 나를 보지 않는다)
  if (v < 0.5) return tb < arrive(t + mine, 0) + 0.5 ? gap : Infinity;
  const tm = arrive(t - mine, v);
  if (
    tb < tm - 0.3 ||
    (Math.abs(tb - tm) <= 0.3 && (x > bx || (x === bx && y > by)))
  )
    return gap;
  return Infinity;
}

/** 속도 v에서 2m/s²로 붙여 d m 가는 데 걸리는 시간 (서 있는 차도 곧 닿는다고 본다) */
function arrive(d: number, v: number): number {
  return d <= 0 ? 0 : (Math.sqrt(v * v + 4 * d) - v) / 2;
}

/** 두 직사각형이 겹치는지 (분리축). (dx, dy)는 첫째 가운데에서 둘째 가운데까지 */
export function obbOverlap(
  dx: number,
  dy: number,
  ahx: number,
  ahy: number,
  alen: number,
  aw: number,
  bhx: number,
  bhy: number,
  blen: number,
  bw: number,
): boolean {
  const axes: [number, number][] = [
    [ahx, ahy],
    [-ahy, ahx],
    [bhx, bhy],
    [-bhy, bhx],
  ];
  for (const [ax, ay] of axes) {
    const d = Math.abs(dx * ax + dy * ay);
    const ra =
      (alen / 2) * Math.abs(ahx * ax + ahy * ay) +
      (aw / 2) * Math.abs(-ahy * ax + ahx * ay);
    const rb =
      (blen / 2) * Math.abs(bhx * ax + bhy * ay) +
      (bw / 2) * Math.abs(-bhy * ax + bhx * ay);
    if (d > ra + rb) return false;
  }
  return true;
}
