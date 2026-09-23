// 화면 효과: 빠를수록 가장자리가 조금 어두워지는 시야 좁아짐(속도감)과, 부딪힌 순간 붉게 번쩍임,
// 요약 주행에서 구간을 건너뛸 때 바깥 풍경만 어두워졌다 밝아지는 전환(계기판은 그대로)과 건너뛴 거리 카드.
// 3D 화면 바로 위, 계기판(HUD, z-index 10) 아래에 깐다. 카드만 계기판 위. 스타일은 여기서 넣는다 (style.css와 따로).

const CSS = `
.drive-fx { position: fixed; inset: 0; pointer-events: none; z-index: 5; }
.drive-fx .vig { position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse 72% 64% at 50% 46%, transparent 58%, rgba(0, 0, 0, 0.55) 100%); }
.drive-fx .hit { position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse 80% 75% at 50% 50%, transparent 35%, rgba(190, 18, 10, 0.55) 100%); }
.drive-fx .hit.flash { animation: drive-fx-hit 0.9s ease-out; }
@keyframes drive-fx-hit { 0% { opacity: 1; } 100% { opacity: 0; } }
.drive-fx .cut { position: absolute; inset: 0; background: #05070a; opacity: 0; transition: opacity 0.6s ease-out; }
.drive-fx .cut.on { opacity: 1; transition: opacity 0.35s ease-in; }
.drive-cut { position: fixed; left: 50%; top: 22%; z-index: 30; pointer-events: none; transform: translate(-50%, 8px); opacity: 0;
  transition: opacity 0.3s ease-out, transform 0.3s ease-out; min-width: 320px; max-width: min(460px, calc(100vw - 32px));
  background: var(--c-paper-2, #1b1f25); border: 1px solid var(--c-rule, #2f3640); border-radius: 10px; padding: 14px 18px 16px;
  color: var(--c-ink, #eef1f4); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5); font-family: var(--font-ui, inherit); }
.drive-cut.show { opacity: 1; transform: translate(-50%, 0); }
.drive-cut .k { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em;
  color: var(--c-sign-ink, #f2fbf6); background: var(--c-sign, #1f7a55); border-radius: 4px; padding: 2px 7px; }
.drive-cut .main { display: flex; align-items: baseline; gap: 6px; margin-top: 10px; font-family: var(--font-num, inherit); font-variant-numeric: tabular-nums; }
.drive-cut .main b { font-size: 34px; font-weight: 600; line-height: 1; }
.drive-cut .main small { font-size: 14px; color: var(--c-muted, #a7b0ba); margin-right: 10px; }
.drive-cut .next { margin-top: 8px; font-size: 14px; color: var(--c-ink-2, #d6dbe0); }
.drive-cut .next b { color: var(--c-ink, #fff); }
.drive-cut .clock { margin-top: 2px; font-size: 12px; color: var(--c-muted, #a7b0ba); font-variant-numeric: tabular-nums; }
.drive-cut .bar { position: relative; height: 6px; margin-top: 12px; border-radius: 3px; background: var(--c-paper-4, #333a43); overflow: hidden; }
.drive-cut .bar i { position: absolute; top: 0; bottom: 0; background: var(--c-muted, #8a939d); border-radius: 3px; min-width: 3px; }
.drive-cut .bar i.done { background: var(--c-sign-hi, #2b9a6c); }
.drive-cut .bar i.now { background: var(--c-ink, #fff); }
.drive-cut .legend { display: flex; justify-content: space-between; margin-top: 5px; font-size: 11px; color: var(--c-muted, #a7b0ba); }
@media (prefers-reduced-motion: reduce) {
  .drive-fx .hit.flash { animation-duration: 0.3s; }
  .drive-fx .cut, .drive-fx .cut.on, .drive-cut { transition-duration: 0.12s; }
}
`;

/** 건너뛸 때 보여 줄 내용 */
export interface CutInfo {
  /** 건너뛴 거리 (km)와 그만큼 실제로 달렸다면 걸렸을 시간 (분) */
  km: number;
  minutes: number;
  /** 다음에 달릴 곳 설명 (HTML 아님) */
  next: string;
  /** 게임 속 시각 */
  clock: string;
  /** 달리는 구간들 (경로 비율 0~1)과 지금 들어가는 구간 번호 */
  windows: [number, number][];
  current: number;
}

export class DriveFx {
  private root: HTMLDivElement;
  private vig: HTMLDivElement;
  private hit: HTMLDivElement;
  private cutEl: HTMLDivElement;
  private card: HTMLDivElement;
  private cardTimer = 0;
  private last = -1;

  constructor() {
    if (!document.getElementById("drive-fx-css")) {
      const st = document.createElement("style");
      st.id = "drive-fx-css";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement("div");
    this.root.className = "drive-fx";
    this.vig = document.createElement("div");
    this.vig.className = "vig";
    this.hit = document.createElement("div");
    this.hit.className = "hit";
    this.cutEl = document.createElement("div");
    this.cutEl.className = "cut";
    this.root.append(this.vig, this.hit, this.cutEl);
    document.body.appendChild(this.root);
    this.card = document.createElement("div");
    this.card.className = "drive-cut";
    this.card.setAttribute("role", "status");
    document.body.appendChild(this.card);
  }

  /** 요약 주행: 바깥 풍경을 어둡게 하고 건너뛴 거리를 보여 준다. 다 어두워지면(0.35초) reveal()로 밝힌다 */
  cut(info: CutInfo) {
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const bars = info.windows
      .map(([a, b], i) => `<i class="${i < info.current ? "done" : i === info.current ? "now" : ""}" style="left:${(a * 100).toFixed(2)}%;width:${((b - a) * 100).toFixed(2)}%"></i>`)
      .join("");
    this.card.innerHTML =
      `<span class="k">요약 주행 · ${info.current + 1}/${info.windows.length} 구간</span>` +
      `<div class="main"><b>${info.km.toFixed(info.km < 10 ? 1 : 0)}</b><small>km 건너뜀</small><b>${Math.round(info.minutes)}</b><small>분</small></div>` +
      `<div class="next">다음 · <b>${esc(info.next)}</b></div>` +
      `<div class="clock">게임 속 시각 ${esc(info.clock)}</div>` +
      `<div class="bar">${bars}</div><div class="legend"><span>출발</span><span>도착</span></div>`;
    clearTimeout(this.cardTimer);
    this.card.classList.add("show");
    this.cutEl.classList.add("on");
  }

  /** 건너뛴 뒤 풍경을 다시 밝힌다. 카드는 조금 더 남았다가 사라진다 */
  reveal() {
    this.cutEl.classList.remove("on");
    clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => this.card.classList.remove("show"), 2200);
  }

  /** 속도감 (0~1): 시속 100km부터 짙어진다 */
  speed(kmh: number, scale: number) {
    const v = Math.round(Math.max(0, Math.min(1, (kmh - 100) / 110)) * 0.8 * scale * 100) / 100;
    if (v === this.last) return;
    this.last = v;
    this.vig.style.opacity = String(v);
  }

  /** 부딪힌 순간 붉은 번쩍임. strength 0~1 */
  flash(strength: number) {
    this.hit.classList.remove("flash");
    void this.hit.offsetWidth; // 애니메이션을 처음부터 다시
    this.hit.style.opacity = "0";
    this.hit.style.filter = `opacity(${Math.max(0.25, Math.min(1, strength))})`;
    this.hit.classList.add("flash");
  }

  set visible(v: boolean) {
    this.root.style.display = v ? "" : "none";
    if (!v) this.card.classList.remove("show");
  }
}
