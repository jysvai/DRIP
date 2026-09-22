// 플레이어 차 물리. 동역학 자전거 모델(앞뒤 타이어 횡력) + 엔진·자동변속기·브레이크.
// 위치는 도로 좌표(s, d)로 적분해서 수백 km를 달려도 오차가 쌓이지 않게 한다.

import type { Road } from "../road/road";
import { LEFT_SHOULDER, RIGHT_SHOULDER } from "../road/road";

export interface CarSpec {
  mass: number; // kg
  inertia: number; // kg·m²
  lf: number; // 무게중심~앞축 (m)
  lr: number; // 무게중심~뒤축 (m)
  cf: number; // 앞 타이어 코너링 강성 (N/rad)
  cr: number;
  mu: number; // 노면 마찰계수
  maxSteer: number; // 바퀴 최대 조향각 (rad)
  torqueCurve: [number, number][]; // [rpm, Nm]
  idleRpm: number;
  redline: number;
  gears: number[];
  finalDrive: number;
  wheelRadius: number;
  dragArea: number; // Cd·A (m²)
  rolling: number;
  maxBrakeDecel: number; // m/s²
  length: number;
  width: number;
  /** 최고속도 제한 (m/s). 없으면 제한 없음 */
  governor?: number;
  /** 자동변속 [적게 밟을 때, 끝까지 밟을 때] 올리는 rpm */
  shiftRpm?: [number, number];
}

export const DEFAULT_CAR: CarSpec = {
  mass: 1550,
  inertia: 2600,
  lf: 1.15,
  lr: 1.7,
  cf: 95000,
  cr: 110000,
  mu: 0.95,
  maxSteer: 0.6,
  torqueCurve: [
    [800, 150],
    [1500, 240],
    [2500, 265],
    [4500, 265],
    [6000, 230],
    [6800, 200],
  ],
  idleRpm: 750,
  redline: 6600,
  gears: [4.6, 2.8, 1.85, 1.38, 1.0, 0.8, 0.66, 0.56],
  finalDrive: 3.3,
  wheelRadius: 0.33,
  dragArea: 0.66,
  rolling: 0.011,
  maxBrakeDecel: 9.3,
  length: 4.8,
  width: 1.86,
};

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1(왼쪽)..1(오른쪽), 바퀴 최대각 대비
  reverse: boolean;
}

export interface GuardrailHit {
  side: "left" | "right";
  lateralSpeed: number; // m/s
  speed: number; // m/s
}

const G = 9.81;
const RHO = 1.2;

export class PlayerCar {
  spec: CarSpec;
  // 도로 좌표
  s = 0;
  d = 0;
  /** 차 방향 - 도로 방향 (rad, 왼쪽 +) */
  theta = 0;
  /** 차체 기준 앞 방향 속도 (m/s) */
  vx = 0;
  /** 차체 기준 왼쪽 방향 속도 (m/s) */
  vy = 0;
  /** 요레이트 (rad/s, 왼쪽 회전 +) */
  r = 0;
  steerAngle = 0; // 바퀴 조향각 (rad, 왼쪽 +)
  gear = 1;
  rpm = 750;
  /** 차체 기준 가속도 (m/s²), 로그와 판정용 */
  ax = 0;
  ay = 0;
  /** 이번 스텝에 난 가드레일 충돌 */
  hits: GuardrailHit[] = [];
  private shiftCooldown = 0;

