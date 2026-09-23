// 그래픽 품질 자동 맞춤: 고사양은 고사양답게, 저사양은 가볍게.
// 1) 그래픽 카드 이름으로 첫 품질을 짐작한다 (내장 그래픽은 보통, 외장은 높음, 소프트웨어 렌더링은 낮음).
// 2) 출발 전 대기 화면과 출발 직후에 실제로 한 프레임 그리는 데 걸리는 시간을 재서 여유가 많으면 올리고, 모자라면 내린다.
// 3) 주행 중 프레임이 떨어지면 먼저 해상도를 조금씩 낮추고, 그래도 느리면(자동일 때만) 품질을 한 단계 내린다.
// 프레임 간격만 보면 모니터 주사율·절전 모드(30fps 제한)에 속으므로, 가끔 GPU를 기다려 실제 일한 시간을 함께 본다.

import { QUALITY, QUALITY_ORDER, type Quality } from "./world";

/** 그래픽 카드 이름 (알 수 없으면 빈 문자열) */
export function gpuName(): string {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "";
  }
}

export interface DeviceHints {
  /** 터치가 주 입력인 기기 (휴대전화·태블릿) */
  coarse: boolean;
  /** navigator.deviceMemory (GB, 모르면 0) */
  memoryGb: number;
  /** navigator.hardwareConcurrency (모르면 0) */
  cores: number;
}

/** 그래픽 카드 이름과 기기 정보로 첫 품질을 짐작한다 (대기 화면에서 재서 고친다) */
export function guessTier(gpu: string, hints: DeviceHints): Quality {
  const g = gpu.toLowerCase();
  let tier: Quality;
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) return "low";
  if (hints.coarse) tier = /apple (gpu|m\d)/.test(g) ? "medium" : "low";
  else if (/intel/.test(g)) tier = /\barc\b/.test(g) ? "high" : "medium";
  else if (/apple m\d (pro|max|ultra)/.test(g)) tier = "ultra";
  else if (/apple m\d/.test(g)) tier = "high";
  else if (/rtx\s*(20[6-9]0|[3-9]0[6-9]0)|radeon rx\s*[6-9][6-9]\d0/.test(g)) tier = "ultra";
  else if (/radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|radeon r[2-7]|radeon hd/.test(g)) tier = "medium";
  else if (/geforce|nvidia|quadro|radeon rx|radeon pro|arc/.test(g)) tier = "high";
  else tier = "medium";
  // 메모리·코어가 적은 기기는 보통까지만
  const weak = (hints.memoryGb > 0 && hints.memoryGb <= 4) || (hints.cores > 0 && hints.cores <= 4);
  if (weak && QUALITY_ORDER.indexOf(tier) > 1) tier = "medium";
  return tier;
}

const STORE = "drip_gfx";

/** 지난번 이 그래픽 카드에서 맞춘 품질 */
export function loadAutoTier(gpu: string): Quality | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as { gpu: string; tier: Quality } | null;
    return v && v.gpu === gpu && QUALITY_ORDER.includes(v.tier) ? v.tier : null;
  } catch {
    return null;
  }
}

export function saveAutoTier(gpu: string, tier: Quality) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ gpu, tier }));
  } catch {
    // 저장 못 해도 다음번에 다시 잰다
  }
}

export interface GovernorAction {
  tier?: Quality;
  scale?: number;
  /** calibrated: 맞추기가 끝났다 (저장할 때), down: 주행 중 품질을 내렸다 (알릴 때) */
  note?: "calibrated" | "down";
}

/** 판단 기준 (ms). work는 GPU까지 기다려 잰 시간이라 실제 프레임 시간보다 조금 길게 나온다 */
export const GOV = {
  /** 맞추기: 이보다 느리면 내리고, 이보다 빠르면 올린다 */
  calDown: 15,
  calUp: 6.5,
  /** 맞추기에 필요한 표본 수, 품질을 바꾸는 최대 횟수, 출발 뒤 맞추기를 끝내는 시각(초) */
  calSamples: 8,
  calMaxChanges: 3,
  calRunSec: 10,
  /** 주행 중: 프레임 간격 중앙값이 이보다 길고(50fps 아래) 일한 시간도 이보다 길면 느리다 */
  slowInterval: 20,
  heavyWork: 16,
  /** 주행 중: 이보다 가벼우면 해상도를 되돌린다 */
  lightWork: 9,
  /** 주행 중 판단 간격 (초) */
  every: 2,
};

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

