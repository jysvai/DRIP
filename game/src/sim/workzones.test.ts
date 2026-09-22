import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { closedLane, coneLine, planWorkZones, TAPER_M, zoneLimit, zoneRatePerKm, ZONE_KMH, type WorkZone } from "./workzones";

describe("공사 구간", () => {
  const road = makeRoad({ length: 200000, lanes: 3, tunnel: [50000, 52000], junctions: [[80000, "가상IC", "1"]] });

  it("낮 평일에 가장 많고 주말에는 드물다", () => {
    expect(zoneRatePerKm(11, false)).toBeGreaterThan(zoneRatePerKm(23, false));
    expect(zoneRatePerKm(11, true)).toBeLessThan(zoneRatePerKm(11, false));
  });

  it("터널·나들목 근처와 출발 직후는 피하고, 서로 5km 넘게 떨어진다", () => {
    const zones = planWorkZones(road, { seed: 7, hour: 11, weekend: false, startS: 0, finishS: road.length });
    expect(zones.length).toBeGreaterThan(1);
    for (const z of zones) {
      expect(z.s0).toBeGreaterThan(1200);
      expect(z.s1 < 49800 || z.s0 > 52200).toBe(true);
      expect(z.s1 < 79600 || z.s0 > 80400).toBe(true);
      expect([1, 3]).toContain(z.lane);
    }
    for (let i = 1; i < zones.length; i++) expect(zones[i].s0 - zones[i - 1].s1).toBeGreaterThan(5000);
  });

  it("놓을 자리가 안 맞아도 km당 빈도에 가깝게 놓인다", () => {
    let n = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) n += planWorkZones(road, { seed, hour: 11, weekend: false, startS: 0, finishS: road.length }).length;
    const expected = (8 * (road.length / 1000)) / 35;
    expect(n).toBeGreaterThan(expected * 0.6);
  });

  it("같은 시드면 어디서 출발하든 같은 곳에 놓인다", () => {
    const a = planWorkZones(road, { seed: 3, hour: 10, weekend: false, startS: 0, finishS: road.length });
    const b = planWorkZones(road, { seed: 3, hour: 10, weekend: false, startS: 60000, finishS: road.length });
    expect(b.length).toBeGreaterThan(0);
    expect(a.filter((z) => z.s0 > 61200)).toEqual(b);
  });

  it("라바콘 줄은 막히는 차로 바깥 가장자리에서 옆 차로 경계로 들어온다", () => {
    const z: WorkZone = { s0: 1000, sClosed: 1000 + TAPER_M, s1: 1600, lane: 3, side: "right" };
    const w = road.widthAt(1000);
    expect(coneLine(road, z, 1000)).toBeCloseTo(w / 2);
    expect(coneLine(road, z, 1300)).toBeCloseTo(w / 2 - 3.6);
    expect(coneLine(road, z, 900)).toBeNull();
    expect(closedLane([z], 1300)).toBe(3);
    expect(closedLane([z], 1010)).toBeNull();
    expect(zoneLimit([z], 800)).toBe(ZONE_KMH);
    expect(zoneLimit([z], 600)).toBeNull();
  });
});
