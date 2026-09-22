// 주행이 끝난 뒤 결과 화면: 요약 수치, 법규 판정, 이벤트 목록, 업로드 상태, 기록 파일 받기.

import type { DriveEvent, EventType, Summary } from "../rules/engine";
import { EVENT_LABELS, VIOLATIONS } from "../rules/engine";

export interface ReportInput {
  summary: Summary;
  events: DriveEvent[];
  reason: string;
  roadLabel: string;
  upload: Promise<"ok" | "offline" | "error" | "no_consent">;
  exportJson: () => string;
  fileName: string;
}

const REASONS: Record<string, string> = {
  road_end: "주행선 끝까지 달렸습니다",
  user: "주행을 끝냈습니다",
  crash: "충돌 뒤 주행을 끝냈습니다",
};

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}분 ${s}초`;
}

export function showReport(input: ReportInput, onRetry: () => void, onMenu: () => void) {
  const { summary: s, events } = input;
  const ov = document.createElement("div");
  ov.className = "overlay";
  const card = document.createElement("div");
  card.className = "card report";
  ov.appendChild(card);

  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "–");
  const stats: [string, string][] = [
    ["주행 거리", `${(s.distanceM / 1000).toFixed(2)} km`],
    ["주행 시간", fmtTime(s.timeSec)],
    ["평균 속도", `${Math.round(s.avgSpeedKmh)} km/h`],
    ["최고 속도", `${Math.round(s.maxSpeedKmh)} km/h`],
    ["과속 시간", `${Math.round(s.speedingTimeSec)}초`],
    ["앞차 2초 미만", pct(s.headwayUnder2Sec, s.headwayMeasuredSec)],
    ["차로 변경", `${s.laneChanges}회`],
    ["방향지시등 사용", pct(s.signaledLaneChanges, s.laneChanges)],
  ];

  const vRows = VIOLATIONS.map((t) => [t, s.counts[t] ?? 0] as [EventType, number]);
  const other: EventType[] = ["hard_accel", "hard_brake", "near_miss", "crash"];
  const oRows = other.map((t) => [t, s.counts[t] ?? 0] as [EventType, number]);
  const table = (rows: [EventType, number][]) =>
    rows.map(([t, n]) => `<tr><td>${EVENT_LABELS[t]}</td><td class="${n ? "bad" : ""}">${n}</td></tr>`).join("");

  const shown = events.filter((e) => e.type !== "lane_change").slice(0, 60);
  const evRows = shown
    .map((e) => {
      const m = Math.floor(e.t / 60);
      const sec = Math.floor(e.t % 60);
      return `<tr><td>${m}:${String(sec).padStart(2, "0")}</td><td>${(e.s / 1000).toFixed(2)} km</td><td>${EVENT_LABELS[e.type]}</td><td>${Math.round(e.speedKmh)} km/h</td><td>${e.lane || "–"}</td></tr>`;
    })
    .join("");

  card.innerHTML = `
    <h2>주행 결과</h2>
    <p>${input.roadLabel} · ${REASONS[input.reason] ?? input.reason}</p>
    <dl class="stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    <div class="row" style="align-items:flex-start;gap:24px">
      <div style="flex:1;min-width:220px"><b>법규 판정</b><table><tbody>${table(vRows)}</tbody></table></div>
      <div style="flex:1;min-width:220px"><b>위험 운전</b><table><tbody>${table(oRows)}</tbody></table>
      <p class="muted">급가속 11km/h/s, 급감속 7.5km/h/s 이상 (교통안전공단 운행기록 분석 기준, 값은 확인 필요). 아차사고는 충돌까지 1.5초 미만이거나 옆 간격 0.4m 미만, 또는 내 차 때문에 다른 차가 급제동한 경우.</p></div>
    </div>
    ${shown.length ? `<b>기록된 일</b><table><thead><tr><th>시간</th><th>위치</th><th>내용</th><th>속도</th><th>차로</th></tr></thead><tbody>${evRows}</tbody></table>` : `<p class="muted">기록된 법규 위반이나 위험 운전이 없습니다.</p>`}
    <p class="muted upload">기록 저장 중…</p>
    <div class="row">
      <button class="btn primary retry">같은 조건으로 다시</button>
      <button class="btn to-menu">노선 고르기</button>
      <button class="btn dl">기록 파일 받기 (JSON)</button>
    </div>`;
  document.body.appendChild(ov);

  const up = card.querySelector(".upload") as HTMLElement;
  void input.upload.then((st) => {
    up.textContent =
      st === "ok"
        ? "익명 주행 기록을 연구 데이터셋에 저장했습니다. 고맙습니다."
        : st === "no_consent"
          ? "연구 참여에 동의하지 않아 기록을 서버에 올리지 않았습니다. 기록은 파일로 받을 수 있습니다."
          : st === "offline"
            ? "서버에 연결되지 않은 빌드라 기록을 올리지 않았습니다. 기록은 파일로 받을 수 있습니다."
            : "기록을 서버에 올리지 못했습니다. 파일로 받아 두세요.";
  });
  (card.querySelector(".retry") as HTMLButtonElement).onclick = onRetry;
  (card.querySelector(".to-menu") as HTMLButtonElement).onclick = onMenu;
  (card.querySelector(".dl") as HTMLButtonElement).onclick = () => {
    const blob = new Blob([input.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = input.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return ov;
}

/** 버튼 몇 개짜리 안내 창 (일시정지, 충돌, 출발 준비) */
export function showDialog(title: string, text: string, buttons: { label: string; primary?: boolean; key?: string; onClick: () => void }[]) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>${title}</h2><p>${text}</p>`;
  const row = document.createElement("div");
  row.className = "row";
  const close = () => {
    removeEventListener("keydown", onKey, true);
    ov.remove();
  };
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.className = `btn${b.primary ? " primary" : ""}`;
    btn.textContent = b.label;
    btn.onclick = () => {
      close();
      b.onClick();
    };
    row.appendChild(btn);
  }
  const onKey = (e: KeyboardEvent) => {
    const b = buttons.find((x) => x.key && (x.key === e.code || (x.key === "Enter" && (e.code === "Enter" || e.code === "Space"))));
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      close();
      b.onClick();
    }
  };
  addEventListener("keydown", onKey, true);
  card.appendChild(row);
  ov.appendChild(card);
  document.body.appendChild(ov);
  return { close };
}
