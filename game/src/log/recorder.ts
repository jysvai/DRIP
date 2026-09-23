// 주행 기록: 세션 정보, 이벤트(법규 판정·아차사고·충돌), 1초 간격 주행 기록, 요약.
// 주행 중에는 브라우저에만 모으고, 끝난 뒤 품질 검사(quality.ts)를 통과한 주행만 Supabase에 한꺼번에 올린다(넣기만 가능한 키).
// 서버 적재는 빌드 변수 VITE_DRIP_COLLECT=on일 때만 한다 (공개 전에는 끈다). 올리지 않은 기록도 결과 화면에서 파일로 받을 수 있다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DriveEvent, Summary } from "../rules/engine";
import type { LegInfo } from "../road/road";
import type { QualityResult } from "./quality";

export const APP_VERSION = "0.3.0";

/** 서버에 올리는지. 저장소 변수 VITE_DRIP_COLLECT가 on인 빌드만 올린다 (연구 공개 전에는 끈다) */
export const COLLECTING = import.meta.env.VITE_DRIP_COLLECT === "on";

export const SAMPLE_COLUMNS = ["t", "s", "d", "lane", "speed_kmh", "ax", "ay", "headway_s", "ttc_s", "signal", "steer", "throttle", "brake", "limit_kmh", "near_count", "flow_kmh", "lanes"] as const;
export type Sample = (number | null)[];

export interface SessionInfo {
  roadId: string;
  roadRef: string;
  roadName: string;
  direction: string;
  startS: number;
  preset: string;
  simHour: number;
  seed: number;
  inputMode: string;
  camera: string;
  /** 차종 id (vehicles.json) */
  vehicle: string;
  /** 날씨 (clear·cloudy·rain·heavy_rain·fog) */
  weather: string;
  /** 여러 주행선을 이어 붙인 경로면 조각들 (s를 원래 주행선 위치로 되돌릴 때 쓴다) */
  route: LegInfo[] | null;
}

function participantId(): string {
  const key = "drip_participant";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** 결과 화면에 보여 줄 저장 결과 */
export type UploadStatus = "ok" | "closed" | "offline" | "error" | "no_consent" | "rejected";

export class Recorder {
  readonly sessionId = crypto.randomUUID();
  readonly participant = participantId();
  private client: SupabaseClient | null = null;
  readonly events: DriveEvent[] = [];
  readonly samples: Sample[] = [];
  status: "idle" | "uploading" | "ok" | "error" = "idle";
  info: SessionInfo | null = null;
  startedAt = new Date();

  /** consent=false면 연구 참여에 동의하지 않은 것. 기록은 브라우저에만 둔다 */
  constructor(readonly consent = true) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (consent && COLLECTING && url && key) {
      this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    }
  }

  get online() {
    return this.client !== null;
  }

  /** 주행 중 화면에 보여 줄 기록 상태 */
  get label(): string {
    if (!COLLECTING) return "기록 (시험 운영 · 브라우저에만)";
    if (!this.consent) return "기록 (브라우저에만)";
    return this.client ? "기록 중" : "기록 (오프라인)";
  }

  start(info: SessionInfo) {
    this.info = info;
    this.startedAt = new Date();
  }

  event(e: DriveEvent) {
    this.events.push(e);
  }

  sample(_t: number, row: Sample) {
    this.samples.push(row);
  }

  private sessionRow(info: SessionInfo) {
    return {
      id: this.sessionId,
      participant_id: this.participant,
      started_at: this.startedAt.toISOString(),
      app_version: APP_VERSION,
      road_id: info.roadId,
      road_ref: info.roadRef,
      road_name: info.roadName,
      direction: info.direction,
      start_s: info.startS,
      traffic_preset: info.preset,
      sim_hour: info.simHour,
      seed: info.seed,
      input_mode: info.inputMode,
      camera: info.camera,
      vehicle: info.vehicle,
      weather: info.weather,
      route: info.route ? info.route.map((l) => [l.road, Math.round(l.s0), Math.round(l.s1), Math.round(l.src0), Math.round(l.src1), l.via]) : null,
      device: {
        ua: navigator.userAgent.slice(0, 300),
        screen: [screen.width, screen.height, devicePixelRatio],
        lang: navigator.language,
      },
    };
  }

  /**
   * 주행이 끝나면 부른다. 품질 검사를 통과한 주행만 세션 → 이벤트 → 1초 기록(30초씩 한 줄) → 요약 순서로 올린다.
   * 세션을 먼저 넣어야 나머지가 참조할 수 있다.
   */
  async finish(summary: Summary, reason: string, quality: QualityResult): Promise<UploadStatus> {
    if (!COLLECTING) return "closed";
    if (!this.consent) return "no_consent";
    if (!quality.ok) return "rejected";
    const client = this.client;
    if (!client || !this.info) return "offline";
    this.status = "uploading";
    const fail = (what: string, message: string): UploadStatus => {
      this.status = "error";
      console.warn(`[DRIP] ${what} 저장 실패`, message);
      return "error";
    };
    const session = await client.from("drip_sessions").insert(this.sessionRow(this.info));
    if (session.error) return fail("세션", session.error.message);
    const ev = this.events.map((e) => ({
      session_id: this.sessionId,
      t: e.t,
      type: e.type,
      s: e.s,
      lane: e.lane,
      speed_kmh: e.speedKmh,
      limit_kmh: e.limitKmh,
      detail: e.detail,
    }));
    for (let i = 0; i < ev.length; i += 200) {
      const { error } = await client.from("drip_events").insert(ev.slice(i, i + 200));
      if (error) return fail("이벤트", error.message);
    }
    const rows = [];
    for (let i = 0; i < this.samples.length; i += 30) {
      const chunk = this.samples.slice(i, i + 30);
      rows.push({ session_id: this.sessionId, t0: chunk[0][0] ?? 0, columns: [...SAMPLE_COLUMNS], data: chunk });
    }
    for (let i = 0; i < rows.length; i += 20) {
      const { error } = await client.from("drip_samples").insert(rows.slice(i, i + 20));
      if (error) return fail("주행 기록", error.message);
    }
    const { error } = await client.from("drip_summaries").insert({ session_id: this.sessionId, ended_reason: reason, summary: { ...summary, quality: quality.metrics, qualityVersion: quality.rulesVersion } });
    if (error) return fail("요약", error.message);
    this.status = "ok";
    return "ok";
  }

  /** 결과 화면에서 내려받는 전체 기록 */
  exportJson(summary: Summary, quality: QualityResult | null = null): string {
    return JSON.stringify(
      {
        sessionId: this.sessionId,
        participant: this.participant,
        appVersion: APP_VERSION,
        startedAt: this.startedAt.toISOString(),
        info: this.info,
        summary,
        quality,
        events: this.events,
        sampleColumns: SAMPLE_COLUMNS,
        samples: this.samples,
      },
      null,
      1,
    );
  }
}
