// 요약 주행: 달리는 동안은 배속 없이 실시간 그대로, 대신 경로 전체가 아니라 몇 구간만 달리고 나머지는 건너뛴다.
// 경로를 실제로 달리면 걸리는 시간의 약 1/12 (1시간이면 5분)만 달린다.
// 반드시 달리는 곳: 출발, 노선을 갈아타는 분기점(2.3km 앞 안내부터 연결로를 지나 합류까지), 도착.
// 남는 시간은 사이 구간에 고르게 나눈다. 고를 때 실제 사고 자료는 보지 않는다 (가상 핫스팟과 실제 핫스팟을 비교하는 연구라서).
// 대신 나들목·공사·선 차·구간단속 시점처럼 이 게임이 이미 알고 있는 곳이 있으면 그쪽으로 조금 당긴다.
// 시내·국도는 느리고 교차로가 잦아 구간을 짧게 잡고(DIGEST_CITY), 교차로 안이나 정지선 바로 앞으로는 건너뛰지 않는다(avoid).

export interface DriveWindow {
  s0: number;
  s1: number;
  why: "start" | "transfer" | "sample" | "finish";
}

export interface DigestOptions {
  startS: number;
  finishS: number;
  /** 노선을 갈아타는 분기점: 앞 조각이 끝나는 곳(s)과 다음 조각이 시작하는 곳(연결로 끝) */
  transfers: { diverge: number; merge: number }[];
  /** 사이 구간을 고를 때 당겨 올 만한 곳 (나들목·공사·선 차 등) */
  poi: number[];
  seed: number;
  /** 실제 주행 시간 대비 몇 분의 1만 달릴지 */
  ratio?: number;
  /** 사이 구간 하나의 길이 (m) */
  windowM?: number;
  /** 아무리 짧아도 이만큼은 달린다 (m) */
  minPlayM?: number;
  /** 구간 길이·간격 묶음 (없으면 고속도로 DIGEST) */
  profile?: DigestProfile;
  /** 건너뛰어 내려앉거나 건너뛰기 시작하면 안 되는 곳 [s0, s1] (시내 교차로와 그 앞 정지선 둘레). 구간 끝이 걸리면 빠져나간 뒤로 늘린다 */
  avoid?: [number, number][];
}

export interface DigestProfile {
  ratio: number;
  windowM: number;
  minPlayM: number;
  /** 분기점 앞 몇 m부터 달리는지 (2km 음성 안내를 듣고 차로를 옮길 시간) */
  transferBefore: number;
  /** 연결로 끝(합류) 뒤 몇 m까지 */
  transferAfter: number;
  /** 도착 앞 몇 m */
  finishM: number;
  /** 이보다 짧은 틈은 건너뛰지 않고 이어서 달린다 (건너뛰는 맛이 없고 화면만 끊긴다) */
  minGapM: number;
  /** 사이 구간을 관심 지점 몇 m 앞에서 시작하는지 */
  poiLeadM: number;
}

export const DIGEST: DigestProfile = {
  ratio: 12,
  windowM: 2200,
  minPlayM: 5000,
  transferBefore: 2300,
  transferAfter: 900,
  finishM: 1800,
  minGapM: 1500,
  poiLeadM: 600,
};

