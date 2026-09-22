// 전국 고속도로망 지도 (2D 캔버스): 메뉴에서 경로를 보여 주고, 지도를 눌러 출발지·도착지를 고른다.
// 좌표는 network.json 기준(원점에서 동쪽·북쪽 m).

import type { Network, Place } from "../road/route";
import { netPoint, placePoint } from "../road/route";

interface Pin {
  x: number;
  y: number;
  label: string;
  color: string;
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
    if (this.lastFit) this.fit(this.lastFit.box, false, this.lastFit.margin);
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

  private lastFit: { box: [number, number, number, number]; margin: number } | null = null;

  private fit(box: [number, number, number, number], animate: boolean, margin = 60) {
    const [x0, y0, x1, y1] = box;
    if (!Number.isFinite(x0)) return;
    this.lastFit = { box, margin };
    const w = Math.max(100, this.w - this.padLeft - this.padRight - margin * 2);
    const h = Math.max(100, this.h - this.padBottom - margin * 2);
    const mpp = Math.max(40, Math.max((x1 - x0) / w, (y1 - y0) / h));
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
      if (first && first.length >= 2) this.pins.push({ x: first[0], y: first[1], label: from?.name ?? "출발", color: "#3ee07a" });
      if (last && last.length >= 2) this.pins.push({ x: last[last.length - 2], y: last[last.length - 1], label: to?.name ?? "도착", color: "#ff5a4e" });
      this.fit(this.bounds(this.routeLines), true, 90);
    } else {
      for (const [p, color] of [
        [from, "#3ee07a"],
        [to, "#ff5a4e"],
      ] as [Place | null | undefined, string][]) {
        if (!p) continue;
        const xy = placePoint(this.net, p);
        if (xy) this.pins.push({ x: xy[0], y: xy[1], label: p.name, color });
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
        this.mpp = Math.max(8, Math.min(4000, this.mpp * f));
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
    this.target = { cx: this.cx, cy: this.cy, mpp: Math.max(8, Math.min(4000, this.mpp * f)) };
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
    g.clearRect(0, 0, this.w, this.h);
    // 격자 (10km)
    const grid = this.mpp < 150 ? 10000 : this.mpp < 600 ? 50000 : 100000;
    g.strokeStyle = "rgba(120,160,150,0.07)";
    g.lineWidth = 1;
    g.beginPath();
    const [wx0, wy1] = this.toWorld(0, 0);
    const [wx1, wy0] = this.toWorld(this.w, this.h);
    for (let x = Math.floor(wx0 / grid) * grid; x <= wx1; x += grid) {
      const [sx] = this.toScreen(x, 0);
      g.moveTo(sx, 0);
      g.lineTo(sx, this.h);
    }
    for (let y = Math.floor(wy0 / grid) * grid; y <= wy1; y += grid) {
      const [, sy] = this.toScreen(0, y);
      g.moveTo(0, sy);
      g.lineTo(this.w, sy);
    }
    g.stroke();

    // 도로망
    const lw = Math.max(1, Math.min(3, 400 / this.mpp));
    g.lineJoin = "round";
    g.lineCap = "round";
    g.strokeStyle = this.routeLines.length ? "rgba(150,175,170,0.32)" : "rgba(160,190,182,0.55)";
    g.lineWidth = lw;
    g.beginPath();
    for (const r of this.roads) this.path(g, r.pts);
    g.stroke();

    // 경로
    if (this.routeLines.length) {
      g.strokeStyle = "rgba(62,224,122,0.25)";
      g.lineWidth = lw + 9;
      g.beginPath();
      for (const l of this.routeLines) this.path(g, l);
      g.stroke();
      g.strokeStyle = "#3ee07a";
      g.lineWidth = lw + 2.5;
      g.beginPath();
      for (const l of this.routeLines) this.path(g, l);
      g.stroke();
    }

    // 도시 이름
    g.font = "600 12px Pretendard, 'Malgun Gothic', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const shown: [number, number][] = [];
    for (const q of this.placePts) {
      const major = q.p.kind === "도시";
      if (!major && this.mpp > 120) continue;
      if (!major && q.p.kind !== "JC" && this.mpp > 50) continue;
      const [sx, sy] = this.toScreen(q.x, q.y);
      if (sx < -20 || sy < -20 || sx > this.w + 20 || sy > this.h + 20) continue;
      if (shown.some(([ax, ay]) => Math.abs(ax - sx) < 46 && Math.abs(ay - sy) < 16)) continue;
      shown.push([sx, sy]);
      g.fillStyle = major ? "rgba(230,238,234,0.8)" : "rgba(170,190,184,0.7)";
      g.beginPath();
      g.arc(sx, sy, major ? 2.5 : 1.8, 0, Math.PI * 2);
      g.fill();
      g.fillText(q.p.name, sx, sy - 10);
    }

    for (const pin of this.pins) this.drawPin(pin);
    if (this.hover) {
      const [sx, sy] = this.toScreen(this.hover.x, this.hover.y);
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(sx, sy, 5, 0, Math.PI * 2);
      g.fill();
      const text = `${this.hover.p.name} · 눌러서 고르기`;
      g.font = "700 13px Pretendard, 'Malgun Gothic', sans-serif";
      const tw = g.measureText(text).width + 16;
      g.fillStyle = "rgba(10,14,15,0.9)";
      g.fillRect(sx - tw / 2, sy - 36, tw, 22);
      g.fillStyle = "#fff";
      g.fillText(text, sx, sy - 25);
    }
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

  private drawPin(p: Pin) {
    const g = this.ctx;
    const [sx, sy] = this.toScreen(p.x, p.y);
    g.fillStyle = p.color;
    g.strokeStyle = "#0b0f10";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx, sy - 16, 9, Math.PI * 0.8, Math.PI * 2.2);
    g.lineTo(sx, sy);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = "#0b0f10";
    g.beginPath();
    g.arc(sx, sy - 16, 3.5, 0, Math.PI * 2);
    g.fill();
    g.font = "800 13px Pretendard, 'Malgun Gothic', sans-serif";
    const tw = g.measureText(p.label).width + 14;
    g.fillStyle = "rgba(10,14,15,0.88)";
    g.fillRect(sx + 12, sy - 28, tw, 22);
    g.fillStyle = p.color;
    g.textAlign = "left";
    g.fillText(p.label, sx + 19, sy - 17);
    g.textAlign = "center";
  }
}
