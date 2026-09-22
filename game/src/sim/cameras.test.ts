import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { enforcementFor } from "./cameras";
import type { CameraData } from "./config";
import type { Road } from "../road/road";

const data: CameraData = {
  source: "test",
  referenceDate: "2026-05-06",
  roads: {
    a: { fixed: [[1000, 100], [9000, 110]], sections: [[2000, 5000, 100], [7000, 12000, 110]] },
    b: { fixed: [[500, 0]], sections: [[1000, 3000, 80]] },
  },
};

describe("enforcementFor", () => {
  it("한 주행선이면 그대로", () => {
    const road = makeRoad({ length: 20000 });
    (road as { id: string }).id = "a";
    const e = enforcementFor(road, data);
    expect(e.fixed.map((c) => c.s)).toEqual([1000, 9000]);
    expect(e.sections).toHaveLength(2);
  });

  it("경로면 조각마다 옮기고, 조각을 벗어나는 구간단속은 뺀다", () => {
    // 조각 1: 주행선 a의 0~8000 → 경로 0~8000, 조각 2: 주행선 b의 200~5000 → 경로 8300~13100
    const route = {
      isRoute: true,
      id: "route",
      legs: [
        { road: "a", s0: 0, s1: 8000, src0: 0, src1: 8000 },
        { road: "b", s0: 8300, s1: 13100, src0: 200, src1: 5000 },
      ],
    } as unknown as Road;
    const e = enforcementFor(route, data);
    expect(e.fixed).toEqual([
      { s: 1000, limit: 100 },
      { s: 8600, limit: 0 },
    ]);
    // a의 7000~12000은 조각 1(0~8000)을 벗어나 빠진다
    expect(e.sections).toEqual([
      { s0: 2000, s1: 5000, limit: 100 },
      { s0: 9100, s1: 11100, limit: 80 },
    ]);
  });

  it("데이터가 없으면 비어 있다", () => {
    expect(enforcementFor(makeRoad({}), null)).toEqual({ fixed: [], sections: [] });
  });
});
