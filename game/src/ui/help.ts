// 조작법: 메뉴와 주행 중(F1)에 같은 그림을 보여 준다.

const key = (k: string, wide = "") => `<kbd class="${wide}">${k}</kbd>`;

export function controlsHtml(): string {
  return `
  <div class="controls">
    <div class="ctl-group">
      <div class="arrows">
        <div></div>${key("↑")}<div></div>
        ${key("←")}${key("↓")}${key("→")}
      </div>
      <div class="ctl-text">
        <b>운전</b>
        <span>${key("↑")} ${key("W")} 가속 페달 — 누르는 동안 서서히 깊게 밟힙니다</span>
        <span>${key("↓")} ${key("S")} 브레이크</span>
        <span>${key("←")}${key("→")} ${key("A")}${key("D")} 핸들 — 놓으면 차가 차로 방향으로 곧게 돌아옵니다</span>
      </div>
    </div>
    <div class="ctl-grid">
      <span>${key("Q")} ${key("E")}</span><span>왼쪽 · 오른쪽 방향지시등 (차로를 옮기면 저절로 꺼짐)</span>
      <span>${key("X")}</span><span>비상등</span>
      <span>${key("H")}</span><span>경적</span>
      <span>${key("R")}</span><span>후진 기어 켜기/끄기</span>
      <span>${key("C")}</span><span>시점 바꾸기 (운전석 · 보닛 · 차 뒤)</span>
      <span>${key("V")}</span><span>사이드미러·룸미러 켜기/끄기</span>
      <span>${key("M")}</span><span>마우스 조향 켜기/끄기 (마우스를 좌우로)</span>
      <span>${key("Tab")}</span><span>계기판·내비 크게/작게</span>
      <span>${key("F1")}</span><span>조작법 보기</span>
      <span>${key("Esc")}</span><span>일시정지 · 주행 끝내기</span>
    </div>
    <div class="ctl-pad">
      <b>게임패드 · 레이싱 휠</b> 연결하면 자동으로 씁니다.
      왼쪽 스틱/휠 조향 · RT 가속 · LT 브레이크 · LB/RB 방향지시등 · B 비상등 · Y 시점 · Start 일시정지
    </div>
  </div>`;
}

/** 조작법 창. 닫히면 onClose */
export function showControls(onClose?: () => void) {
  const ov = document.createElement("div");
  ov.className = "overlay help-overlay";
  ov.innerHTML = `<div class="card help-card"><div class="help-head"><h2>조작법</h2><button class="btn" data-close>닫기 (Esc)</button></div>${controlsHtml()}</div>`;
  document.body.appendChild(ov);
  const close = () => {
    ov.remove();
    window.removeEventListener("keydown", onKey, true);
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
  ov.querySelector("[data-close]")!.addEventListener("click", close);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });
}
