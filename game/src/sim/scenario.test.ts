import { describe, expect, it } from "vitest";
import { sunFor } from "./scenario";

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
