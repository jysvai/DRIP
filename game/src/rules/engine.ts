// 플레이어 주행을 한국 고속도로 법규(rules_kr.json)로 판정한다.
// 판정 결과는 주행 중에는 보여주지 않고 기록만 한다. 결과 화면과 데이터셋에 쓰인다.

import type { Road } from "../road/road";
import { Structure } from "../road/road";
import { designatedLanes, type Rules } from "../sim/config";
import type { Agent, BusLaneZone } from "../sim/traffic";

export type EventType =
  | "speeding"
  | "min_speed"
  | "lane_change"
  | "no_signal"
  | "late_signal"
  | "tunnel_lane_change"
  | "shoulder"
  | "headway_critical"
  | "hard_accel"
  | "hard_brake"
  | "passing_lane"
  | "bus_lane"
  | "designated_lane"
  | "near_miss"
  | "crash";

export interface DriveEvent {
  t: number;
  type: EventType;
  s: number;
  lane: number;
  speedKmh: number;
  limitKmh: number;
  detail: Record<string, unknown>;
}

export const EVENT_LABELS: Record<EventType, string> = {
  speeding: "과속",
  min_speed: "최저속도 미달",
  lane_change: "차로 변경",
  no_signal: "방향지시등 없이 차로 변경",
  late_signal: "방향지시등 늦게 켬 (100m 전 미만)",
  tunnel_lane_change: "터널 안 차로 변경",
  shoulder: "갓길 주행",
  headway_critical: "앞차와 1초 미만 근접",
  hard_accel: "급가속",
  hard_brake: "급감속",
  passing_lane: "1차로 계속 주행",
  bus_lane: "버스전용차로 통행",
  designated_lane: "지정차로 위반 (화물·대형승합은 오른쪽 차로)",
  near_miss: "아차사고",
  crash: "충돌",
};

export const VIOLATIONS: EventType[] = [
  "speeding",
  "min_speed",
  "no_signal",
  "late_signal",
  "tunnel_lane_change",
  "shoulder",
  "headway_critical",
  "passing_lane",
  "bus_lane",
  "designated_lane",
];

export interface PlayerFrame {
  t: number;
  dt: number;
  s: number;
  d: number;
  speed: number; // m/s
  ax: number; // m/s² 앞뒤 가속도
  width: number;
  len: number;
  signal: -1 | 0 | 1;
  hazard: boolean;
}

export interface Summary {
  distanceM: number;
  timeSec: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  speedingTimeSec: number;
  headwayUnder2Sec: number;
  headwayMeasuredSec: number;
  laneChanges: number;
  signaledLaneChanges: number;
  counts: Partial<Record<EventType, number>>;
}

interface Episode {
  start: number;
  s0: number;
  max: number;
  limit: number;
}

export class RuleEngine {
  events: DriveEvent[] = [];
  summary: Summary = {
    distanceM: 0,
    timeSec: 0,
    maxSpeedKmh: 0,
    avgSpeedKmh: 0,
    speedingTimeSec: 0,
    headwayUnder2Sec: 0,
    headwayMeasuredSec: 0,
    laneChanges: 0,
    signaledLaneChanges: 0,
    counts: {},
  };
  /** 지금 앞차와의 시간 간격 (초), 로그용 */
  headway = Infinity;
  ttc = Infinity;
  private speeding: Episode | null = null;
  private slow: Episode | null = null;
  private shoulderSince = -1;
  private criticalSince = -1;
  private lane1Start = -1;
  private busLaneOn = false;
  private lastLane = 0;
  private signalDir: -1 | 0 | 1 = 0;
  private signalDist = 0;
  private signalOffAt = -1e9;
  private lastSignalDir: -1 | 0 | 1 = 0;
  private lastSignalDist = 0;
  private accelWindow: { t: number; v: number }[] = [];
  private lastHardAccel = -10;
  private lastHardBrake = -10;
  private lastNearMiss = -10;
  onEvent: (e: DriveEvent) => void = () => {};
  /** 플레이어 차 구분: 화물·대형승합은 지정차로, 버스는 버스전용차로 통행 가능 */
  vehicleClass: "car" | "bus" | "truck" = "car";
  /** 1.5톤 넘는 화물차는 화물차 제한속도 */
  heavySpeed = false;
  private designatedSince = -1;

