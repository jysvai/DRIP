import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { realEventsFor, realEventsStamp, REAL_WORK_M, type RealEventData } from "./realEvents";

describe("실제 돌발상황 (ITS)", () => {
  const road = makeRoad({ length: 50000, lanes: 3 });
  const data: RealEventData = {
    source: "test",
    fetchedAt: "2026-09-22T06:40+09:00",
    roads: {
      [road.id]: [
        [10000, "work", [2, 3], "202609220500", "(2,3차로) 노면보수"],
        [10300, "work", [3], "202609220500", "겹치는 공사"],
        [20000, "work", [1], "202609220500", "1차로 공사"],
        [30000, "crash", [2], "202609220600", "2차로 승용차 추돌"],
        [40000, "breakdown", [], "202609220610", "갓길 고장"],
      ],
      other: [[5000, "crash", [1], "", ""]],
    },
  };

  it("공사는 가까운 가장자리 차로를 막고, 겹치는 공사는 하나로, 사고·고장은 선 차로", () => {
    const r = realEventsFor(road, data)!;
    expect(r.workZones).toHaveLength(2);
    expect(r.workZones[0]).toMatchObject({ sClosed: 10000, s1: 10000 + REAL_WORK_M, lane: 3, side: "right" });
    expect(r.workZones[1]).toMatchObject({ lane: 1, side: "left" });
    expect(r.incidents).toHaveLength(2);
    expect(r.incidents[0]).toMatchObject({ s: 30000, lane: 2, kind: "crash", vehicles: 2 });
    expect(r.incidents[1]).toMatchObject({ s: 40000, lane: 0, kind: "breakdown" });
    expect(realEventsStamp(data)).toBe("09/22 06:40 기준");
  });

  it("자료가 없으면 null (빈도로 놓는다)", () => {
    expect(realEventsFor(road, null)).toBeNull();
  });
});
