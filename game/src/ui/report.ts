// 주행이 끝난 뒤 결과 화면: 요약 수치, 법규 판정, 이벤트 목록, 업로드 상태, 기록 파일 받기.

import type { DriveEvent, EventType, Summary } from "../rules/engine";
import { CITY_ONLY, EVENT_LABELS, HIGHWAY_ONLY, VIOLATIONS } from "../rules/engine";
import type { UploadStatus } from "../log/recorder";
import { REJECT_LABELS, type QualityResult } from "../log/quality";
import { ICON } from "./icons";

export interface ReportInput {
  summary: Summary;
  events: DriveEvent[];
  reason: string;
  roadLabel: string;
  upload: Promise<UploadStatus>;
  /** 연구 데이터 품질 검사 결과 */
  quality: QualityResult;
  exportJson: () => string;
  fileName: string;
  /** 시내 주행이면 시내 판정만, 아니면 고속도로 판정만 보여 준다 */
  urban?: boolean;
}

const REASONS: Record<string, string> = {
  arrived: "목적지에 도착했습니다",
  road_end: "주행선 끝까지 달렸습니다",
  user: "주행을 끝냈습니다",
  crash: "충돌 뒤 주행을 끝냈습니다",
};

const REASON_ICON: Record<string, string> = { arrived: ICON.check, road_end: ICON.check, crash: ICON.warn };

