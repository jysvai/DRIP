// 연구 데이터 품질 검사: 현실에서 보기 어려운 주행을 한 기록은 데이터셋에 올리지 않는다.
// 기준은 public/data/data_quality.json. 판정은 저장되는 1초 기록과 이벤트만으로 해서,
// 서버 쪽 재검사(pipeline/quality.py, 브라우저 코드는 고칠 수 있으므로)가 같은 결과를 낸다.
// 현실에도 있는 위험 운전(과속·꼬리물기·칼치기)은 연구 대상이라 거르지 않는다.

export interface QualityRules {
  version: string;
  minDriveSec: number;
  minDistanceM: number;
  jamSpeeding: { flowBelowKmh: number; aboveFlowKmh: number; minSec: number; minShare: number };
  extremeSpeed: { overLimitKmh: number; minSec: number };
  crashes: { seriousKmh: number; minCount: number; per10km: number };
  contacts: { minCount: number; per10km: number };
  shoulder: { minSec: number; minShare: number };
  idle: { flowAboveKmh: number; stoppedBelowKmh: number; maxShare: number };
  noInput: { maxShare: number };
  nearMiss: { minCount: number; per10km: number };
  participant: { window: number; maxRejected: number; clearAfterAccepted: number };
}

export type RejectReason =
  | "too_short"
  | "jam_speeding"
  | "extreme_speed"
  | "crashes"
  | "contacts"
  | "shoulder"
  | "idle"
  | "no_input"
  | "near_miss"
  | "autopilot"
  | "participant";

export const REJECT_LABELS: Record<RejectReason, string> = {
  too_short: "주행이 너무 짧음",
  jam_speeding: "정체 도로에서 흐름을 무시한 질주",
  extreme_speed: "제한속도를 크게 넘는 폭주가 오래 이어짐",
  crashes: "충돌이 너무 잦음",
  contacts: "가드레일·차와 너무 자주 부딪힘",
  shoulder: "갓길 질주",
  idle: "세워 둔 시간이 김",
  no_input: "조작이 거의 없음",
  near_miss: "아차사고가 지나치게 많음",
  autopilot: "자동 운전",
  participant: "최근 주행이 여러 번 걸러진 참여자",
};

export interface QualityMetrics {
  driveSec: number;
  distanceM: number;
  congestedSec: number;
  jamSpeedingSec: number;
  extremeSec: number;
  shoulderSec: number;
  idleSec: number;
  noInputSec: number;
  crashes: number;
  seriousCrashes: number;
  nearMisses: number;
}

export interface QualityResult {
  ok: boolean;
  reasons: RejectReason[];
  metrics: QualityMetrics;
  rulesVersion: string;
}

interface EventLike {
  type: string;
  detail?: Record<string, unknown> | null;
}

