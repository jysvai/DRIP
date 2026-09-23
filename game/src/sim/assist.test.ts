import { describe, expect, it } from "vitest";
import { LKA, laneKeep } from "./assist";

// 3.6m 차로 가운데가 0, 폭 1.9m 승용차
const base = { center: 0, laneWidth: 3.6, carWidth: 1.9, steer: 0 };

describe("차로 유지 보조", () => {
  it("차로 가운데를 곧게 달리면 가만히 있다", () => {
    expect(laneKeep({ ...base, d: 0, ddot: 0 })).toEqual({ side: 0, steer: 0, intended: false });
  });

  it("오른쪽 선으로 흘러가면 왼쪽으로 되돌린다", () => {
    const r = laneKeep({ ...base, d: 0.6, ddot: 0.5 });
    expect(r.side).toBe(1);
    expect(r.intended).toBe(false);
    expect(r.steer).toBeLessThan(0);
    expect(r.steer).toBeGreaterThanOrEqual(-LKA.maxSteer);
  });

  it("왼쪽 선으로 흘러가면 오른쪽으로 되돌린다 (운전자 조향에 더한다)", () => {
    const r = laneKeep({ ...base, d: -0.6, ddot: -0.5, steer: -0.05 });
    expect(r.side).toBe(-1);
    expect(r.steer).toBeGreaterThan(-0.05);
    expect(r.steer - -0.05).toBeLessThanOrEqual(LKA.maxSteer + 1e-9);
  });

  it("운전자가 그쪽으로 크게 꺾고 있으면 경고만 하고 조향은 그대로", () => {
    const r = laneKeep({ ...base, d: 0.6, ddot: 0.8, steer: 0.5 });
    expect(r).toEqual({ side: 1, steer: 0.5, intended: true });
  });

  it("선 쪽으로 가더라도 아주 느리거나 아직 멀면 가만히 있다", () => {
    expect(laneKeep({ ...base, d: 0.8, ddot: 0.05 }).side).toBe(0);
    expect(laneKeep({ ...base, d: 0, ddot: 0.5 }).side).toBe(0);
  });

  it("이미 선에 닿았으면 천천히 밀려가도 되돌린다", () => {
    const r = laneKeep({ ...base, d: 0.9, ddot: 0.04 });
    expect(r.side).toBe(1);
    expect(r.steer).toBeLessThan(0);
  });

  it("선에서 멀어지는 중이면 선 위에 있어도 가만히 있다", () => {
    expect(laneKeep({ ...base, d: 1.2, ddot: -0.4 }).side).toBe(0);
  });
});
