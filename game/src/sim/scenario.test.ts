import { describe, expect, it } from "vitest";
import { makeConfig } from "../testing/fixtures";
import { sunFor, trafficFor } from "./scenario";

describe("sunFor (시간대 밝기)", () => {
  it("한낮은 낮, 한밤은 밤이다", () => {
    for (const h of [9, 12, 15]) {
      expect(sunFor(h).night, `${h}시`).toBe(0);
      expect(sunFor(h).daylight, `${h}시`).toBe(1);
    }
    for (const h of [0, 2, 21, 23]) {
      expect(sunFor(h).night, `${h}시`).toBe(1);
      expect(sunFor(h).daylight, `${h}시`).toBeLessThan(0.1);
    }
  });

  it("해 뜰 무렵·질 무렵은 그 사이이고, 해는 아침에 동쪽·저녁에 서쪽에 있다", () => {
    for (const h of [6, 18]) {
      const s = sunFor(h);
      expect(s.night, `${h}시`).toBeGreaterThan(0);
      expect(s.night, `${h}시`).toBeLessThan(0.6);
    }
    expect(sunFor(7).azimuth).toBeGreaterThan(45);
    expect(sunFor(17).azimuth).toBeLessThan(-45);
    expect(Math.abs(sunFor(12).azimuth)).toBeLessThan(15);
  });
});

describe("trafficFor (실제 교통)", () => {
  const flat = (v: number) => Array.from({ length: 24 }, () => v);
  const cfg = makeConfig();
  cfg.real = {
    date: "2026-09-21",
    source: "test",
    roads: {
      a: {
        density: flat(10),
        composition: { 승용: 0.7, 화물: 0.3 },
        sites: [
          { s: 5000, km: 400, lanes: 3, density: flat(4), speed: flat(100) },
          { s: 80000, km: 325, lanes: 3, density: flat(20), speed: flat(55) },
        ],
      },
    },
  };

  it("출발 위치에서 가장 가까운 측정 지점 값을 쓴다", () => {
    expect(trafficFor({ road: { id: "a" }, preset: "실제", hour: 8, startKm: 3 }, cfg).density).toBe(4);
    expect(trafficFor({ road: { id: "a" }, preset: "실제", hour: 8, startKm: 70 }, cfg).density).toBe(20);
    expect(trafficFor({ road: { id: "a" }, preset: "실제", hour: 8, startKm: 70 }, cfg).composition).toEqual({ 승용: 0.7, 화물: 0.3 });
    // 막히는 지점(시속 55km)만 흐름 속도를 넘긴다
    expect(trafficFor({ road: { id: "a" }, preset: "실제", hour: 8, startKm: 70 }, cfg).flowKmh).toBe(55);
    expect(trafficFor({ road: { id: "a" }, preset: "실제", hour: 8, startKm: 3 }, cfg).flowKmh).toBeUndefined();
  });

  it("30km 안에 측정 지점이 없으면 주행선 전체 값, 실제 교통이 없는 주행선은 시간대 반영", () => {
    expect(trafficFor({ road: { id: "a" }, preset: "실제", hour: 8, startKm: 200 }, cfg).density).toBe(10);
    const auto = trafficFor({ road: { id: "b" }, preset: "자동", hour: 8 }, cfg);
    expect(trafficFor({ road: { id: "b" }, preset: "실제", hour: 8 }, cfg)).toEqual(auto);
  });
});