  constructor(spec: CarSpec = DEFAULT_CAR) {
    this.spec = spec;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  place(road: Road, s: number, lane: number, speed: number) {
    this.s = s;
    this.d = road.laneCenter(lane, s);
    this.theta = 0;
    this.vx = speed;
    this.vy = 0;
    this.r = 0;
    this.steerAngle = 0;
    this.gear = this.pickGear(speed, 0.3);
    this.rpm = this.engineRpm(speed, this.gear);
  }

  private engineRpm(v: number, gear: number): number {
    const ratio = this.spec.gears[gear - 1] * this.spec.finalDrive;
    return Math.max(this.spec.idleRpm, (v / this.spec.wheelRadius) * ratio * (60 / (2 * Math.PI)));
  }

  private torqueAt(rpm: number): number {
    const c = this.spec.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
      }
    }
    return rpm > this.spec.redline ? 0 : c[c.length - 1][1];
  }

  /** 자동변속: 가속 페달을 많이 밟을수록 높은 rpm까지 끌고 간다 */
  private pickGear(v: number, throttle: number): number {
    const [lo, hi] = this.spec.shiftRpm ?? [2000, 5800];
    const upRpm = lo + throttle * (hi - lo);
    let gear = 1;
    for (let g = 1; g <= this.spec.gears.length; g++) {
      gear = g;
      if (this.engineRpm(v, g) < upRpm) break;
    }
    return gear;
  }

  step(dt: number, road: Road, c: Controls) {
    const sp = this.spec;
    const L = sp.lf + sp.lr;
    const v = this.vx;

    // 조향: 바퀴각은 초당 최대 0.9rad로 따라간다
    const targetSteer = -c.steer * sp.maxSteer; // 오른쪽 입력 → 음수(오른쪽) 각
    const maxRate = 0.9 * dt;
    this.steerAngle += Math.max(-maxRate, Math.min(maxRate, targetSteer - this.steerAngle));

    // 변속
    this.shiftCooldown -= dt;
    if (!c.reverse && this.shiftCooldown <= 0) {
      const want = this.pickGear(Math.max(v, 0), c.throttle);
      if (want !== this.gear) {
        this.gear = want;
        this.shiftCooldown = 0.35;
      }
    }
    this.rpm = this.engineRpm(Math.abs(v), this.gear);

    // 길이 방향 힘
    const p = road.sample(this.s);
    let fx = 0;
    if (c.reverse) {
      fx += c.throttle * 3500 * (v > -5 ? 1 : 0);
    } else {
      const ratio = sp.gears[this.gear - 1] * sp.finalDrive;
      // 속도제한장치: 제한속도 0.5m/s 앞에서부터 힘을 줄인다
      const gov = sp.governor ?? Infinity;
      const cut = v > gov - 0.5 ? Math.max(0, (gov - v) / 0.5) : 1;
      const torque = this.torqueAt(this.rpm) * c.throttle * cut;
      fx += (torque * ratio * 0.9) / sp.wheelRadius;
    }
    fx -= 0.5 * RHO * sp.dragArea * v * Math.abs(v);
    fx -= sp.rolling * sp.mass * G * Math.sign(v) * Math.min(1, Math.abs(v) / 0.5);
    fx -= sp.mass * G * p.grade * Math.cos(this.theta);
    // 엔진 브레이크
    if (!c.reverse && c.throttle < 0.05 && v > 1) fx -= (250 + this.rpm * 0.08) * Math.sqrt(sp.mass / 1550);
    const brakeF = c.brake * sp.maxBrakeDecel * sp.mass;

    // 옆 방향: 타이어 힘
    let ay: number;
    let rdot: number;
    if (Math.abs(v) < 3) {
      // 저속에서는 운동학 모델 (미끄럼각 계산이 불안정해서)
      const rTarget = (v * Math.tan(this.steerAngle)) / L;
      rdot = (rTarget - this.r) / Math.max(dt, 0.05);
      this.vy += (((sp.lr / L) * v * Math.tan(this.steerAngle)) - this.vy) * Math.min(1, dt * 10);
      ay = v * this.r;
    } else {
      const alphaF = Math.atan2(this.vy + sp.lf * this.r, v) - this.steerAngle;
      const alphaR = Math.atan2(this.vy - sp.lr * this.r, v);
      const fzF = (sp.mass * G * sp.lr) / L;
      const fzR = (sp.mass * G * sp.lf) / L;
      const fyF = clamp(-sp.cf * alphaF, -sp.mu * fzF, sp.mu * fzF);
      const fyR = clamp(-sp.cr * alphaR, -sp.mu * fzR, sp.mu * fzR);
      ay = (fyF * Math.cos(this.steerAngle) + fyR) / sp.mass;
      rdot = (sp.lf * fyF * Math.cos(this.steerAngle) - sp.lr * fyR) / sp.inertia;
      this.vy += (ay - v * this.r) * dt;
    }
    this.r += rdot * dt;

    // 브레이크는 속도를 0 너머로 넘기지 않는다
    let axLong = fx / sp.mass;
    const brakeA = brakeF / sp.mass;
    if (v > 0) axLong -= brakeA;
    else if (v < 0) axLong += brakeA;
    const newV = v + (axLong + this.vy * this.r) * dt;
    if (c.brake > 0 && Math.sign(newV) !== Math.sign(v) && v !== 0) this.vx = 0;
    else this.vx = newV;
    if (!c.reverse && this.vx < 0 && c.throttle > 0) this.vx = 0;
    this.ax = axLong;
    this.ay = ay;

    // 정지 상태에서는 미끄러짐을 없앤다
    if (Math.abs(this.vx) < 0.05 && c.throttle === 0) {
      this.vx = 0;
      this.vy *= 0.8;
      this.r *= 0.8;
    }

    // 도로 좌표로 적분
    const cosT = Math.cos(this.theta);
    const sinT = Math.sin(this.theta);
    const sdot = (this.vx * cosT - this.vy * sinT) / (1 + p.kappa * this.d);
    const ddot = -(this.vx * sinT + this.vy * cosT);
    this.s += sdot * dt;
    this.d += ddot * dt;
    this.theta += (this.r - p.kappa * sdot) * dt;
    this.s = clamp(this.s, 0, road.length - 1);

    this.collideWalls(road);
  }

  /** 오른쪽 가드레일·왼쪽 중앙분리대 */
  private collideWalls(road: Road) {
    this.hits.length = 0;
    const w = road.widthAt(this.s);
    const half = this.spec.width / 2;
    const rightWall = w / 2 + RIGHT_SHOULDER + 0.35 - half;
    const leftWall = -w / 2 - LEFT_SHOULDER - 0.1 + half;
    // 차가 비스듬하면 모서리가 먼저 닿는다
    const corner = Math.abs(Math.sin(this.theta)) * (this.spec.length / 2);
    const lateral = -(this.vx * Math.sin(this.theta) + this.vy * Math.cos(this.theta)); // d 방향 속도
    if (this.d + corner > rightWall && lateral > -0.01) {
      this.d = rightWall - corner;
      this.bounce(lateral, "right");
    } else if (this.d - corner < leftWall && lateral < 0.01) {
      this.d = leftWall + corner;
      this.bounce(lateral, "left");
    }
  }

  private bounce(lateral: number, side: "left" | "right") {
    const speed = this.speed;
    this.hits.push({ side, lateralSpeed: Math.abs(lateral), speed });
    // 벽 쪽 속도는 없애고, 차를 벽과 나란하게 돌리며 마찰로 속도를 줄인다
    this.theta *= 0.4;
    this.vy *= 0.3;
    this.r *= 0.3;
    this.vx *= Math.max(0.55, 1 - Math.abs(lateral) * 0.06);
  }

  /** 앞뒤 차와 부딪혔을 때 */
  impact(deltaV: number) {
    this.vx = Math.max(0, this.vx + deltaV);
    this.r *= 0.5;
  }
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
