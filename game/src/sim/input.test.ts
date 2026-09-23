import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { PEDAL, pedalStep, type PedalMode } from "./input";
import { PlayerCar } from "./player";

const DT = 1 / 60;

/** keys: [↑, ↓, 초] 순서대로 누른다 */
function press(mode: PedalMode, keys: [boolean, boolean, number][]) {
  let p = { throttle: 0, brake: 0 };
  let upFor = 0;
  let downFor = 0;
  for (const [up, down, sec] of keys) {
    for (let i = 0; i < sec / DT; i++) {
      upFor = up ? upFor + DT : 0;
      downFor = down ? downFor + DT : 0;
      p = pedalStep(mode, p.throttle, p.brake, up, down, DT, upFor, downFor);
    }
  }
  return p;
}

describe("키보드 페달 (누른 만큼 유지)", () => {
  it("↑를 누른 만큼 깊게 밟히고, 떼도 그 깊이가 남는다", () => {
    const p = press("hold", [
      [true, false, 0.6],
      [false, false, 5],
    ]);
    expect(p.throttle).toBeCloseTo(PEDAL.fineFor * PEDAL.fine + (0.6 - PEDAL.fineFor) * PEDAL.press, 1);
    expect(p.brake).toBe(0);
  });

  it("짧게 톡 누르면 조금씩만 바뀐다 (정속 페달 15~30%를 맞출 수 있게)", () => {
    const tap = press("hold", [
      [true, false, 0.6],
      [false, false, 0.5],
      [true, false, 0.1],
    ]);
    const base = press("hold", [[true, false, 0.6]]);
    expect(tap.throttle - base.throttle).toBeLessThan(0.05);
    const lifted = press("hold", [
      [true, false, 0.6],
      [false, false, 0.5],
      [false, true, 0.1],
    ]);
    expect(base.throttle - lifted.throttle).toBeLessThan(0.05);
    expect(lifted.brake).toBe(0);
  });

  it("↓를 꾹 누르면 0.3초 안에 브레이크가 밟힌다", () => {
    const p = press("hold", [
      [true, false, 0.6],
      [false, true, 0.35],
    ]);
    expect(p.throttle).toBe(0);
    expect(p.brake).toBeGreaterThan(0);
  });

  it("↓는 먼저 발을 떼고, 계속 누르면 브레이크를 밟는다. 떼면 브레이크만 풀린다", () => {
    const lifted = press("hold", [
      [true, false, 1],
      [false, true, 0.1],
    ]);
    expect(lifted.throttle).toBeGreaterThan(0);
    expect(lifted.brake).toBe(0);
    const braking = press("hold", [
      [true, false, 1],
      [false, true, 1],
    ]);
    expect(braking.throttle).toBe(0);
    expect(braking.brake).toBeGreaterThan(0.5);
    const released = press("hold", [
      [true, false, 1],
      [false, true, 1],
      [false, false, 1],
    ]);
    expect(released.brake).toBe(0);
    expect(released.throttle).toBe(0);
  });

  it("누르는 동안만: 떼면 곧 풀린다", () => {
    const p = press("momentary", [
      [true, false, 1],
      [false, false, 0.5],
    ]);
    expect(p.throttle).toBe(0);
  });

  it("같은 깊이로 밟고 있으면 속도와 엔진 회전수가 한 자리에서 자리 잡는다", () => {
    const road = makeRoad({ length: 30000 });
    const car = new PlayerCar();
    car.place(road, 100, 2, 0);
    const c = { throttle: 0.25, brake: 0, steer: 0, reverse: false };
    const step = (sec: number) => {
      for (let i = 0; i < sec * 120; i++) car.step(1 / 120, road, c);
    };
    step(240);
    const v1 = car.speed;
    const r1 = car.revs;
    step(10);
    expect(car.speed * 3.6).toBeGreaterThan(50);
    expect(Math.abs(car.speed - v1) * 3.6).toBeLessThan(1);
    expect(Math.abs(car.revs - r1)).toBeLessThan(120);
  });
});
