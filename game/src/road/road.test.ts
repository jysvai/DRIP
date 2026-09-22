import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { LANE_WIDTH, Structure } from "./road";

describe("Road", () => {
  it("복원한 좌표로 길이와 방향을 맞게 계산한다", () => {
    const r = makeRoad({ length: 2000 });
    expect(r.length).toBeCloseTo(2000, 0);
    const p = r.sample(500);
    expect(p.te).toBeCloseTo(1, 3);
    expect(p.tn).toBeCloseTo(0, 3);
    expect(p.e - r.e[0]).toBeCloseTo(500, 0);
  });

  it("d는 진행 방향 오른쪽이 +다 (동쪽으로 갈 때 오른쪽은 남쪽)", () => {
    const r = makeRoad();
    const w = r.toWorld(100, 5);
    expect(w.n - r.nn[0]).toBeCloseTo(-5, 2);
  });

  it("차로 중심과 차로 번호가 서로 맞는다 (1차로가 왼쪽)", () => {
    const r = makeRoad({ lanes: 3 });
    expect(r.widthAt(1000)).toBeCloseTo(3 * LANE_WIDTH, 5);
    for (let lane = 1; lane <= 3; lane++) expect(r.laneOf(r.laneCenter(lane, 1000), 1000)).toBe(lane);
    expect(r.laneCenter(1, 1000)).toBeLessThan(r.laneCenter(3, 1000));
    expect(r.laneOf(-10, 1000)).toBe(0);
    expect(r.laneOf(10, 1000)).toBe(4);
  });

  it("왼쪽으로 굽으면 곡률이 +다", () => {
    const r = makeRoad({ curveFrom: 1000, radius: 500 });
    expect(r.sample(2000).kappa).toBeCloseTo(1 / 500, 4);
    expect(Math.abs(r.sample(500).kappa)).toBeLessThan(1e-5);
  });

  it("터널 구간과 나들목 종류를 읽는다", () => {
    const r = makeRoad({
      tunnel: [1000, 1500],
      junctions: [
        [800, "수원신갈", "44"],
        [1200, "신갈분기점", "45A"],
        [1600, "기흥 휴게소 (부산 방향)", ""],
        [1700, "통도사 하이패스", ""],
      ],
    });
    expect(r.structureAt(1200)).toBe(Structure.Tunnel);
    expect(r.structureAt(900)).toBe(Structure.Normal);
    expect(r.structures).toHaveLength(1);
    expect(r.junctions.map((j) => [j.name, j.kind])).toEqual([
      ["수원신갈IC", "IC"],
      ["신갈JC", "JC"],
      ["기흥 휴게소", "SA"],
      ["통도사 하이패스", "기타"],
    ]);
    expect(r.nextJunction(1000)?.name).toBe("신갈JC");
  });
});
