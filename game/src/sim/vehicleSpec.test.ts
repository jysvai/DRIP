import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import { PlayerCar } from "./player";
import { specFor } from "./vehicleSpec";

const road = makeRoad({ length: 20000, lanes: 3 });

/** 평지에서 끝까지 밟고 달린다: 100km/h까지 걸린 시간(초)과 60초 뒤 속도 */
function launch(type: Parameters<typeof specFor>[0]) {
  const spec = specFor(type);
  const car = new PlayerCar(spec);
  car.place(road, 100, 2, 0);
  let t100 = Infinity;
  let t = 0;
  const dt = 1 / 120;
  let vmax = 0;
  while (t < 90) {
    car.step(dt, road, { throttle: 1, brake: 0, steer: 0, reverse: false });
    t += dt;
    vmax = Math.max(vmax, car.vx);
    if (t100 === Infinity && car.vx >= 100 / 3.6) t100 = t;
    if (car.s > road.length - 200) break;
  }
  return { spec, t100, vmax: vmax * 3.6 };
}

describe("차종별 플레이어 물리", () => {
  const types = makeConfig().catalog.types;

  it("모든 차종이 출발해서 달리고, 제한장치 속도를 넘지 않는다", () => {
    for (const t of types) {
      const r = launch(t);
      expect(Number.isFinite(r.vmax), t.id).toBe(true);
      expect(r.vmax, t.id).toBeGreaterThan(60);
      expect(r.vmax, t.id).toBeLessThanOrEqual(r.spec.governor * 3.6 + 1);
    }
  });

  it("승용은 빠르고 대형 화물은 느리게 붙는다", () => {
    const by = (id: string) => launch(types.find((t) => t.id === id)!);
    const sedan = by("sedan_mid");
    const sports = by("sports_car");
    const micro = by("micro_hatch");
    const tractor = by("tractor_40ft");
    const ev = by("ev_crossover_sport");
    expect(sedan.t100).toBeGreaterThan(6);
    expect(sedan.t100).toBeLessThan(12);
    expect(sports.t100).toBeLessThan(sedan.t100);
    expect(micro.t100).toBeGreaterThan(sedan.t100);
    expect(ev.t100).toBeLessThan(sedan.t100);
    // 40톤 트랙터: 90km/h 제한, 한참 걸린다
    expect(tractor.vmax).toBeLessThanOrEqual(91);
    expect(tractor.t100).toBe(Infinity);
    expect(tractor.spec.vehicleClass).toBe("truck");
    expect(by("bus_express").spec.vehicleClass).toBe("bus");
    expect(sedan.spec.vehicleClass).toBe("car");
  });
});
