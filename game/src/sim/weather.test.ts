import { describe, expect, it } from "vitest";
import { makeConfig } from "../testing/fixtures";
import { legalFactor, trafficResponse, weatherOf, WEATHERS } from "./weather";

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
});
