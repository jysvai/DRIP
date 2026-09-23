// 조작법: 메뉴와 주행 중(F1)에 같은 그림을 보여 준다.

import { ICON } from "./icons";

const key = (k: string, label = "") => `<kbd${label ? ` aria-label="${label}"` : ""}>${k}</kbd>`;

/** [키들, 설명, 덧붙임] */
const DRIVE: [string, string, string][] = [
  [`${key("↑", "위쪽 화살표")}${key("W")}`, "가속 페달", "누르는 동안 깊게 밟히고, 떼면 그 깊이로 유지 (속도·rpm 유지)"],
  [`${key("↓", "아래쪽 화살표")}${key("S")}`, "발 떼기 · 브레이크", "먼저 가속 페달에서 발을 떼고, 계속 누르면 브레이크"],
  [`${key("←", "왼쪽 화살표")}${key("→", "오른쪽 화살표")}${key("A")}${key("D")}`, "핸들", "놓으면 차가 차로 방향으로 곧게 돌아옵니다"],
];

const MORE: [string, string][] = [
  [`${key("Q")}${key("E")}`, "왼쪽 · 오른쪽 방향지시등 <small>계기판에 그쪽 뒤 카메라가 뜨고, 차로를 옮기면 저절로 꺼짐</small>"],
  [key("X"), "비상등"],
  [key("L"), "차로 유지 보조 켜기·끄기 <small>시속 60km부터, 방향지시등 없이 차선을 넘으면 경고하고 되돌림</small>"],
  [key("H"), "경적"],
  [key("R"), "후진 기어 켜기·끄기"],
  [key("C"), "시점 바꾸기 <small>운전석 · 보닛 · 차 뒤</small>"],
  [key("V"), "거울 크게 보기 <small>화면 가장자리 창</small>"],
  [key("M"), "마우스 조향 켜기·끄기 <small>마우스를 좌우로</small>"],
  [key("Tab"), "계기판·내비 크게·작게"],
  [key("F1"), "조작법 보기"],
  [key("Esc"), "일시정지 · 주행 끝내기"],
];

export function controlsHtml(): string {
  const row = ([k, text, sub]: [string, string, string?]) => `<div><dt>${k}</dt><dd><b>${text}</b>${sub ? `<small>${sub}</small>` : ""}</dd></div>`;
  return `
  <div class="controls">
    <div class="ctl-drive">
      <div class="arrows" aria-hidden="true">
        <span></span>${key("↑")}<span></span>
        ${key("←")}${key("↓")}${key("→")}
      </div>
      <dl class="ctl-list">${DRIVE.map(row).join("")}</dl>
    </div>
    <dl class="ctl-list ctl-cols">${MORE.map(([k, t]) => `<div><dt>${k}</dt><dd>${t}</dd></div>`).join("")}</dl>
    <div class="ctl-pad">
      ${ICON.gamepad}
      <p><b>게임패드 · 레이싱 휠</b>은 연결하면 바로 씁니다. 왼쪽 스틱·휠 조향, RT 가속, LT 브레이크, LB·RB 방향지시등, B 비상등, Y 시점, Start 일시정지.</p>
    </div>
  </div>`;
}

/** 조작법 창. 닫히면 onClose */
export function showControls(onClose?: () => void) {
  const ov = document.createElement("div");
  ov.className = "overlay help-overlay";
  ov.innerHTML = `<div class="card help-card" role="dialog" aria-modal="true" aria-labelledby="help-title"><div class="help-head"><h2 id="help-title">조작법</h2><button class="btn ghost" data-close>닫기 <kbd>Esc</kbd></button></div>${controlsHtml()}</div>`;
  document.body.appendChild(ov);
  const prev = document.activeElement as HTMLElement | null;
  const close = () => {
    ov.remove();
    window.removeEventListener("keydown", onKey, true);
    prev?.focus?.();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code === "Escape" || e.code === "F1" || e.code === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);
  const btn = ov.querySelector<HTMLButtonElement>("[data-close]")!;
  btn.addEventListener("click", close);
  btn.focus({ preventScroll: true });
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });
}
