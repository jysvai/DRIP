import { describe, expect, it } from "vitest";
import { yellowFor } from "./signals";

describe("신호 황색 시간", () => {
  it("접근 속도가 빠를수록 길다 (50km/h 3초, 60~70km/h 4초, 80km/h 이상 5초)", () => {
    expect(yellowFor(30)).toBe(3);
    expect(yellowFor(50)).toBe(3);
    expect(yellowFor(60)).toBe(4);
    expect(yellowFor(70)).toBe(4);
    expect(yellowFor(80)).toBe(5);
    expect(yellowFor(100)).toBe(5);
  });
});
