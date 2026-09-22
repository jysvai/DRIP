// 한국 고속도로 표지판. 캔버스에 그려서 텍스처로 쓴다.
// 안내표지: 초록 바탕·흰 글씨 / 규제표지: 최고속도(빨간 테), 최저속도(파란 원) / 노선번호: 빨강·파랑 방패

import * as THREE from "three";
import type { Road } from "../road/road";
import { Structure } from "../road/road";
import type { Enforcement } from "../sim/cameras";

export const SIGN_GREEN = "#0b6a3b";
const FONT = `"Pretendard Variable", Pretendard, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;

const textureCache = new Map<string, THREE.CanvasTexture>();

function canvasTexture(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const hit = textureCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  textureCache.set(key, t);
  return t;
}

export async function loadSignFonts() {
  try {
    await Promise.all([document.fonts.load(`800 64px ${FONT}`), document.fonts.load(`600 64px ${FONT}`)]);
  } catch {
    // 글꼴을 못 받아도 시스템 글꼴로 그린다
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitText(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 800) {
  let s = size;
  do {
    g.font = `${weight} ${s}px ${FONT}`;
    s -= 2;
  } while (g.measureText(text).width > maxW && s > 10);
}

function drawShield(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ref: string) {
  // 고속도로 노선번호 방패: 위는 빨강 띠, 아래는 파랑, 흰 숫자
  g.save();
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w, y + h * 0.62);
  g.quadraticCurveTo(x + w, y + h * 0.92, x + w / 2, y + h);
  g.quadraticCurveTo(x, y + h * 0.92, x, y + h * 0.62);
  g.closePath();
  g.fillStyle = "#ffffff";
  g.fill();
  g.clip();
  g.fillStyle = "#c8102e";
  g.fillRect(x, y, w, h * 0.26);
  g.fillStyle = "#0a3d91";
  g.fillRect(x, y + h * 0.3, w, h);
  g.restore();
  g.fillStyle = "#ffffff";
  fitText(g, ref, w * 0.8, h * 0.5);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(ref, x + w / 2, y + h * 0.63);
}

export function guideTexture(lines: { name: string; exit?: string; dist?: string; shieldRef?: string }): THREE.CanvasTexture {
  const key = `guide|${lines.name}|${lines.exit}|${lines.dist}|${lines.shieldRef}`;
  return canvasTexture(key, 1024, 384, (g) => {
    g.fillStyle = SIGN_GREEN;
    g.fillRect(0, 0, 1024, 384);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 10;
    roundRect(g, 14, 14, 996, 356, 22);
    g.stroke();
    let x = 60;
    if (lines.shieldRef) {
      drawShield(g, x, 70, 130, 150, lines.shieldRef);
      x += 170;
    }
    g.fillStyle = "#ffffff";
    g.textAlign = "left";
    g.textBaseline = "middle";
    fitText(g, lines.name, 1024 - x - 60, 132);
    g.fillText(lines.name, x, 150);
    g.font = `700 88px ${FONT}`;
    if (lines.dist) {
      g.textAlign = "right";
      g.fillText(lines.dist, 964, 290);
    }
    if (lines.exit) {
      g.textAlign = "left";
      g.fillStyle = "#ffffff";
      roundRect(g, 60, 240, 190, 100, 12);
      g.fill();
      g.fillStyle = SIGN_GREEN;
      g.font = `800 72px ${FONT}`;
      g.fillText(lines.exit, 82, 292);
    }
  });
}

export function speedTexture(speed: number, kind: "max" | "min" | "hgv"): THREE.CanvasTexture {
  return canvasTexture(`speed|${speed}|${kind}`, 256, kind === "hgv" ? 320 : 256, (g) => {
    const cx = 128;
    const cy = 128;
    if (kind === "min") {
      g.fillStyle = "#1a4fa8";
      g.beginPath();
      g.arc(cx, cy, 124, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#ffffff";
      g.font = `800 112px ${FONT}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(speed), cx, cy - 6);
      g.fillRect(cx - 70, cy + 52, 140, 12);
      return;
    }
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(cx, cy, 124, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#d4161c";
    g.lineWidth = 26;
    g.beginPath();
    g.arc(cx, cy, 108, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "#111111";
    g.font = `800 ${speed >= 100 ? 104 : 118}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(speed), cx, cy + 6);
    if (kind === "hgv") {
      g.fillStyle = "#ffffff";
      g.fillRect(28, 262, 200, 54);
      g.strokeStyle = "#111";
      g.lineWidth = 4;
      g.strokeRect(28, 262, 200, 54);
      g.fillStyle = "#111";
      g.font = `700 38px ${FONT}`;
      g.fillText("화물·특수", cx, 290);
    }
  });
}

export function kmPostTexture(ref: string, km: number): THREE.CanvasTexture {
  return canvasTexture(`km|${ref}|${km}`, 256, 320, (g) => {
    g.fillStyle = SIGN_GREEN;
    g.fillRect(0, 0, 256, 320);
    g.strokeStyle = "#fff";
    g.lineWidth = 6;
    g.strokeRect(8, 8, 240, 304);
    drawShield(g, 78, 26, 100, 116, ref);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, km.toFixed(0), 200, 110);
    g.fillText(km.toFixed(0), 128, 220);
    g.font = `700 40px ${FONT}`;
    g.fillText("km", 128, 288);
  });
}

export function distanceTexture(ref: string, place: string, km: number): THREE.CanvasTexture {
  return canvasTexture(`dist|${ref}|${place}|${km}`, 768, 256, (g) => {
    g.fillStyle = SIGN_GREEN;
    g.fillRect(0, 0, 768, 256);
    g.strokeStyle = "#fff";
    g.lineWidth = 8;
    roundRect(g, 10, 10, 748, 236, 16);
    g.stroke();
    drawShield(g, 40, 50, 120, 140, ref);
    g.fillStyle = "#fff";
    g.textBaseline = "middle";
    g.textAlign = "left";
    fitText(g, place, 330, 104);
    g.fillText(place, 190, 130);
    g.textAlign = "right";
    g.font = `800 96px ${FONT}`;
    g.fillText(`${km}`, 690, 130);
    g.font = `700 44px ${FONT}`;
    g.fillText("km", 738, 150);
  });
}

export function plateTexture(text: string, sub = ""): THREE.CanvasTexture {
  return canvasTexture(`plate|${text}|${sub}`, 1024, 192, (g) => {
    g.fillStyle = "#1d2d2a";
    g.fillRect(0, 0, 1024, 192);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, text, sub ? 620 : 940, 120);
    g.fillText(text, sub ? 380 : 512, 100);
    if (sub) {
      g.font = `700 72px ${FONT}`;
      g.fillText(sub, 820, 104);
    }
  });
}

/** 카메라 그림 (몸통, 렌즈, 받침) */
function drawCamera(g: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string) {
  const s = size;
  g.fillStyle = color;
  roundRect(g, cx - s * 0.5, cy - s * 0.28, s * 0.78, s * 0.5, s * 0.06);
  g.fill();
  g.beginPath();
  g.moveTo(cx + s * 0.28, cy - s * 0.12);
  g.lineTo(cx + s * 0.5, cy - s * 0.26);
  g.lineTo(cx + s * 0.5, cy + s * 0.2);
  g.lineTo(cx + s * 0.28, cy + s * 0.06);
  g.closePath();
  g.fill();
  g.fillRect(cx - s * 0.16, cy + s * 0.22, s * 0.1, s * 0.3);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(cx - s * 0.12, cy - s * 0.03, s * 0.13, 0, Math.PI * 2);
  g.fill();
}

/** 제한속도 아래 붙는 "과속단속" 보조표지 */
export function cameraPlateTexture(): THREE.CanvasTexture {
  return canvasTexture("camplate", 256, 320, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 256, 320);
    g.strokeStyle = "#111";
    g.lineWidth = 10;
    g.strokeRect(5, 5, 246, 310);
    drawCamera(g, 128, 120, 150, "#111");
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "과속단속", 220, 58);
    g.fillText("과속단속", 128, 262);
  });
}

/** 구간단속 시작·끝 표지: 파란 띠에 "구간단속", 아래에 시작/끝과 구간 길이 */
export function sectionSignTexture(kind: "start" | "end", lengthKm: number, limit: number): THREE.CanvasTexture {
  return canvasTexture(`section|${kind}|${lengthKm}|${limit}`, 512, 600, (g) => {
    g.fillStyle = "#ffffff";
    roundRect(g, 0, 0, 512, 600, 26);
    g.fill();
    g.fillStyle = "#1a4fa8";
    roundRect(g, 14, 14, 484, 150, 16);
    g.fill();
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, "구간단속", 440, 104);
    g.fillText("구간단속", 256, 92);
    g.fillStyle = "#111";
    g.font = `800 150px ${FONT}`;
    g.fillText(kind === "start" ? "시작" : "끝", 256, 290);
    drawCamera(g, 110, 470, 120, "#1a4fa8");
    g.fillStyle = "#111";
    g.textAlign = "left";
    fitText(g, kind === "start" ? `${lengthKm}km` : `${limit}`, 250, 92);
    g.fillText(kind === "start" ? `${lengthKm}km` : `${limit}`, 200, 470);
  });
}

export function sloganTexture(text: string): THREE.CanvasTexture {
  return canvasTexture(`slogan|${text}`, 1536, 192, (g) => {
    g.fillStyle = "#123c7a";
    g.fillRect(0, 0, 1536, 192);
    g.fillStyle = "#ffd33d";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, text, 1440, 116);
    g.fillText(text, 768, 100);
  });
}

// ---------- 표지판 배치 ----------

export type SignKind = "guide" | "gantry" | "speed" | "km" | "distance" | "slogan" | "tunnel" | "bridge";

export interface SignSpec {
  s: number;
  kind: SignKind;
  texture: () => THREE.CanvasTexture;
  /** 판 크기(m) */
  w: number;
  h: number;
  extra?: () => THREE.CanvasTexture; // 아래에 붙는 작은 판 (화물차 속도 등)
}

const SLOGANS = [
  "졸음운전! 목숨을 건 도박입니다",
  "졸리면 졸음쉼터에서 쉬어가세요",
  "뒷좌석도 안전띠 착용",
  "앞차와의 안전거리를 확보하세요",
  "터널 안 차로변경 금지",
  "화물차는 지정차로로 통행하세요",
  "고속도로 2차 사고 조심! 비상등 켜고 대피",
];

export function planSigns(road: Road): SignSpec[] {
  const out: SignSpec[] = [];
  const add = (spec: SignSpec) => {
    if (spec.s > 30 && spec.s < road.length - 30) out.push(spec);
  };

  // IC·JC·휴게소 예고: 2km, 1km 지주식 / 500m 문형식. 나들목이 붙어 있으면 겹치는 판은 뺀다
  const guideAt: number[] = [];
  const addGuide = (spec: SignSpec) => {
    if (guideAt.some((s) => Math.abs(s - spec.s) < 150)) return;
    guideAt.push(spec.s);
    add(spec);
  };
  for (const j of road.junctions) {
    if (j.kind === "기타") continue;
    const exit = j.exitNo && /^\d+/.test(j.exitNo) ? j.exitNo : undefined;
    addGuide({ s: j.s - 500, kind: "gantry", w: 6.4, h: 2.4, texture: () => guideTexture({ name: j.name, exit, dist: "500m" }) });
  }
  for (const j of road.junctions) {
    if (j.kind === "기타") continue;
    const exit = j.exitNo && /^\d+/.test(j.exitNo) ? j.exitNo : undefined;
    for (const [before, label] of [
      [1000, "1km"],
      [2000, "2km"],
    ] as const) {
      addGuide({ s: j.s - before, kind: "guide", w: 5.2, h: 1.95, texture: () => guideTexture({ name: j.name, exit, dist: label }) });
    }
  }

  // 제한속도: 바뀌는 곳 + 5km마다 (화물차 제한속도 판 함께)
  let last = -1;
  let lastAt = -1e9;
  for (let s = 200; s < road.length; s += 100) {
    const v = road.speedAt(s);
    if (v !== last || s - lastAt > 5000) {
      const hgv = road.speedAt(s, true);
      add({
        s,
        kind: "speed",
        w: 1.2,
        h: 1.2,
        texture: () => speedTexture(v, "max"),
        extra: hgv < v ? () => speedTexture(hgv, "hgv") : undefined,
      });
      last = v;
      lastAt = s;
    }
  }
  // 최저속도: 가끔
  for (let s = 2600; s < road.length; s += 12000) {
    add({ s, kind: "speed", w: 1.1, h: 1.1, texture: () => speedTexture(road.minSpeed[road.index(s)], "min") });
  }

  // 거리표 (이정): 1km마다
  for (let km = 1; km * 1000 < road.length; km++) {
    add({ s: km * 1000, kind: "km", w: 0.55, h: 0.69, texture: () => kmPostTexture(road.ref, km) });
  }
  // 목적지 거리: 10km마다
  for (let s = 5000; s < road.length - 5000; s += 10000) {
    const km = Math.round((road.length - s) / 1000);
    add({ s, kind: "distance", w: 4.2, h: 1.4, texture: () => distanceTexture(road.ref, road.to, km) });
  }
  // 안전 문구 문형 표지: 15km마다
  let k = 0;
  for (let s = 8000; s < road.length; s += 15000) {
    const text = SLOGANS[k++ % SLOGANS.length];
    add({ s, kind: "slogan", w: 9, h: 1.1, texture: () => sloganTexture(text) });
  }
  // 터널·교량 이름
  for (const st of road.structures) {
    const len = st.s1 - st.s0;
    if (st.kind === Structure.Tunnel && len > 60) {
      const name = st.name || "터널";
      add({ s: st.s0, kind: "tunnel", w: 7, h: 1.3, texture: () => plateTexture(name, `L=${len >= 1000 ? (len / 1000).toFixed(1) + "km" : Math.round(len) + "m"}`) });
    } else if (st.kind === Structure.Bridge && len > 250 && st.name) {
      add({ s: st.s0 - 20, kind: "bridge", w: 2.4, h: 0.45, texture: () => plateTexture(st.name) });
    }
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

/** 단속 카메라 표지: 고정식 500m 앞 제한속도 + "과속단속", 구간단속 시점 300m 앞과 종점 뒤 */
export function enforcementSigns(e: Enforcement, road: Road): SignSpec[] {
  const out: SignSpec[] = [];
  const ok = (s: number) => s > 30 && s < road.length - 30;
  for (const cam of e.fixed) {
    const s = cam.s - 500;
    const limit = cam.limit || road.speedAt(cam.s);
    if (ok(s)) out.push({ s, kind: "speed", w: 1.2, h: 1.2, texture: () => speedTexture(limit, "max"), extra: cameraPlateTexture });
  }
  for (const sec of e.sections) {
    const km = Math.round((sec.s1 - sec.s0) / 100) / 10;
    const limit = sec.limit || road.speedAt(sec.s0);
    if (ok(sec.s0 - 300)) out.push({ s: sec.s0 - 300, kind: "guide", w: 1.7, h: 2.0, texture: () => sectionSignTexture("start", km, limit) });
    if (ok(sec.s1 + 60)) out.push({ s: sec.s1 + 60, kind: "guide", w: 1.7, h: 2.0, texture: () => sectionSignTexture("end", km, limit) });
  }
  return out;
}
