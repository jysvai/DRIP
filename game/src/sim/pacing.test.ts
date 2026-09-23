import { describe, expect, it } from "vitest";
import { DIGEST, planDigest, playDistance, windowAt } from "./pacing";

const base = { poi: [], seed: 7, transfers: [] };

function wellFormed(wins: ReturnType<typeof planDigest>, start: number, end: number) {
  expect(wins[0].s0).toBe(start);
  expect(wins[wins.length - 1].s1).toBe(end);
  for (let i = 0; i < wins.length; i++) {
    expect(wins[i].s1).toBeGreaterThan(wins[i].s0);
    if (i > 0) expect(wins[i].s0 - wins[i - 1].s1).toBeGreaterThanOrEqual(DIGEST.minGapM);
  }
}

describe("요약 주행 구간", () => {
  it("짧은 길은 끊지 않고 다 달린다", () => {
    expect(planDigest({ ...base, startS: 1000, finishS: 7000 })).toEqual([{ s0: 1000, s1: 7000, why: "start" }]);
  });

  it("긴 길은 약 12분의 1만 달린다 (1시간 → 5분)", () => {
    const wins = planDigest({ ...base, startS: 0, finishS: 100_000 });
    wellFormed(wins, 0, 100_000);
    const d = playDistance(wins);
    expect(d).toBeGreaterThan(100_000 / 12 - DIGEST.windowM);
    expect(d).toBeLessThan(100_000 / 12 + DIGEST.windowM);
    expect(wins.length).toBeGreaterThanOrEqual(4);
  });

  it("노선을 갈아타는 분기점은 2km 안내 전부터 합류 뒤까지 꼭 달린다", () => {
    const transfers = [
      { diverge: 60_000, merge: 60_600 },
      { diverge: 200_000, merge: 200_450 },
    ];
    const wins = planDigest({ ...base, startS: 0, finishS: 370_000, transfers });
    wellFormed(wins, 0, 370_000);
    for (const t of transfers) {
      const w = wins.find((x) => x.s0 <= t.diverge - DIGEST.transferBefore && x.s1 >= t.merge + DIGEST.transferAfter);
      expect(w).toBeDefined();
    }
    // 서울→부산(370km, 약 3시간 40분)이 20분 안쪽
    expect(playDistance(wins)).toBeLessThan(370_000 / 12 + 3 * DIGEST.windowM);
  });

  it("같은 시드면 같은 구간, 관심 지점 쪽으로 당긴다", () => {
    const a = planDigest({ ...base, startS: 0, finishS: 120_000 });
    const b = planDigest({ ...base, startS: 0, finishS: 120_000 });
    expect(a).toEqual(b);
    const poi = a.filter((w) => w.why === "sample").map((w) => w.s0 + 600 + 1500);
    const c = planDigest({ ...base, startS: 0, finishS: 120_000, poi });
    const hits = c.filter((w) => w.why === "sample" && poi.some((p) => p > w.s0 && p < w.s1));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("다음 달릴 구간 찾기", () => {
    const wins = planDigest({ ...base, startS: 0, finishS: 100_000 });
    expect(windowAt(wins, 10)).toBe(wins[0]);
    expect(windowAt(wins, wins[0].s1 + 1)).toBe(wins[1]);
    expect(windowAt(wins, 100_001)).toBeNull();
  });
});
