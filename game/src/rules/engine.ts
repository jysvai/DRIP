// 플레이어 주행을 한국 고속도로 법규(rules_kr.json)로 판정한다.
// 판정 결과는 주행 중에는 보여주지 않고 기록만 한다. 결과 화면과 데이터셋에 쓰인다.

import type { Road } from "../road/road";
import { Structure } from "../road/road";
import type { Enforcement, EnforcementSection } from "../sim/cameras";
import { designatedLanes, type Rules } from "../sim/config";
import { zoneLimit, type WorkZone } from "../sim/workzones";
import { incidentBlockS, type Incident } from "../sim/incidents";
import { iceAt, type IcePatch } from "../sim/ice";
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
  | "camera_speeding"
  | "section_speeding"
  | "work_zone_merge"
  | "incident_pass"
  | "ice_pass"
  | "near_miss"
  | "crash"
  | "skip"
  | "lka_assist"
  | "lka_toggle";

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
  camera_speeding: "과속 단속 카메라 적발",
  section_speeding: "구간단속 평균속도 초과",
  work_zone_merge: "공사 구간 앞 합류",
  incident_pass: "고장·사고 차량 옆 통과",
  ice_pass: "결빙 구간(블랙아이스) 통과",
  near_miss: "아차사고",
  crash: "충돌",
  skip: "구간 건너뜀 (요약 주행)",
  lka_assist: "차로 유지 보조 작동",
  lka_toggle: "차로 유지 보조 켜기·끄기",
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
  "camera_speeding",
  "section_speeding",
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
  /** 새벽 결빙 구간 (날씨가 black_ice일 때). 지날 때마다 들어갈 때·가장 빠를 때·나올 때 속도를 남긴다 */
  ice: IcePatch[] = [];
  private onIce: { p: IcePatch; entry: number; max: number; lane: number } | null = null;
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
  /** 이번 주행 도로의 단속 카메라 (enforcementFor) */
  enforcement: Enforcement = { fixed: [], sections: [] };
  private lastS = NaN;
  private inSection: { sec: EnforcementSection; t0: number } | null = null;
  /** 공사 구간: 임시 제한속도와 막힌 차로에서 언제 빠져나왔는지 */
  workZones: WorkZone[] = [];

  /** 돌발상황: 선 차 옆을 몇 km/h로, 얼마나 떨어져 지났는지와 막힌 차로에서 언제 빠져나왔는지 */
  incidents: Incident[] = [];
  private incidentMerge = new Map<Incident, number>();
  private lastIncS = NaN;

  /** 악천후 감속 배율 (weather.legalFactor): 젖은 노면 0.8, 가시거리 100m 이내 0.5 */
  weatherFactor = 1;

  /** 표지판에 적힌 제한속도 (화물차 제한속도, 공사 구간 임시 제한속도) */
  postedAt(s: number): number {
    const zl = zoneLimit(this.workZones, s);
    const base = this.road.speedAt(s, this.heavySpeed);
    return zl ? Math.min(zl, base) : base;
  }

  /** s 위치의 악천후 감속 배율. 터널 안은 노면이 마르고 앞이 보여 감속하지 않는다 */
  weatherFactorAt(s: number): number {
    return this.weatherFactor < 1 && this.road.structureAt(s) === Structure.Tunnel ? 1 : this.weatherFactor;
  }

  /** 이 차가 지켜야 하는 제한속도: 표지판 속도에 악천후 감속까지 */
  limitAt(s: number): number {
    return Math.round(this.postedAt(s) * this.weatherFactorAt(s));
  }

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
      limitKmh: this.limitAt(f.s),
      detail,
    };
    this.events.push(e);
    this.summary.counts[type] = (this.summary.counts[type] ?? 0) + 1;
    this.onEvent(e);
  }

  /** 지금 구간단속 안이면 평균 속도와 남은 거리 */
  sectionState(s: number, t: number): { avgKmh: number; limit: number; remainM: number; lengthM: number } | null {
    const cur = this.inSection;
    if (!cur) return null;
    const dt = t - cur.t0;
    return {
      avgKmh: dt > 1 ? ((s - cur.sec.s0) / dt) * 3.6 : 0,
      limit: this.sectionLimit(cur.sec),
      remainM: Math.max(0, cur.sec.s1 - s),
      lengthM: cur.sec.s1 - cur.sec.s0,
    };
  }

  private sectionLimit(sec: EnforcementSection): number {
    return sec.limit || this.road.speedAt(sec.s0, this.heavySpeed);
  }

  /** 선 차 옆을 지나는 순간: 속도, 옆 간격, 막힌 차로에서 빠져나온 거리 (2차사고 위험 행동 분석용) */
  private checkIce(f: PlayerFrame, lane: number, kmh: number) {
    if (!this.ice.length) return;
    const p = iceAt(this.ice, f.s);
    const on = this.onIce;
    if (on && on.p !== p) {
      this.emit(f, "ice_pass", { kind: on.p.kind, lengthM: Math.round(on.p.s1 - on.p.s0), entryKmh: Math.round(on.entry), maxKmh: Math.round(on.max), exitKmh: Math.round(kmh) }, on.lane);
      this.onIce = null;
    }
    if (p && !this.onIce) this.onIce = { p, entry: kmh, max: kmh, lane };
    if (this.onIce) this.onIce.max = Math.max(this.onIce.max, kmh);
  }

  private checkIncidents(f: PlayerFrame, lane: number, kmh: number, limit: number) {
    const prev = this.lastIncS;
    this.lastIncS = f.s;
    if (!(f.s > prev) || f.s - prev > 100) return;
    for (const i of this.incidents) {
      if (i.s <= prev || i.s > f.s) continue;
      const w = this.road.widthAt(i.s);
      const stopD = i.lane === 0 ? w / 2 + 1.55 : this.road.laneCenter(i.lane, i.s);
      const gap = Math.abs(f.d - stopD) - (f.width + 1.9) / 2;
      this.emit(
        f,
        "incident_pass",
        {
          kind: i.kind,
          blockedLane: i.lane,
          sideGapM: Math.round(gap * 10) / 10,
          overLimitKmh: Math.round(kmh - limit),
          leftLaneBeforeM: this.incidentMerge.get(i) ?? null,
          triangle: i.triangleS !== null,
        },
        lane,
      );
    }
  }

  /** 고정식 카메라를 지나는 순간과 구간단속 시점·종점 */
  private checkEnforcement(f: PlayerFrame, kmh: number, limit: number) {
    const cfg = this.rules.rules.enforcement;
    const prev = this.lastS;
    this.lastS = f.s;
    if (!cfg?.enabled || !(f.s > prev) || f.s - prev > 100) {
      // 처음이거나 뒤로 가거나 (사고 뒤) 옮겨지면 구간 측정을 버린다
      if (f.s - prev > 100 || f.s < prev) this.inSection = null;
      return;
    }
    for (const cam of this.enforcement.fixed) {
      if (cam.s <= prev || cam.s > f.s) continue;
      const camLimit = cam.limit || limit;
      if (kmh > camLimit + cfg.cameraToleranceKmh) this.emit(f, "camera_speeding", { cameraS: Math.round(cam.s), limitKmh: camLimit, overKmh: Math.round(kmh - camLimit) });
    }
    for (const sec of this.enforcement.sections) {
      if (sec.s0 > prev && sec.s0 <= f.s) this.inSection = { sec, t0: f.t };
      if (this.inSection?.sec === sec && sec.s1 > prev && sec.s1 <= f.s) {
        const dt = f.t - this.inSection.t0;
        const avg = dt > 0 ? ((sec.s1 - sec.s0) / dt) * 3.6 : 0;
        const secLimit = this.sectionLimit(sec);
        if (avg > secLimit + cfg.sectionToleranceKmh)
          this.emit(f, "section_speeding", { fromS: Math.round(sec.s0), lengthM: Math.round(sec.s1 - sec.s0), avgKmh: Math.round(avg), limitKmh: secLimit });
        this.inSection = null;
      }
    }
  }

  update(f: PlayerFrame, agents: Agent[]) {
    const r = this.rules.rules;
    const road = this.road;
    const kmh = f.speed * 3.6;
    const limit = this.limitAt(f.s);
    // 무인 카메라는 표지판 속도로 찍는다 (악천후 감속은 운전자가 지킬 몫)
    this.checkEnforcement(f, kmh, this.postedAt(f.s));
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
      // 악천후로 감속해야 하면 최저속도도 같은 비율로 낮춘다
      const minV = Math.min(Math.round(road.minSpeed[road.index(f.s)] * this.weatherFactorAt(f.s)), limit);
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
      // 공사로 막히는 차로에서 빠져나온 곳: 막히는 지점까지 남은 거리 (미리 합류하는지, 끝에서 끼어드는지)
      const zone = this.workZones.find((z) => z.lane === this.lastLane && f.s > z.s0 - 2000 && f.s < z.sClosed);
      if (zone) this.emit(f, "work_zone_merge", { closedLane: zone.lane, beforeClosedM: Math.round(zone.sClosed - f.s) }, lane);
      const inc = this.incidents.find((i) => i.lane === this.lastLane && f.s > incidentBlockS(i) - 2000 && f.s < incidentBlockS(i));
      if (inc) this.incidentMerge.set(inc, Math.round(incidentBlockS(inc) - f.s));
    }
    if (lane >= 1 && lane <= lanes) this.lastLane = lane;
    this.checkIncidents(f, lane, kmh, limit);
    this.checkIce(f, lane, kmh);

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

  /**
   * 요약 주행으로 toS까지 건너뛴다: 이어지던 과속·저속·근접·갓길 같은 판정은 건너뛰기 전에서 끊는다
   * (건너뛴 길은 달리지 않았으니 판정에 넣지 않는다). skippedSec: 건너뛴 길을 실제로 달렸다면 걸렸을 시간
   */
  skip(f: PlayerFrame, toS: number, skippedSec: number) {
    this.finish(f);
    if (this.slow) {
      const dur = f.t - this.slow.start;
      if (dur >= this.rules.rules.minSpeed.minDurationSec) this.emit(f, "min_speed", { durationSec: Math.round(dur), minKmh: this.slow.limit });
      this.slow = null;
    }
    this.emit(f, "skip", { toS: Math.round(toS), skippedM: Math.round(toS - f.s), skippedSec: Math.round(skippedSec) });
    this.shoulderSince = -1;
    this.criticalSince = -1;
    this.lane1Start = -1;
    this.designatedSince = -1;
    this.busLaneOn = false;
    this.onIce = null;
    this.inSection = null;
    this.lastS = NaN;
    this.lastIncS = NaN;
    this.lastLane = 0;
    this.accelWindow = [];
    this.signalDist = 0;
  }

  /** 주행 중 차로 유지 보조를 켜거나 껐다 (기록용) */
  lkaToggle(f: PlayerFrame, on: boolean) {
    this.emit(f, "lka_toggle", { on });
  }

  /** 차로 유지 보조가 작동했다 (판정이 아니라 기록용) */
  lkaAssist(f: PlayerFrame, side: "left" | "right", steered: boolean) {
    this.emit(f, "lka_assist", { side, steered });
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
