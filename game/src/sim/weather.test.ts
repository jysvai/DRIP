import { describe, expect, it } from "vitest";
import { makeConfig, makeRoad } from "../testing/fixtures";
import { gripAt, legalFactor, realWeatherAt, trafficResponse, weatherOf, WEATHERS, type RealWeatherData } from "./weather";

describe("날씨", () => {
  const cfg = makeConfig();

  it("법정 감속: 젖은 노면 20%, 가시거리 100m 이내 50%, 맑음·흐림은 그대로", () => {
    expect(legalFactor(WEATHERS.clear, cfg.rules)).toBe(1);
    expect(legalFactor(WEATHERS.cloudy, cfg.rules)).toBe(1);
    expect(legalFactor(WEATHERS.rain, cfg.rules)).toBeCloseTo(0.8);
    expect(legalFactor(WEATHERS.heavy_rain, cfg.rules)).toBeCloseTo(0.5);
    expect(legalFactor(WEATHERS.fog, cfg.rules)).toBeCloseTo(0.5);
    // 눈이 20mm 미만 쌓이면 20%, 폭설로 가시거리 100m 이내면 50%
    expect(legalFactor(WEATHERS.snow, cfg.rules)).toBeCloseTo(0.8);
    expect(legalFactor(WEATHERS.heavy_snow, cfg.rules)).toBeCloseTo(0.5);
  });

  it("눈길은 빗길보다 미끄럽고, 물이 고이지 않아 빨라도 수막현상은 없다", () => {
    expect(gripAt(WEATHERS.snow, 60)).toBeLessThan(gripAt(WEATHERS.rain, 60) * 0.7);
    expect(gripAt(WEATHERS.heavy_snow, 60)).toBeLessThan(gripAt(WEATHERS.snow, 60));
    expect(gripAt(WEATHERS.snow, 120)).toBe(gripAt(WEATHERS.snow, 40));
    expect(gripAt(WEATHERS.snow, 60, true)).toBeGreaterThan(gripAt(WEATHERS.snow, 60));
  });

  it("눈이 오면 주변 차도 느려지고 차간시간을 늘린다 (폭설일수록 더)", () => {
    const table = cfg.profiles.weather;
    const snow = trafficResponse(WEATHERS.snow, table);
    const heavy = trafficResponse(WEATHERS.heavy_snow, table);
    expect(snow.speedScale).toBeLessThan(1);
    expect(heavy.speedScale).toBeLessThan(snow.speedScale);
    expect(heavy.headwayScale).toBeGreaterThan(snow.headwayScale);
    expect(snow.headwayScale).toBeGreaterThan(1);
  });

  it("비에는 한국 운전자가 속도를 거의 줄이지 않고, 폭우·안개에는 줄인다", () => {
    const table = cfg.profiles.weather;
    expect(trafficResponse(WEATHERS.rain, table).speedScale).toBe(1);
    expect(trafficResponse(WEATHERS.heavy_rain, table).speedScale).toBeLessThan(0.9);
    expect(trafficResponse(WEATHERS.fog, table).speedScale).toBeLessThan(0.9);
    expect(trafficResponse(WEATHERS.heavy_rain, table).headwayScale).toBeGreaterThan(1);
  });

  it("모르는 날씨 이름은 맑음", () => {
    expect(weatherOf("hail").kind).toBe("clear");
    expect(weatherOf(null).kind).toBe("clear");
    expect(weatherOf("fog").visibilityM).toBeLessThanOrEqual(100);
  });

  it("실제 날씨는 출발 위치에서 가장 가까운 지점의 그 시각 날씨", () => {
    const road = makeRoad({ length: 100000 });
    const hours = (c: string) => c.repeat(24);
    const data: RealWeatherData = {
      source: "t",
      date: "20260921",
      roads: {
        [road.id]: [
          [0, hours("c")],
          [40000, "cccccccccccccchrrrrrrccc"],
          [80000, "sssssSSSSsssssssssssssss"],
        ],
      },
    };
    const a = realWeatherAt(data, road, 45000, 14)!;
    expect(a.weather.kind).toBe("heavy_rain");
    expect(a.stamp).toBe("09/21 14시");
    expect(realWeatherAt(data, road, 45000, 15)!.weather.kind).toBe("rain");
    expect(realWeatherAt(data, road, 10000, 14)!.weather.kind).toBe("clear");
    expect(realWeatherAt(data, road, 90000, 3)!.weather.kind).toBe("snow");
    expect(realWeatherAt(data, road, 90000, 6)!.weather.kind).toBe("heavy_snow");
    expect(realWeatherAt(null, road, 0, 0)).toBeNull();
  });
});
