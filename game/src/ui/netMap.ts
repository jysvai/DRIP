// 전국 고속도로망 지도 (2D 캔버스): 메뉴에서 경로를 보여 주고, 지도를 눌러 출발지·도착지를 고른다.
// 좌표는 network.json 기준(원점에서 동쪽·북쪽 m). 시내 도로망도 같은 좌표계(UTM-K)라 원점만 옮겨 그린다.

import type { Network, Place } from "../road/route";
import { netPoint, placePoint } from "../road/route";
import type { CityGraph } from "../city/graph";
import type { CityNet } from "../city/net";
import { FONT_UI, PAL } from "./palette";

interface Pin {
  x: number;
  y: number;
  label: string;
  color: string;
  /** 도착 표시 (네모) */
  end?: boolean;
}

export class NetMap {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private cx = 0;
  private cy = 0;
  /** 화면 1px당 m */
  private mpp = 1000;
  private target: { cx: number; cy: number; mpp: number } | null = null;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private roads: { ref: string; pts: Float32Array }[] = [];
  private placePts: { p: Place; x: number; y: number }[] = [];
  private routeLines: Float32Array[] = [];
  /** 시내 도로 (큰길·골목) */
  private cityLines: { pts: Float32Array; major: boolean }[] = [];
  /** 시내 모드: 시내 도로를 그리고 고속도로 지명은 가린다 */
  showCity = false;
  private pins: Pin[] = [];
  private hover: { p: Place; x: number; y: number } | null = null;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private dirty = true;
  private raf = 0;
  /** 지도를 눌러 장소를 골랐을 때 */
  onPick?: (p: Place) => void;
  /** 오른쪽 아래 여백 (경로 요약 카드가 덮는 부분) */
  padBottom = 0;
  padLeft = 0;
  padRight = 0;

