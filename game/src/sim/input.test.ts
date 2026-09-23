import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import {
  PAD,
  PEDAL,
  STEER,
  STEER_SENS,
  detectPedal,
  latAccel,
  isWheel,
  keySteerStep,
  padMoved,
  padSteer,
  pedalStep,
  pedalValue,
  steerLimit,
  wheelSteer,
  type PadSnapshot,
  type PedalMode,
} from "./input";
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

const L = 2.85;
const MAX = 0.6;
const CAR = new PlayerCar().spec;
const SC = { wheelbase: CAR.lf + CAR.lr, maxSteer: CAR.maxSteer, understeer: (CAR.mass * CAR.lr) / L / CAR.cf - (CAR.mass * CAR.lf) / L / CAR.cr };
const limitAt = (v: number, sens: keyof typeof STEER_SENS = "normal") => steerLimit(v, latAccel(v, STEER_SENS[sens][1]), SC);

/** 키보드로 want쪽을 sec초 누른다 (속도 v m/s 고정). 끝난 꺾임 (한계 대비) */
function steerKeys(steps: [-1 | 0 | 1, number][], v: number, sens: keyof typeof STEER_SENS = "normal") {
  let x = 0;
  let held = 0;
  let dir = 0;
  for (const [want, sec] of steps) {
    for (let i = 0; i < sec / DT; i++) {
      held = want !== 0 && want === dir ? held + DT : 0;
      dir = want;
      x = keySteerStep(x, want, held, v, DT, STEER_SENS[sens][0]);
    }
  }
  return x;
}

/** 차를 v로 달리게 두고 steer를 주었을 때 자리 잡은 옆 가속도 v·요레이트 (m/s², 0.6~0.9초 평균, 가드레일에 닿기 전) */
function lateral(v: number, steer: number) {
  const road = makeRoad({ length: 30000 });
  const car = new PlayerCar();
  car.place(road, 100, 2, v);
  const c = { throttle: 0, brake: 0, steer, reverse: false };
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 0.9 * 120; i++) {
    // 속도는 그대로 둔다 (조향만 본다)
    car.vx = v;
    car.step(1 / 120, road, c);
    if (car.hits.length) break;
    if (i >= 0.6 * 120) {
      sum += Math.abs(car.r) * v;
      n++;
    }
  }
  return sum / Math.max(1, n);
}

describe("키보드 핸들", () => {
  it("끝까지 누르면 속도와 상관없이 옆 가속도가 약 4m/s² (언더스티어까지 셈한다)", () => {
    for (const kmh of [80, 100, 130]) {
      const v = kmh / 3.6;
      const ay = lateral(v, limitAt(v));
      expect(ay).toBeGreaterThan(3.6);
      expect(ay).toBeLessThan(4.4);
    }
  });

  it("시속 20~25km에서 끝까지 누르면 교차로를 돌 만큼 (반지름 10m 안) 꺾인다", () => {
    for (const kmh of [20, 25]) {
      const v = kmh / 3.6;
      const ay = lateral(v, limitAt(v));
      const r = (v * v) / ay;
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(10);
    }
  });

  it("고속에서 톡 치면 살짝만, 꾹 누르면 끝까지 꺾인다", () => {
    const v = 100 / 3.6;
    expect(steerKeys([[1, 0.1]], v)).toBeLessThan(0.06);
    expect(steerKeys([[1, 1.2]], v)).toBe(1);
    expect(steerKeys([[-1, 0.1]], v)).toBeGreaterThan(-0.06);
  });

  it("느릴 때는 빨리 돌아간다 (교차로에서 크게 돌리기)", () => {
    const slow = steerKeys([[1, 0.35]], 5);
    const fast = steerKeys([[1, 0.35]], 30);
    expect(slow).toBeGreaterThan(0.75);
    expect(fast).toBeLessThan(0.4);
  });

  it("놓으면 가운데로 돌아오고, 빠를수록 더 빨리 돌아온다", () => {
    const back = (v: number) =>
      steerKeys(
        [
          [1, 2],
          [0, 0.2],
        ],
        v,
      );
    expect(back(30)).toBeLessThan(back(3));
    expect(
      steerKeys(
        [
          [1, 2],
          [0, 1],
        ],
        20,
      ),
    ).toBe(0);
  });

  it("반대로 꺾으면 가운데를 빨리 지나 넘어간다", () => {
    const x = steerKeys(
      [
        [1, 2],
        [-1, 0.5],
      ],
      10,
    );
    expect(x).toBeLessThan(-0.3);
  });

  it("감도: 느리게는 덜 꺾이고 천천히, 빠르게는 더 꺾이고 빨리", () => {
    const v = 20;
    expect(limitAt(v, "slow")).toBeLessThan(limitAt(v, "fast"));
    expect(steerKeys([[1, 0.4]], v, "slow")).toBeLessThan(steerKeys([[1, 0.4]], v, "fast"));
    expect(STEER.fine).toBeLessThan(1);
  });
});

