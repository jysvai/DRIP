// 주행 중 화면: 계기판(속도·rpm·기어·방향지시등), 페달·핸들 표시, 내비(다음 분기점 안내·차로 안내·미니맵·남은 거리),
// 제한속도 표지, 노선·위치. 법규 판정 결과는 주행 중에 보여주지 않는다 (알려 주면 평소 운전 습관이 기록되지 않는다).

import type { Road } from "../road/road";
import { Structure } from "../road/road";
import type { Network } from "../road/route";
import type { Enforcement } from "../sim/cameras";
import type { BusLaneZone } from "../sim/traffic";
import { zoneLimit, type WorkZone } from "../sim/workzones";

export interface HudFrame {
  kmh: number;
  gear: string;
  rpm: number;
  signal: -1 | 0 | 1;
  hazard: boolean;
  s: number;
  d: number;
  /** 차 방향 - 도로 방향 (rad) */
  theta: number;
  lane: number;
  time: number;
  throttle: number;
  brake: number;
  steer: number;
  night: boolean;
  recStatus: string;
  camera: string;
  inputMode: string;
  /** 구간단속 안이면 평균 속도 (RuleEngine.sectionState) */
  section?: { avgKmh: number; limit: number; remainM: number; lengthM: number } | null;
}

export interface HudOptions {
  /** 도착 위치 (s)와 이름 */
  finishS: number;
  destName: string;
  startS: number;
  /** 출발 시각 (시) */
  hour: number;
  /** 속도계 눈금 끝 (km/h) */
  maxKmh: number;
  redline: number;
  idleRpm: number;
  /** 법규상 이 차의 제한속도를 화물차 기준으로 보여 줄지 */
  heavy: boolean;
  net?: Network | null;
  /** 음성 안내. 지금 말할 수 없으면(출발 전·일시정지) false를 돌려주고, 그러면 나중에 다시 말한다 */
  say?: (text: string) => boolean;
  /** 단속 카메라·구간단속 (enforcementFor) */
  enforcement?: Enforcement;
  /** 단속 카메라 앞에서 과속하면 울리는 경고음 */
  chime?: () => void;
  /** 공사 구간 (planWorkZones) */
  workZones?: WorkZone[];
}

const CONE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 3h4l5 16H5z"/><path fill="#fff" d="M8.6 9h6.8l.8 2.6H7.8zM7.2 13.6h9.6l.7 2.4H6.5z"/><rect x="3" y="19" width="18" height="2" rx="1" fill="currentColor"/></svg>`;
const CAM_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 7h11l2-2h3v4l-2 1v5H4z"/><circle cx="9.5" cy="11" r="2.3" fill="#111"/><rect x="8" y="15" width="3" height="5" fill="currentColor"/></svg>`;

type Turn = "left" | "right" | "straight";

interface Maneuver {
  s: number;
  kind: Turn | "dest";
  text: string;
  lanes: "left" | "right" | "all";
  /** 음성 안내용: 분기점 이름, 갈아탈 노선 이름, 방향 */
  voice?: { via: string; road: string; to: string };
}

/** 음성 안내 거리 (m): 분기점, 목적지 */
const VOICE_AT = { turn: [2000, 1000, 300], dest: [2000, 500] };

/** 소리 내어 읽을 이름 (신갈JC → 신갈분기점) */
function spoken(name: string): string {
  return name.replace(/JC$/, "분기점").replace(/IC$/, "나들목").replace(/TG$/, "요금소");
}

/** 읽을 거리: 1km 넘으면 0.1km 단위, 아래는 100m 단위 */
function spokenDist(m: number): string {
  return m >= 950 ? `${Math.round(m / 100) / 10}킬로미터` : `${Math.round(m / 100) * 100}미터`;
}

/** 분기점 안내 문장 (한국 내비 말투). dist는 남은 거리(m) */
export function turnPhrase(dist: number, kind: Turn, voice: { via: string; road: string; to: string }): string {
  const v = { ...voice, via: spoken(voice.via) };
  const side = kind === "left" ? "왼쪽 방향" : kind === "right" ? "오른쪽 방향" : "직진";
  if (dist <= 300) return kind === "straight" ? `잠시 후 ${v.to} 방향으로 직진입니다.` : `잠시 후 ${v.via}에서 ${side}입니다.`;
  return `${spokenDist(dist)} 앞, ${v.via}에서 ${v.road} ${v.to} 방향, ${side}입니다.`;
}

