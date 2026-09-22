// 새벽 결빙(블랙아이스): 맑고 추운 밤이면 다리 위와 터널을 나온 뒤 그늘진 곳이 얇게 언다.
// 노면이 젖은 것처럼 조금 어둡고 반들거릴 뿐 잘 보이지 않아, 모르고 들어가면 미끄러진다.
// 한국 고속도로 결빙 사고는 교량·터널 입출구·그늘진 구간에 몰린다. 어느 다리가 얼었는지는 시드로 정한다 (출발 위치와 무관).
// 얼음 위 마찰: 한국교통안전공단 빙판길 제동 시험 30km/h 제동거리 마른 노면 대비 승용 7.0배, 화물 4.6배, 버스 4.9배.

import { Structure, type Road } from "../road/road";

export interface IcePatch {
  s0: number;
  s1: number;
  kind: "bridge" | "tunnel_exit";
}

/** 얼음 위 노면 마찰 배율 (마른 노면 1) */
export const ICE_GRIP = { car: 1 / 7, heavy: 1 / 4.75 };
/** 결빙주의 안내를 띄우는 다리 길이 (이보다 짧은 다리는 안내 없이 가끔 언다) */
export const ICE_WARN_BRIDGE_M = 100;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 언 곳: 100m 넘는 다리의 35%, 짧은 다리의 10%, 터널 출구 뒤 120~300m의 30%.
 * 긴 다리는 150~600m만 언다. 출발 300m 안과 도착 뒤는 뺀다
 */
export function planIce(road: Road, opts: { seed: number; startS: number; finishS: number }): IcePatch[] {
  const rand = mulberry32(opts.seed ^ 0x1ce1ce);
  const out: IcePatch[] = [];
  for (const st of road.structures) {
    const r = rand();
    const r2 = rand();
    const r3 = rand();
    const len = st.s1 - st.s0;
    if (st.kind === Structure.Bridge) {
      if (r >= (len >= ICE_WARN_BRIDGE_M ? 0.35 : 0.1)) continue;
      const pl = Math.min(len, 150 + r2 * 450);
      const a = st.s0 + r3 * (len - pl);
      out.push({ s0: a, s1: a + pl, kind: "bridge" });
    } else if (st.kind === Structure.Tunnel) {
      if (r >= 0.3) continue;
      out.push({ s0: st.s1, s1: st.s1 + 120 + r2 * 180, kind: "tunnel_exit" });
    }
  }
  out.sort((a, b) => a.s0 - b.s0);
  // 겹치면 합친다
  const merged: IcePatch[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && p.s0 <= last.s1) last.s1 = Math.max(last.s1, p.s1);
    else merged.push({ ...p });
  }
  return merged.filter((p) => p.s1 > opts.startS + 300 && p.s0 < opts.finishS);
}

/** s에 있는 얼음 (없으면 null) */
export function iceAt(patches: IcePatch[], s: number): IcePatch | null {
  let lo = 0;
  let hi = patches.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = patches[mid];
    if (s < p.s0) hi = mid - 1;
    else if (s > p.s1) lo = mid + 1;
    else return p;
  }
  return null;
}

/** 결빙주의 안내: s 앞 range 안에서 가장 가까운 긴 다리 (얼었는지와 상관없이, 실제 도로의 결빙주의 표지처럼) */
export function nextIceWarning(road: Road, s: number, range: number): { s0: number; name: string } | null {
  for (const st of road.structures) {
    if (st.kind !== Structure.Bridge || st.s1 - st.s0 < ICE_WARN_BRIDGE_M) continue;
    if (st.s1 < s) continue;
    if (st.s0 - s > range) return null;
    return { s0: st.s0, name: st.name };
  }
  return null;
}
