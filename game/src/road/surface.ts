// 노면에서 바퀴로 느끼는 것들: 교량 신축이음(철판 이음매), 갓길 노면요철(럼블 스트립), 거친 노면(공사 구간·눈길).
// 소리(덜컥·부르릉·드르르), 화면 흔들림, 게임패드 진동, 도로 그림이 모두 여기 위치를 쓴다.

import { LEFT_SHOULDER, RIGHT_SHOULDER, Structure, type Road } from "./road";

/** 긴 다리는 양 끝 말고도 이 간격마다 신축이음이 있다 (연속 거더 몇 경간마다) */
const JOINT_SPACING = 120;
/** 이 길이보다 긴 다리부터 중간 이음을 넣는다 */
const LONG_BRIDGE = 300;

/** 교량 신축이음과 터널 입출구 포장 이음매 위치 (s 오름차순). 터널 이음은 약하다 */
export function expansionJoints(road: Road): { s: number; strength: number }[] {
  const out: { s: number; strength: number }[] = [];
  for (const st of road.structures) {
    if (st.kind === Structure.Bridge) {
      out.push({ s: st.s0, strength: 1 }, { s: st.s1, strength: 1 });
      const len = st.s1 - st.s0;
      if (len > LONG_BRIDGE) {
        const n = Math.floor(len / JOINT_SPACING);
        const step = len / (n + 1);
        for (let k = 1; k <= n; k++) out.push({ s: st.s0 + k * step, strength: 0.75 });
      }
    } else if (st.kind === Structure.Tunnel) {
      out.push({ s: st.s0, strength: 0.35 }, { s: st.s1, strength: 0.35 });
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/** 거친 노면이 앞뒤로 서서히 시작하고 끝나는 거리 (m) */
export const ROUGH_RAMP = 60;

/**
 * 노면 거칠기 (0 매끈 ~ 1 거칢). 보통 고속도로는 0이라 차가 떨지 않는다.
 * 공사 구간(임시 포장·덧씌우기 경계)은 라바콘이 시작하는 곳부터 끝나는 곳까지 1, 앞뒤 60m에 걸쳐 서서히.
 * 눈 쌓인 길은 바퀴 자국이 얼어 울퉁불퉁하다: 눈 양(0~1)에 따라 0.3~0.6. 터널 안에는 눈이 없으니 snow를 0으로 넘긴다.
 */
export function roughnessAt(s: number, zones: readonly { s0: number; s1: number }[], snow: number): number {
  let r = snow > 0 ? 0.3 + 0.3 * Math.min(1, snow) : 0;
  for (const z of zones) {
    const a = z.s0 - ROUGH_RAMP;
    const b = z.s1 + ROUGH_RAMP;
    if (s <= a || s >= b) continue;
    r = Math.max(r, Math.min(1, (s - a) / ROUGH_RAMP, (b - s) / ROUGH_RAMP));
  }
  return r;
}

/** 노면요철 띠: 바깥 차선에서 조금 떨어진 갓길 쪽 (d, 오른쪽 +). 터널 안에는 없다 */
export const RUMBLE = {
  /** 오른쪽 가장자리 차선 바깥으로 [from, to] m */
  right: [0.15, 0.55] as [number, number],
  /** 왼쪽 (중앙분리대 쪽) 가장자리 바깥으로 */
  left: [0.12, 0.42] as [number, number],
};

/** 타이어 폭 (m) */
const TIRE = 0.24;

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * 바퀴가 노면요철을 얼마나 밟았는지 (0~1)와 쪽 (-1 왼쪽, 1 오른쪽).
 * d: 차 중심 가로 위치, halfTrack: 좌우 바퀴 중심 간격의 반, w: 차로 폭 합.
 */
export function rumbleContact(road: Road, s: number, d: number, halfTrack: number): { amount: number; side: number } {
  if (road.structureAt(s) === Structure.Tunnel) return { amount: 0, side: 0 };
  const w = road.widthAt(s);
  const rw = d + halfTrack;
  const lw = d - halfTrack;
  const r0 = w / 2 + RUMBLE.right[0];
  const r1 = Math.min(w / 2 + RIGHT_SHOULDER, w / 2 + RUMBLE.right[1]);
  const l1 = -w / 2 - RUMBLE.left[0];
  const l0 = Math.max(-w / 2 - LEFT_SHOULDER, -w / 2 - RUMBLE.left[1]);
  const right = overlap(rw - TIRE / 2, rw + TIRE / 2, r0, r1) / TIRE;
  const left = overlap(lw - TIRE / 2, lw + TIRE / 2, l0, l1) / TIRE;
  if (right >= left) return { amount: right, side: right > 0 ? 1 : 0 };
  return { amount: left, side: -1 };
}
