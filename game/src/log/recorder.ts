// 주행 기록: 세션 정보, 이벤트(법규 판정·아차사고·충돌), 1초 간격 주행 기록, 요약.
// Supabase에 올리고(넣기만 가능한 키), 연결이 없으면 브라우저에만 모아 두었다가 결과 화면에서 파일로 받을 수 있다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DriveEvent, Summary } from "../rules/engine";
import type { LegInfo } from "../road/road";

export const APP_VERSION = "0.2.0";

export const SAMPLE_COLUMNS = ["t", "s", "d", "lane", "speed_kmh", "ax", "ay", "headway_s", "ttc_s", "signal", "steer", "throttle", "brake", "limit_kmh", "near_count"] as const;
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

export class Recorder {
  readonly sessionId = crypto.randomUUID();
  readonly participant = participantId();
  private client: SupabaseClient | null = null;
  private events: DriveEvent[] = [];
  private eventQueue: DriveEvent[] = [];
  private samples: Sample[] = [];
  private sampleQueue: Sample[] = [];
  private sampleT0 = 0;
  private flushTimer = 0;
  private sessionOk: Promise<boolean> = Promise.resolve(false);
  uploaded = { events: 0, samples: 0, errors: 0 };
  status: "offline" | "ok" | "error" = "offline";
  info: SessionInfo | null = null;
  startedAt = new Date();

  /** upload=false면 연구 참여에 동의하지 않은 것. 기록은 브라우저에만 둔다 */
  constructor(upload = true) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (upload && url && key) {
      this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    }
  }

  get online() {
    return this.client !== null;
  }

  start(info: SessionInfo) {
    this.info = info;
    this.startedAt = new Date();
    if (!this.client) return;
    const row = {
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
      route: info.route ? info.route.map((l) => [l.road, Math.round(l.s0), Math.round(l.s1), Math.round(l.src0), Math.round(l.src1), l.via]) : null,
      device: {
        ua: navigator.userAgent.slice(0, 300),
        screen: [screen.width, screen.height, devicePixelRatio],
        lang: navigator.language,
      },
    };
    this.sessionOk = Promise.resolve(this.client.from("drip_sessions").insert(row)).then(({ error }) => {
      this.status = error ? "error" : "ok";
      if (error) {
        this.uploaded.errors++;
        console.warn("[DRIP] 세션 저장 실패", error.message);
      }
      return !error;
    });
  }

  event(e: DriveEvent) {
    this.events.push(e);
    this.eventQueue.push(e);
  }

  sample(t: number, row: Sample) {
    if (!this.sampleQueue.length) this.sampleT0 = t;
    this.samples.push(row);
    this.sampleQueue.push(row);
  }

  /** 주기적으로 호출. 이벤트는 5초, 주행 기록은 30초마다 올린다 */
  tick(dt: number) {
    this.flushTimer += dt;
    if (this.flushTimer >= 5) {
      this.flushTimer = 0;
      void this.flushEvents();
      if (this.sampleQueue.length >= 30) void this.flushSamples();
    }
  }

  private async flushEvents() {
    if (!this.client || !this.eventQueue.length) return;
    if (!(await this.sessionOk)) return;
    const batch = this.eventQueue.splice(0);
    const { error } = await this.client.from("drip_events").insert(
      batch.map((e) => ({
        session_id: this.sessionId,
        t: e.t,
        type: e.type,
        s: e.s,
        lane: e.lane,
        speed_kmh: e.speedKmh,
        limit_kmh: e.limitKmh,
        detail: e.detail,
      })),
    );
    if (error) {
      this.uploaded.errors++;
      this.eventQueue.unshift(...batch);
    } else this.uploaded.events += batch.length;
  }

  private async flushSamples() {
    if (!this.client || !this.sampleQueue.length) return;
    if (!(await this.sessionOk)) return;
    const batch = this.sampleQueue.splice(0);
    const t0 = this.sampleT0;
    const { error } = await this.client.from("drip_samples").insert({ session_id: this.sessionId, t0, columns: [...SAMPLE_COLUMNS], data: batch });
    if (error) {
      this.uploaded.errors++;
      this.sampleQueue.unshift(...batch);
    } else this.uploaded.samples += batch.length;
  }

  async finish(summary: Summary, reason: string): Promise<boolean> {
    if (!this.client) return false;
    await this.flushEvents();
    await this.flushSamples();
    if (!(await this.sessionOk)) return false;
    const { error } = await this.client.from("drip_summaries").insert({ session_id: this.sessionId, ended_reason: reason, summary });
    if (error) this.uploaded.errors++;
    return !error;
  }

  /** 결과 화면에서 내려받는 전체 기록 */
  exportJson(summary: Summary): string {
    return JSON.stringify(
      {
        sessionId: this.sessionId,
        participant: this.participant,
        appVersion: APP_VERSION,
        startedAt: this.startedAt.toISOString(),
        info: this.info,
        summary,
        events: this.events,
        sampleColumns: SAMPLE_COLUMNS,
        samples: this.samples,
      },
      null,
      1,
    );
  }
}