export function destPhrase(dist: number): string {
  return dist <= 500 ? "잠시 후 목적지 부근입니다." : `목적지까지 ${spokenDist(dist)} 남았습니다.`;
}

const NS = "http://www.w3.org/2000/svg";

function el(cls: string, parent: HTMLElement, html = ""): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (html) d.innerHTML = html;
  parent.appendChild(d);
  return d;
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)}m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
}

function clock(hour: number, sec: number): string {
  const total = Math.floor(hour * 60 + sec / 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 원호 경로 (각도는 도, 12시 방향 0, 시계 방향 +) */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** 바늘 계기 하나: 눈금·숫자·바늘 */
function dial(svg: SVGSVGElement, cx: number, cy: number, r: number, max: number, major: number, minor: number, label: (v: number) => string, red?: number) {
  const A0 = -135;
  const A1 = 135;
  const ang = (v: number) => A0 + ((A1 - A0) * Math.min(max, Math.max(0, v))) / max;
  let html = `<path d="${arc(cx, cy, r, A0, A1)}" class="dial-track"/>`;
  if (red !== undefined) html += `<path d="${arc(cx, cy, r, ang(red), A1)}" class="dial-red"/>`;
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = (ang(v) * Math.PI) / 180;
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const r0 = r - (isMajor ? 10 : 5);
    html += `<line x1="${(cx + r0 * Math.sin(a)).toFixed(1)}" y1="${(cy - r0 * Math.cos(a)).toFixed(1)}" x2="${(cx + r * Math.sin(a)).toFixed(1)}" y2="${(cy - r * Math.cos(a)).toFixed(1)}" class="${isMajor ? "tick-major" : "tick"}"/>`;
    if (isMajor) {
      const rl = r - 21;
      html += `<text x="${(cx + rl * Math.sin(a)).toFixed(1)}" y="${(cy - rl * Math.cos(a) + 4).toFixed(1)}" class="dial-num">${label(v)}</text>`;
    }
  }
  html += `<path d="" class="dial-fill"/>`;
  html += `<g class="needle"><line x1="${cx}" y1="${cy + 10}" x2="${cx}" y2="${cy - r + 6}"/><circle cx="${cx}" cy="${cy}" r="6"/></g>`;
  const g = document.createElementNS(NS, "g");
  g.innerHTML = html;
  svg.appendChild(g);
  const needle = g.querySelector(".needle") as SVGGElement;
  const fill = g.querySelector(".dial-fill") as SVGPathElement;
  return (v: number) => {
    const a = ang(v);
    needle.setAttribute("transform", `rotate(${a.toFixed(2)} ${cx} ${cy})`);
    fill.setAttribute("d", a > A0 + 0.5 ? arc(cx, cy, r - 2, A0, a) : "");
  };
}

export class Hud {
  readonly root: HTMLDivElement;
  private setSpeed: (v: number) => void;
  private setRpm: (v: number) => void;
  private speedText: SVGTextElement;
  private gearText: SVGTextElement;
  private sigL: SVGElement;
  private sigR: SVGElement;
  private icons: { hazard: SVGElement; beam: SVGElement; limit: SVGElement };
  private pedalT: HTMLElement;
  private pedalB: HTMLElement;
  private wheel: HTMLElement;
  private steerBar: HTMLElement;
  private title: HTMLDivElement;
  private meta: HTMLDivElement;
  private limit: HTMLDivElement;
  private limitNote: HTMLDivElement;
  private nav: HTMLDivElement;
  private navArrow: HTMLDivElement;
  private navDist: HTMLDivElement;
  private navText: HTMLDivElement;
  private navLanes: HTMLDivElement;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private upcoming: HTMLDivElement;
  private progressBar: HTMLElement;
  private progressText: HTMLDivElement;
  private clockEl: HTMLDivElement;
  private status: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private toastTimer = 0;
  private slowTimer = 0;
  private miniTimer = 0;
  private hintTime = 14;
  private lastLanesKey = "";
  private spoken = new Set<string>();
  private lastLimit = 0;
  private enfEl: HTMLDivElement;
  private lastSection: { avgKmh: number } | null = null;
  private chimeTimer = 0;
  /** 남은 경로를 제한속도로 달리는 데 걸리는 시간 (1km 간격, 끝에서부터 누적) */
  private etaTable: Float32Array;
  private netLines: { pts: Float32Array; box: [number, number, number, number] }[] = [];
  private compact = false;

  constructor(
    parent: HTMLElement,
    private road: Road,
    private busZones: BusLaneZone[],
    private opts: HudOptions,
  ) {
    this.root = el("hud2", parent);

    // 왼쪽 위: 제한속도·노선
    const sign = el("signbox", this.root);
    this.limit = el("limit-sign", sign, "100");
    const info = el("roadinfo", sign);
    this.title = el("t", info);
    this.meta = el("m", info);
    this.limitNote = el("ln", info);
    this.enfEl = el("enf", this.root);

    // 가운데 위: 내비 안내
    this.nav = el("navbar", this.root);
    this.navArrow = el("nav-arrow", this.nav);
    const navMain = el("nav-main", this.nav);
    this.navDist = el("nav-dist", navMain);
    this.navText = el("nav-text", navMain);
    this.navLanes = el("nav-lanes", this.nav);

    // 오른쪽 위: 기록 상태
    this.status = el("status", this.root);

    // 왼쪽 아래: 페달·핸들
    const ctl = el("controls-panel", this.root);
    this.wheel = el("wheel", ctl, `<svg viewBox="-50 -50 100 100"><circle r="42" class="rim"/><circle r="10" class="hub"/><path d="M-41 -4 L-10 -4 L-8 8 L8 8 L10 -4 L41 -4" class="spoke"/><path d="M0 8 L0 41" class="spoke"/><rect x="-4" y="-46" width="8" height="8" rx="2" class="mark"/></svg>`);
    const pedals = el("pedals", ctl);
    const mk = (cls: string, label: string, key: string) => {
      const p = el(`pedal ${cls}`, pedals, `<div class="bar"><i></i></div><b>${label}</b><kbd>${key}</kbd>`);
      return p.querySelector("i") as HTMLElement;
    };
    this.pedalB = mk("brake", "브레이크", "↓");
    this.pedalT = mk("throttle", "가속", "↑");
    const steerRow = el("steer-row", ctl, `<kbd>←</kbd><div class="steer-track"><i></i></div><kbd>→</kbd>`);
    this.steerBar = steerRow.querySelector("i") as HTMLElement;

    // 가운데 아래: 계기판
    const cluster = el("cluster", this.root);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 440 190");
    cluster.appendChild(svg);
    const maxKmh = opts.maxKmh;
    const major = maxKmh > 200 ? 40 : 20;
    this.setSpeed = dial(svg, 110, 105, 84, maxKmh, major, major / 4, (v) => String(v));
    const rpmMax = Math.ceil(opts.redline / 1000 + 0.5) * 1000;
    const ev = opts.idleRpm === 0;
    this.setRpm = ev ? () => {} : dial(svg, 330, 105, 70, rpmMax / 1000, 1, 0.5, (v) => String(v), opts.redline / 1000);
    const center = document.createElementNS(NS, "g");
    center.innerHTML = `
      <text x="220" y="100" class="digital">0</text>
      <text x="220" y="120" class="unit">km/h</text>
      <rect x="198" y="132" width="44" height="28" rx="6" class="gear-box"/>
      <text x="220" y="152" class="gear">D</text>
      <path d="M170 38 l-16 10 l16 10 z" class="sig sig-l"/>
      <path d="M270 38 l16 10 l-16 10 z" class="sig sig-r"/>
      <path d="M212 34 l8 -12 l8 12 z" class="icon hazard"/>
      <g class="icon beam"><path d="M196 172 q-10 -8 0 -16 q8 0 8 8 q0 8 -8 8 z"/><path d="M208 160 h10 M208 164 h10 M208 168 h10"/></g>
      <g class="icon limiter"><circle cx="244" cy="164" r="8"/><text x="244" y="168">L</text></g>
      ${ev ? `<text x="330" y="100" class="ev-text">EV</text><text x="330" y="122" class="unit">READY</text>` : `<text x="330" y="160" class="unit">×1000 rpm</text>`}`;
    svg.appendChild(center);
    this.speedText = center.querySelector(".digital") as SVGTextElement;
    this.gearText = center.querySelector(".gear") as SVGTextElement;
    this.sigL = center.querySelector(".sig-l") as SVGElement;
    this.sigR = center.querySelector(".sig-r") as SVGElement;
    this.icons = { hazard: center.querySelector(".hazard") as SVGElement, beam: center.querySelector(".beam") as SVGElement, limit: center.querySelector(".limiter") as SVGElement };

    // 오른쪽 아래: 센터페시아 화면 (미니맵 + 다음 나들목 + 남은 거리)
    const screen = el("fascia", this.root);
    const top = el("fascia-top", screen);
    el("fascia-title", top, `<b>내비게이션</b>`);
    this.clockEl = el("fascia-clock", top);
    this.mini = document.createElement("canvas");
    this.mini.className = "minimap";
    screen.appendChild(this.mini);
    this.miniCtx = this.mini.getContext("2d")!;
    this.upcoming = el("upcoming", screen);
    const prog = el("progress", screen);
    this.progressText = el("progress-text", prog);
    const bar = el("progress-bar", prog, "<i></i>");
    this.progressBar = bar.firstElementChild as HTMLElement;

    this.toastEl = el("toast", this.root);
    this.hintEl = el(
      "start-hint",
      this.root,
      `<div><kbd>↑</kbd> 가속</div><div><kbd>↓</kbd> 브레이크</div><div><kbd>←</kbd><kbd>→</kbd> 핸들</div><div><kbd>Q</kbd><kbd>E</kbd> 방향지시등</div><div><kbd>C</kbd> 시점</div><div><kbd>F1</kbd> 조작법 전체</div>`,
    );
    el("hint", this.root, "F1 조작법 · Tab 화면 크기 · Esc 일시정지");

    // 남은 시간 표: 제한속도 기준
    const n = Math.ceil(road.length / 1000) + 1;
    this.etaTable = new Float32Array(n + 1);
    for (let k = n - 1; k >= 0; k--) {
      const s = Math.min(road.length, k * 1000 + 500);
      const v = Math.max(40, road.speedAt(s, opts.heavy)) / 3.6;
      this.etaTable[k] = this.etaTable[k + 1] + 1000 / (v * 0.97);
    }
    if (opts.net) {
      const [ox, oy] = opts.net.origin;
      for (const r of opts.net.roads) {
        const pts = new Float32Array(r.p.length);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let i = 0; i < r.p.length; i += 2) {
          pts[i] = r.p[i] * 10 + ox - road.e[0];
          pts[i + 1] = r.p[i + 1] * 10 + oy - road.nn[0];
          x0 = Math.min(x0, pts[i]);
          x1 = Math.max(x1, pts[i]);
          y0 = Math.min(y0, pts[i + 1]);
          y1 = Math.max(y1, pts[i + 1]);
        }
        this.netLines.push({ pts, box: [x0, y0, x1, y1] });
      }
    }
    new ResizeObserver(() => {
      const r = this.mini.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      this.mini.width = Math.max(1, Math.round(r.width * dpr));
      this.mini.height = Math.max(1, Math.round(r.height * dpr));
    }).observe(this.mini);
    window.addEventListener("keydown", (e) => {
      if (e.code === "Tab") {
        e.preventDefault();
        this.compact = !this.compact;
        this.root.classList.toggle("compact", this.compact);
      }
    });
  }

  toast(text: string, sec = 2.2) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    this.toastTimer = sec;
  }

  /** 다음 안내: 경로의 다음 조각으로 넘어가는 곳, 또는 목적지 */
  private maneuver(s: number): Maneuver | null {
    const road = this.road;
    if (road.isRoute) {
      for (let k = 0; k + 1 < road.legs.length; k++) {
        const a = road.legs[k];
        const b = road.legs[k + 1];
        if (a.s1 < s - 5) continue;
        if (a.s1 > this.opts.finishS) break;
        const dir = `${b.name.replace(/고속도로$/, "선")} ${b.to} 방향`;
        // 연결로가 실제로 꺾는 쪽 (연결로 앞뒤 도로 방향 차이)
        let dh = road.sample(Math.min(road.length, b.s0 + 60)).heading - road.sample(Math.max(0, a.s1 - 60)).heading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        const turn = dh > 0.35 ? "left" : dh < -0.35 ? "right" : "straight";
        const side = turn === "left" ? "왼쪽 " : turn === "right" ? "오른쪽 " : "";
        // 이름 없는 연결은 길이 그대로 이어진다
        if (!b.via) return { s: a.s1, kind: turn, text: `${b.name}(으)로 이어집니다 · ${b.to} 방향`, lanes: "all" };
        return {
          s: a.s1,
          kind: turn,
          text: `<b>${b.via}</b>에서 ${side}${dir}`,
          lanes: turn === "straight" ? "all" : turn,
          voice: { via: b.via, road: b.name, to: b.to },
        };
      }
    }
    return { s: this.opts.finishS, kind: "dest", text: `목적지 <b>${this.opts.destName}</b>`, lanes: "all" };
  }

  /** 한 번만 말할 안내 (말하지 못했으면 다음에 다시) */
  private sayOnce(key: string, text: string) {
    if (this.spoken.has(key) || !this.opts.say?.(text)) return;
    this.spoken.add(key);
  }

  /** 단속 안내: 1km 안의 고정식 카메라와 구간단속 시점, 구간단속 중에는 평균 속도 */
  private updateEnforcement(f: HudFrame, s: number, kmh: number) {
    const enf = this.opts.enforcement;
    const sec = f.section ?? null;
    let html = "";
    let cls = "";
    let icon = CAM_ICON;
    let warn = false;
    if (sec) {
      const over = sec.avgKmh > sec.limit;
      cls = over ? "section over" : "section";
      html = `<b>구간단속</b> 평균 <em>${sec.avgKmh > 0 ? Math.round(sec.avgKmh) : "--"}</em>km/h · 제한 ${sec.limit} · 남은 ${fmtDist(sec.remainM)}`;
      warn = over;
      if (!this.lastSection) this.opts.say?.(`구간 단속 구간입니다. 구간 길이 ${spokenDist(sec.lengthM)}, 제한속도 ${sec.limit}킬로미터입니다.`);
    } else if (this.lastSection) {
      this.opts.say?.(`구간 단속이 끝났습니다. 평균 속도 ${Math.round(this.lastSection.avgKmh)}킬로미터였습니다.`);
    }
    this.lastSection = sec;
    const work = (this.opts.workZones ?? []).find((z) => z.s1 > s && z.s0 - s < 2000);
    if (!sec && work && (!enf || !enf.fixed.some((c) => c.s > s && c.s < work.s0))) {
      const dist = work.s0 - s;
      const inLane = f.lane === work.lane;
      cls = inLane ? "work over" : "work";
      icon = CONE_ICON;
      html = dist > 0 ? `<b>공사 구간</b> ${work.lane}차로 차단 · ${fmtDist(dist)}` : `<b>공사 구간</b> ${work.lane}차로 차단 · 남은 ${fmtDist(work.s1 - s)}`;
      if (dist <= 1000 && dist > 0) this.sayOnce(`work|${Math.round(work.s0)}`, `${spokenDist(dist)} 앞 공사 구간입니다. ${work.lane}차로가 막혀 있습니다.`);
      if (dist <= 300 && dist > 0 && inLane) this.sayOnce(`work-near|${Math.round(work.s0)}`, "잠시 후 차로가 막힙니다. 옆 차로로 옮기세요.");
      warn = inLane && dist < 300;
    } else if (!sec && enf) {
      const cam = enf.fixed.find((c) => c.s > s - 5 && c.s - s < 1000);
      const start = enf.sections.find((x) => x.s0 > s && x.s0 - s < 1000);
      if (cam && (!start || cam.s < start.s0)) {
        const camLimit = cam.limit || this.road.speedAt(cam.s, this.opts.heavy);
        const dist = cam.s - s;
        cls = kmh > camLimit ? "over" : "";
        html = `<b>과속 단속</b> 제한 ${camLimit} · ${fmtDist(dist)}`;
        warn = kmh > camLimit && dist < 400;
        if (dist <= 600) this.sayOnce(`cam|${Math.round(cam.s)}`, `전방에 과속 단속 카메라가 있습니다. 제한속도 ${camLimit}킬로미터입니다.`);
      } else if (start) {
        html = `<b>구간단속 시작</b> ${fmtDist(start.s0 - s)}`;
        this.sayOnce(`sec|${Math.round(start.s0)}`, `${spokenDist(start.s0 - s)} 앞 구간 단속 시작 지점입니다.`);
      }
    }
    this.enfEl.className = `enf${html ? " on" : ""}${cls ? ` ${cls}` : ""}`;
    if (html) this.enfEl.innerHTML = icon + `<span>${html}</span>`;
    this.chimeTimer -= 0.2;
    if (warn && this.chimeTimer <= 0) {
      this.opts.chime?.();
      this.chimeTimer = 1.6;
    }
  }

  /** 안내 지점을 지날 때 한 번씩 말한다. 처음 볼 때 이미 가까우면 가장 가까운 안내만 */
  private announce(m: Maneuver, dist: number) {
    const say = this.opts.say;
    if (!say || dist < 0) return;
    if (m.kind !== "dest" && !m.voice) return;
    const at = m.kind === "dest" ? VOICE_AT.dest : VOICE_AT.turn;
    const hit = at.filter((d) => dist <= d);
    if (!hit.length) return;
    const nearest = hit[hit.length - 1];
    const key = (d: number) => `${Math.round(m.s)}|${d}`;
    if (this.spoken.has(key(nearest))) return;
    if (!say(m.kind === "dest" ? destPhrase(dist) : turnPhrase(dist, m.kind, m.voice!))) return;
    for (const d of hit) this.spoken.add(key(d));
  }

  update(f: HudFrame, dt: number) {
    const road = this.road;
    const s = f.s;
    // 매 프레임: 계기판·페달
    const kmh = Math.abs(f.kmh);
    this.setSpeed(kmh);
    this.setRpm(f.rpm / 1000);
    this.speedText.textContent = String(Math.round(kmh));
    this.gearText.textContent = f.gear;
    const blink = Math.floor(f.time * 1.6) % 2 === 0;
    this.sigL.classList.toggle("on", (f.signal === -1 || f.hazard) && blink);
    this.sigR.classList.toggle("on", (f.signal === 1 || f.hazard) && blink);
    this.icons.hazard.classList.toggle("on", f.hazard);
    this.icons.beam.classList.toggle("on", f.night);
    this.pedalT.style.transform = `scaleY(${f.throttle.toFixed(3)})`;
    this.pedalB.style.transform = `scaleY(${f.brake.toFixed(3)})`;
    this.wheel.style.transform = `rotate(${(f.steer * 200).toFixed(1)}deg)`;
    this.steerBar.style.transform = `translateX(${(f.steer * 50).toFixed(1)}%)`;
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove("show");
    }
    if (this.hintTime > 0) {
      this.hintTime -= dt;
      if (this.hintTime <= 0) this.hintEl.classList.add("hide");
    }

    this.miniTimer -= dt;
    if (this.miniTimer <= 0) {
      this.miniTimer = 1 / 30;
      this.drawMini(f);
    }

    // 나머지는 0.2초마다
    this.slowTimer -= dt;
    if (this.slowTimer > 0) return;
    this.slowTimer = 0.2;
    const zl = zoneLimit(this.opts.workZones ?? [], s);
    const limit = zl ? Math.min(zl, road.speedAt(s, this.opts.heavy)) : road.speedAt(s, this.opts.heavy);
    this.limit.textContent = String(limit);
    // 제한속도가 바뀌면 알린다 (속도가 굽기에 따라 바뀌는 연결로는 빼고)
    if (this.lastLimit && limit !== this.lastLimit && !road.onConnector(s)) this.opts.say?.(`제한속도 ${limit}킬로미터 구간입니다.`);
    if (!road.onConnector(s)) this.lastLimit = limit;
    this.updateEnforcement(f, s, kmh);
    this.limit.classList.toggle("over", kmh > limit + 10);
    this.icons.limit.classList.toggle("on", false);
    this.title.innerHTML = `<span class="shield">${road.refAt(s)}</span>${road.sectionNameAt(s)}`;
    const st = road.structures.find((x) => s >= x.s0 && s < x.s1);
    const where = st ? ` · ${st.kind === Structure.Tunnel ? "터널" : "교량"}${st.name ? ` ${st.name}` : ""}` : "";
    const leg = road.legAt(s);
    const src = road.sourceAt(s);
    this.meta.textContent = road.onConnector(s) ? `연결로${where}` : `${leg.to} 방향 · ${(src.s / 1000).toFixed(1)}km${where}`;
    this.limitNote.textContent = this.opts.heavy ? "화물차 제한속도" : "";

    // 내비 안내
    const m = this.maneuver(s);
    if (m) {
      const dist = m.s - s;
      const near = dist < 3000;
      this.nav.classList.toggle("near", near);
      this.nav.classList.toggle("dest", m.kind === "dest");
      const showFar = m.kind === "dest" && !near && dist >= 20000;
      this.navArrow.className = `nav-arrow ${showFar ? "up" : m.kind === "dest" ? "flag" : near && m.kind !== "straight" ? m.kind : "up"}`;
      if (!showFar) {
        this.navDist.textContent = fmtDist(dist);
        this.navText.innerHTML = m.text;
      } else {
        const j = road.nextJunction(s);
        this.navDist.textContent = j ? fmtDist(j.s - s) : "";
        this.navText.innerHTML = road.onConnector(s)
          ? `${leg.name} 합류 · ${leg.to} 방향`
          : `${road.sectionNameAt(s)} 따라 ${leg.to} 방향${j ? ` · 다음 <b>${j.name}</b>` : ""}`;
      }
      // 차로 안내: 분기점 2km 앞부터 꺾는 쪽 두 차로 (왼쪽은 1차로(앞지르기 차로)를 빼고)
      const lanes = road.lanesAt(s);
      const bus = this.busZones.filter((z) => s >= z.s0 && s <= z.s1).map((z) => z.lane);
      const guide = near && dist < 2000 && m.lanes !== "all" ? m.lanes : "";
      // 공사로 막힌 차로 (1.5km 앞부터)
      const work = (this.opts.workZones ?? []).find((z) => s > z.s0 - 1500 && s < z.s1);
      const key = `${lanes}|${f.lane}|${guide}|${bus.join(",")}|${work?.lane ?? 0}`;
      if (key !== this.lastLanesKey) {
        this.lastLanesKey = key;
        let html = "";
        for (let l = 1; l <= lanes; l++) {
          const rec = guide === "right" ? l > lanes - 2 : guide === "left" ? l >= Math.min(2, lanes) && l <= Math.min(3, lanes) : false;
          const closed = work?.lane === l;
          html += `<i class="${l === f.lane ? "me" : ""}${rec && !closed ? " rec" : ""}${bus.includes(l) ? " bus" : ""}${closed ? " closed" : ""}">${closed ? "✕" : rec ? (guide === "right" ? "↗" : "↖") : "↑"}</i>`;
        }
        this.navLanes.innerHTML = html;
      }
    }

    if (m) this.announce(m, m.s - s);

    // 다음 나들목 셋
    const next = road.junctions.filter((j) => j.s > s && j.s < this.opts.finishS && j.kind !== "기타").slice(0, 3);
    this.upcoming.innerHTML = next.map((j) => `<div class="${j.kind}"><span>${j.name}</span><b>${fmtDist(j.s - s)}</b></div>`).join("") || `<div><span>${this.opts.destName}</span><b>${fmtDist(this.opts.finishS - s)}</b></div>`;

    // 남은 거리·도착 예정
    const remain = Math.max(0, this.opts.finishS - s);
    const k = Math.min(this.etaTable.length - 2, Math.floor(s / 1000));
    const kEnd = Math.min(this.etaTable.length - 2, Math.floor(this.opts.finishS / 1000));
    const etaSec = Math.max(0, this.etaTable[k] - this.etaTable[kEnd]);
    this.progressText.innerHTML = `<span>${this.opts.destName}까지 <b>${fmtDist(remain)}</b></span><span>도착 <b>${clock(this.opts.hour, f.time + etaSec)}</b></span>`;
    const total = Math.max(1, this.opts.finishS - this.opts.startS);
    this.progressBar.style.width = `${Math.min(100, Math.max(0, ((s - this.opts.startS) / total) * 100)).toFixed(1)}%`;
    this.clockEl.textContent = clock(this.opts.hour, f.time);

    const mm = Math.floor(f.time / 60);
    const ss = Math.floor(f.time % 60);
    this.status.innerHTML = `<span class="rec">●</span> ${f.recStatus}<br>${Math.floor(mm / 60) ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}` : mm}:${String(ss).padStart(2, "0")} · ${f.camera} · ${f.inputMode}`;
  }

  /** 미니맵: 진행 방향이 위, 내 차는 아래쪽 가운데 */
  private drawMini(f: HudFrame) {
    const c = this.mini;
    const g = this.miniCtx;
    const W = c.width;
    const H = c.height;
    if (W < 4 || H < 4) return;
    const road = this.road;
    const p = road.sample(f.s);
    const e0 = p.e + f.d * p.tn - road.e[0];
    const n0 = p.n - f.d * p.te - road.nn[0];
    const heading = p.heading + f.theta;
    // 빠를수록 멀리 보이게
    const range = 700 + Math.min(1, Math.abs(f.kmh) / 110) * 900; // 화면 높이에 해당하는 m
    const scale = H / range;
    const cx = W / 2;
    const cy = H * 0.72;
    const rot = Math.PI / 2 - heading;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const tx = (x: number, y: number): [number, number] => {
      const dx = x - e0;
      const dy = y - n0;
      return [cx + (dx * cos - dy * sin) * scale, cy - (dx * sin + dy * cos) * scale];
    };
    g.fillStyle = "#0d1417";
    g.fillRect(0, 0, W, H);
    g.lineCap = "round";
    g.lineJoin = "round";
    const R = range * 1.3;
    // 주변 고속도로
    g.strokeStyle = "rgba(140,165,160,0.35)";
    g.lineWidth = Math.max(2, 5 * scale * 2);
    g.beginPath();
    for (const l of this.netLines) {
      const [x0, y0, x1, y1] = l.box;
      if (x1 < e0 - R || x0 > e0 + R || y1 < n0 - R || y0 > n0 + R) continue;
      let first = true;
      for (let i = 0; i < l.pts.length; i += 2) {
        const [sx, sy] = tx(l.pts[i], l.pts[i + 1]);
        if (first) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
        first = false;
      }
    }
    g.stroke();
    // 경로: 지나온 길은 흐리게, 갈 길은 밝게
    const step = road.step;
    const i0 = Math.max(0, Math.floor((f.s - R) / step));
    const iNow = Math.floor(f.s / step);
    const i1 = Math.min(road.n - 1, Math.min(Math.floor(this.opts.finishS / step), Math.ceil((f.s + R) / step)));
    const stride = 3;
    const line = (a: number, b: number, color: string, w: number) => {
      if (b <= a) return;
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      for (let i = a; i <= b; i += stride) {
        const [sx, sy] = tx(road.e[i] - road.e[0], road.nn[i] - road.nn[0]);
        if (i === a) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
      }
      const [ex, ey] = tx(road.e[b] - road.e[0], road.nn[b] - road.nn[0]);
      g.lineTo(ex, ey);
      g.stroke();
    };
    const dpr = W / Math.max(1, c.clientWidth);
    line(i0, iNow, "rgba(120,140,150,0.8)", 6 * dpr);
    line(iNow, i1, "#2f8cff", 7 * dpr);
    line(iNow, i1, "#8cc4ff", 2 * dpr);
    // 목적지 깃발
    if (this.opts.finishS - f.s < R) {
      const k = Math.min(road.n - 1, Math.floor(this.opts.finishS / step));
      const [sx, sy] = tx(road.e[k] - road.e[0], road.nn[k] - road.nn[0]);
      g.fillStyle = "#ff5a4e";
      g.beginPath();
      g.arc(sx, sy, 6 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    // 분기점 표시
    g.font = `${11 * dpr}px Pretendard, 'Malgun Gothic', sans-serif`;
    g.textAlign = "left";
    for (const j of road.junctions) {
      if (j.s < f.s - 100 || j.s > f.s + R || (j.kind !== "JC" && j.kind !== "IC")) continue;
      const [sx, sy] = tx(road.e[road.index(j.s)] - road.e[0], road.nn[road.index(j.s)] - road.nn[0]);
      if (sy < 10 * dpr) continue;
      g.fillStyle = j.kind === "JC" ? "#ffd166" : "#cfd8d4";
      g.beginPath();
      g.arc(sx, sy, 3 * dpr, 0, Math.PI * 2);
      g.fill();
      g.fillText(j.name, sx + 6 * dpr, sy + 4 * dpr);
    }
    // 내 차
    g.save();
    g.translate(cx, cy);
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#2f8cff";
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(0, -11 * dpr);
    g.lineTo(8 * dpr, 9 * dpr);
    g.lineTo(0, 4 * dpr);
    g.lineTo(-8 * dpr, 9 * dpr);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  set visible(v: boolean) {
    this.root.style.display = v ? "" : "none";
  }
}
