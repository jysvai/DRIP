import { describe, expect, it } from "vitest";
import { makeRoad } from "../testing/fixtures";
import { PlayerCar, type Controls } from "./player";
import { gripAt, WEATHERS } from "./weather";

const DT = 1 / 120;

function run(car: PlayerCar, road: ReturnType<typeof makeRoad>, c: Controls, sec: number) {
  for (let i = 0; i < sec / DT; i++) car.step(DT, road, c);
}

describe("PlayerCar", () => {
  const road = makeRoad({ length: 20000 });

  it("정지에서 가속하면 10초에 시속 80~130km 사이가 된다 (중형 세단 수준)", () => {
    const car = new PlayerCar();
    car.place(road, 100, 2, 0);
    run(car, road, { throttle: 1, brake: 0, steer: 0, reverse: false }, 10);
    const kmh = car.speed * 3.6;
    expect(kmh).toBeGreaterThan(80);
    expect(kmh).toBeLessThan(130);
    expect(car.gear).toBeGreaterThan(2);
  });

  it("시속 100km에서 급제동하면 45m 안쪽에서 멈춘다", () => {
    const car = new PlayerCar();
    car.place(road, 100, 2, 100 / 3.6);
    const s0 = car.s;
    run(car, road, { throttle: 0, brake: 1, steer: 0, reverse: false }, 6);
    expect(car.speed).toBeLessThan(0.1);
    expect(car.s - s0).toBeLessThan(45);
    expect(car.s - s0).toBeGreaterThan(35);
  });

  it("핸들을 놓으면 차로를 크게 벗어나지 않는다", () => {
    const car = new PlayerCar();
    car.place(road, 100, 2, 100 / 3.6);
    const d0 = car.d;
    run(car, road, { throttle: 0.3, brake: 0, steer: 0, reverse: false }, 5);
    expect(Math.abs(car.d - d0)).toBeLessThan(0.05);
  });

  it("오른쪽으로 꺾으면 d가 커진다 (오른쪽 +)", () => {
    const car = new PlayerCar();
    car.place(road, 100, 2, 80 / 3.6);
    const d0 = car.d;
    run(car, road, { throttle: 0.3, brake: 0, steer: 0.05, reverse: false }, 1.5);
    expect(car.d).toBeGreaterThan(d0 + 0.3);
  });

  it("굽은 길: 조향 없이 가면 바깥쪽으로 밀리고, 곡률만큼 꺾으면 훨씬 덜 밀린다", () => {
    const curvy = makeRoad({ length: 6000, curveFrom: 500, radius: 800 });
    const drift = (steer: number) => {
      const car = new PlayerCar();
      car.place(curvy, 520, 2, 90 / 3.6);
      const d0 = car.d;
      run(car, curvy, { throttle: 0.25, brake: 0, steer, reverse: false }, 3);
      return car.d - d0;
    };
    // 정상 선회 조향각 = L/R + K·(v²/R), K는 언더스티어 계수
    const sp = new PlayerCar().spec;
    const L = sp.lf + sp.lr;
    const K = (sp.mass * sp.lr) / L / sp.cf - (sp.mass * sp.lf) / L / sp.cr;
    const v = 90 / 3.6;
    const ff = -(L / 800 + (K * v * v) / 800) / sp.maxSteer;
    const straight = drift(0);
    expect(straight).toBeGreaterThan(3); // 왼쪽으로 굽는 길에서 직진하면 오른쪽(+)으로 벗어난다
    expect(Math.abs(drift(ff))).toBeLessThan(straight * 0.3);
  });

  it("가드레일에 부딪히면 밖으로 나가지 않고 충돌이 기록된다", () => {
    const car = new PlayerCar();
    car.place(road, 100, 3, 90 / 3.6);
    let hit = false;
    for (let i = 0; i < 4 / DT; i++) {
      car.step(DT, road, { throttle: 0.3, brake: 0, steer: 0.3, reverse: false });
      if (car.hits.length) hit = true;
    }
    expect(hit).toBe(true);
    expect(car.d).toBeLessThan(road.widthAt(car.s) / 2 + 3.5);
  });

  it("젖은 노면에서는 50km/h 제동거리가 약 1.8배 (한국교통안전공단 시험 9.9m → 18.1m)", () => {
    const stop = (wet: boolean) => {
      const car = new PlayerCar();
      if (wet) car.grip = (kmh) => gripAt(WEATHERS.rain, kmh);
      car.place(road, 100, 2, 50 / 3.6);
      const s0 = car.s;
      run(car, road, { throttle: 0, brake: 1, steer: 0, reverse: false }, 6);
      return car.s - s0;
    };
    const dry = stop(false);
    const wet = stop(true);
    expect(dry).toBeGreaterThan(8);
    expect(dry).toBeLessThan(12);
    expect(wet / dry).toBeGreaterThan(1.65);
    expect(wet / dry).toBeLessThan(1.95);
  });

  it("폭우에 빠르면 수막현상으로 마찰이 더 준다", () => {
    expect(gripAt(WEATHERS.heavy_rain, 120)).toBeLessThan(gripAt(WEATHERS.heavy_rain, 60) * 0.8);
    expect(gripAt(WEATHERS.rain, 120)).toBe(gripAt(WEATHERS.rain, 60));
    expect(gripAt(WEATHERS.rain, 60, true)).toBeGreaterThan(gripAt(WEATHERS.rain, 60));
  });
});
