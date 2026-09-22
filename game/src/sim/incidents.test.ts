import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { incidentBlockS, incidentLabel, planIncidents } from "./incidents";

describe("돌발상황 배치", () => {
  const road = makeRoad({ length: 300000, lanes: 3, tunnel: [50000, 52000], junctions: [[80000, "가상IC", "1"]] });

  it("km당 빈도에 가깝게, 서로 4km 이상, 나들목 근처는 피해서 놓는다", () => {
    let n = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const list = planIncidents(road, { seed, night: false, startS: 0, finishS: road.length });
      n += list.length;
      for (const i of list) expect(Math.abs(i.s - 80000)).toBeGreaterThan(300);
      for (let k = 1; k < list.length; k++) expect(list[k].s - list[k - 1].s).toBeGreaterThanOrEqual(4000);
    }
    const perKm = n / 5 / (road.length / 1000);
    expect(perKm).toBeGreaterThan(1 / 120);
    expect(perKm).toBeLessThan(1 / 30);
  });

  it("터널 안에서는 갓길이 아니라 차로에 서고, 사고는 두 대다", () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => planIncidents(road, { seed, night: true, startS: 0, finishS: road.length }));
    for (const i of all) {
      if (i.s > 50000 && i.s < 52000) expect(i.lane).toBeGreaterThan(0);
      expect(i.vehicles).toBe(i.kind === "crash" ? 2 : 1);
      if (i.triangleS !== null) expect(i.triangleS).toBeLessThan(incidentBlockS(i));
    }
    expect(all.some((i) => i.lane === 0)).toBe(true);
    expect(all.some((i) => i.kind === "crash")).toBe(true);
  });

  it("공사 구간을 피해도, 피할 목록이 같으면 출발 위치와 상관없이 같은 자리", () => {
    const zones = [{ s0: 120000, sClosed: 120120, s1: 120800, lane: 3, side: "right" as const }];
    const a = planIncidents(road, { seed: 4, night: false, startS: 0, finishS: road.length, workZones: zones });
    const b = planIncidents(road, { seed: 4, night: false, startS: 150000, finishS: road.length, workZones: zones });
    expect(a.filter((i) => i.s > 151500)).toEqual(b);
    for (const i of a) expect(i.s < 118500 || i.s > 122300).toBe(true);
  });

  it("같은 시드면 어디서 출발하든 같은 자리", () => {
    const a = planIncidents(road, { seed: 9, night: false, startS: 0, finishS: road.length });
    const b = planIncidents(road, { seed: 9, night: false, startS: 100000, finishS: road.length });
    expect(a.filter((i) => i.s > 101500)).toEqual(b);
    expect(incidentLabel({ s: 0, lane: 0, kind: "breakdown", vehicles: 1, triangleS: null, evacuated: true })).toBe("갓길 고장 차량");
  });
});