describe("게임패드·레이싱 휠", () => {
  it("패드 스틱: 가운데 흔들림은 0, 끝까지 밀어도 키보드 한계의 1.5배까지", () => {
    expect(padSteer(0.05, 1)).toBe(0);
    expect(padSteer(-0.05, 1)).toBe(0);
    expect(padSteer(1, 1)).toBe(1);
    expect(padSteer(-1, 0.1)).toBeCloseTo(-0.1 * PAD.limit, 6);
    // 가운데 쪽이 곱다 (반쯤 밀면 반보다 적게)
    expect(padSteer(0.5, 1)).toBeLessThan(0.4);
    // 고속에서 끝까지 밀어도 미끄러지지 않는다
    const v = 110 / 3.6;
    const ay = lateral(v, padSteer(1, limitAt(v)));
    expect(ay).toBeLessThan(7);
  });

  it("휠: 돌린 만큼 그대로, 900°는 끝까지 돌리면 앞바퀴도 끝까지, 짧게 도는 휠은 덜 꺾인다", () => {
    expect(wheelSteer(0.5, 900, MAX)).toBeCloseTo(0.5, 6);
    expect(wheelSteer(1, 900, MAX)).toBeCloseTo(1, 6);
    expect(wheelSteer(-0.25, 540, MAX)).toBeCloseTo(-0.25 * wheelSteer(1, 540, MAX), 6);
    expect(wheelSteer(1, 270, MAX)).toBeLessThan(0.6);
    // 조향비는 15:1보다 느리지 않다 (1080° 휠도 끝까지 꺾인다)
    expect(wheelSteer(1, 1080, MAX)).toBe(1);
  });

  it("이름으로 휠을 가린다", () => {
    expect(isWheel("Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)")).toBe(true);
    expect(isWheel("Logitech G920 Driving Force Racing Wheel for Xbox One")).toBe(true);
    expect(isWheel("Thrustmaster T300RS Racing wheel")).toBe(true);
    expect(isWheel("Xbox 360 Controller (XInput STANDARD GAMEPAD)")).toBe(false);
    expect(isWheel("Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d)")).toBe(false);
    expect(isWheel("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)")).toBe(false);
  });

  it("키보드를 쓰다 패드를 크게 움직이거나 버튼을 누르면 알아챈다 (잔떨림은 무시)", () => {
    const base: PadSnapshot = { axes: [0.01, 1, 1], buttons: [0, 0] };
    expect(padMoved(base, { axes: [0.03, 1, 0.98], buttons: [0, 0] })).toBe(false);
    expect(padMoved(base, { axes: [0.5, 1, 1], buttons: [0, 0] })).toBe(true);
    expect(padMoved(base, { axes: [0.01, 1, 0.2], buttons: [0, 0] })).toBe(true);
    expect(padMoved(base, { axes: [0.01, 1, 1], buttons: [0, 1] })).toBe(true);
  });
});

describe("휠·페달 맞추기", () => {
  /** 축 k가 rest에서 full로 갔다가 돌아오는 기록 (다른 축은 가만히, 조향 축은 흔들림) */
  const press = (k: number, rest: number, full: number, n = 8): PadSnapshot[] => {
    const frames: PadSnapshot[] = [];
    for (let i = 0; i <= 2 * n; i++) {
      const t = i <= n ? i / n : (2 * n - i) / n;
      const axes = [0.4 * Math.sin(i), 1, 1, 1];
      axes[k] = rest + (full - rest) * t;
      frames.push({ axes, buttons: [0, 0, 0, 0, 0, 0, 0, 0] });
    }
    return frames;
  };

  it("가장 크게 움직인 축을 찾고, 뗀 값이 rest, 가장 먼 값이 full (조향 축은 뺀다)", () => {
    const p = detectPedal(press(2, 1, -1));
    expect(p).toEqual({ kind: "axis", index: 2, rest: 1, full: -1 });
    // 브레이크를 찾을 때 가속 페달 축은 뺀다
    const b = detectPedal([...press(2, 1, -1), ...press(3, 1, -1)], [p!]);
    expect(b?.index).toBe(3);
  });

  it("크롬이 처음에 0으로 준 축도 뗀 값으로 맞춘다", () => {
    const frames = press(1, 1, -1);
    frames.unshift({ axes: [0, 0, 1, 1], buttons: [0, 0, 0, 0, 0, 0, 0, 0] });
    expect(detectPedal(frames)).toEqual({ kind: "axis", index: 1, rest: 1, full: -1 });
  });

  it("아직 밟고 있거나 조금만 움직였으면 못 찾는다", () => {
    const held = press(2, 1, -1).slice(0, 9);
    expect(detectPedal(held)).toBeNull();
    expect(detectPedal(press(2, 1, 0.8))).toBeNull();
  });

  it("버튼으로 들어오는 트리거도 찾는다", () => {
    const frames: PadSnapshot[] = [0, 0.5, 1, 0.5, 0].map((v) => ({ axes: [0, 0, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, v] }));
    expect(detectPedal(frames)).toEqual({ kind: "button", index: 7, rest: 0, full: 1 });
  });

  it("맞춘 페달 값: 쉴 때 0, 끝까지 1, 뒤집힌 축도", () => {
    const p = { kind: "axis" as const, index: 2, rest: 1, full: -1 };
    const at = (v: number) => pedalValue({ axes: [0, 0, v], buttons: [] }, p);
    expect(at(1)).toBe(0);
    expect(at(0.97)).toBe(0);
    expect(at(-1)).toBe(1);
    expect(at(0)).toBeCloseTo((0.5 - 0.03) / 0.97, 6);
  });
});