/** 시내·국도: 시속 30~60km에 신호가 잦아 800m 구간이면 교차로 두세 곳을 지난다. 짧은 길도 1.5km(3~4분)는 달린다 */
export const DIGEST_CITY: DigestProfile = {
  ratio: 12,
  windowM: 800,
  minPlayM: 1500,
  transferBefore: 0,
  transferAfter: 0,
  finishM: 600,
  minGapM: 500,
  poiLeadM: 250,
};

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 달릴 구간들 (s 순서, 겹치지 않음). 건너뛸 필요가 없을 만큼 짧으면 전체 한 구간 */
export function planDigest(o: DigestOptions): DriveWindow[] {
  const P = o.profile ?? DIGEST;
  const ratio = o.ratio ?? P.ratio;
  const W = o.windowM ?? P.windowM;
  const start = o.startS;
  const end = o.finishS;
  const total = end - start;
  const budget = Math.max(o.minPlayM ?? P.minPlayM, total / ratio);
  if (total <= budget * 1.3) return [{ s0: start, s1: end, why: "start" }];

  const must: DriveWindow[] = [{ s0: start, s1: Math.min(end, start + W), why: "start" }];
  for (const t of o.transfers) {
    if (t.merge <= start || t.diverge >= end) continue;
    must.push({ s0: Math.max(start, t.diverge - P.transferBefore), s1: Math.min(end, t.merge + P.transferAfter), why: "transfer" });
  }
  must.push({ s0: Math.max(start, end - P.finishM), s1: end, why: "finish" });
  let wins = merge(must);

  // 남는 몫을 사이 구간으로 채운다 (가장 긴 틈부터 하나씩)
  const used = wins.reduce((a, w) => a + (w.s1 - w.s0), 0);
  let n = Math.round(Math.max(0, budget - used) / W);
  const gaps = () => {
    const out: { a: number; b: number }[] = [];
    for (let i = 0; i + 1 < wins.length; i++) out.push({ a: wins[i].s1, b: wins[i + 1].s0 });
    return out;
  };
  let k = 0;
  while (n > 0) {
    // 가장 긴 틈 가운데쯤 (시드로 조금 흔들고, 가까운 관심 지점이 있으면 그쪽으로)
    const g = gaps().sort((x, y) => y.b - y.a - (x.b - x.a))[0];
    if (!g || g.b - g.a < W + 2 * P.minGapM) break;
    const lo = g.a + P.minGapM;
    const hi = g.b - P.minGapM - W;
    let s0 = lo + (hi - lo) * (0.3 + 0.4 * hash(o.seed * 31 + k++));
    const lead = P.poiLeadM;
    const near = o.poi.filter((p) => p - lead >= lo && p - lead <= hi).sort((x, y) => Math.abs(x - lead - s0) - Math.abs(y - lead - s0))[0];
    if (near !== undefined && Math.abs(near - lead - s0) < (hi - lo) * 0.3) s0 = near - lead;
    wins = merge([...wins, { s0, s1: s0 + W, why: "sample" }]);
    n--;
  }
  // 교차로 안이나 정지선 바로 앞에 내려앉지 않게 빠져나간 뒤로 미루고, 교차로 안에서 건너뛰지 않게 끝을 빠져나간 뒤로 늘린다
  if (o.avoid?.length) {
    // 붙어 있는 교차로는 차례로 빠져나간다
    const out = (s: number) => {
      for (let hit = o.avoid!.find(([a, b]) => s > a && s < b); hit; hit = o.avoid!.find(([a, b]) => s > a && s < b)) s = hit[1];
      return s;
    };
    wins = merge(wins.map((w, i) => ({ ...w, s0: i === 0 ? w.s0 : Math.min(out(w.s0), w.s1), s1: i === wins.length - 1 ? w.s1 : Math.min(end, out(w.s1)) })));
  }
  // 너무 짧은 틈은 이어 달린다
  const out: DriveWindow[] = [];
  for (const w of wins) {
    const last = out[out.length - 1];
    if (last && w.s0 - last.s1 < P.minGapM) last.s1 = Math.max(last.s1, w.s1);
    else out.push({ ...w });
  }
  return out;
}

function merge(list: DriveWindow[]): DriveWindow[] {
  const sorted = [...list].sort((a, b) => a.s0 - b.s0);
  const out: DriveWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.s0 <= last.s1) {
      last.s1 = Math.max(last.s1, w.s1);
      if (last.why === "sample") last.why = w.why;
    } else out.push({ ...w });
  }
  return out;
}

/** 달리는 거리 합 (m) */
export function playDistance(wins: DriveWindow[]): number {
  return wins.reduce((a, w) => a + (w.s1 - w.s0), 0);
}

/** s 다음에 달릴 구간 (s가 구간 안이면 그 구간) */
export function windowAt(wins: DriveWindow[], s: number): DriveWindow | null {
  for (const w of wins) if (s < w.s1) return w;
  return null;
}

/**
 * 메뉴용 어림: 경로 조각 길이들로 요약 주행 구간을 짠다 (연결로 길이는 300m로 친다).
 * 실제 주행에서는 이어 붙인 도로로 다시 짠다.
 */
export function digestForLegs(legLens: number[], startM: number, seed = 1): DriveWindow[] {
  let s = 0;
  const transfers: { diverge: number; merge: number }[] = [];
  legLens.forEach((len, i) => {
    if (i > 0) {
      transfers.push({ diverge: s, merge: s + 300 });
      s += 300;
    }
    s += len;
  });
  return planDigest({ startS: Math.min(startM, Math.max(0, s - 2000)), finishS: s, transfers, poi: [], seed });
}
