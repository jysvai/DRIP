// 화면 효과: 빠를수록 가장자리가 조금 어두워지는 시야 좁아짐(속도감)과, 부딪힌 순간 붉게 번쩍임.
// 3D 화면 바로 위, 계기판(HUD, z-index 10) 아래에 깐다. 스타일은 여기서 넣는다 (style.css와 따로).

const CSS = `
.drive-fx { position: fixed; inset: 0; pointer-events: none; z-index: 5; }
.drive-fx .vig { position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse 72% 64% at 50% 46%, transparent 58%, rgba(0, 0, 0, 0.55) 100%); }
.drive-fx .hit { position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse 80% 75% at 50% 50%, transparent 35%, rgba(190, 18, 10, 0.55) 100%); }
.drive-fx .hit.flash { animation: drive-fx-hit 0.9s ease-out; }
@keyframes drive-fx-hit { 0% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .drive-fx .hit.flash { animation-duration: 0.3s; } }
`;

export class DriveFx {
  private root: HTMLDivElement;
  private vig: HTMLDivElement;
  private hit: HTMLDivElement;
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
    this.root.append(this.vig, this.hit);
    document.body.appendChild(this.root);
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
  }
}
