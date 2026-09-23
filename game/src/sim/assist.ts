// 운전 보조: 차로 유지 보조 (LKA). 판정이 아니라 요즘 차에 있는 보조 기능을 흉내 낸다.
// 시속 60km 넘게 달릴 때 방향지시등 없이 차선을 넘으려 하면(0.7초 뒤 차 옆면이 선을 넘으면)
// 경고하고 운전대를 살짝 돌려 차로 안으로 되돌린다. 실제 차처럼 힘은 약하고,
// 운전자가 그쪽으로 크게 꺾고 있으면(일부러 옮기는 중) 경고만 한다.

/** 계기판 표시: 꺼짐, 대기(느려서 쉼), 작동 준비, 경고(막는 중) */
export type LkaState = "off" | "standby" | "ready" | "warn";

export const LKA = {
  minKmh: 60,
  /** 몇 초 뒤 위치로 넘을지 본다 */
  lookahead: 0.7,
  /** 아직 선에 닿지 않았으면 이보다 빨리(m/s) 다가갈 때만 (이미 닿았으면 조금만 다가가도) */
  minDrift: 0.12,
  /** 되돌리는 조향의 최대 크기 (조향 입력 -1~1 기준) */
  maxSteer: 0.16,
  /** 운전자가 그쪽으로 이만큼 넘게 꺾고 있으면 일부러 옮기는 것으로 본다 */
  intendSteer: 0.35,
  /** 방향지시등을 켜거나 끈 뒤 쉬는 시간 (s) */
  signalHold: 2,
  /** 경고 표시를 유지하는 시간 (s) */
  warnHold: 1.2,
};

export interface LaneKeepInput {
  /** 차 중심의 가로 위치 (도로 기준, 오른쪽 +) */
  d: number;
  /** d의 변화율 (m/s) */
  ddot: number;
  /** 지금 달리는 차로의 가운데 */
  center: number;
  laneWidth: number;
  carWidth: number;
  /** 운전자 조향 입력 (-1~1, 오른쪽 +) */
  steer: number;
}

export interface LaneKeepOut {
  /** 넘으려는 쪽: -1 왼쪽, 1 오른쪽, 0 없음 */
  side: -1 | 0 | 1;
  /** 보조를 더한 조향 입력 */
  steer: number;
  /** 운전자가 일부러 옮기는 중이라 경고만 했는지 */
  intended: boolean;
}

export function laneKeep(i: LaneKeepInput): LaneKeepOut {
  const future = i.d + i.ddot * LKA.lookahead;
  const edge = i.carWidth / 2;
  const half = i.laneWidth / 2;
  const overR = future + edge - (i.center + half);
  const overL = i.center - half - (future - edge);
  const touchR = i.d + edge > i.center + half;
  const touchL = i.d - edge < i.center - half;
  const side = overR > 0 && (i.ddot > LKA.minDrift || (touchR && i.ddot > 0)) ? 1 : overL > 0 && (i.ddot < -LKA.minDrift || (touchL && i.ddot < 0)) ? -1 : 0;
  if (!side) return { side: 0, steer: i.steer, intended: false };
  const over = side > 0 ? overR : overL;
  const intended = Math.sign(i.steer) === side && Math.abs(i.steer) > LKA.intendSteer;
  if (intended) return { side, steer: i.steer, intended };
  const push = Math.min(LKA.maxSteer, 0.05 + over * 0.12 + Math.abs(i.ddot) * 0.05);
  return { side, steer: Math.max(-1, Math.min(1, i.steer - side * push)), intended };
}
