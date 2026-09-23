import { describe, expect, it } from "vitest";
import { GfxGovernor, GOV, guessTier } from "./gfx";

const pc = { coarse: false, memoryGb: 8, cores: 8 };

describe("그래픽 카드로 첫 품질 짐작", () => {
  it("외장 그래픽은 높음, 최신 고성능은 최고", () => {
    expect(guessTier("ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 (0x00002184) Direct3D11 vs_5_0 ps_5_0, D3D11)", pc)).toBe("high");
    expect(guessTier("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)", pc)).toBe("ultra");
    expect(guessTier("ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)", pc)).toBe("ultra");
    expect(guessTier("ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)", pc)).toBe("ultra");
    expect(guessTier("ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", pc)).toBe("high");
  });

  it("내장 그래픽은 보통, 소프트웨어 렌더링은 낮음", () => {
    expect(guessTier("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)", pc)).toBe("medium");
    expect(guessTier("ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)", pc)).toBe("medium");
    expect(guessTier("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", pc)).toBe("low");
    expect(guessTier("", pc)).toBe("medium");
  });

  it("휴대기기·메모리가 적은 기기는 낮춘다", () => {
    expect(guessTier("Adreno (TM) 640", { ...pc, coarse: true })).toBe("low");
    expect(guessTier("Apple GPU", { ...pc, coarse: true })).toBe("medium");
    expect(guessTier("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070)", { ...pc, memoryGb: 4 })).toBe("medium");
  });
});

/** 초당 60프레임으로 sec초 동안 넣고, 나온 결정을 모은다 */
function feed(g: GfxGovernor, t0: number, sec: number, interval: number, work: number, running: boolean) {
  const out = [];
  let frame = 0;
  for (let t = t0; t < t0 + sec; t += 1 / 60) {
    const a = g.push(t, interval, g.wantsSample(frame++) ? work : null, running);
    if (a) out.push(a);
  }
  return out;
}

describe("대기 화면에서 맞추기", () => {
  it("여유가 많으면 한 단계씩 올려 최고까지", () => {
    const g = new GfxGovernor(true, "medium");
    const acts = feed(g, 0, 10, 16.7, 4, false);
    expect(acts.filter((a) => a.tier).map((a) => a.tier)).toEqual(["high", "ultra"]);
    expect(g.calibrating).toBe(false);
    expect(acts[acts.length - 1].note).toBe("calibrated");
  });

  it("느리면 내리고, 한 번 내린 뒤에는 다시 올리지 않는다", () => {
    const g = new GfxGovernor(true, "high");
    // 높음에서는 30ms, 한 단계 내리면 아주 가볍다 (3ms)
    const acts = [];
    let frame = 0;
    for (let t = 0; t < 6; t += 1 / 60) {
      const work = g.tier === "high" ? 30 : 3;
      const a = g.push(t, work > 16 ? 33 : 16.7, g.wantsSample(frame++) ? work : null, false);
      if (a) acts.push(a);
    }
    expect(acts).toEqual([{ tier: "medium" }, { note: "calibrated" }]);
  });

  it("알맞으면 그대로 끝낸다", () => {
    const g = new GfxGovernor(true, "high");
    const acts = feed(g, 0, 3, 16.7, 10, false);
    expect(acts).toEqual([{ note: "calibrated" }]);
  });

  it("직접 고른 품질은 맞추지 않는다", () => {
    const g = new GfxGovernor(false, "low");
    expect(feed(g, 0, 5, 16.7, 2, false)).toEqual([]);
    expect(g.tier).toBe("low");
  });
});

describe("주행 중 프레임이 떨어지면", () => {
  it("해상도부터 낮추고, 바닥이면 (자동일 때) 품질을 내린다", () => {
    const g = new GfxGovernor(true, "high");
    feed(g, 0, 2, 16.7, 10, false);
    expect(g.calibrating).toBe(false);
    const acts = feed(g, 2, 30, 33, GOV.heavyWork + 10, true);
    const scales = acts.filter((a) => a.scale !== undefined && !a.tier).map((a) => a.scale);
    expect(scales.slice(0, 3)).toEqual([0.9, 0.8, 0.75]);
    const down = acts.find((a) => a.note === "down");
    expect(down?.tier).toBe("medium");
  });

  it("직접 고른 품질은 해상도만 낮춘다", () => {
    const g = new GfxGovernor(false, "high");
    const acts = feed(g, 0, 30, 33, 30, true);
    expect(acts.some((a) => a.tier)).toBe(false);
    expect(g.scale).toBe(0.75);
  });

  it("절전 모드처럼 프레임만 느리고 일은 가벼우면 건드리지 않는다", () => {
    const g = new GfxGovernor(false, "high");
    expect(feed(g, 0, 20, 33, 6, true)).toEqual([]);
  });

  it("다시 가벼워지면 해상도를 되돌린다", () => {
    const g = new GfxGovernor(false, "high");
    feed(g, 0, 10, 33, 30, true);
    expect(g.scale).toBeLessThan(1);
    feed(g, 10, 40, 16.7, 5, true);
    expect(g.scale).toBe(1);
  });
});
