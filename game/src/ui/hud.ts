// 주행 중 화면: 계기판(속도·rpm·기어·방향지시등), 페달·핸들 표시, 내비(다음 분기점 안내·차로 안내·미니맵·남은 거리),
// 제한속도 표지, 노선·위치. 법규 판정 결과는 주행 중에 보여주지 않는다 (알려 주면 평소 운전 습관이 기록되지 않는다).

import type { Road } from "../road/road";
import { Structure } from "../road/road";
import type { Network } from "../road/route";
import type { Enforcement } from "../sim/cameras";
import type { BusLaneZone } from "../sim/traffic";
import { zoneLimit, type WorkZone } from "../sim/workzones";
import { nextIceWarning } from "../sim/ice";
import { incidentBlockS, type Incident } from "../sim/incidents";
import { ICON, LANE_ARROW, NAV_ARROW } from "./icons";
import { FONT_UI, PAL } from "./palette";

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
  /** 돌발상황 (고장·사고로 선 차). 실제 내비처럼 1km 앞에서 알린다 */
  incidents?: Incident[];
  /** 새벽 결빙: 긴 다리 앞마다 결빙주의 안내 (실제 도로의 결빙주의 표지·전광판처럼, 얼었는지와 상관없이) */
  iceWarn?: boolean;
  /** 악천후 감속: 날씨 이름과 법정 감속 배율 (weather.legalFactor) */
  weather?: { label: string; factorAt: (s: number) => number };
}

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

function distParts(m: number): [string, string] {
  if (m < 1000) return [String(Math.max(0, Math.round(m / 10) * 10)), "m"];
  return [(m / 1000).toFixed(m < 10000 ? 1 : 0), "km"];
}

/** 거리: 숫자는 크게, 단위는 작게 */
function distHtml(m: number): string {
  const [n, u] = distParts(m);
  return `${n}<small>${u}</small>`;
}

/** 알림 줄 안의 거리 */
function distEm(m: number): string {
  const [n, u] = distParts(m);
  return `<em>${n}</em>${u}`;
}

const KIND_BADGE: Record<string, string> = { IC: "IC", JC: "JC", TG: "요금소", SA: "휴게소" };

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

interface Dial {
  set: (v: number) => void;
  /** 바깥 테두리에 작은 표시 (제한속도) */
  mark: (v: number | null) => void;
}

