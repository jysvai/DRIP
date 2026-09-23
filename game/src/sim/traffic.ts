// 주변 교통. 차마다 운전 습관(driver_profiles.json)을 뽑아 IDM(앞차 따라가기)과 MOBIL(차로 변경)로 움직인다.
// 한국 규칙: 1차로 앞지르기 후 복귀, 대형차 지정차로, 버스전용차로, 터널 안 차로변경 금지, 차로 감소·공사 구간 합류.
// 돌발상황(고장·사고로 선 차)은 비상등을 켠 채 서 있는 차로 넣고, 옆을 지나는 차는 구경하느라 속도를 줄인다.

import type { Road } from "../road/road";
import { LANE_WIDTH, Structure } from "../road/road";
import type { VehicleType } from "../render/vehicleModels";
import { paletteFor } from "../render/vehicleModels";
import { designatedLanes, type DriverProfile, type GameConfig } from "./config";
import { Rng } from "./rng";
import { TAPER_M, zoneLimit, type WorkZone } from "./workzones";
import { incidentBlockS, incidentVehicleS, type Incident } from "./incidents";

export interface Agent {
  id: number;
  type: VehicleType;
  typeIndex: number;
  color: string;
  profileId: string;
  heavy: boolean;
  bus: boolean;
  len: number;
  width: number;
  /** 우리 방향이면 s 증가 방향으로 달린다. 반대편은 u = -s 좌표로 계산한다 */
  opposite: boolean;
  s: number;
  v: number;
  acc: number;
  lane: number;
  targetLane: number;
  lcProgress: number;
  lcDuration: number;
  d: number;
  /** 도로 방향 대비 차 방향 (rad, 왼쪽 +) */
  yaw: number;
  pendingLane: number;
  pendingTimer: number;
  pendingWait: number;
  signal: -1 | 0 | 1;
  signalOff: number;
  brake: boolean;
  hazard: boolean;
  decideTimer: number;
  lane1Time: number;
  /** 지금 차로에 머문 시간 (초) */
  laneTime: number;
  wander: number;
  // 습관 (뽑은 값)
  speedFactor: number;
  T: number;
  s0: number;
  aMax: number;
  b: number;
  p: number;
  thr: number;
  keepRight: number;
  safeDecel: number;
  signalUse: number;
  signalLead: number;
  lcTime: number;
  compliant: boolean;
  busCompliant: boolean;
  passingStay: number;
  /** 왼쪽 차로(승용은 1차로, 대형차는 앞지르기 차로)를 달리는 차로로 쓰는 운전자 (앞지르기 뒤에도 돌아가지 않는다) */
  cruiser: boolean;
  /** 급가속 버릇: 분당 빈도, 남은 시간 (s), 지금 세기 (0~1, 끝나면 0.7초 만에 줄어든다) */
  surgeRate: number;
  surgeT: number;
  surgeK: number;
  /** 차선 물기: 차로 가운데에서 치우치는 양 (m, 오른쪽 +, 0이면 안 문다)과 지금 치우친 양 */
  lineBias: number;
  lineNow: number;
  /** 플레이어 때문에 급제동했는지 (아차사고 판정용) */
  brakedByPlayer: number;
  /** 고장·사고로 서 있는 차 (움직이지 않는다) */
  parked?: boolean;
}

export interface PlayerState {
  s: number;
  d: number;
  v: number;
  len: number;
  width: number;
}

export interface BusLaneZone {
  s0: number;
  s1: number;
  lane: number;
}

const REGION_BEHIND = 700;
/** 대형차가 앞지르기 차로(지정차로 바로 왼쪽)에서 나타나는 비율. 실측(AVC)에서 편도 3차로 대형화물의 42%가 2차로 */
const TRUCK_PASSING_SPAWN = 0.45;
const REGION_AHEAD = 2300;
const MAX_DECEL = 9;