/** 한 번의 주행 기록을 검사한다. columns는 SAMPLE_COLUMNS, samples는 1초 간격 행 */
export function assessSession(columns: readonly string[], samples: readonly (readonly (number | null)[])[], events: readonly EventLike[], rules: QualityRules): QualityResult {
  const col = (name: string) => columns.indexOf(name);
  const iSpeed = col("speed_kmh");
  const iLimit = col("limit_kmh");
  const iFlow = col("flow_kmh");
  const iLane = col("lane");
  const iLanes = col("lanes");
  const iThrottle = col("throttle");
  const iBrake = col("brake");
  const iSteer = col("steer");
  const num = (row: readonly (number | null)[], i: number): number | null => (i >= 0 && row[i] !== null && row[i] !== undefined ? Number(row[i]) : null);

  const m: QualityMetrics = { driveSec: samples.length, distanceM: 0, congestedSec: 0, jamSpeedingSec: 0, extremeSec: 0, shoulderSec: 0, idleSec: 0, noInputSec: 0, crashes: 0, seriousCrashes: 0, nearMisses: 0 };
  const r = rules;
  for (const row of samples) {
    const kmh = num(row, iSpeed) ?? 0;
    m.distanceM += kmh / 3.6;
    const flow = num(row, iFlow);
    if (flow !== null && flow <= r.jamSpeeding.flowBelowKmh) {
      m.congestedSec++;
      if (kmh >= flow + r.jamSpeeding.aboveFlowKmh) m.jamSpeedingSec++;
    }
    const limit = num(row, iLimit);
    if (limit !== null && limit > 0 && kmh >= limit + r.extremeSpeed.overLimitKmh) m.extremeSec++;
    const lane = num(row, iLane);
    const lanes = num(row, iLanes);
    if (lane !== null && lanes !== null && (lane < 1 || lane > lanes)) m.shoulderSec++;
    if (flow !== null && flow > r.idle.flowAboveKmh && kmh < r.idle.stoppedBelowKmh) m.idleSec++;
    if (!num(row, iThrottle) && !num(row, iBrake) && !num(row, iSteer)) m.noInputSec++;
  }
  m.distanceM = Math.round(m.distanceM);
  for (const e of events) {
    if (e.type === "crash") {
      m.crashes++;
      const rel = Number(e.detail?.relSpeedKmh ?? 0);
      if (rel >= r.crashes.seriousKmh) m.seriousCrashes++;
    } else if (e.type === "near_miss") m.nearMisses++;
  }

  const per10km = (n: number) => n / Math.max(1, m.distanceM / 10000);
  const share = (n: number, of: number) => (of > 0 ? n / of : 0);
  const reasons: RejectReason[] = [];
  if (m.driveSec < r.minDriveSec || m.distanceM < r.minDistanceM) reasons.push("too_short");
  if (m.jamSpeedingSec >= r.jamSpeeding.minSec && share(m.jamSpeedingSec, m.congestedSec) >= r.jamSpeeding.minShare) reasons.push("jam_speeding");
  if (m.extremeSec >= r.extremeSpeed.minSec) reasons.push("extreme_speed");
  if (m.seriousCrashes >= r.crashes.minCount && per10km(m.seriousCrashes) >= r.crashes.per10km) reasons.push("crashes");
  if (m.crashes >= r.contacts.minCount && per10km(m.crashes) >= r.contacts.per10km) reasons.push("contacts");
  if (m.shoulderSec >= r.shoulder.minSec && share(m.shoulderSec, m.driveSec) >= r.shoulder.minShare) reasons.push("shoulder");
  if (share(m.idleSec, m.driveSec) >= r.idle.maxShare) reasons.push("idle");
  if (m.driveSec > 0 && share(m.noInputSec, m.driveSec) >= r.noInput.maxShare) reasons.push("no_input");
  if (m.nearMisses >= r.nearMiss.minCount && per10km(m.nearMisses) >= r.nearMiss.per10km) reasons.push("near_miss");
  return { ok: reasons.length === 0, reasons, metrics: m, rulesVersion: r.version };
}

/** 참여자(브라우저)의 최근 판정 기록. true = 걸러지지 않음 */
export interface ParticipantHistory {
  recent: boolean[];
  flagged: boolean;
}

/** 이번 판정을 기록에 더하고, 이 참여자를 거를지 정한다. 이번 주행 판정은 바꾸지 않는다 */
export function updateParticipant(h: ParticipantHistory, accepted: boolean, rules: QualityRules): ParticipantHistory {
  const p = rules.participant;
  const recent = [...h.recent, accepted].slice(-Math.max(p.window, p.clearAfterAccepted));
  const inWindow = recent.slice(-p.window);
  const rejected = inWindow.filter((x) => !x).length;
  let flagged = h.flagged;
  if (rejected >= p.maxRejected) flagged = true;
  else if (flagged && recent.length >= p.clearAfterAccepted && recent.slice(-p.clearAfterAccepted).every((x) => x)) flagged = false;
  return { recent, flagged };
}

const HISTORY_KEY = "drip_quality_history";

export function loadParticipant(): ParticipantHistory {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null") as ParticipantHistory | null;
    if (h && Array.isArray(h.recent)) return { recent: h.recent.map(Boolean), flagged: !!h.flagged };
  } catch {
    // 저장소를 못 쓰면 매번 새 참여자
  }
  return { recent: [], flagged: false };
}

export function saveParticipant(h: ParticipantHistory) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    // 저장소를 못 쓰면 기록하지 않는다
  }
}