/** 걸린 시간: 숫자는 크게, 단위는 작게 */
function durationHtml(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}<small>시간</small> ${String(m % 60).padStart(2, "0")}<small>분</small>`;
  return `${m}<small>분</small> ${String(s).padStart(2, "0")}<small>초</small>`;
}

const num = (v: string, unit = "") => `${v}${unit ? `<small>${unit}</small>` : ""}`;

export function showReport(input: ReportInput, onRetry: () => void, onMenu: () => void) {
  const { summary: s, events } = input;
  const ov = document.createElement("div");
  ov.className = "overlay";
  const card = document.createElement("div");
  card.className = "card report";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "rp-title");
  ov.appendChild(card);

  const pct = (a: number, b: number) => (b > 0 ? num(String(Math.round((a / b) * 100)), "%") : "–");
  const km = s.distanceM / 1000;
  const key: [string, string][] = [
    ["주행 거리", num(km.toFixed(km < 10 ? 2 : 1), "km")],
    ["주행 시간", durationHtml(s.timeSec)],
    ["평균 속도", num(String(Math.round(s.avgSpeedKmh)), "km/h")],
    ["최고 속도", num(String(Math.round(s.maxSpeedKmh)), "km/h")],
  ];
  const sub: [string, string][] = [
    ["과속한 시간", num(String(Math.round(s.speedingTimeSec)), "초")],
    ["앞차와 2초 미만", pct(s.headwayUnder2Sec, s.headwayMeasuredSec)],
    ["차로 변경", num(String(s.laneChanges), "회")],
    ["방향지시등 켜고 변경", pct(s.signaledLaneChanges, s.laneChanges)],
  ];
  const dl = (cls: string, rows: [string, string][]) => `<dl class="${cls}">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

  const skip = input.urban ? HIGHWAY_ONLY : CITY_ONLY;
  const vRows = VIOLATIONS.filter((t) => !skip.includes(t)).map((t) => [t, s.counts[t] ?? 0] as [EventType, number]);
  const other: EventType[] = ["hard_accel", "hard_brake", "near_miss", "crash"];
  const oRows = other.map((t) => [t, s.counts[t] ?? 0] as [EventType, number]);
  const total = (rows: [EventType, number][]) => rows.reduce((a, [, n]) => a + n, 0);
  const table = (rows: [EventType, number][]) =>
    `<table><tbody>${rows.map(([t, n]) => `<tr class="${n ? "" : "zero"}"><td>${EVENT_LABELS[t]}</td><td class="n${n ? " bad" : ""}">${n}</td></tr>`).join("")}</tbody></table>`;

  const all = events.filter((e) => e.type !== "lane_change" && e.type !== "junction_pass");
  const shown = all.slice(0, 60);
  const evRows = shown
    .map((e) => {
      const m = Math.floor(e.t / 60);
      const sec = Math.floor(e.t % 60);
      return `<tr><td class="t">${m}:${String(sec).padStart(2, "0")}</td><td class="k">${(e.s / 1000).toFixed(2)}</td><td>${EVENT_LABELS[e.type]}</td><td class="v">${Math.round(e.speedKmh)}</td><td class="l">${e.lane || "–"}</td></tr>`;
    })
    .join("");
  const when = new Date().toLocaleString("ko-KR", { dateStyle: "long", timeStyle: "short" });

  card.innerHTML = `
    <div class="rp-scroll">
      <header class="rp-head">
        <p>주행 결과 · ${when}</p>
        <h2 id="rp-title">${input.roadLabel}</h2>
        <p class="rp-reason" data-r="${input.reason}">${REASON_ICON[input.reason] ?? ICON.info}${REASONS[input.reason] ?? input.reason}</p>
      </header>
      ${dl("rp-key", key)}
      ${dl("rp-sub", sub)}
      <div class="rp-body">
        <section><h3>법규 판정 <small>${total(vRows)}건</small></h3>${table(vRows)}</section>
        <section><h3>위험 운전 <small>${total(oRows)}건</small></h3>${table(oRows)}
          <p class="rp-note">급가속 11km/h/s, 급감속 7.5km/h/s 이상 (교통안전공단 운행기록 분석 기준, 값은 확인 필요). 아차사고는 충돌까지 1.5초 미만이거나 옆 간격 0.4m 미만, 또는 내 차 때문에 다른 차가 급제동한 경우.</p>
        </section>
      </div>
      <section class="rp-log">
        <h3>기록된 일 <small>${all.length > shown.length ? `${all.length}건 중 처음 ${shown.length}건` : `${all.length}건`}</small></h3>
        ${
          shown.length
            ? `<table><thead><tr><th>시간</th><th class="r">위치 km</th><th>내용</th><th class="r">속도 km/h</th><th class="c">차로</th></tr></thead><tbody>${evRows}</tbody></table>`
            : `<p class="rp-empty">기록된 법규 위반이나 위험 운전이 없습니다.</p>`
        }
      </section>
    </div>
    <p class="rp-upload" data-state="pending" role="status">${ICON.info}<span>기록 저장 중…</span></p>
    <div class="rp-actions">
      <button class="btn ghost dl">${ICON.download}기록 파일 받기 <small>JSON</small></button>
      <span class="spacer"></span>
      <button class="btn to-menu">노선 고르기</button>
      <button class="btn primary retry">${ICON.retry}같은 조건으로 다시</button>
    </div>`;
  document.body.appendChild(ov);

  const up = card.querySelector(".rp-upload") as HTMLElement;
  // 걸러진 이유는 크게만 알려 준다 (기준 수치는 data_quality.json)
  const q = input.quality;
  const why = q.reasons.map((r) => REJECT_LABELS[r]).join(", ");
  const verdict = q.ok ? "연구 데이터 기준을 통과한 주행입니다." : `연구 데이터 기준에 맞지 않는 주행입니다 (${why}).`;
  void input.upload.then((st) => {
    const text =
      st === "ok"
        ? "익명 주행 기록을 연구 데이터셋에 저장했습니다. 고맙습니다."
        : st === "closed"
          ? `지금은 시험 운영 기간이라 기록을 서버에 올리지 않습니다. ${verdict} 기록은 파일로 받을 수 있습니다.`
          : st === "rejected"
            ? `${verdict} 데이터셋이 흐려지지 않도록 서버에 올리지 않았습니다.`
            : st === "no_consent"
              ? "연구 참여에 동의하지 않아 기록을 서버에 올리지 않았습니다. 기록은 파일로 받을 수 있습니다."
              : st === "offline"
                ? "서버에 연결되지 않은 빌드라 기록을 올리지 않았습니다. 기록은 파일로 받을 수 있습니다."
                : "기록을 서버에 올리지 못했습니다. 파일로 받아 두세요.";
    const state = st === "ok" ? "ok" : st === "rejected" ? "rejected" : st === "error" ? "error" : "info";
    up.dataset.state = state;
    up.innerHTML = `${state === "ok" ? ICON.check : state === "rejected" ? ICON.warn : state === "error" ? ICON.alert : ICON.info}<span></span>`;
    up.querySelector("span")!.textContent = text;
  });
  const retry = card.querySelector(".retry") as HTMLButtonElement;
  retry.onclick = onRetry;
  (card.querySelector(".to-menu") as HTMLButtonElement).onclick = onMenu;
  (card.querySelector(".dl") as HTMLButtonElement).onclick = () => {
    const blob = new Blob([input.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = input.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  retry.focus({ preventScroll: true });
  return ov;
}

/** 버튼 이름 끝의 "(키)"를 키 모양으로: "계속 (Esc)" → 계속 [Esc] */
function buttonHtml(label: string): string {
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(label);
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return m ? `${esc(m[1])}<kbd>${esc(m[2])}</kbd>` : esc(label);
}

/** 버튼 몇 개짜리 안내 창 (일시정지, 충돌, 출발 준비). 주 버튼은 오른쪽 끝에 두고 처음부터 누를 수 있게 한다 */
export function showDialog(title: string, text: string, buttons: { label: string; primary?: boolean; key?: string; keep?: boolean; onClick: () => void }[]) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  const card = document.createElement("div");
  card.className = "dialog";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "dialog-title");
  // 설명 뒤에 붙는 흐린 덧말은 따로 한 단락으로 (줄바꿈을 겹치지 않게)
  const body = text.replace(/<br>\s*(?=<span class=['"]muted)/g, "");
  card.innerHTML = `<h2 id="dialog-title">${title}</h2><div class="dialog-body"><p>${body}</p></div>`;
  const row = document.createElement("div");
  row.className = "dialog-actions";
  const close = () => {
    removeEventListener("keydown", onKey, true);
    ov.remove();
  };
  let primary: HTMLButtonElement | null = null;
  for (const b of [...buttons.filter((x) => !x.primary), ...buttons.filter((x) => x.primary)]) {
    const btn = document.createElement("button");
    btn.className = `btn${b.primary ? " primary" : ""}`;
    btn.innerHTML = buttonHtml(b.label);
    btn.onclick = () => {
      if (!b.keep) close();
      b.onClick();
    };
    if (b.primary) primary = btn;
    row.appendChild(btn);
  }
  const onKey = (e: KeyboardEvent) => {
    // 조작법 창이 위에 떠 있으면 그 창이 키를 받는다
    if (document.querySelector(".help-overlay")) return;
    const b = buttons.find((x) => x.key && (x.key === e.code || (x.key === "Enter" && (e.code === "Enter" || e.code === "Space"))));
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      if (!b.keep) close();
      b.onClick();
    }
  };
  addEventListener("keydown", onKey, true);
  card.appendChild(row);
  ov.appendChild(card);
  document.body.appendChild(ov);
  primary?.focus({ preventScroll: true });
  return { close };
}