function idm(v: number, v0: number, gap: number, dv: number, a: Agent): number {
  const vr = v0 > 0.1 ? v / v0 : 2;
  const free = 1 - vr * vr * vr * vr;
  if (gap === Infinity) return a.aMax * free;
  const sStar = a.s0 + Math.max(0, v * a.T + (v * dv) / (2 * Math.sqrt(a.aMax * a.b)));
  const g = Math.max(gap, 0.1);
  return Math.max(-MAX_DECEL, Math.min(a.aMax, a.aMax * (free - (sStar / g) * (sStar / g))));
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

export class Traffic {
  agents: Agent[] = [];
  opposite: Agent[] = [];
  busZones: BusLaneZone[] = [];
  /** 공사 구간: 막힌 차로로는 들어가지 않고, 막히기 전에 옆 차로로 합류한다 */
  workZones: WorkZone[] = [];
  density = 15; // 대/km/차로
  /** 실측 교통이 막히는 시간대면 그 흐름 속도(m/s). 같은 방향 차의 희망속도를 이 근처로 묶는다 */
  flowSpeed: number | null = null;
  /** 차간시간 배율: 밤에는 1.1 (야간 안전거리 준수율이 더 높다), 날씨 반응도 곱한다 */
  headwayScale = 1;
  /** 날씨에 따른 희망속도 배율 (driver_profiles.json weather). 비에는 거의 안 줄인다 */
  weatherSpeed = 1;
  /** 돌발상황: 플레이어가 가까이 오면 선 차를 놓는다 */
  incidents: Incident[] = [];
  private incidentsPlaced = new Set<Incident>();
  private nextId = 1;
  private rng: Rng;
  private typeWeights: { idx: number; w: number }[] = [];
  private categoryWeights: [string, number][] = [];
  private byLane = new Map<number, Agent[]>();
  private playerInfo: { s: number; v: number; len: number; lanes: number[] } | null = null;

  constructor(
    private road: Road,
    private cfg: GameConfig,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.setComposition(cfg.traffic.composition);
  }

  setComposition(comp: Record<string, number>) {
    this.categoryWeights = Object.entries(comp).filter(([, w]) => w > 0);
    this.typeWeights = this.cfg.catalog.types.map((t, idx) => ({ idx, w: t.share }));
  }

  private pickType(): number {
    const cat = this.rng.weighted(this.categoryWeights);
    const cands = this.typeWeights.filter((t) => this.cfg.catalog.types[t.idx].category === cat);
    if (!cands.length) return this.rng.weighted(this.typeWeights.map((t) => [t.idx, t.w] as [number, number]));
    return this.rng.weighted(cands.map((t) => [t.idx, t.w] as [number, number]));
  }

  private pickProfile(t: VehicleType): string {
    const table = this.cfg.profiles.typeOverrides[t.id] ?? this.cfg.profiles.assignment[t.category] ?? { standard: 1 };
    return this.rng.weighted(Object.entries(table));
  }

  private draw(d: [number, number], lo = 0): number {
    return Math.max(lo, this.rng.normal(d[0], d[1]));
  }

  private make(typeIndex: number, s: number, lane: number, v: number, opposite: boolean): Agent {
    const type = this.cfg.catalog.types[typeIndex];
    const profileId = this.pickProfile(type);
    const pr: DriverProfile = this.cfg.profiles.profiles[profileId] ?? this.cfg.profiles.profiles.standard;
    const palette = paletteFor(type, this.cfg.catalog);
    const a: Agent = {
      id: this.nextId++,
      type,
      typeIndex,
      color: palette[Math.floor(this.rng.next() * palette.length)],
      profileId,
      heavy: !!type.heavy,
      bus: type.category === "버스",
      len: type.length,
      width: type.width,
      opposite,
      s,
      v,
      acc: 0,
      lane,
      targetLane: lane,
      lcProgress: 0,
      lcDuration: 4,
      d: 0,
      yaw: 0,
      pendingLane: 0,
      pendingTimer: 0,
      pendingWait: 0,
      signal: 0,
      signalOff: 0,
      brake: false,
      hazard: false,
      decideTimer: this.rng.next() * 1.5,
      lane1Time: 0,
      laneTime: 0,
      wander: this.rng.next() * 100,
      speedFactor: this.draw(pr.speedFactor, 0.6),
      T: this.draw(pr.timeHeadway, 0.5) * this.headwayScale,
      s0: this.draw(pr.minGap, 1),
      aMax: Math.min(type.accel, this.draw(pr.accelScale, 0.3) * type.accel * 1.4),
      b: this.draw(pr.comfortDecel, 1),
      p: Math.min(1, this.draw(pr.politeness, 0)),
      thr: this.draw(pr.changeThreshold, 0.02),
      keepRight: this.draw(pr.keepRightBias, 0),
      safeDecel: this.draw(pr.safeDecel, 1),
      signalUse: pr.signalUse,
      signalLead: this.draw(pr.signalLead, 0.2),
      lcTime: this.draw(pr.laneChangeTime, 2),
      compliant: this.rng.next() < pr.designatedLaneCompliance,
      busCompliant: this.rng.next() < pr.busLaneCompliance,
      passingStay: this.draw(pr.passingLaneStay, 2),
      cruiser: this.rng.next() < (pr.passingLaneCruise ?? 0),
      surgeRate: opposite ? 0 : (pr.surge ?? 0),
      surgeT: 0,
      surgeK: 0,
      lineBias: !opposite && this.rng.next() < (pr.lineRide ?? 0) ? (this.rng.next() < 0.5 ? -1 : 1) * (1.05 + this.rng.next() * 0.3) : 0,
      lineNow: 0,
      brakedByPlayer: 0,
    };
    return a;
  }

  /** 우리 방향 s 위치에서 반대편 차로 중심 d (반대편 1차로 = 분리대 쪽) */
  private oppD(lane: number, s: number) {
    const w = this.road.widthAt(s);
    return -w / 2 - 3 - (lane - 0.5) * LANE_WIDTH;
  }

  private desiredSpeed(a: Agent, s: number): number {
    const road = this.road;
    const look = a.opposite ? s - 150 : s + 150;
    const limit = road.speedAt(Math.max(0, Math.min(road.length - 1, look)), a.heavy) / 3.6;
    let v0 = Math.min(a.type.maxSpeed / 3.6, limit * a.speedFactor * this.weatherSpeed);
    const k = Math.abs(road.sample(Math.max(0, Math.min(road.length - 1, look))).kappa);
    if (k > 1e-4) v0 = Math.min(v0, Math.sqrt(2.3 / k));
    if (this.flowSpeed && !a.opposite) v0 = Math.min(v0, this.flowSpeed * a.speedFactor);
    if (!a.opposite) {
      const zl = zoneLimit(this.workZones, look);
      if (zl) v0 = Math.min(v0, (zl / 3.6) * a.speedFactor);
    }
    // 선 차 옆을 지날 때는 구경하며 속도를 줄인다 (사고는 반대편도). 비율은 가정
    for (const i of this.incidents) {
      if (s < i.s - 250 || s > i.s + 40) continue;
      if (a.opposite && i.kind !== "crash") continue;
      const k = a.opposite ? 0.85 : i.kind === "crash" ? 0.65 : i.lane === 0 ? 0.88 : 0.75;
      v0 = Math.min(v0, limit * k);
    }
    return v0;
  }

  /** 처음 시작할 때 주변에 차를 채운다 */
  fill(player: PlayerState) {
    this.agents = [];
    this.opposite = [];
    const road = this.road;
    const s0 = Math.max(0, player.s - REGION_BEHIND + 50);
    const s1 = Math.min(road.length - 1, player.s + REGION_AHEAD - 50);
    const spacing = 1000 / this.density;
    const playerLane = road.laneOf(player.d, player.s);
    for (let lane = 1; lane <= 8; lane++) {
      for (let s = s0 + this.rng.next() * spacing; s < s1; s += spacing * (0.6 + this.rng.next() * 0.8)) {
        if (lane > road.lanesAt(s)) continue;
        if (lane === playerLane && Math.abs(s - player.s) < 60) continue;
        if (Math.abs(s - player.s) < 12) continue;
        const idx = this.pickType();
        const a = this.make(idx, s, lane, 0, false);
        if (!this.laneAllowed(a, lane, s, a.heavy && this.rng.next() < TRUCK_PASSING_SPAWN)) continue;
        a.v = this.desiredSpeed(a, s) * (this.density > 30 ? 0.35 : 0.9);
        a.d = road.laneCenter(lane, s);
        this.agents.push(a);
      }
    }
    const oppSpacing = spacing / this.cfg.traffic.oppositeDensityFactor;
    for (let lane = 1; lane <= 8; lane++) {
      for (let s = s0 + this.rng.next() * oppSpacing; s < s1; s += oppSpacing * (0.6 + this.rng.next() * 0.8)) {
        if (lane > road.lanesAt(s) || road.structureAt(s) === Structure.Tunnel) continue;
        const a = this.make(this.pickType(), -s, lane, 0, true);
        a.v = this.desiredSpeed(a, s) * 0.9;
        a.d = this.oppD(lane, s);
        this.opposite.push(a);
      }
    }
  }

  /** 대형차 지정차로·버스전용차로 규칙으로 이 차가 이 차로를 쓸 수 있는지 */
  private laneAllowed(a: Agent, lane: number, s: number, passing = false): boolean {
    const lanes = this.road.lanesAt(s);
    if (lane < 1 || lane > lanes) return false;
    if (!a.opposite && this.cfg.rules.rules.busLane.enabled && a.busCompliant && !a.bus) {
      if (this.busZones.some((z) => z.lane === lane && s >= z.s0 && s <= z.s1)) return false;
    }
    // 공사로 막힌 차로와 곧 막힐 차로, 선 차가 막은 차로
    if (!a.opposite && this.workZones.some((z) => z.lane === lane && s >= z.s0 - 150 && s <= z.s1)) return false;
    if (!a.opposite && this.incidents.some((i) => i.lane === lane && s >= incidentBlockS(i) - 150 && s <= i.s + 10)) return false;
    if (a.heavy && a.compliant && lanes >= 3 && !a.bus) {
      const { right } = designatedLanes(lanes);
      const lowest = Math.min(...right);
      if (right.includes(lane)) return true;
      return passing && lane === lowest - 1;
    }
    return true;
  }

  private buildLanes(list: Agent[], player: PlayerState | null) {
    this.byLane.clear();
    const push = (lane: number, a: Agent) => {
      let arr = this.byLane.get(lane);
      if (!arr) this.byLane.set(lane, (arr = []));
      arr.push(a);
    };
    for (const a of list) {
      push(a.lane, a);
      if (a.targetLane !== a.lane) push(a.targetLane, a);
      else if (a.pendingLane && a.pendingTimer <= 0.3) push(a.pendingLane, a);
    }
    for (const arr of this.byLane.values()) arr.sort((x, y) => x.s - y.s);
    if (player) {
      const road = this.road;
      const lanes = new Set<number>();
      lanes.add(road.laneOf(player.d - player.width / 2 + 0.2, player.s));
      lanes.add(road.laneOf(player.d + player.width / 2 - 0.2, player.s));
      this.playerInfo = { s: player.s, v: player.v, len: player.len, lanes: [...lanes] };
    } else {
      this.playerInfo = null;
    }
  }

  /** lane 차로에서 s 바로 앞 차(플레이어 포함)와 간격 */
  private leaderOf(a: Agent, lane: number, s: number, includePlayer: boolean): { gap: number; v: number; isPlayer: boolean } {
    let best = { gap: Infinity, v: 0, isPlayer: false };
    const arr = this.byLane.get(lane);
    if (arr) {
      // 이진 탐색으로 s보다 큰 첫 차
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].s <= s) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < arr.length; i++) {
        const o = arr[i];
        if (o === a) continue;
        best = { gap: o.s - o.len / 2 - (s + a.len / 2), v: o.v, isPlayer: false };
        break;
      }
    }
    const p = this.playerInfo;
    if (includePlayer && p && !a.opposite && p.lanes.includes(lane) && p.s > s) {
      const gap = p.s - p.len / 2 - (s + a.len / 2);
      if (gap < best.gap) best = { gap, v: p.v, isPlayer: true };
    }
    return best;
  }

  private followerOf(a: Agent, lane: number, s: number, includePlayer: boolean): { gap: number; agent: Agent | null; isPlayer: boolean; v: number } {
    let best: { gap: number; agent: Agent | null; isPlayer: boolean; v: number } = { gap: Infinity, agent: null, isPlayer: false, v: 0 };
    const arr = this.byLane.get(lane);
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const o = arr[i];
        if (o === a || o.s >= s) continue;
        best = { gap: s - a.len / 2 - (o.s + o.len / 2), agent: o, isPlayer: false, v: o.v };
        break;
      }
    }
    const p = this.playerInfo;
    if (includePlayer && p && !a.opposite && p.lanes.includes(lane) && p.s < s) {
      const gap = s - a.len / 2 - (p.s + p.len / 2);
      if (gap < best.gap) best = { gap, agent: null, isPlayer: true, v: p.v };
    }
    return best;
  }

  private accelIn(a: Agent, lane: number, s: number, v0: number, includePlayer = true): number {
    const l = this.leaderOf(a, lane, s, includePlayer);
    return idm(a.v, v0, l.gap, a.v - l.v, a);
  }

  update(dt: number, player: PlayerState, time: number) {
    this.placeIncidents(player);
    this.stepList(this.agents, dt, player, time, false);
    this.stepList(this.opposite, dt, null, time, true);
    this.maintain(player);
  }

  private stepList(list: Agent[], dt: number, player: PlayerState | null, time: number, opposite: boolean) {
    const road = this.road;
    this.buildLanes(list, player);
    for (const a of list) {
      if (a.parked) {
        a.v = 0;
        a.acc = 0;
        continue;
      }
      const s = opposite ? -a.s : a.s;
      let v0 = this.desiredSpeed(a, s);
      // 급가속 버릇: 가끔 3~6초 동안 세게 몰아 앞차에 바짝 붙고, 끝나면 차간을 되찾느라 세게 선다
      if (a.surgeRate > 0) {
        if (a.surgeT > 0) a.surgeT -= dt;
        else if (this.rng.next() < (a.surgeRate / 60) * dt) a.surgeT = 3 + this.rng.next() * 3;
        a.surgeK = a.surgeT > 0 ? Math.min(1, a.surgeK + dt / 0.5) : Math.max(0, a.surgeK - dt / 0.7);
      }
      const T = a.T;
      const aMax = a.aMax;
      if (a.surgeK > 0) {
        v0 = Math.min(a.type.maxSpeed / 3.6, v0 * (1 + 0.12 * a.surgeK));
        a.T = T * (1 - 0.5 * a.surgeK);
        a.aMax = Math.min(a.type.accel * 1.5, aMax * (1 + 0.3 * a.surgeK));
      }
      // 가속: 지금 차로와 옮겨 가는 차로 중 더 조심스러운 쪽
      let acc = this.accelIn(a, a.lane, a.s, v0, !opposite);
      if (a.targetLane !== a.lane) acc = Math.min(acc, this.accelIn(a, a.targetLane, a.s, v0, !opposite));
      // 차로가 끝나면 끝나기 전에 선다
      if (!opposite) {
        const end = this.laneEnd(a.lane, a.s);
        if (end < 400 && a.targetLane === a.lane) acc = Math.min(acc, idm(a.v, v0, Math.max(1, end - a.len / 2), a.v, a));
      }
      a.T = T;
      a.aMax = aMax;
      const leader = this.leaderOf(a, a.lane, a.s, !opposite);
      if (leader.isPlayer && acc < -this.cfg.rules.rules.nearMiss.inducedBrakeMs2) a.brakedByPlayer = time;
      a.acc = acc;
      a.v = Math.max(0, a.v + acc * dt);
      a.s += a.v * dt;
      a.brake = acc < -0.9 || a.v < 0.3;

      // 차로 변경 진행
      if (a.targetLane !== a.lane) {
        a.lcProgress += dt / a.lcDuration;
        if (a.lcProgress >= 1) {
          a.lane = a.targetLane;
          a.lcProgress = 0;
          a.signalOff = 0.6;
        }
      } else if (a.signalOff > 0) {
        a.signalOff -= dt;
        if (a.signalOff <= 0 && !a.pendingLane) a.signal = 0;
      }

      // 방향지시등을 켜고 기다리는 중
      if (a.pendingLane) {
        a.pendingTimer -= dt;
        a.pendingWait += dt;
        if (a.pendingTimer <= 0) {
          if (this.safeToChange(a, a.pendingLane)) {
            a.targetLane = a.pendingLane;
            a.lcProgress = 0;
            a.lcDuration = a.lcTime * (a.heavy ? 1.2 : 1);
            a.pendingLane = 0;
          } else if (a.pendingWait > 6) {
            a.pendingLane = 0;
            a.signal = 0;
          }
        }
      }

      // 차로 변경 판단 (가끔씩)
      a.decideTimer -= dt;
      if (a.decideTimer <= 0 && a.targetLane === a.lane && !a.pendingLane) {
        a.decideTimer = 0.8 + this.rng.next() * 0.8;
        if (!opposite) this.decide(a, v0, s);
        else this.decideOpposite(a, v0);
      }
      if (a.lane === 1) a.lane1Time += dt;
      else a.lane1Time = 0;
      a.laneTime = a.targetLane === a.lane ? a.laneTime + dt : 0;

      // 가로 위치
      const sr = Math.max(0, Math.min(road.length - 1, s));
      const center = (lane: number) => (opposite ? this.oppD(lane, sr) : road.laneCenter(lane, sr));
      const wobble = Math.sin(time * 0.35 + a.wander) * 0.12;
      // 차선 물기: 차로를 바꾸지 않을 때 한쪽으로 치우친다 (길 밖 쪽이면 조금만). 차로를 바꿀 때는 서서히 가운데로
      let line = 0;
      if (a.lineBias && a.targetLane === a.lane) {
        const outward = (a.lineBias < 0 && a.lane === 1) || (a.lineBias > 0 && a.lane >= road.lanesAt(sr));
        line = a.lineBias * (outward ? 0.3 : 1) * (0.925 + 0.075 * Math.sin(time * 0.07 + a.wander));
      }
      a.lineNow += (line - a.lineNow) * Math.min(1, dt * 0.6);
      let d: number;
      if (a.targetLane !== a.lane) {
        const t = smoothstep(Math.min(1, a.lcProgress));
        d = center(a.lane) + (center(a.targetLane) - center(a.lane)) * t;
        const dd = (center(a.targetLane) - center(a.lane)) * (6 * a.lcProgress * (1 - a.lcProgress)) / a.lcDuration;
        a.yaw = -Math.atan2(dd, Math.max(a.v, 1)) * (opposite ? -1 : 1);
      } else {
        d = center(a.lane) + wobble;
        a.yaw *= 0.9;
      }
      a.d = d + a.lineNow;
    }
  }

  /** 이 차로가 앞으로 몇 m 뒤에 끝나는지 (차로 감소, 공사로 막힘). 600m 안에 없으면 Infinity */
  private laneEnd(lane: number, s: number): number {
    const road = this.road;
    let end = Infinity;
    for (let ds = 0; ds <= 600; ds += 50) {
      if (road.lanesAt(Math.min(road.length - 1, s + ds)) < lane) {
        end = ds;
        break;
      }
    }
    for (const z of this.workZones) {
      // 라바콘이 차로 절반을 넘게 막는 곳 앞에서 선다
      const block = z.s0 + TAPER_M / 2;
      if (z.lane === lane && s <= z.s1 && block - s <= 600) end = Math.min(end, Math.max(0, block - s));
    }
    // 선 차: 비상등이 멀리서 보여 미리 옮긴다
    for (const i of this.incidents) {
      const block = incidentBlockS(i);
      if (i.lane === lane && s <= i.s && block - s <= 600) end = Math.min(end, Math.max(0, block - s));
    }
    return end;
  }

  private safeToChange(a: Agent, lane: number): boolean {
    const lead = this.leaderOf(a, lane, a.s, true);
    const fol = this.followerOf(a, lane, a.s, true);
    if (lead.gap < a.s0 * 0.5 || fol.gap < 1.5) return false;
    if (fol.agent) {
      const newAcc = idm(fol.agent.v, fol.agent.v + 0.1, fol.gap, fol.agent.v - a.v, fol.agent);
      if (newAcc < -a.safeDecel) return false;
    }
    if (fol.isPlayer) {
      // 플레이어 앞으로 끼어들 때도 최소한 거리를 본다
      const closing = fol.v - a.v;
      if (fol.gap < 4 + Math.max(0, closing) * 1.2) return false;
    }
    return true;
  }

  private decide(a: Agent, v0: number, s: number) {
    const road = this.road;
    if (road.structureAt(s) === Structure.Tunnel && this.rng.next() < 0.97) return; // 터널 안 차로변경 금지
    const lanes = road.lanesAt(s);
    const aCur = this.accelIn(a, a.lane, a.s, v0);
    const endAhead = this.laneEnd(a.lane, a.s);
    let best = 0;
    let bestScore = 0;
    for (const dir of [-1, 1] as const) {
      const tl = a.lane + dir;
      if (tl < 1 || tl > lanes || road.lanesAt(Math.min(road.length - 1, s + 200)) < tl) continue;
      const passing = dir === -1;
      if (!this.laneAllowed(a, tl, s, passing)) continue;
      const lead = this.leaderOf(a, tl, a.s, true);
      const fol = this.followerOf(a, tl, a.s, true);
      if (lead.gap < a.s0 * 0.5 || fol.gap < 2) continue;
      const aNew = idm(a.v, v0, lead.gap, a.v - lead.v, a);
      let followerLoss = 0;
      if (fol.agent) {
        const f = fol.agent;
        const fv0 = this.desiredSpeed(f, f.s);
        const before = this.accelIn(f, tl, f.s, fv0);
        const after = idm(f.v, fv0, fol.gap, f.v - a.v, f);
        if (after < -a.safeDecel) continue;
        followerLoss = after - before;
      } else if (fol.isPlayer && fol.gap < 6 + Math.max(0, fol.v - a.v) * 1.5) {
        continue;
      }
      let score = aNew - aCur + a.p * followerLoss;
      // 오른쪽으로 돌아가려는 성향, 1차로는 앞지르기 뒤 비운다
      if (a.cruiser) {
        // 정속 주행 차로를 왼쪽에 두는 운전자: 오른쪽으로 돌아가려 하지 않고 왼쪽으로 옮기려 한다.
        // 승용은 1차로, 지정차로를 지키는 대형차는 앞지르기 차로(편도 3차로의 2차로)까지 (laneAllowed가 막는다)
        score += dir === -1 ? 0.5 : -0.5;
      } else {
        // 대형차는 앞지르기 차로에 들어가면 passingLaneStay 동안은 오른쪽으로 돌아가려 하지 않는다
        const holdPassing = a.heavy && dir === 1 && a.laneTime < a.passingStay && !this.laneAllowed(a, a.lane, s);
        if (!holdPassing) score += dir === 1 ? a.keepRight : -a.keepRight;
        if (a.lane === 1 && dir === 1 && a.lane1Time > a.passingStay) score += 0.6;
      }
      // 대형차가 앞지르기 차로(지정차로 바로 왼쪽)에 있으면 앞지르기 뒤 돌아간다
      // (앞지르기 차로에 머무는 시간은 passingLaneStay: 실측에서 편도 3차로 대형화물의 42%가 2차로)
      // 2차로 정속 대형차(cruiser)는 돌아가지 않는다
      if (a.heavy && a.compliant && !a.cruiser && dir === 1 && !this.laneAllowed(a, a.lane, s) && a.laneTime > a.passingStay) score += 1.2;
      // 차로가 곧 끝나면(차로 감소·공사) 이어지는 차로로, 더 먼저 끝나는 차로로는 가지 않는다
      const targetEnd = this.laneEnd(tl, s);
      if (endAhead < 500 && targetEnd > endAhead + 100) score += 3;
      if (targetEnd < 500 && targetEnd <= endAhead) score -= 5;
      // 버스는 전용차로가 있으면 그쪽으로
      if (a.bus && this.busZones.some((z) => z.lane === tl && s >= z.s0 && s <= z.s1)) score += 1;
      if (score > a.thr && score > bestScore) {
        best = tl;
        bestScore = score;
      }
    }
    if (best) this.begin(a, best);
  }

  private decideOpposite(a: Agent, v0: number) {
    // 반대편은 보기만 하는 교통이라 간단하게: 오른쪽 차로 선호 + 앞지르기
    const lanes = 3;
    const aCur = this.accelIn(a, a.lane, a.s, v0, false);
    for (const dir of [-1, 1] as const) {
      const tl = a.lane + dir;
      if (tl < 1 || tl > lanes) continue;
      const lead = this.leaderOf(a, tl, a.s, false);
      const fol = this.followerOf(a, tl, a.s, false);
      if (lead.gap < 10 || fol.gap < 15) continue;
      const aNew = idm(a.v, v0, lead.gap, a.v - lead.v, a);
      const score = aNew - aCur + (dir === 1 ? a.keepRight : -a.keepRight);
      if (score > a.thr + 0.1) {
        this.begin(a, tl);
        return;
      }
    }
  }

  private begin(a: Agent, lane: number) {
    const dir = lane < a.lane ? -1 : 1;
    if (this.rng.next() < a.signalUse) {
      a.signal = dir;
      a.pendingLane = lane;
      a.pendingTimer = a.signalLead;
      a.pendingWait = 0;
    } else {
      a.signal = 0;
      a.targetLane = lane;
      a.lcProgress = 0;
      a.lcDuration = a.lcTime * (a.heavy ? 1.2 : 1);
    }
  }

  /** 범위 밖 차를 지우고, 빈 곳에 새 차를 넣는다 */
  private maintain(player: PlayerState) {
    const road = this.road;
    const sMin = player.s - REGION_BEHIND;
    const sMax = player.s + REGION_AHEAD;
    this.agents = this.agents.filter((a) => a.s > sMin - 100 && a.s < sMax + 100 && a.s < road.length - 5);
    this.opposite = this.opposite.filter((a) => -a.s > sMin - 100 && -a.s < sMax + 100 && -a.s > 5);
    if (!(this.density > 0)) return;
    const spacing = 1000 / this.density;

    const spawnLane = (list: Agent[], opposite: boolean, lane: number, at: number, ahead: boolean) => {
      const sPos = Math.max(1, Math.min(road.length - 2, at));
      if (lane > road.lanesAt(sPos)) return;
      if (opposite && road.structureAt(sPos) === Structure.Tunnel) return;
      const coord = opposite ? -sPos : sPos;
      // 그 차로에서 가장 가까운 차와 거리
      let nearest = Infinity;
      for (const a of list) {
        if (a.lane !== lane && a.targetLane !== lane) continue;
        nearest = Math.min(nearest, Math.abs(a.s - coord));
      }
      const need = spacing * (0.7 + this.rng.next() * 0.9);
      if (nearest < need) return;
      const a = this.make(this.pickType(), coord, lane, 0, opposite);
      if (!opposite && !this.laneAllowed(a, lane, sPos, a.heavy && this.rng.next() < TRUCK_PASSING_SPAWN)) return;
      const v0 = this.desiredSpeed(a, sPos);
      // 앞쪽에 넣는 차는 흐름 속도, 뒤쪽에 넣는 차는 플레이어보다 빠를 때만
      if (!opposite && !ahead && v0 <= player.v + 1) return;
      a.v = v0 * (this.density > 30 ? 0.4 : 0.92);
      a.d = opposite ? this.oppD(lane, sPos) : road.laneCenter(lane, sPos);
      list.push(a);
    };
    for (let lane = 1; lane <= 6; lane++) {
      spawnLane(this.agents, false, lane, sMax - this.rng.next() * 150, true);
      spawnLane(this.agents, false, lane, sMin + this.rng.next() * 80, false);
      if (this.rng.next() < this.cfg.traffic.oppositeDensityFactor) spawnLane(this.opposite, true, lane, sMax - this.rng.next() * 100, true);
    }
  }

  /** 플레이어 앞 교통 범위에 들어온 돌발상황에 선 차를 놓는다 (한 번만) */
  private placeIncidents(player: PlayerState) {
    const road = this.road;
    for (const i of this.incidents) {
      if (this.incidentsPlaced.has(i) || i.s - player.s > REGION_AHEAD - 100 || i.s < player.s + 150) continue;
      this.incidentsPlaced.add(i);
      const lanes = road.lanesAt(i.s);
      incidentVehicleS(i).forEach((s, k) => {
        // 갓길 차는 바깥 차로 번호(lanes + 1)로 두어 다른 차의 앞차가 되지 않게 한다
        const lane = i.lane === 0 ? lanes + 1 : i.lane;
        const a = this.make(this.pickType(), s, lane, 0, false);
        a.parked = true;
        a.hazard = true;
        a.signal = 0;
        a.brake = false;
        const w = road.widthAt(s);
        a.d = i.lane === 0 ? w / 2 + 1.55 : road.laneCenter(lane, s) + (this.rng.next() - 0.5) * 0.6;
        // 사고 차는 비스듬히, 뒤차는 앞차를 들이받은 모양으로
        a.yaw = i.kind === "crash" ? (this.rng.next() - 0.5) * (k === 0 ? 0.7 : 0.4) : (this.rng.next() - 0.5) * 0.06;
        this.agents.push(a);
      });
    }
  }

  /**
   * 갑자기 끼어들기: 옆 차로 차가 플레이어 바로 앞(범퍼 사이 6~35m)으로 들어온다. 방향지시등은 없거나 움직이면서 켠다.
   * 자기 차로가 막힌 차(앞차가 느리거나 가까운 차)를 먼저 고르고, 1차로에서 빠져나오는 차를 조금 더 고른다.
   * 플레이어와 속도가 비슷한 차(-4~+3m/s)나 앞질러 가며 15m 안으로 칼치기하는 차(+6m/s까지)만 고른다:
   * 훨씬 느린 차는 피할 수 없는 사고가 되고, 훨씬 빠른 차는 금방 멀어져 놀랍지 않다. 들어올 차가 없으면 null
   */
  cutIn(player: PlayerState): { agent: Agent; gapM: number; dvKmh: number; signaled: boolean; fromLane: number } | null {
    const road = this.road;
    if (road.structureAt(player.s) === Structure.Tunnel) return null;
    const pl = road.laneOf(player.d, player.s);
    const lanes = road.lanesAt(player.s);
    if (pl < 1 || pl > lanes) return null;
    this.buildLanes(this.agents, player);
    let best: Agent | null = null;
    let bestScore = -Infinity;
    for (const a of this.agents) {
      if (a.parked || a.targetLane !== a.lane || a.pendingLane || Math.abs(a.lane - pl) !== 1) continue;
      const gap = a.s - a.len / 2 - (player.s + player.len / 2);
      // 비슷한 속도(-4~+3m/s)거나, 앞질러 가며 바로 앞(15m 안)으로 칼치기하는 차(+6m/s까지)
      const dv = a.v - player.v;
      if (gap < 6 || gap > 35 || dv < -4 || dv > 6 || (dv > 3 && gap > 15)) continue;
      if (!this.laneAllowed(a, pl, a.s)) continue;
      // 들어갈 자리 앞이 비어 있어야 한다
      if (this.leaderOf(a, pl, a.s, false).gap < 12) continue;
      const own = this.leaderOf(a, a.lane, a.s, false);
      const blocked = own.gap < 40 || own.v < a.v - 2;
      // 막힌 차로에서 빠져나오는 차, 1차로에서 나오는 차, 가까운 차일수록 (놀랄 만큼)
      const score = (blocked ? 2 : 0) + (a.lane === 1 ? 0.5 : 0) + (35 - gap) / 20 + this.rng.next();
      if (score > bestScore) {
        best = a;
        bestScore = score;
      }
    }
    if (!best) return null;
    const a = best;
    const fromLane = a.lane;
    const signaled = this.rng.next() < 0.35;
    a.signal = signaled ? (pl < a.lane ? -1 : 1) : 0;
    a.signalOff = 0;
    a.targetLane = pl;
    a.lcProgress = 0;
    a.lcDuration = 1.5 + this.rng.next() * 0.6;
    a.lineNow = 0;
    const gapM = a.s - a.len / 2 - (player.s + player.len / 2);
    return { agent: a, gapM, dvKmh: (a.v - player.v) * 3.6, signaled, fromLane };
  }

  /** 차 주변을 비운다 (충돌 뒤 다시 출발할 때) */
  clearAround(s: number, radius: number) {
    this.agents = this.agents.filter((a) => Math.abs(a.s - s) > radius);
  }
}
