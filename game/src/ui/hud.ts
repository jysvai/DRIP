// 주행 중 화면 표시: 속도·기어·방향지시등, 노선·위치·차로, 제한속도, 다음 나들목, 기록 상태.
// 법규 판정 결과는 주행 중에 보여주지 않는다 (알려 주면 평소 운전 습관이 기록되지 않는다).

import type { Road } from "../road/road";
import { Structure } from "../road/road";
import type { BusLaneZone } from "../sim/traffic";

export interface HudFrame {
  kmh: number;
  gear: string;
  rpmRatio: number;
  signal: -1 | 0 | 1;
  hazard: boolean;
  s: number;
  lane: number;
  time: number;
  recStatus: string;
  camera: string;
  inputMode: string;
}

function el(cls: string, parent: HTMLElement, html = ""): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (html) d.innerHTML = html;
  parent.appendChild(d);
  return d;
}

export class Hud {
  readonly root: HTMLDivElement;
  private speed: HTMLDivElement;
  private gear: HTMLDivElement;
  private rpm: HTMLElement;
  private sigL: HTMLDivElement;
  private sigR: HTMLDivElement;
  private title: HTMLDivElement;
  private meta: HTMLDivElement;
  private lanes: HTMLDivElement;
  private limit: HTMLDivElement;
  private next: HTMLDivElement;
  private status: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private toastTimer = 0;
  private slowTimer = 0;
  private lastLanesKey = "";

  constructor(
    parent: HTMLElement,
    private road: Road,
    private busZones: BusLaneZone[],
  ) {
    this.root = el("hud", parent);
    const limitBox = el("limit", this.root);
    this.limit = el("circle", limitBox, "100");
    this.next = el("next", limitBox);
    this.status = el("status", this.root);
    const info = el("roadinfo", this.root);
    this.title = el("t", info);
    this.meta = el("m", info);
    this.lanes = el("lanes", info);
    const speedo = el("speedo", this.root);
    this.sigL = el("sig l", speedo, "◀");
    this.sigR = el("sig r", speedo, "▶");
    this.speed = el("v", speedo, "0");
    el("u", speedo, "km/h");
    this.gear = el("gear", speedo, "D");
    const rpm = el("rpm", speedo, "<i></i>");
    this.rpm = rpm.firstElementChild as HTMLElement;
    this.toastEl = el("toast", this.root);
    el("hint", this.root, "Esc 일시정지 · C 시점 · V 거울 · Q/E 방향지시등");
  }

  toast(text: string, sec = 2.2) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    this.toastTimer = sec;
  }

  update(f: HudFrame, dt: number) {
    // 매 프레임: 속도·방향지시등
    this.speed.textContent = String(Math.round(f.kmh));
    this.gear.textContent = f.gear;
    this.rpm.style.width = `${Math.round(Math.min(1, f.rpmRatio) * 100)}%`;
    const blink = Math.floor(f.time * 1.6) % 2 === 0;
    this.sigL.classList.toggle("on", (f.signal === -1 || f.hazard) && blink);
    this.sigR.classList.toggle("on", (f.signal === 1 || f.hazard) && blink);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove("show");
    }

    // 나머지는 0.2초마다
    this.slowTimer -= dt;
    if (this.slowTimer > 0) return;
    this.slowTimer = 0.2;
    const road = this.road;
    const s = f.s;
    this.title.innerHTML = `<span class="shield">${road.ref}</span>${road.sectionNameAt(s)}`;
    const st = road.structures.find((x) => s >= x.s0 && s < x.s1);
    const where = st ? ` · ${st.kind === Structure.Tunnel ? "터널" : "교량"}${st.name ? ` ${st.name}` : ""}` : "";
    this.meta.textContent = `${(s / 1000).toFixed(1)} km · ${road.to} 방향${where}`;
    const lanes = road.lanesAt(s);
    const key = `${lanes}|${f.lane}|${this.busZones.map((z) => (s >= z.s0 && s <= z.s1 ? z.lane : 0)).join(",")}`;
    if (key !== this.lastLanesKey) {
      this.lastLanesKey = key;
      let html = "";
      for (let l = 1; l <= lanes; l++) {
        const bus = this.busZones.some((z) => z.lane === l && s >= z.s0 && s <= z.s1);
        html += `<i class="${l === f.lane ? "me" : ""}${bus ? " bus" : ""}" title="${l}차로${bus ? " (버스전용)" : ""}"></i>`;
      }
      this.lanes.innerHTML = html;
    }
    this.limit.textContent = String(road.speedAt(s));
    const j = road.nextJunction(s);
    if (j) {
      const km = (j.s - s) / 1000;
      this.next.innerHTML = `${j.name}<small>${km < 1 ? `${Math.round(km * 1000 / 10) * 10}m` : `${km.toFixed(1)}km`}${j.exitNo ? ` · 출구 ${j.exitNo}` : ""}</small>`;
      this.next.style.display = "";
    } else this.next.style.display = "none";
    const mm = Math.floor(f.time / 60);
    const ss = Math.floor(f.time % 60);
    this.status.innerHTML = `<span class="rec">●</span> ${f.recStatus}<br>${mm}:${String(ss).padStart(2, "0")} · ${f.camera} · ${f.inputMode}`;
  }

  set visible(v: boolean) {
    this.root.style.display = v ? "" : "none";
  }
}