  constructor(
    private road: Road,
    private rules: Rules,
    private busZones: BusLaneZone[],
  ) {}

  private emit(f: PlayerFrame, type: EventType, detail: Record<string, unknown> = {}, lane = this.lastLane) {
    const e: DriveEvent = {
      t: Math.round(f.t * 100) / 100,
      type,
      s: Math.round(f.s * 10) / 10,
      lane,
      speedKmh: Math.round(f.speed * 3.6 * 10) / 10,
      limitKmh: this.road.speedAt(f.s, this.heavySpeed),
      detail,
    };
    this.events.push(e);
    this.summary.counts[type] = (this.summary.counts[type] ?? 0) + 1;
    this.onEvent(e);
  }

  update(f: PlayerFrame, agents: Agent[]) {
    const r = this.rules.rules;
    const road = this.road;
    const kmh = f.speed * 3.6;
    const limit = road.speedAt(f.s, this.heavySpeed);
    const lane = road.laneOf(f.d, f.s);
    const lanes = road.lanesAt(f.s);
    const sum = this.summary;
    sum.distanceM += f.speed * f.dt;
    sum.timeSec += f.dt;
    sum.maxSpeedKmh = Math.max(sum.maxSpeedKmh, kmh);
    sum.avgSpeedKmh = sum.timeSec > 0 ? (sum.distanceM / sum.timeSec) * 3.6 : 0;
    if (this.lastLane === 0) this.lastLane = lane;

    // ---- 과속 ----
    if (r.speeding.enabled) {
      const over = kmh - limit - r.speeding.toleranceKmh;
      if (over > 0) {
        sum.speedingTimeSec += f.dt;
        if (!this.speeding) this.speeding = { start: f.t, s0: f.s, max: over, limit };
        this.speeding.max = Math.max(this.speeding.max, over);
      } else if (this.speeding) {
        const dur = f.t - this.speeding.start;
        if (dur >= r.speeding.minDurationSec)
          this.emit(f, "speeding", { maxOverKmh: Math.round(this.speeding.max), durationSec: Math.round(dur), fromS: Math.round(this.speeding.s0), limitKmh: this.speeding.limit });
        this.speeding = null;
      }
    }

    // ---- 앞차 ----
    let lead: Agent | null = null;
    let leadGap = Infinity;
    for (const a of agents) {
      if (a.opposite) continue;
      const aLaneMatch = a.lane === lane || a.targetLane === lane;
      if (!aLaneMatch) continue;
      const gap = a.s - a.len / 2 - (f.s + f.len / 2);
      if (gap > -0.5 && gap < leadGap) {
        leadGap = gap;
        lead = a;
      }
    }
    this.headway = lead && f.speed > 1 ? Math.max(0, leadGap) / f.speed : Infinity;
    this.ttc = lead && f.speed > lead.v + 0.3 ? Math.max(0, leadGap) / (f.speed - lead.v) : Infinity;

    // ---- 최저속도 ----
    if (r.minSpeed.enabled) {
      const minV = road.minSpeed[road.index(f.s)];
      const blocked = lead && leadGap < 120 && lead.v * 3.6 < r.minSpeed.ignoreWhenLeaderSlowerKmh;
      if (kmh < minV && kmh > 3 && !blocked) {
        if (!this.slow) this.slow = { start: f.t, s0: f.s, max: minV - kmh, limit: minV };
      } else if (this.slow) {
        const dur = f.t - this.slow.start;
        if (dur >= r.minSpeed.minDurationSec) this.emit(f, "min_speed", { durationSec: Math.round(dur), minKmh: this.slow.limit });
        this.slow = null;
      }
    }

    // ---- 안전거리 ----
    if (r.headway.enabled && kmh >= r.headway.minSpeedKmh && lead && leadGap < 250) {
      sum.headwayMeasuredSec += f.dt;
      if (this.headway < r.headway.thresholdSec) sum.headwayUnder2Sec += f.dt;
      if (this.headway < r.headway.criticalSec) {
        if (this.criticalSince < 0) this.criticalSince = f.t;
        if (f.t - this.criticalSince >= r.headway.criticalDurationSec) {
          this.emit(f, "headway_critical", { headwaySec: Math.round(this.headway * 100) / 100, leader: lead.type.id });
          this.criticalSince = f.t + 30; // 한 번 알린 뒤 30초 쉼
        }
      } else if (this.criticalSince >= 0 && this.criticalSince <= f.t) {
        this.criticalSince = -1;
      }
    }

    // ---- 급가속·급감속 (1초 동안 속도 변화) ----
    this.accelWindow.push({ t: f.t, v: kmh });
    while (this.accelWindow.length > 2 && f.t - this.accelWindow[0].t > 1.0) this.accelWindow.shift();
    const first = this.accelWindow[0];
    if (f.t - first.t >= 0.95) {
      const dv = kmh - first.v;
      if (r.hardAccel.enabled && dv >= r.hardAccel.kmhPerSec && first.v >= r.hardAccel.minSpeedKmh && f.t - this.lastHardAccel > 3) {
        this.emit(f, "hard_accel", { kmhPerSec: Math.round(dv * 10) / 10 });
        this.lastHardAccel = f.t;
      }
      if (r.hardBrake.enabled && -dv >= r.hardBrake.kmhPerSec && first.v >= r.hardBrake.minSpeedKmh && f.t - this.lastHardBrake > 3) {
        this.emit(f, "hard_brake", { kmhPerSec: Math.round(-dv * 10) / 10 });
        this.lastHardBrake = f.t;
      }
    }

    // ---- 방향지시등 거리 ----
    if (f.signal !== 0) {
      if (f.signal !== this.signalDir) this.signalDist = 0;
      this.signalDist += f.speed * f.dt;
    } else if (this.signalDir !== 0) {
      this.signalOffAt = f.t;
      this.lastSignalDir = this.signalDir;
      this.lastSignalDist = this.signalDist;
      this.signalDist = 0;
    }
    this.signalDir = f.signal;

    // ---- 차로 변경 ----
    if (lane !== this.lastLane && lane >= 1 && lane <= lanes && this.lastLane >= 1) {
      const dir = lane < this.lastLane ? -1 : 1;
      const on = this.signalDir === dir;
      const recent = !on && this.lastSignalDir === dir && f.t - this.signalOffAt < 2;
      const dist = on ? this.signalDist : recent ? this.lastSignalDist : 0;
      const signaled = on || recent;
      sum.laneChanges++;
      if (signaled) sum.signaledLaneChanges++;
      this.emit(f, "lane_change", { from: this.lastLane, to: lane, signaled, signalDistanceM: Math.round(dist) }, lane);
      if (r.turnSignal.enabled) {
        if (!signaled) this.emit(f, "no_signal", { from: this.lastLane, to: lane }, lane);
        else if (dist < r.turnSignal.leadDistanceM) this.emit(f, "late_signal", { signalDistanceM: Math.round(dist) }, lane);
      }
      if (r.tunnelLaneChange.enabled && road.structureAt(f.s) === Structure.Tunnel) this.emit(f, "tunnel_lane_change", {}, lane);
    }
    if (lane >= 1 && lane <= lanes) this.lastLane = lane;

    // ---- 갓길 ----
    if (r.shoulder.enabled) {
      const w = road.widthAt(f.s);
      const onShoulder = f.d - f.width * 0.25 > w / 2 || f.d + f.width * 0.25 < -w / 2;
      if (onShoulder && kmh > 5) {
        if (this.shoulderSince < 0) this.shoulderSince = f.t;
        if (f.t - this.shoulderSince >= r.shoulder.minDurationSec) {
          this.emit(f, "shoulder", { side: f.d > 0 ? "right" : "left" }, lanes + 1);
          this.shoulderSince = f.t + 20;
        }
      } else if (this.shoulderSince <= f.t) this.shoulderSince = -1;
    }

    // ---- 1차로 계속 주행 ----
    if (r.passingLane.enabled && lanes >= 2) {
      if (lane === 1) {
        if (this.lane1Start < 0) this.lane1Start = f.s;
        if (f.s - this.lane1Start >= r.passingLane.maxDistanceM) {
          this.emit(f, "passing_lane", { distanceM: Math.round(f.s - this.lane1Start) }, 1);
          this.lane1Start = f.s + 1e9; // 1차로를 벗어날 때까지 한 번만
        }
      } else this.lane1Start = -1;
    }

    // ---- 지정차로 (별표9): 편도 3차로 이상에서 화물·대형승합은 오른쪽 차로. 바로 왼쪽 차로는 앞지르기 때만 ----
    if (r.designatedLanes.enabled && this.vehicleClass !== "car" && lanes >= 3 && lane >= 1 && lane <= lanes && kmh > 20) {
      const { right } = designatedLanes(lanes);
      const passing = lane === right[0] - 1;
      if (!right.includes(lane)) {
        if (this.designatedSince < 0) this.designatedSince = f.t;
        if (f.t - this.designatedSince >= (passing ? 30 : 10)) {
          this.emit(f, "designated_lane", { lane, allowed: right }, lane);
          this.designatedSince = f.t + 1e9; // 돌아갈 때까지 한 번만
        }
      } else this.designatedSince = -1;
    }

    // ---- 버스전용차로 ----
    if (r.busLane.enabled && this.vehicleClass !== "bus") {
      const inZone = this.busZones.some((z) => lane === z.lane && f.s >= z.s0 && f.s <= z.s1);
      if (inZone && !this.busLaneOn && kmh > 5) this.emit(f, "bus_lane", {}, lane);
      this.busLaneOn = inZone;
    }

    // ---- 아차사고 ----
    if (r.nearMiss.enabled && f.t - this.lastNearMiss > r.nearMiss.cooldownSec) {
      let kind = "";
      let other = "";
      if (this.ttc < r.nearMiss.ttcSec && leadGap < 60 && lead) {
        kind = "ttc";
        other = lead.type.id;
      }
      if (!kind) {
        for (const a of agents) {
          if (a.opposite || Math.abs(a.s - f.s) > (a.len + f.len) / 2) continue;
          const lat = Math.abs(a.d - f.d) - (a.width + f.width) / 2;
          if (lat > 0 && lat < r.nearMiss.lateralGapM) {
            kind = "side";
            other = a.type.id;
            break;
          }
          if (a.brakedByPlayer > 0 && f.t - a.brakedByPlayer < 0.2) {
            kind = "induced_brake";
            other = a.type.id;
            a.brakedByPlayer = 0;
            break;
          }
        }
      }
      if (kind) {
        this.emit(f, "near_miss", { kind, other, ttcSec: Number.isFinite(this.ttc) ? Math.round(this.ttc * 100) / 100 : null });
        this.lastNearMiss = f.t;
      }
    }
  }

  crash(f: PlayerFrame, withWhat: string, relSpeedKmh: number) {
    this.emit(f, "crash", { with: withWhat, relSpeedKmh: Math.round(relSpeedKmh) });
  }

  /** 주행이 끝날 때 진행 중이던 구간을 마저 기록 */
  finish(f: PlayerFrame) {
    if (this.speeding) {
      const dur = f.t - this.speeding.start;
      if (dur >= this.rules.rules.speeding.minDurationSec)
        this.emit(f, "speeding", { maxOverKmh: Math.round(this.speeding.max), durationSec: Math.round(dur), fromS: Math.round(this.speeding.s0), limitKmh: this.speeding.limit });
      this.speeding = null;
    }
  }
}