  constructor(
    parent: HTMLElement,
    private net: Network,
    places: Place[],
  ) {
    this.canvas.className = "netmap";
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    for (const r of net.roads) {
      const pts = new Float32Array(r.p.length);
      for (let i = 0; i < r.p.length; i++) pts[i] = r.p[i] * 10;
      this.roads.push({ ref: r.ref, pts });
    }
    for (const p of places) {
      if (p.kind === "SA" || p.kind === "기타") continue;
      const xy = placePoint(net, p);
      if (xy) this.placePts.push({ p, x: xy[0], y: xy[1] });
    }
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas);
    this.bind();
    this.fitAll(false);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // 크기가 바뀌면 마지막으로 맞춘 영역을 다시 맞춘다 (처음 만들 때는 캔버스 크기가 0이다)
    if (this.lastFit) this.fit(this.lastFit.box, false, this.lastFit.margin, this.lastFit.minMpp);
    this.dirty = true;
  }

  private bounds(lines: Float32Array[]): [number, number, number, number] {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of lines) {
      for (let i = 0; i < l.length; i += 2) {
        x0 = Math.min(x0, l[i]);
        x1 = Math.max(x1, l[i]);
        y0 = Math.min(y0, l[i + 1]);
        y1 = Math.max(y1, l[i + 1]);
      }
    }
    return [x0, y0, x1, y1];
  }

  private lastFit: { box: [number, number, number, number]; margin: number; minMpp?: number } | null = null;

  private fit(box: [number, number, number, number], animate: boolean, margin = 60, minMpp = 40) {
    const [x0, y0, x1, y1] = box;
    if (!Number.isFinite(x0)) return;
    this.lastFit = { box, margin, minMpp };
    const w = Math.max(100, this.w - this.padLeft - this.padRight - margin * 2);
    const h = Math.max(100, this.h - this.padBottom - margin * 2);
    const mpp = Math.max(minMpp, Math.max((x1 - x0) / w, (y1 - y0) / h));
    // 패널이 덮지 않는 영역 가운데에 오게
    const cx = (x0 + x1) / 2 - ((this.padLeft - this.padRight) / 2) * mpp;
    const cy = (y0 + y1) / 2 - (this.padBottom / 2) * mpp;
    if (animate) this.target = { cx, cy, mpp };
    else {
      this.cx = cx;
      this.cy = cy;
      this.mpp = mpp;
      this.target = null;
    }
    this.dirty = true;
  }

  fitAll(animate = true) {
    this.fit(this.bounds(this.roads.map((r) => r.pts)), animate, 30);
  }

  /** 시내 도로망 (한 번만) */
  setCityGraph(graph: CityGraph) {
    if (this.cityLines.length) return;
    const dx = graph.origin[0] - this.net.origin[0];
    const dy = graph.origin[1] - this.net.origin[1];
    for (const e of graph.edges) {
      const pts = new Float32Array(e.pts.length);
      for (let i = 0; i < e.pts.length; i += 2) {
        pts[i] = e.pts[i] + dx;
        pts[i + 1] = e.pts[i + 1] + dy;
      }
      this.cityLines.push({ pts, major: /^(t|p|s)/.test(e.cls) });
    }
    this.dirty = true;
  }

  /** 시내 경로: 링크 모양을 이어 그리고 출발·도착 핀을 꽂는다 */
  setCityRoute(net: CityNet | null, links: number[] | null, from?: { name: string; x: number; y: number } | null, to?: { name: string; x: number; y: number } | null) {
    this.routeLines = [];
    this.pins = [];
    const dx = net ? net.graph.origin[0] - this.net.origin[0] : 0;
    const dy = net ? net.graph.origin[1] - this.net.origin[1] : 0;
    if (net && links?.length) {
      const pts: number[] = [];
      for (const id of links) {
        const g = net.geom(id);
        for (let i = 0; i < g.pts.length; i += 2) pts.push(g.pts[i] + dx, g.pts[i + 1] + dy);
      }
      this.routeLines.push(new Float32Array(pts));
    }
    for (const [p, color] of [
      [from, PAL.route],
      [to, PAL.danger],
    ] as [{ name: string; x: number; y: number } | null | undefined, string][]) {
      if (p) this.pins.push({ x: p.x + dx, y: p.y + dy, label: p.name, color, end: p === to });
    }
    const box = this.routeLines.length ? this.bounds(this.routeLines) : this.bounds([new Float32Array(this.pins.flatMap((p) => [p.x, p.y]))]);
    this.fit(box, true, 90, 4);
    this.dirty = true;
  }

  /** 경로 조각들을 지도에 그린다 */
  setRoute(legs: { road: string; s0: number; s1: number }[] | null, from?: Place | null, to?: Place | null) {
    this.routeLines = [];
    this.pins = [];
    if (legs?.length) {
      let prev: [number, number] | null = null;
      for (const l of legs) {
        const pts: number[] = [];
        if (prev) pts.push(...prev);
        const n = Math.max(2, Math.ceil((l.s1 - l.s0) / 500) + 1);
        for (let i = 0; i < n; i++) {
          const xy = netPoint(this.net, l.road, l.s0 + ((l.s1 - l.s0) * i) / (n - 1));
          if (xy) pts.push(xy[0], xy[1]);
        }
        prev = pts.length >= 2 ? [pts[pts.length - 2], pts[pts.length - 1]] : prev;
        this.routeLines.push(new Float32Array(pts));
      }
      const first = this.routeLines[0];
      const last = this.routeLines[this.routeLines.length - 1];
      if (first && first.length >= 2) this.pins.push({ x: first[0], y: first[1], label: from?.name ?? "출발", color: PAL.route });
      if (last && last.length >= 2) this.pins.push({ x: last[last.length - 2], y: last[last.length - 1], label: to?.name ?? "도착", color: PAL.danger, end: true });
      this.fit(this.bounds(this.routeLines), true, 90);
    } else {
      for (const [p, color] of [
        [from, PAL.route],
        [to, PAL.danger],
      ] as [Place | null | undefined, string][]) {
        if (!p) continue;
        const xy = placePoint(this.net, p);
        if (xy) this.pins.push({ x: xy[0], y: xy[1], label: p.name, color, end: p === to });
      }
    }
    this.dirty = true;
  }

  private toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) / this.mpp + this.w / 2, this.h / 2 - (y - this.cy) / this.mpp];
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) * this.mpp + this.cx, (this.h / 2 - sy) * this.mpp + this.cy];
  }

  private nearestPlace(sx: number, sy: number) {
    let best: { p: Place; x: number; y: number } | null = null;
    let bd = 16 * 16;
    const rank = { 도시: 0, IC: 1, JC: 2, TG: 3, SA: 4, 기타: 5 } as const;
    for (const q of this.placePts) {
      const [px, py] = this.toScreen(q.x, q.y);
      const d = (px - sx) ** 2 + (py - sy) ** 2 + rank[q.p.kind] * 20;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
      this.target = null;
    });
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
        this.lastFit = null;
        this.cx = this.drag.cx - dx * this.mpp;
        this.cy = this.drag.cy + dy * this.mpp;
        this.dirty = true;
      } else {
        const h = this.nearestPlace(e.clientX - r.left, e.clientY - r.top);
        if (h?.p !== this.hover?.p) {
          this.hover = h;
          c.style.cursor = h ? "pointer" : "grab";
          this.dirty = true;
        }
      }
    });
    c.addEventListener("pointerup", (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved) {
        const r = c.getBoundingClientRect();
        const h = this.nearestPlace(e.clientX - r.left, e.clientY - r.top);
        if (h) this.onPick?.(h.p);
      }
    });
    c.addEventListener("pointerleave", () => {
      this.hover = null;
      this.dirty = true;
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const [wx, wy] = this.toWorld(sx, sy);
        const f = Math.exp(e.deltaY * 0.0015);
        this.mpp = Math.max(this.showCity ? 2 : 8, Math.min(4000, this.mpp * f));
        // 커서 아래 지점이 그대로 있게
        this.cx = wx - (sx - this.w / 2) * this.mpp;
        this.cy = wy - (this.h / 2 - sy) * this.mpp;
        this.target = null;
        this.lastFit = null;
        this.dirty = true;
      },
      { passive: false },
    );
  }

  zoom(f: number) {
    this.target = { cx: this.cx, cy: this.cy, mpp: Math.max(this.showCity ? 2 : 8, Math.min(4000, this.mpp * f)) };
  }

  private tick() {
    if (this.target) {
      const k = 0.16;
      this.cx += (this.target.cx - this.cx) * k;
      this.cy += (this.target.cy - this.cy) * k;
      this.mpp *= Math.pow(this.target.mpp / this.mpp, k);
      if (Math.abs(this.target.mpp / this.mpp - 1) < 0.002 && Math.abs(this.target.cx - this.cx) < this.mpp) this.target = null;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
  }

  private draw() {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = PAL.land;
    g.fillRect(0, 0, this.w, this.h);
    // 격자 (10·50·100km)
    const grid = this.mpp < 150 ? 10000 : this.mpp < 600 ? 50000 : 100000;
    g.strokeStyle = PAL.grid;
    g.lineWidth = 1;
    g.beginPath();
    const [wx0, wy1] = this.toWorld(0, 0);
    const [wx1, wy0] = this.toWorld(this.w, this.h);
    for (let x = Math.floor(wx0 / grid) * grid; x <= wx1; x += grid) {
      const [sx] = this.toScreen(x, 0);
      g.moveTo(Math.round(sx) + 0.5, 0);
      g.lineTo(Math.round(sx) + 0.5, this.h);
    }
    for (let y = Math.floor(wy0 / grid) * grid; y <= wy1; y += grid) {
      const [, sy] = this.toScreen(0, y);
      g.moveTo(0, Math.round(sy) + 0.5);
      g.lineTo(this.w, Math.round(sy) + 0.5);
    }
    g.stroke();

    // 도로망
    const lw = Math.max(1, Math.min(3, 400 / this.mpp));
    g.lineJoin = "round";
    g.lineCap = "round";
    g.strokeStyle = this.routeLines.length ? PAL.roadDim : PAL.road;
    g.lineWidth = lw;
    g.beginPath();
    for (const r of this.roads) this.path(g, r.pts);
    g.stroke();
    // 시내 도로: 가까이 볼 때만 (골목은 더 가까이)
    if (this.showCity && this.mpp < 120) {
      const [vx0, vy1] = this.toWorld(0, 0);
      const [vx1, vy0] = this.toWorld(this.w, this.h);
      for (const major of [false, true]) {
        if (!major && this.mpp > 30) continue;
        g.strokeStyle = this.routeLines.length ? PAL.roadDim : PAL.road;
        g.lineWidth = major ? Math.max(1, Math.min(4, 60 / this.mpp)) : 1;
        g.beginPath();
        for (const l of this.cityLines) {
          if (l.major !== major) continue;
          const p = l.pts;
          if (p[0] < vx0 - 500 || p[0] > vx1 + 500 || p[1] < vy0 - 500 || p[1] > vy1 + 500) continue;
          this.path(g, p);
        }
        g.stroke();
      }
    }

    // 경로: 짙은 테두리 위에 밝은 선 (내비 경로선처럼)
    if (this.routeLines.length) {
      g.strokeStyle = PAL.routeCasing;
      g.lineWidth = lw + 6;
      g.beginPath();
      for (const l of this.routeLines) this.path(g, l);
      g.stroke();
      g.strokeStyle = PAL.route;
      g.lineWidth = lw + 2.5;
      g.beginPath();
      for (const l of this.routeLines) this.path(g, l);
      g.stroke();
    }

    // 지명: 도시는 밝게, 분기점·나들목은 가까이 볼 때만
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    const shown: [number, number][] = [];
    for (const q of this.showCity ? [] : this.placePts) {
      const major = q.p.kind === "도시";
      if (!major && this.mpp > 120) continue;
      if (!major && q.p.kind !== "JC" && this.mpp > 50) continue;
      const [sx, sy] = this.toScreen(q.x, q.y);
      if (sx < -20 || sy < -20 || sx > this.w + 20 || sy > this.h + 20) continue;
      if (shown.some(([ax, ay]) => Math.abs(ax - sx) < 46 && Math.abs(ay - sy) < 16)) continue;
      shown.push([sx, sy]);
      g.fillStyle = major ? PAL.ink : q.p.kind === "JC" ? PAL.warn : PAL.labelDim;
      g.beginPath();
      if (major) g.arc(sx, sy, 2.75, 0, Math.PI * 2);
      else g.rect(sx - 1.75, sy - 1.75, 3.5, 3.5);
      g.fill();
      g.font = major ? `600 12px ${FONT_UI}` : `500 11px ${FONT_UI}`;
      g.strokeStyle = PAL.halo;
      g.lineWidth = 3.5;
      g.strokeText(q.p.name, sx, sy - 11);
      g.fillStyle = major ? PAL.label : PAL.labelDim;
      g.fillText(q.p.name, sx, sy - 11);
    }

    for (const pin of this.pins) this.drawPin(pin);
    if (this.hover) {
      const [sx, sy] = this.toScreen(this.hover.x, this.hover.y);
      g.strokeStyle = PAL.ink;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sx, sy, 6.5, 0, Math.PI * 2);
      g.stroke();
      const name = this.hover.p.name;
      const hint = "  눌러서 고르기";
      g.font = `700 13px ${FONT_UI}`;
      const nw = g.measureText(name).width;
      g.font = `500 12px ${FONT_UI}`;
      const hw = g.measureText(hint).width;
      const tw = nw + hw + 20;
      const bx = Math.round(sx - tw / 2);
      const by = Math.round(sy - 42);
      this.box(bx, by, tw, 26);
      g.textAlign = "left";
      g.font = `700 13px ${FONT_UI}`;
      g.fillStyle = PAL.ink;
      g.fillText(name, bx + 10, by + 13.5);
      g.font = `500 12px ${FONT_UI}`;
      g.fillStyle = PAL.muted;
      g.fillText(hint, bx + 10 + nw, by + 13.5);
      g.textAlign = "center";
    }
  }

  /** 말풍선 바탕: 단단한 판 + 가는 테두리 */
  private box(x: number, y: number, w: number, h: number) {
    const g = this.ctx;
    g.beginPath();
    g.roundRect(x + 0.5, y + 0.5, w, h, 5);
    g.fillStyle = PAL.paper2;
    g.fill();
    g.strokeStyle = PAL.rule;
    g.lineWidth = 1;
    g.stroke();
  }

  private path(g: CanvasRenderingContext2D, pts: Float32Array) {
    let first = true;
    for (let i = 0; i < pts.length; i += 2) {
      const sx = (pts[i] - this.cx) / this.mpp + this.w / 2;
      const sy = this.h / 2 - (pts[i + 1] - this.cy) / this.mpp;
      if (first) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
      first = false;
    }
  }

  /** 출발은 원, 도착은 네모 (메뉴의 출발·도착 표시와 같게) */
  private drawPin(p: Pin) {
    const g = this.ctx;
    const [sx, sy] = this.toScreen(p.x, p.y);
    g.fillStyle = p.color;
    g.strokeStyle = PAL.paper;
    g.lineWidth = 2.5;
    g.beginPath();
    if (p.end) g.rect(sx - 6.5, sy - 6.5, 13, 13);
    else g.arc(sx, sy, 7, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = PAL.paper;
    g.beginPath();
    g.arc(sx, sy, 2.5, 0, Math.PI * 2);
    g.fill();
    g.font = `700 13px ${FONT_UI}`;
    const tw = g.measureText(p.label).width + 22;
    const bx = Math.round(sx + 12);
    const by = Math.round(sy - 13);
    this.box(bx, by, tw, 26);
    g.fillStyle = p.color;
    g.fillRect(bx + 1, by + 1, 3, 25);
    g.fillStyle = PAL.ink;
    g.textAlign = "left";
    g.fillText(p.label, bx + 12, by + 13.5);
    g.textAlign = "center";
  }
}
