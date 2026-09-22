import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { ICE_GRIP, iceAt, nextIceWarning, planIce } from "./ice";

describe("새벽 결빙", () => {
  // 30km에 긴 다리 40개(200m)와 짧은 다리 몇 개, 터널 두 개
  const bridges: [number, number][] = [];
  for (let k = 0; k < 40; k++) bridges.push([1000 + k * 700, 1200 + k * 700]);
  bridges.push([29000, 29050]);
  const road = makeRoad({ length: 40000, tunnel: [30000, 31500], bridges });

  it("긴 다리의 일부와 터널 출구 뒤만 얼고, 같은 시드면 출발 위치와 상관없이 같다", () => {
    const all = planIce(road, { seed: 7, startS: 0, finishS: 40000 });
    const bridgeIce = all.filter((p) => p.kind === "bridge");
    expect(bridgeIce.length).toBeGreaterThan(4);
    expect(bridgeIce.length).toBeLessThan(28);
    for (const p of bridgeIce) {
      const b = bridges.find(([a, e]) => p.s0 >= a - 1 && p.s1 <= e + 1);
      expect(b).toBeTruthy();
    }
    const later = planIce(road, { seed: 7, startS: 15000, finishS: 40000 });
    expect(later.every((p) => all.some((q) => q.s0 === p.s0 && q.s1 === p.s1))).toBe(true);
    expect(later.every((p) => p.s1 > 15300)).toBe(true);
    // 다른 시드면 다른 다리
    const other = planIce(road, { seed: 8, startS: 0, finishS: 40000 });
    expect(other.map((p) => p.s0)).not.toEqual(all.map((p) => p.s0));
  });

  it("터널 출구 뒤 결빙은 터널 끝에서 시작한다", () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i);
    const exits = seeds.flatMap((seed) => planIce(road, { seed, startS: 0, finishS: 40000 }).filter((p) => p.kind === "tunnel_exit"));
    expect(exits.length).toBeGreaterThan(3);
    for (const p of exits) {
      expect(p.s0).toBe(31500);
      expect(p.s1 - p.s0).toBeGreaterThanOrEqual(120);
      expect(p.s1 - p.s0).toBeLessThanOrEqual(300);
    }
  });

  it("언 곳 찾기와 결빙주의 안내 (100m 넘는 다리마다)", () => {
    const ice = planIce(road, { seed: 7, startS: 0, finishS: 40000 });
    const p = ice[0];
    expect(iceAt(ice, (p.s0 + p.s1) / 2)).toBe(p);
    expect(iceAt(ice, p.s0 - 1)).toBeNull();
    expect(nextIceWarning(road, 800, 500)?.s0).toBe(1000);
    expect(nextIceWarning(road, 1100, 500)?.s0).toBe(1000);
    expect(nextIceWarning(road, 28900, 500)).toBeNull();
    // 얼음 위 마찰: 공단 빙판길 시험 (승용 7배, 대형 약 4.75배 제동거리)
    expect(1 / ICE_GRIP.car).toBeCloseTo(7);
    expect(ICE_GRIP.heavy).toBeGreaterThan(ICE_GRIP.car);
  });
});
