import { describe, expect, it } from "vitest";
import type { CabinSpec } from "./vehicleModels";
import { WindshieldRain } from "./windshield";

// 중형 승용차 앞유리 정도 (vehicleModels의 sedan_mid 값)
const cab = { kind: "car", wsBase: [1.03, 0.93], wsTop: [0.29, 1.44] } as unknown as CabinSpec;

function run(w: WindshieldRain, sec: number, kmh: number, covered = false) {
  let strokes = 0;
  w.onStroke = () => strokes++;
  for (let i = 0; i < sec * 30; i++) w.update(1 / 30, kmh, covered, 1, null);
  return strokes;
}

describe("앞유리 빗방울·와이퍼", () => {
  it("맑으면 방울도 없고 와이퍼도 쉰다", () => {
    const w = new WindshieldRain(cab, 1.86);
    expect(run(w, 5, 100)).toBe(0);
    expect(w.dropCount).toBe(0);
    expect(w.wiping).toBe(false);
  });

  it("비가 오면 방울이 맺히고 와이퍼가 돈다. 달릴수록 더 많이 맺힌다", () => {
    const slow = new WindshieldRain(cab, 1.86);
    const fast = new WindshieldRain(cab, 1.86);
    slow.rain = fast.rain = 0.5;
    const n = run(slow, 1, 10);
    run(fast, 1, 110);
    expect(slow.dropCount).toBeGreaterThan(10);
    expect(fast.dropCount).toBeGreaterThan(slow.dropCount * 2);
    expect(n).toBe(0);
    // 몇 초 지나면 간헐로 닦는다
    expect(run(slow, 6, 10)).toBeGreaterThan(0);
  });

  it("와이퍼가 한 번 쓸면 방울이 줄어든다 (쓸지 않는 구석은 남는다)", () => {
    const w = new WindshieldRain(cab, 1.86);
    w.rain = 0.5;
    // 천천히 가며 첫 번째 닦기가 끝날 때까지, 그다음 쉬는 동안 방울이 쌓인다
    let i = 0;
    while (!w.wiping && i++ < 300) w.update(1 / 30, 10, false, 1, null);
    while (w.wiping && i++ < 600) w.update(1 / 30, 10, false, 1, null);
    for (let k = 0; k < 50; k++) w.update(1 / 30, 10, false, 1, null);
    const before = w.dropCount;
    expect(before).toBeGreaterThan(30);
    w.rain = 0;
    while (!w.wiping && i++ < 900) w.update(1 / 30, 10, false, 1, null);
    while (w.wiping && i++ < 1200) w.update(1 / 30, 10, false, 1, null);
    // 운전자 앞 가운데는 깨끗하고, 조수석 위 구석에는 남는다
    const drops = (w as unknown as { drops: { u: number; v: number }[] }).drops;
    const inBox = (u0: number, u1: number, v0: number, v1: number) => drops.filter((p) => p.u > u0 && p.u < u1 && p.v > v0 && p.v < v1).length;
    expect(inBox(-0.28, 0.1, 0.2, 0.5)).toBe(0);
    expect(inBox(0.2, 0.7, 0.55, 0.9)).toBeGreaterThan(0);
    expect(w.dropCount).toBeLessThan(before);
  });

  it("폭우는 쉬지 않고 빠르게, 터널에서는 새 방울이 없어 두 번 더 닦고 멈춘다", () => {
    const w = new WindshieldRain(cab, 1.86);
    w.rain = 1;
    expect(run(w, 4, 80)).toBeGreaterThanOrEqual(7);
    const outside = w.dropCount;
    expect(run(w, 20, 80, true)).toBeLessThanOrEqual(5);
    expect(w.dropCount).toBeLessThan(outside);
    expect(w.wiping).toBe(false);
  });
});
