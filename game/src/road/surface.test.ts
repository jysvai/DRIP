import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { ROUGH_RAMP, expansionJoints, roughnessAt, rumbleContact } from "./surface";

describe("노면 거칠기", () => {
  const zones = [{ s0: 5000, s1: 6000 }];
  it("보통 고속도로는 매끈하다", () => {
    expect(roughnessAt(1000, zones, 0)).toBe(0);
    expect(roughnessAt(4900, zones, 0)).toBe(0);
  });
  it("공사 구간은 거칠고, 앞뒤로 서서히 바뀐다", () => {
    expect(roughnessAt(5500, zones, 0)).toBe(1);
    expect(roughnessAt(5000 - ROUGH_RAMP / 2, zones, 0)).toBeCloseTo(0.5);
    expect(roughnessAt(6000 + ROUGH_RAMP / 2, zones, 0)).toBeCloseTo(0.5);
    expect(roughnessAt(6000 + ROUGH_RAMP, zones, 0)).toBe(0);
  });
  it("눈길은 눈 양에 따라 조금 거칠다", () => {
    expect(roughnessAt(1000, zones, 0.5)).toBeCloseTo(0.45);
    expect(roughnessAt(1000, zones, 1)).toBeCloseTo(0.6);
    expect(roughnessAt(5500, zones, 1)).toBe(1);
  });
});

describe("신축이음", () => {
  it("짧은 다리는 양 끝에만, 긴 다리는 중간에도 있다", () => {
    const road = makeRoad({
      length: 8000,
      bridges: [
        [1000, 1200],
        [3000, 3800],
      ],
    });
    const js = expansionJoints(road).map((j) => j.s);
    expect(js.filter((s) => s >= 1000 && s <= 1200)).toEqual([1000, 1200]);
    const long = js.filter((s) => s >= 3000 && s <= 3800);
    expect(long[0]).toBe(3000);
    expect(long[long.length - 1]).toBe(3800);
    expect(long.length).toBeGreaterThan(4);
  });

  it("터널 입출구 이음매는 약하다", () => {
    const road = makeRoad({ length: 6000, tunnel: [2000, 2600] });
    const js = expansionJoints(road);
    expect(js.map((j) => j.s)).toEqual([2000, 2600]);
    expect(js.every((j) => j.strength < 0.5)).toBe(true);
  });
});

describe("노면요철", () => {
  const road = makeRoad({ length: 5000, lanes: 3, tunnel: [3000, 3500] });
  const half = 1.86 / 2 - 0.12;

  it("차로 가운데서는 밟지 않는다", () => {
    expect(rumbleContact(road, 1000, road.laneCenter(3, 1000), half).amount).toBe(0);
  });

  it("오른쪽 바퀴가 갓길 요철에 올라가면 오른쪽에서 느낀다", () => {
    const w = road.widthAt(1000);
    const c = rumbleContact(road, 1000, w / 2 + 0.35 - half, half);
    expect(c.amount).toBeGreaterThan(0.9);
    expect(c.side).toBe(1);
  });

  it("왼쪽(중앙분리대 쪽)도 있고, 터널 안에는 없다", () => {
    const w = road.widthAt(1000);
    const left = rumbleContact(road, 1000, -w / 2 - 0.27 + half, half);
    expect(left.amount).toBeGreaterThan(0.9);
    expect(left.side).toBe(-1);
    expect(rumbleContact(road, 3200, road.widthAt(3200) / 2 + 0.35 - half, half).amount).toBe(0);
  });
});
