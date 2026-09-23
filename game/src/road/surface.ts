// 노면에서 바퀴로 느끼는 것들: 교량 신축이음(철판 이음매)과 갓길 노면요철(럼블 스트립).
// 소리(덜컥·부르릉), 화면 흔들림, 게임패드 진동, 도로 그림이 모두 여기 위치를 쓴다.

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
