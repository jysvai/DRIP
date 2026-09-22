import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import { legalFactor, realWeatherAt, trafficResponse, weatherOf, WEATHERS, type RealWeatherData } from "./weather";

describe("날씨", () => {
  const cfg = makeConfig();

  it("법정 감속: 젖은 노면 20%, 가시거리 100m 이내 50%, 맑음·흐림은 그대로", () => {
    expect(legalFactor(WEATHERS.clear, cfg.rules)).toBe(1);
    expect(legalFactor(WEATHERS.cloudy, cfg.rules)).toBe(1);
    expect(legalFactor(WEATHERS.rain, cfg.rules)).toBeCloseTo(0.8);
    expect(legalFactor(WEATHERS.heavy_rain, cfg.rules)).toBeCloseTo(0.5);
    expect(legalFactor(WEATHERS.fog, cfg.rules)).toBeCloseTo(0.5);
  });

  it("비에는 한국 운전자가 속도를 거의 줄이지 않고, 폭우·안개에는 줄인다", () => {
    const table = cfg.profiles.weather;
    expect(trafficResponse(WEATHERS.rain, table).speedScale).toBe(1);
    expect(trafficResponse(WEATHERS.heavy_rain, table).speedScale).toBeLessThan(0.9);
    expect(trafficResponse(WEATHERS.fog, table).speedScale).toBeLessThan(0.9);
    expect(trafficResponse(WEATHERS.heavy_rain, table).headwayScale).toBeGreaterThan(1);
  });

  it("모르는 날씨 이름은 맑음", () => {
    expect(weatherOf("snow").kind).toBe("clear");
    expect(weatherOf(null).kind).toBe("clear");
    expect(weatherOf("fog").visibilityM).toBeLessThanOrEqual(100);
  });

  it("실제 날씨는 출발 위치에서 가장 가까운 지점의 그 시각 날씨 (눈은 비로)", () => {
    const road = makeRoad({ length: 100000 });
    const hours = (c: string) => c.repeat(24);
    const data: RealWeatherData = {
      source: "t",
      date: "20260921",
      roads: { [road.id]: [[0, hours("c")], [40000, "cccccccccccccchrrrrrrccc"], [80000, hours("s")]] },
    };
    const a = realWeatherAt(data, road, 45000, 14)!;
    expect(a.weather.kind).toBe("heavy_rain");
    expect(a.stamp).toBe("09/21 14시");
    expect(realWeatherAt(data, road, 45000, 15)!.weather.kind).toBe("rain");
    expect(realWeatherAt(data, road, 10000, 14)!.weather.kind).toBe("clear");
    const snow = realWeatherAt(data, road, 90000, 3)!;
    expect(snow.weather.kind).toBe("rain");
    expect(snow.snow).toBe(true);
    expect(realWeatherAt(null, road, 0, 0)).toBeNull();
  });
});