/** 바늘 계기 하나: 테두리·눈금·숫자·바늘 */
function dial(svg: SVGSVGElement, cx: number, cy: number, r: number, max: number, major: number, minor: number, label: (v: number) => string, cap: string, red?: number): Dial {
  const A0 = -135;
  const A1 = 135;
  const ang = (v: number) => A0 + ((A1 - A0) * Math.min(max, Math.max(0, v))) / max;
  const pt = (a: number, rr: number) => [(cx + rr * Math.sin((a * Math.PI) / 180)).toFixed(1), (cy - rr * Math.cos((a * Math.PI) / 180)).toFixed(1)];
  let html = `<path d="${arc(cx, cy, r + 7, A0, A1)}" class="dial-bezel"/><path d="${arc(cx, cy, r, A0, A1)}" class="dial-track"/>`;
  if (red !== undefined) html += `<path d="${arc(cx, cy, r - 2.5, ang(red), A1)}" class="dial-red"/>`;
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = ang(v);
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const [x0, y0] = pt(a, r - (isMajor ? 11 : 6));
    const [x1, y1] = pt(a, r - 1);
    html += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="${isMajor ? "tick-major" : "tick"}"/>`;
    if (isMajor) {
      const [lx, ly] = pt(a, r - 23);
      html += `<text x="${lx}" y="${(Number(ly) + 4.5).toFixed(1)}" class="dial-num">${label(v)}</text>`;
    }
  }
  html += `<text x="${cx}" y="${(cy + r * 0.62).toFixed(1)}" class="dial-cap">${cap}</text>`;
  html += `<path d="" class="dial-fill"/><path d="M0 0" class="dial-mark"/>`;
  // 끝이 가는 바늘
  html += `<g class="needle"><path d="M${cx - 2.6} ${cy + 15} L${cx - 0.9} ${cy - r + 9} L${cx + 0.9} ${cy - r + 9} L${cx + 2.6} ${cy + 15} Z"/><circle cx="${cx}" cy="${cy}" r="7.5" class="hub"/></g>`;
  const g = document.createElementNS(NS, "g");
  g.innerHTML = html;
  svg.appendChild(g);
  const needle = g.querySelector(".needle") as SVGGElement;
  const fill = g.querySelector(".dial-fill") as SVGPathElement;
  const markEl = g.querySelector(".dial-mark") as SVGPathElement;
  let lastA = NaN;
  return {
    set: (v: number) => {
      const a = Math.round(ang(v) * 4) / 4;
      if (a === lastA) return;
      lastA = a;
      needle.setAttribute("transform", `rotate(${a} ${cx} ${cy})`);
      fill.setAttribute("d", a > A0 + 0.5 ? arc(cx, cy, r - 2, A0, a) : "");
    },
    mark: (v: number | null) => {
      if (v === null) return markEl.setAttribute("d", "M0 0");
      const a = ang(v);
      const [tx, ty] = pt(a, r + 3);
      const [lx, ly] = pt(a - 3.2, r + 10);
      const [rx, ry] = pt(a + 3.2, r + 10);
      markEl.setAttribute("d", `M${tx} ${ty}L${lx} ${ly}L${rx} ${ry}Z`);
    },
  };
}

export class Hud {
  readonly root: HTMLDivElement;
  private speedDial: Dial;
  private rpmDial: Dial;
  private speedText: SVGTextElement;
  private prnd: { letters: Record<string, SVGTextElement>; gearN: SVGTextElement; mark: SVGRectElement };
  private sigL: SVGElement;
  private sigR: SVGElement;
  private icons: { hazard: SVGElement; beam: SVGElement };
  private tripText: SVGTextElement;
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
  private lastArrow = "";
  private lastGear = "";
  private lastSpeed = -1;
  private lastPosted = 0;
  private spoken = new Set<string>();
  private lastLimit = 0;
  private enfEl: HTMLDivElement;
  private lastSection: { avgKmh: number } | null = null;
  private chimeTimer = 0;
  private iceSaidS = -1e9;
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
    this.limit.setAttribute("aria-label", "제한속도");
    const info = el("roadinfo", sign);
    this.title = el("t", info);
    this.meta = el("m", info);
    this.limitNote = el("ln", info);
    this.enfEl = el("enf", this.root);
    this.enfEl.setAttribute("role", "status");

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
    this.wheel = el(
      "wheel",
      ctl,
      `<svg viewBox="-50 -50 100 100"><circle r="42" class="rim"/><path d="M-39.5 -14.5A42 42 0 0 1 -14.5 -39.5M14.5 -39.5A42 42 0 0 1 39.5 -14.5" class="grip"/><path d="M-40 -2 L-12 -2 L-8 10 L8 10 L12 -2 L40 -2" class="spoke"/><path d="M0 10 L0 40" class="spoke"/><circle r="11" class="hub"/><rect x="-3" y="-47" width="6" height="9" rx="1.5" class="mark"/></svg>`,
    );
    const pedals = el("pedals", ctl);
    const mk = (cls: string, label: string, key: string) => {
      const p = el(`pedal ${cls}`, pedals, `<div class="bar"><i></i></div><b>${label}</b><kbd>${key}</kbd>`);
      return p.querySelector("i") as HTMLElement;
    };
    this.pedalB = mk("brake", "브레이크", "↓");
    this.pedalT = mk("throttle", "가속", "↑");
    const steerRow = el("steer-row", ctl, `<kbd>←</kbd><div class="steer-track"><i></i></div><kbd>→</kbd>`);
    this.steerBar = steerRow.querySelector("i") as HTMLElement;

    // 가운데 아래: 계기판 (왼쪽 속도계, 가운데 숫자 속도·기어·표시등, 오른쪽 회전계)
    const cluster = el("cluster", this.root);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 480 196");
    cluster.appendChild(svg);
    const maxKmh = opts.maxKmh;
    const major = maxKmh > 200 ? 40 : 20;
    this.speedDial = dial(svg, 116, 106, 86, maxKmh, major, major / 4, (v) => String(v), "km/h");
    const rpmMax = Math.ceil(opts.redline / 1000 + 0.5) * 1000;
    const ev = opts.idleRpm === 0;
    this.rpmDial = ev ? { set: () => {}, mark: () => {} } : dial(svg, 364, 106, 72, rpmMax / 1000, 1, 0.5, (v) => String(v), "×1000 r/min", opts.redline / 1000);
    const center = document.createElementNS(NS, "g");
    // 방향지시등: 두꺼운 화살표 (ISO 2575 녹색)
    const sig = (x: number, dir: -1 | 1) => {
      const p = (dx: number, dy: number) => `${x + dir * dx} ${34 + dy}`;
      return `M${p(-11, 0)}L${p(-1, -9)}L${p(-1, -4)}L${p(10, -4)}L${p(10, 4)}L${p(-1, 4)}L${p(-1, 9)}Z`;
    };
    const px = { P: 216, R: 232, N: 248, D: 264 };
    center.innerHTML = `
      <path d="${sig(206, 1)}" class="tt tt-sig sig-l"/>
      <path d="${sig(274, -1)}" class="tt tt-sig sig-r"/>
      <path d="M240 21 251 40H229ZM240 28.5 245 37H235Z" class="tt tt-hazard hazard"/>
      <text x="240" y="98" class="digital">0</text>
      <text x="240" y="116" class="unit">km/h</text>
      <g class="prnd">
        <rect x="${px.D - 8}" y="130" width="16" height="21" rx="3" class="prnd-mark"/>
        ${Object.entries(px)
          .map(([k, x]) => `<text x="${x}" y="146" data-g="${k}">${k}</text>`)
          .join("")}
        <text x="${px.D + 9}" y="146" class="gear-n"></text>
      </g>
      <g class="tt tt-beam beam"><path d="M242 162h2.5a7 7 0 0 1 0 14H242Z"/><path d="M237.5 164.5l-8 1.8M237.5 169l-8 1.8M237.5 173.5l-8 1.8"/></g>
      <text x="116" y="${(106 + 86 * 0.62 + 17).toFixed(0)}" class="trip">TRIP 0.0 km</text>
      ${ev ? `<text x="364" y="104" class="ev-text">EV</text><text x="364" y="124" class="unit">READY</text>` : ""}`;
    svg.appendChild(center);
    this.speedText = center.querySelector(".digital") as SVGTextElement;
    this.tripText = center.querySelector(".trip") as SVGTextElement;
    const letters: Record<string, SVGTextElement> = {};
    center.querySelectorAll<SVGTextElement>("[data-g]").forEach((t) => (letters[t.dataset.g!] = t));
    this.prnd = { letters, gearN: center.querySelector(".gear-n") as SVGTextElement, mark: center.querySelector(".prnd-mark") as SVGRectElement };
    this.sigL = center.querySelector(".sig-l") as SVGElement;
    this.sigR = center.querySelector(".sig-r") as SVGElement;
    this.icons = { hazard: center.querySelector(".hazard") as SVGElement, beam: center.querySelector(".beam") as SVGElement };

    // 오른쪽 아래: 센터페시아 화면 (미니맵 + 다음 나들목 + 남은 거리)
    const screen = el("fascia", this.root);
    const top = el("fascia-top", screen);
    el("fascia-title", top, `${ICON.map}<b>내비게이션</b>`);
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
    this.toastEl.setAttribute("role", "status");
    this.hintEl = el(
      "start-hint",
      this.root,
      `<div><kbd>↑</kbd> 가속</div><div><kbd>↓</kbd> 브레이크</div><div><kbd>←</kbd><kbd>→</kbd> 핸들</div><div><kbd>Q</kbd><kbd>E</kbd> 방향지시등</div><div><kbd>C</kbd> 시점</div><div><kbd>F1</kbd> 조작법 전체</div>`,
    );
    el("hint", this.root, "<kbd>F1</kbd> 조작법 <kbd>Tab</kbd> 화면 크기 <kbd>Esc</kbd> 일시정지");

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
    let icon = ICON.camera;
    let warn = false;
    if (sec) {
      const over = sec.avgKmh > sec.limit;
      cls = over ? "section over" : "section";
      html = `<b>구간단속</b> 평균 <em>${sec.avgKmh > 0 ? Math.round(sec.avgKmh) : "--"}</em>km/h · 제한 ${sec.limit} · 남은 ${distEm(sec.remainM)}`;
      warn = over;
      if (!this.lastSection) this.opts.say?.(`구간 단속 구간입니다. 구간 길이 ${spokenDist(sec.lengthM)}, 제한속도 ${sec.limit}킬로미터입니다.`);
    } else if (this.lastSection) {
      this.opts.say?.(`구간 단속이 끝났습니다. 평균 속도 ${Math.round(this.lastSection.avgKmh)}킬로미터였습니다.`);
    }
    this.lastSection = sec;
    const work = (this.opts.workZones ?? []).find((z) => z.s1 > s && z.s0 - s < 2000);
    let ice: ReturnType<typeof nextIceWarning> = null;
    // 돌발상황이 1km 안이면 다른 안내보다 먼저
    const inc = (this.opts.incidents ?? []).find((i) => i.s + 20 > s && incidentBlockS(i) - s < 1000);
    if (inc) {
      const dist = Math.max(0, incidentBlockS(inc) - s);
      const inLane = inc.lane > 0 && f.lane === inc.lane;
      cls = inLane ? "incident over" : "incident";
      icon = ICON.warn;
      html = `<b>${inc.kind === "crash" ? "사고 차량" : "고장 차량"}</b> ${inc.lane === 0 ? "갓길" : `${inc.lane}차로`} · ${dist > 0 ? distEm(dist) : "옆"}`;
      const where = inc.lane === 0 ? "갓길에" : `${inc.lane}차로에`;
      if (dist > 50) this.sayOnce(`inc|${Math.round(inc.s)}`, `${spokenDist(dist)} 앞 ${where} ${inc.kind === "crash" ? "사고 차량" : "고장 차량"}이 서 있습니다. 주의하세요.`);
      if (dist <= 300 && dist > 0 && inLane) this.sayOnce(`inc-near|${Math.round(inc.s)}`, "앞에 멈춘 차가 있습니다. 옆 차로로 옮기세요.");
      warn = inLane && dist < 300;
    } else if (!sec && this.opts.iceWarn && (ice = nextIceWarning(this.road, s, 500))) {
      const dist = Math.max(0, ice.s0 - s);
      cls = "ice";
      icon = ICON.flake;
      html = `<b>결빙 주의</b> ${ice.name || "교량"} · ${dist > 0 ? distEm(dist) : "통과 중"}`;
      // 말로는 8km에 한 번만 (긴 다리는 몇 km마다 나온다)
      if (dist > 100 && s - this.iceSaidS > 8000) {
        this.iceSaidS = s;
        this.opts.say?.(`전방 ${ice.name || "교량"} 결빙 주의 구간입니다. 다리 위는 먼저 얼어 있을 수 있습니다.`);
      }
    } else if (!sec && work && (!enf || !enf.fixed.some((c) => c.s > s && c.s < work.s0))) {
      const dist = work.s0 - s;
      const inLane = f.lane === work.lane;
      cls = inLane ? "work over" : "work";
      icon = ICON.cone;
      html = dist > 0 ? `<b>공사 구간</b> ${work.lane}차로 차단 · ${distEm(dist)}` : `<b>공사 구간</b> ${work.lane}차로 차단 · 남은 ${distEm(work.s1 - s)}`;
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
        html = `<b>과속 단속</b> 제한 ${camLimit} · ${distEm(dist)}`;
        warn = kmh > camLimit && dist < 400;
        if (dist <= 600) this.sayOnce(`cam|${Math.round(cam.s)}`, `전방에 과속 단속 카메라가 있습니다. 제한속도 ${camLimit}킬로미터입니다.`);
      } else if (start) {
        html = `<b>구간단속 시작</b> ${distEm(start.s0 - s)}`;
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
    // 매 프레임: 계기판·페달 (바뀐 것만 DOM에 쓴다)
    const kmh = Math.abs(f.kmh);
    this.speedDial.set(kmh);
    this.rpmDial.set(f.rpm / 1000);
    const shown = Math.round(kmh);
    if (shown !== this.lastSpeed) {
      this.lastSpeed = shown;
      this.speedText.textContent = String(shown);
    }
    if (f.gear !== this.lastGear) this.setGear(f.gear);
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
    const posted = zl ? Math.min(zl, road.speedAt(s, this.opts.heavy)) : road.speedAt(s, this.opts.heavy);
    // 표지판은 적힌 속도, 과속 경고는 악천후 감속까지 넣은 속도로
    const wf = this.opts.weather?.factorAt(s) ?? 1;
    const limit = Math.round(posted * wf);
    if (posted !== this.lastPosted) {
      this.lastPosted = posted;
      this.limit.textContent = String(posted);
      // 속도계 테두리에도 제한속도 표시 (내비 연동 계기판처럼)
      this.speedDial.mark(posted);
    }
    // 제한속도가 바뀌면 알린다 (속도가 굽기에 따라 바뀌는 연결로는 빼고)
    if (this.lastLimit && posted !== this.lastLimit && !road.onConnector(s)) this.opts.say?.(`제한속도 ${posted}킬로미터 구간입니다.`);
    if (!road.onConnector(s)) this.lastLimit = posted;
    this.updateEnforcement(f, s, kmh);
    this.limit.classList.toggle("over", kmh > limit + 10);
    this.title.innerHTML = `<span class="shield">${road.refAt(s)}</span>${road.sectionNameAt(s)}`;
    const st = road.structures.find((x) => s >= x.s0 && s < x.s1);
    const where = st ? ` · ${st.kind === Structure.Tunnel ? "터널" : "교량"}${st.name ? ` ${st.name}` : ""}` : "";
    const leg = road.legAt(s);
    const src = road.sourceAt(s);
    this.meta.textContent = road.onConnector(s) ? `연결로${where}` : `${leg.to} 방향 · ${(src.s / 1000).toFixed(1)}km${where}`;
    const notes: string[] = [];
    if (this.opts.heavy) notes.push("화물차 제한속도");
    if (wf < 1) notes.push(`${this.opts.weather!.label} · ${Math.round((1 - wf) * 100)}% 감속 ${limit}km/h`);
    this.limitNote.textContent = notes.join(" · ");
    this.tripText.textContent = `TRIP ${(Math.max(0, s - this.opts.startS) / 1000).toFixed(1)} km`;

    // 내비 안내
    const m = this.maneuver(s);
    if (m) {
      const dist = m.s - s;
      const near = dist < 3000;
      this.nav.classList.toggle("near", near);
      this.nav.classList.toggle("dest", m.kind === "dest");
      const showFar = m.kind === "dest" && !near && dist >= 20000;
      const arrow = showFar ? "up" : m.kind === "dest" ? "flag" : near && m.kind !== "straight" ? m.kind : "up";
      if (arrow !== this.lastArrow) {
        this.lastArrow = arrow;
        this.navArrow.innerHTML = NAV_ARROW[arrow];
      }
      if (!showFar) {
        this.navDist.innerHTML = `<b>${distHtml(dist)}</b>`;
        this.navText.innerHTML = m.text;
      } else {
        const j = road.nextJunction(s);
        this.navDist.innerHTML = j ? `<b>${distHtml(j.s - s)}</b>` : "";
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
      // 선 차가 막은 차로 (1km 앞부터)
      const inc = (this.opts.incidents ?? []).find((i) => i.lane > 0 && s > incidentBlockS(i) - 1000 && s < i.s + 10);
      const shut = [work?.lane ?? 0, inc?.lane ?? 0];
      const key = `${lanes}|${f.lane}|${guide}|${bus.join(",")}|${shut.join(",")}`;
      if (key !== this.lastLanesKey) {
        this.lastLanesKey = key;
        let html = "";
        for (let l = 1; l <= lanes; l++) {
          const rec = guide === "right" ? l > lanes - 2 : guide === "left" ? l >= Math.min(2, lanes) && l <= Math.min(3, lanes) : false;
          const closed = shut.includes(l);
          const icon = closed ? LANE_ARROW.closed : rec ? LANE_ARROW[guide as "left" | "right"] : LANE_ARROW.up;
          html += `<i class="${l === f.lane ? "me" : ""}${rec && !closed ? " rec" : ""}${bus.includes(l) ? " bus" : ""}${closed ? " closed" : ""}">${icon}</i>`;
        }
        this.navLanes.innerHTML = html;
      }
    }

    if (m) this.announce(m, m.s - s);

    // 다음 나들목 셋
    const next = road.junctions.filter((j) => j.s > s && j.s < this.opts.finishS && j.kind !== "기타").slice(0, 3);
    const row = (kind: string, badge: string, name: string, d: number) => `<div class="${kind}"><i>${badge}</i><span>${name}</span><b>${distHtml(d)}</b></div>`;
    this.upcoming.innerHTML =
      next.map((j) => row(j.kind, KIND_BADGE[j.kind] ?? j.kind, j.kind === "IC" || j.kind === "JC" || j.kind === "TG" ? j.name.replace(new RegExp(`${j.kind}$`), "") : j.name, j.s - s)).join("") ||
      row("dest", "도착", this.opts.destName, this.opts.finishS - s);

    // 남은 거리·도착 예정
    const remain = Math.max(0, this.opts.finishS - s);
    const k = Math.min(this.etaTable.length - 2, Math.floor(s / 1000));
    const kEnd = Math.min(this.etaTable.length - 2, Math.floor(this.opts.finishS / 1000));
    const etaSec = Math.max(0, this.etaTable[k] - this.etaTable[kEnd]);
    this.progressText.innerHTML = `<span>${this.opts.destName}까지<b>${distHtml(remain)}</b></span><span>도착 예정<b>${clock(this.opts.hour, f.time + etaSec)}</b></span>`;
    const total = Math.max(1, this.opts.finishS - this.opts.startS);
    this.progressBar.style.transform = `scaleX(${Math.min(1, Math.max(0, (s - this.opts.startS) / total)).toFixed(4)})`;
    this.clockEl.textContent = clock(this.opts.hour, f.time);

    const mm = Math.floor(f.time / 60);
    const ss = Math.floor(f.time % 60);
    const elapsed = `${Math.floor(mm / 60) ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}` : mm}:${String(ss).padStart(2, "0")}`;
    this.status.innerHTML = `<span><i class="rec"></i>${f.recStatus}</span><span class="st-meta">${elapsed} · ${f.camera} · ${f.inputMode}</span>`;
  }

  /** 기어 표시: P R N D 가운데 지금 칸에 테두리, D면 단수 */
  private setGear(gear: string) {
    this.lastGear = gear;
    const g = gear.startsWith("R") ? "R" : gear.startsWith("N") ? "N" : gear.startsWith("P") ? "P" : "D";
    const { letters, gearN, mark } = this.prnd;
    for (const [k, t] of Object.entries(letters)) t.classList.toggle("on", k === g);
    const n = g === "D" ? gear.slice(1) : "";
    gearN.textContent = n;
    const x = Number(letters[g].getAttribute("x"));
    mark.setAttribute("x", String(x - 8));
    mark.setAttribute("width", String(n ? 24 : 16));
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
    g.fillStyle = PAL.land;
    g.fillRect(0, 0, W, H);
    g.lineCap = "round";
    g.lineJoin = "round";
    const R = range * 1.3;
    // 주변 고속도로
    g.strokeStyle = PAL.road;
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
    line(i0, iNow, PAL.road, 5 * dpr);
    line(iNow, i1, PAL.routeCasing, 8 * dpr);
    line(iNow, i1, PAL.route, 4 * dpr);
    // 목적지 깃발
    if (this.opts.finishS - f.s < R) {
      const k = Math.min(road.n - 1, Math.floor(this.opts.finishS / step));
      const [sx, sy] = tx(road.e[k] - road.e[0], road.nn[k] - road.nn[0]);
      g.fillStyle = PAL.danger;
      g.beginPath();
      g.arc(sx, sy, 6 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    // 분기점 표시
    g.font = `600 ${11 * dpr}px ${FONT_UI}`;
    g.lineWidth = 3 * dpr;
    g.strokeStyle = PAL.halo;
    g.textAlign = "left";
    for (const j of road.junctions) {
      if (j.s < f.s - 100 || j.s > f.s + R || (j.kind !== "JC" && j.kind !== "IC")) continue;
      const [sx, sy] = tx(road.e[road.index(j.s)] - road.e[0], road.nn[road.index(j.s)] - road.nn[0]);
      if (sy < 10 * dpr) continue;
      g.fillStyle = j.kind === "JC" ? PAL.warn : PAL.label;
      g.beginPath();
      g.arc(sx, sy, 3 * dpr, 0, Math.PI * 2);
      g.fill();
      g.strokeText(j.name, sx + 7 * dpr, sy + 4 * dpr);
      g.fillText(j.name, sx + 7 * dpr, sy + 4 * dpr);
    }
    // 내 차
    g.save();
    g.translate(cx, cy);
    g.fillStyle = PAL.ink;
    g.strokeStyle = PAL.paper;
    g.lineWidth = 2.5 * dpr;
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