export class GfxGovernor {
  tier: Quality;
  scale = 1;
  calibrating: boolean;
  private work: number[] = [];
  private intervals: number[] = [];
  private steppedDown = false;
  private changes = 0;
  private quietUntil = 0;
  private lastEval = 0;
  private runSince = -1;

  /** auto: 기기에 맞춰 품질을 바꿔도 되는지 (아니면 해상도만 조절) */
  constructor(
    readonly auto: boolean,
    tier: Quality,
  ) {
    this.tier = tier;
    this.calibrating = auto;
  }

  /** 이번 프레임에 GPU를 기다려 일한 시간을 잴지 (맞추는 동안은 자주, 그 뒤로는 가끔) */
  wantsSample(frame: number): boolean {
    return frame % (this.calibrating ? 3 : 12) === 0;
  }

  /**
   * 한 프레임을 넣는다. t: 초, intervalMs: 앞 프레임과의 간격, workMs: 잰 경우 계산+그리기 시간, running: 주행 중인지.
   * 바꿀 것이 있으면 돌려준다.
   */
  push(t: number, intervalMs: number, workMs: number | null, running: boolean): GovernorAction | null {
    if (running && this.runSince < 0) this.runSince = t;
    if (t < this.quietUntil) return null;
    if (intervalMs > 0 && intervalMs < 250) {
      this.intervals.push(intervalMs);
      if (this.intervals.length > 90) this.intervals.shift();
    }
    if (workMs !== null) {
      this.work.push(workMs);
      if (this.work.length > 12) this.work.shift();
    }
    return this.calibrating ? this.calibrate(t) : running ? this.steady(t) : null;
  }

  private reset(t: number, quiet: number) {
    this.work.length = 0;
    this.intervals.length = 0;
    this.quietUntil = t + quiet;
    this.lastEval = t;
  }

  private calibrate(t: number): GovernorAction | null {
    const i = QUALITY_ORDER.indexOf(this.tier);
    const late = this.runSince >= 0 && t - this.runSince > GOV.calRunSec;
    if (this.work.length < GOV.calSamples && !late) return null;
    const w = median(this.work);
    if (this.work.length >= GOV.calSamples && this.changes < GOV.calMaxChanges) {
      if (w > GOV.calDown && i > 0) {
        this.tier = QUALITY_ORDER[i - 1];
        this.steppedDown = true;
        this.changes++;
        // 셰이더를 다시 만드느라 잠깐 느리니 1초는 재지 않는다
        this.reset(t, 1);
        return { tier: this.tier };
      }
      if (w < GOV.calUp && !this.steppedDown && i < QUALITY_ORDER.length - 1) {
        this.tier = QUALITY_ORDER[i + 1];
        this.changes++;
        this.reset(t, 1);
        return { tier: this.tier };
      }
    }
    this.calibrating = false;
    this.reset(t, 0);
    return { note: "calibrated" };
  }

  private steady(t: number): GovernorAction | null {
    if (t - this.lastEval < GOV.every || this.work.length < 6 || this.intervals.length < 30) return null;
    this.lastEval = t;
    const w = median(this.work);
    const iv = median(this.intervals);
    const minScale = QUALITY[this.tier].minScale;
    if (iv > GOV.slowInterval && w > GOV.heavyWork) {
      if (this.scale > minScale + 0.01) {
        this.scale = Math.max(minScale, Math.round((this.scale - 0.1) * 100) / 100);
        this.reset(t, 0.5);
        return { scale: this.scale };
      }
      const i = QUALITY_ORDER.indexOf(this.tier);
      if (this.auto && i > 0) {
        this.tier = QUALITY_ORDER[i - 1];
        this.scale = 1;
        this.reset(t, 1.5);
        return { tier: this.tier, scale: 1, note: "down" };
      }
      return null;
    }
    if (w < GOV.lightWork && this.scale < 1) {
      this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
      this.reset(t, 0.5);
      return { scale: this.scale };
    }
    return null;
  }
}
