// 휠·페달 맞추기: 레이싱 휠 페달은 기기마다 들어오는 축과 값이 달라서, 밟아 보게 하고 어느 축인지 찾는다.

import { detectPedal, isWheel, snapshot, type PadSnapshot, type PedalAxis, type WheelCalibration } from "../sim/input";

/** 연결된 첫 게임패드 (브라우저는 버튼을 한 번 누르기 전까지 알려 주지 않는다) */
export function connectedPad(): Gamepad | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  for (const p of navigator.getGamepads()) if (p?.connected) return p;
  return null;
}

/** 게임패드 이름을 짧게 (괄호 안 제조사 번호 빼고) */
export function padLabel(p: Gamepad): string {
  const name = p.id.replace(/\s*\(.*\)\s*$/, "").trim() || "게임패드";
  return `${name} · ${isWheel(p.id) ? "레이싱 휠" : "게임패드"}`;
}

/** 페달 이름 (설정 화면 표시용) */
export function pedalLabel(p: PedalAxis): string {
  return p.kind === "axis" ? `축 ${p.index}` : `버튼 ${p.index}`;
}

const STEPS = [
  ["throttle", "가속 페달을 끝까지 밟았다 떼세요"],
  ["brake", "이번에는 브레이크 페달을 끝까지 밟았다 떼세요"],
] as const;

/** 맞추기 창. 끝까지 하면 결과, 취소하면 null */
export function calibratePedals(): Promise<WheelCalibration | null> {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay help-overlay";
    ov.innerHTML = `<div class="card help-card pad-card" role="dialog" aria-modal="true" aria-labelledby="pad-title">
      <div class="help-head"><h2 id="pad-title">휠·페달 맞추기</h2><button class="btn ghost" data-close>취소 <kbd>Esc</kbd></button></div>
      <div class="pad-body">
        <p class="pad-name"></p>
        <p class="pad-step" aria-live="polite"></p>
        <div class="pad-axes"></div>
        <p class="note">페달은 기기마다 들어오는 축이 달라서 한 번 밟아 보고 찾습니다. 맞춘 값은 이 브라우저에 저장되고, 메뉴에서 지울 수 있습니다.</p>
        <div class="pad-actions"><button class="btn" data-redo>처음부터</button></div>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const name = ov.querySelector<HTMLElement>(".pad-name")!;
    const stepEl = ov.querySelector<HTMLElement>(".pad-step")!;
    const axesEl = ov.querySelector<HTMLElement>(".pad-axes")!;
    let step = 0;
    let frames: PadSnapshot[] = [];
    const found: PedalAxis[] = [];
    let stableSince = 0;
    let raf = 0;
    let done = false;

    const finish = (r: WheelCalibration | null) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      ov.remove();
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    ov.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => finish(null);
    ov.querySelector<HTMLButtonElement>("[data-redo]")!.onclick = () => {
      step = 0;
      frames = [];
      found.length = 0;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const pad = connectedPad();
      if (!pad) {
        name.textContent = "연결된 휠·게임패드가 없습니다";
        stepEl.textContent = "휠이나 패드를 꽂고 버튼을 한 번 누르세요 (브라우저는 버튼을 누르기 전까지 장치를 알려 주지 않습니다)";
        axesEl.innerHTML = "";
        return;
      }
      name.textContent = padLabel(pad);
      const snap = snapshot(pad);
      frames.push(snap);
      if (frames.length > 900) frames.shift();
      stepEl.textContent = `${step + 1}/${STEPS.length} · ${STEPS[step][1]}`;
      // 축 막대: 지금 값, 찾은 페달은 표시
      axesEl.innerHTML = snap.axes
        .map((v, i) => {
          const tag = found.find((p) => p.kind === "axis" && p.index === i);
          const label = i === 0 ? "조향" : tag ? (found.indexOf(tag) === 0 ? "가속" : "브레이크") : "";
          return `<div class="pad-axis${tag ? " on" : ""}"><span>축 ${i}${label ? ` · ${label}` : ""}</span><div class="bar"><i style="left:${((v + 1) / 2) * 100}%"></i></div><b>${v.toFixed(2)}</b></div>`;
        })
        .join("");
      const p = detectPedal(frames, found);
      if (!p) {
        stableSince = 0;
        return;
      }
      // 떼고 나서 0.4초 가만히 있으면 그 페달로 정한다
      const cur = p.kind === "axis" ? snap.axes[p.index] : snap.buttons[p.index];
      const prev = frames.length > 1 ? frames[frames.length - 2] : snap;
      const was = p.kind === "axis" ? prev.axes[p.index] : prev.buttons[p.index];
      if (Math.abs(cur - was) > 0.02) stableSince = 0;
      else if (!stableSince) stableSince = now;
      if (!stableSince || now - stableSince < 400) return;
      found.push(p);
      frames = [];
      stableSince = 0;
      step++;
      if (step >= STEPS.length) finish({ throttle: found[0], brake: found[1] });
    };
    raf = requestAnimationFrame(tick);
  });
}
