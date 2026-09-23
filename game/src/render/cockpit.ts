// 운전석 실내: 대시보드(파노라마 디스플레이), 운전대, 가운데 콘솔, 조수석, 룸미러, 햇빛가리개.
// 차종마다 모델의 운전석 배치(CabinSpec)에 맞춰 만든다. 승용차는 차체 안쪽 면(model.interior)이 천장·기둥·문을 이루고,
// 버스·트럭은 여기서 상자형 운전실 벽을 따로 만든다. 한국 차는 왼쪽 운전석(z < 0).
// 좌표: 모델 좌표 (x 앞, y 위, z 오른쪽)

import * as THREE from "three";
import type { LkaState } from "../sim/assist";
import { createVehicleMaterial } from "./carMaterials";
import { Mesher, box, cbox, cyl, profile, TAG, type Surf } from "./vehicleGeom";
import type { CabinSpec, VehicleModel } from "./vehicleModels";

const IN = {
  dash: { color: 0x19191b, r: 0.85, m: 0, c: 0, tag: 0 } as Surf,
  dashTop: { color: 0x161618, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  trim: { color: 0x9aa0a7, r: 0.3, m: 1, c: 0, tag: 0 } as Surf,
  gloss: { color: 0x0a0b0c, r: 0.1, m: 0.1, c: 1, tag: 0 } as Surf,
  leather: { color: 0x17181a, r: 0.55, m: 0, c: 0.3, tag: 0 } as Surf,
  seat: { color: 0x2a2826, r: 0.75, m: 0, c: 0.1, tag: 0 } as Surf,
  seatLight: { color: 0x8a7d6c, r: 0.7, m: 0, c: 0.1, tag: 0 } as Surf,
  plastic: { color: 0x2c2d30, r: 0.8, m: 0, c: 0, tag: 0 } as Surf,
  head: { color: 0xb3afa6, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  headDark: { color: 0x2b2c2f, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  floor: { color: 0x121314, r: 1, m: 0, c: 0, tag: 0 } as Surf,
  ambient: { color: 0x7fc4ff, r: 0.3, m: 0, c: 0, tag: TAG.GLOW } as Surf,
  mirror: { color: 0x7c8894, r: 0.02, m: 1, c: 0, tag: 0 } as Surf,
};

export interface Cockpit {
  group: THREE.Group;
  /** 운전대 (x축 = 운전대 축으로 돌린다) */
  wheel: THREE.Object3D;
  material: THREE.MeshPhysicalMaterial;
  screen: THREE.MeshBasicMaterial;
  /** 계기판 화면 (속도를 그린다) */
  display: ClusterScreen;
  /** 후측방 화면 자리: 왼쪽 원(속도계 자리), 오른쪽 원(출력계 자리). 재질은 PlayerView가 붙인다 */
  bvm: [THREE.Mesh, THREE.Mesh];
}

/** 계기판 표시등: 방향지시 화살표(지금 켜진 순간인지), 비상등, 차로 유지 보조, 후측방 화면이 뜬 쪽 */
export interface ClusterTells {
  left: boolean;
  right: boolean;
  hazard: boolean;
  lka: LkaState;
  /** 차로 유지 보조가 막고 있는 쪽 (-1 왼쪽, 1 오른쪽, 0 없음) */
  lkaSide: number;
  /** 후측방 화면이 원 안을 덮는 쪽 (그쪽 원은 그리지 않는다) */
  bvm: number;
}

const NO_TELLS: ClusterTells = { left: false, right: false, hazard: false, lka: "off", lkaSide: 0, bvm: 0 };

/** 계기판·내비 화면 (캔버스). 속도가 바뀌면 다시 그린다 */
export class ClusterScreen {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private key = "";
  private tellKey = "";
  private last = -1;

  constructor(
    private wide: boolean,
    aspect: number,
  ) {
    const c = document.createElement("canvas");
    c.width = wide ? 1536 : 512;
    c.height = Math.round(c.width / aspect);
    this.g = c.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw(0, "P", NO_TELLS);
  }

  /** 원 두 개의 가운데와 반지름 (캔버스 폭·높이에 대한 비율). side: -1 왼쪽(속도), 1 오른쪽(출력) */
  gauge(side: number): { u: number; v: number; r: number } {
    const { W, H, cw, cy, R } = this.layout();
    return { u: (cw * (side < 0 ? 0.2 : 0.8)) / W, v: cy / H, r: R / W };
  }

  private layout() {
    const W = this.g.canvas.width;
    const H = this.g.canvas.height;
    const cw = this.wide ? W * 0.44 : W;
    return { W, H, cw, cy: H * 0.56, R: Math.min(H * 0.42, cw * 0.16) };
  }

  /** 속도(km/h)와 기어는 너무 자주 그리지 않는다 (0.1초). 표시등이 바뀌면 바로 그린다 */
  update(kmh: number, gear: string, time: number, tells: ClusterTells = NO_TELLS) {
    const key = `${Math.round(kmh)}|${gear}`;
    const tk = tellKey(tells);
    if (tk === this.tellKey && (key === this.key || time - this.last < 0.1)) return;
    this.last = time;
    this.draw(kmh, gear, tells);
  }

  private draw(kmh: number, gear: string, tells: ClusterTells) {
    this.key = `${Math.round(kmh)}|${gear}`;
    this.tellKey = tellKey(tells);
    const g = this.g;
    const { W, H, cw, cy, R } = this.layout();
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0d141d");
    bg.addColorStop(1, "#070a0f");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // 속도 원호 (왼쪽), 출력 원호 (오른쪽)
    const arc = (x: number, frac: number, col: string) => {
      g.lineCap = "round";
      g.lineWidth = R * 0.09;
      g.strokeStyle = "rgba(120,150,180,0.22)";
      g.beginPath();
      g.arc(x, cy, R, Math.PI * 0.8, Math.PI * 2.2);
      g.stroke();
      g.strokeStyle = col;
      g.beginPath();
      g.arc(x, cy, R, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * Math.max(0.01, Math.min(1, frac))));
      g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = "rgba(200,220,240,0.55)";
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI * (0.8 + (1.4 * i) / 12);
        g.beginPath();
        g.moveTo(x + Math.cos(a) * R * 0.78, cy + Math.sin(a) * R * 0.78);
        g.lineTo(x + Math.cos(a) * R * 0.7, cy + Math.sin(a) * R * 0.7);
        g.stroke();
      }
    };
    // 후측방 화면이 뜬 원은 비워 둔다 (그 위에 카메라 화면을 얹는다)
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (tells.bvm !== -1) {
      arc(cw * 0.2, kmh / 200, "#4fb3ff");
      g.font = `600 ${Math.round(R * 0.42)}px sans-serif`;
      g.fillStyle = gear === "R" ? "#ffb14a" : "#dfe8f2";
      g.fillText(gear, cw * 0.2, cy);
    }
    if (tells.bvm !== 1) {
      arc(cw * 0.8, 0.15 + Math.min(0.6, kmh / 260), "#7fe3c0");
      g.font = `${Math.round(R * 0.26)}px sans-serif`;
      g.fillStyle = "#7fe3c0";
      g.fillText("ECO", cw * 0.8, cy);
    }
    g.fillStyle = "#eef4fa";
    g.font = `600 ${Math.round(R * 0.95)}px sans-serif`;
    g.fillText(String(Math.round(kmh)), cw * 0.5, cy - R * 0.1);
    g.font = `${Math.round(R * 0.28)}px sans-serif`;
    g.fillStyle = "#8aa0b4";
    g.fillText("km/h", cw * 0.5, cy + R * 0.55);
    drawTells(g, cw * 0.5, cy, R, tells);
    if (this.wide) {
      // 내비게이션: 어두운 지도, 도로, 파란 경로
      const x0 = W * 0.5;
      const mw = W - x0 - H * 0.12;
      g.fillStyle = "#101923";
      g.fillRect(x0, H * 0.08, mw, H * 0.84);
      g.strokeStyle = "#1f2e3d";
      g.lineWidth = 4;
      for (let i = 0; i < 8; i++) {
        g.beginPath();
        g.moveTo(x0 + i * mw * 0.14, H * 0.08);
        g.lineTo(x0 + i * mw * 0.1 + mw * 0.15, H * 0.92);
        g.stroke();
      }
      g.strokeStyle = "#2c3f52";
      g.lineWidth = 10;
      g.beginPath();
      g.moveTo(x0, H * 0.7);
      g.bezierCurveTo(x0 + mw * 0.3, H * 0.6, x0 + mw * 0.6, H * 0.4, x0 + mw, H * 0.3);
      g.stroke();
      g.strokeStyle = "#3aa0ff";
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(x0 + mw * 0.42, H * 0.92);
      g.bezierCurveTo(x0 + mw * 0.42, H * 0.6, x0 + mw * 0.47, H * 0.45, x0 + mw * 0.62, H * 0.08);
      g.stroke();
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.moveTo(x0 + mw * 0.42, H * 0.64);
      g.lineTo(x0 + mw * 0.405, H * 0.8);
      g.lineTo(x0 + mw * 0.435, H * 0.8);
      g.fill();
      g.fillStyle = "rgba(8,12,18,0.8)";
      g.fillRect(x0 + mw * 0.03, H * 0.14, mw * 0.28, H * 0.26);
      g.fillStyle = "#dfe8f2";
      g.textAlign = "left";
      g.font = `${Math.round(H * 0.14)}px sans-serif`;
      g.fillText("1.2 km  ↑", x0 + mw * 0.05, H * 0.27);
    }
    this.texture.needsUpdate = true;
  }
}

function tellKey(t: ClusterTells): string {
  return `${+t.left}${+t.right}${+t.hazard}|${t.lka}${t.lkaSide}|${t.bvm}`;
}

/**
 * 계기판 가운데 위 표시등: 방향지시 화살표 (ISO 2575 녹색, 켜진 순간에 빛 번짐), 그 사이 비상등,
 * 속도 숫자 아래 차로 유지 보조 (대기 회색, 준비 녹색, 경고 주황 + 넘으려는 쪽 차선이 굵어진다)
 */
function drawTells(g: CanvasRenderingContext2D, x: number, cy: number, R: number, t: ClusterTells) {
  const y = cy - R * 0.84;
  const a = R * 0.2;
  const arrow = (cx: number, dir: number, on: boolean) => {
    g.save();
    g.translate(cx, y);
    g.scale(dir, 1);
    g.beginPath();
    g.moveTo(-a * 1.3, 0);
    g.lineTo(-a * 0.1, -a);
    g.lineTo(-a * 0.1, -a * 0.45);
    g.lineTo(a * 1.2, -a * 0.45);
    g.lineTo(a * 1.2, a * 0.45);
    g.lineTo(-a * 0.1, a * 0.45);
    g.lineTo(-a * 0.1, a);
    g.closePath();
    if (on) {
      g.shadowColor = "#3dff7e";
      g.shadowBlur = R * 0.35;
      g.fillStyle = "#3dff7e";
      g.fill();
    } else {
      g.fillStyle = "rgba(90,120,100,0.22)";
      g.fill();
    }
    g.restore();
  };
  arrow(x - R * 1.05, 1, t.left);
  arrow(x + R * 1.05, -1, t.right);
  if (t.hazard) {
    g.save();
    g.strokeStyle = "#ff4a3d";
    g.lineWidth = R * 0.05;
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(x, y - a);
    g.lineTo(x + a * 1.1, y + a * 0.9);
    g.lineTo(x - a * 1.1, y + a * 0.9);
    g.closePath();
    g.stroke();
    g.restore();
  }
  if (t.lka === "off") return;
  const col = t.lka === "warn" ? "#ffb84a" : t.lka === "ready" ? "#3dff7e" : "#8a9aac";
  const ly = cy + R * 0.86;
  const s = R * 0.14;
  g.save();
  g.strokeStyle = col;
  g.lineCap = "round";
  // 차선 두 줄 (멀어질수록 좁아진다), 가운데 운전대
  for (const side of [-1, 1]) {
    g.lineWidth = t.lka === "warn" && t.lkaSide === side ? s * 0.5 : s * 0.22;
    g.beginPath();
    g.moveTo(x + side * s * 1.9, ly + s);
    g.lineTo(x + side * s * 1.1, ly - s);
    g.stroke();
  }
  g.lineWidth = s * 0.22;
  g.beginPath();
  g.arc(x, ly + s * 0.1, s * 0.62, 0, Math.PI * 2);
  g.moveTo(x - s * 0.62, ly + s * 0.1);
  g.lineTo(x + s * 0.62, ly + s * 0.1);
  g.stroke();
  g.restore();
}

export function buildCockpit(model: VehicleModel): Cockpit {
  const cab: CabinSpec = model.cabin;
  const t = model.type;
  const group = new THREE.Group();
  const m = new Mesher();
  const big = cab.kind === "bus" || cab.kind === "truck";
  const eye = cab.eye;
  const { x0, x1, y: dy, w } = cab.dash;
  const dz = cab.dash.z ?? 0;
  const hw = w / 2;
  const premium = /luxury|flagship|large|import/.test(t.id);
  // 앞유리 면(높이 y에서 x)보다 3cm 안쪽까지만: 눈이 유리에 가까운 트럭은 대시보드·계기판이 유리 밖으로 튀어나오지 않게 (앞유리 빗방울이 그 위에 그려진다)
  const [gbx, gby] = cab.wsBase;
  const [gtx, gty] = cab.wsTop;
  const glassX = (y: number) => gbx + ((gtx - gbx) * Math.max(0, y - gby)) / (gty - gby) - 0.03;
  const inside = (p: [number, number]): [number, number] => (p[1] > gby ? [Math.min(p[0], glassX(p[1])), p[1]] : p);

  // ---- 대시보드: 옆모양을 폭만큼 뽑는다 ----
  // 운전자 앞 윗면은 눈보다 충분히 낮게 (길이 잘 보이게), 앞유리 쪽으로 조금 내려간다
  const dT = Math.min(dy + 0.02, eye.y - (big ? 0.28 : 0.21));
  const dash = (
    [
      [x0 + 0.02, Math.min(dy, dT) - 0.05],
      [x0 - 0.1, Math.min(dy, dT) - 0.005],
      [x1 + 0.24, dT + 0.02],
      [x1 + 0.06, dT + 0.012],
      [x1 + 0.005, dT - 0.03],
      [x1 + 0.02, dT - 0.16],
      [x1 + 0.13, dT - 0.27],
      [x1 + 0.15, dT - 0.55],
      [x0 + 0.02, dT - 0.55],
    ] as [number, number][]
  ).map(inside);
  profile(m, dash, w, IN.dash, dz, 0.02);
  // 윗면 덮개 (조금 밝은 가죽 느낌) + 가운데 장식 띠 (금속) + 무드등
  const topY = (Math.min(dy, dT) + dT) / 2 + 0.012;
  const topLen = Math.max(0.05, x0 - x1 - 0.3);
  box(m, topLen, 0.004, w - 0.04, Math.min((x0 + x1) / 2 + 0.08, glassX(topY) - topLen / 2), topY, dz, IN.dashTop, 0, -0.02);
  box(m, 0.012, 0.016, w - 0.1, x1 + 0.03, dT - 0.05, dz, IN.trim);
  if (!big) box(m, 0.006, 0.005, w - 0.2, x1 + 0.028, dT - 0.066, dz, IN.ambient);
  // 송풍구
  for (const z of (big ? [eye.z - 0.3, eye.z + 0.4, 0.25, 0.6] : [eye.z - 0.26, -0.09, 0.09, -eye.z + 0.26]).filter((z) => Math.abs(z - dz) < hw - 0.1)) {
    cbox(m, 0.02, 0.045, 0.12, 0.01, x1 + 0.035, dT - 0.1, z, IN.gloss);
    for (let k = -1; k <= 1; k++) box(m, 0.004, 0.004, 0.11, x1 + 0.024, dT - 0.1 + k * 0.012, z, IN.trim);
  }

  // ---- 화면: 계기판 + (승용차) 내비 파노라마. 대시보드 위에 떠 있고 윗변은 눈보다 8cm 넘게 아래 ----
  const wide = !big;
  const sw = wide ? Math.min(0.92, hw + Math.abs(eye.z) - 0.08) : 0.36;
  const sBot = dT + 0.022;
  const sh = Math.max(0.07, Math.min(wide ? 0.105 : 0.14, eye.y - (big ? 0.14 : 0.085) - sBot));
  const sx = Math.min(x1 + (wide ? 0.16 : 0.12), glassX(sBot + sh + 0.03) - (wide ? 0.06 : 0.14));
  const sy = sBot + sh / 2;
  const sz = wide ? eye.z - 0.2 + sw / 2 : eye.z;
  const tiltS = 0.18;
  // 화면 판 (검은 유리 테) + 뒤 받침. 화면처럼 위가 뒤로 조금 눕는다
  cbox(m, 0.02, sh + 0.014, sw + 0.014, 0.006, sx + 0.012, sy, sz, IN.gloss, 0, -tiltS);
  cbox(m, 0.08, 0.05, sw - 0.12, 0.015, sx + 0.06, sBot - 0.005, sz, IN.dash);
  if (!wide) cbox(m, 0.14, 0.02, sw + 0.05, 0.01, sx + 0.05, sBot + sh + 0.02, sz, IN.dash);
  const display = new ClusterScreen(wide, sw / sh);
  const screen = new THREE.MeshBasicMaterial({ map: display.texture, toneMapped: true });
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), screen);
  scr.position.set(sx + 0.001, sy, sz);
  scr.rotation.set(0, -Math.PI / 2, 0);
  scr.rotateX(-tiltS);
  group.add(scr);
  // 후측방 화면: 원 자리에 얹는 둥근 판 (거울처럼 좌우를 뒤집는다). 방향지시등을 켰을 때만 보인다
  const disc = (side: number): THREE.Mesh => {
    const gp = display.gauge(side);
    const geo = new THREE.CircleGeometry(gp.r * sw * 1.08, 40);
    const uv = geo.getAttribute("uv");
    for (let k = 0; k < uv.count; k++) uv.setX(k, 1 - uv.getX(k));
    const m = new THREE.Mesh(geo, screen);
    m.position.set((gp.u - 0.5) * sw, (0.5 - gp.v) * sh, 0.002);
    m.visible = false;
    scr.add(m);
    return m;
  };
  const bvm: [THREE.Mesh, THREE.Mesh] = [disc(-1), disc(1)];
  if (big) {
    // 큰 차: 가운데 작은 화면
    const s2 = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.13), screen);
    s2.position.set(x1 + 0.1, dT - 0.1, Math.min(dz + hw - 0.2, 0.15));
    s2.rotation.set(0, -Math.PI / 2, 0);
    group.add(s2);
  }

  // ---- 가운데 콘솔·기어 (승용차) ----
  if (!big) {
    const cy = cab.floorY + 0.42;
    const cz = 0;
    cbox(m, x1 - (eye.x - 0.45) + 0.1, cy - cab.floorY, 0.24, 0.03, (x1 + eye.x - 0.45) / 2, (cy + cab.floorY) / 2, cz, IN.plastic);
    cbox(m, 0.5, 0.05, 0.22, 0.02, eye.x - 0.22, cy + 0.03, cz, IN.leather);
    cbox(m, 0.26, 0.02, 0.2, 0.01, x1 - 0.18, cy + 0.005, cz, IN.gloss);
    cyl(m, 0.022, 0.07, x1 - 0.12, cy + 0.045, cz, "y", IN.trim, 10);
    // 가운데 아래 패널
    cbox(m, 0.1, 0.3, 0.26, 0.02, x1 + 0.06, dT - 0.33, cz, IN.gloss, 0, -0.35);
  }

  // ---- 조수석 ----
  if (!big || cab.kind === "van") {
    const zs = -eye.z;
    const sx0 = eye.x + 0.05;
    const fy = cab.floorY;
    const seatS = premium ? IN.seatLight : IN.seat;
    cbox(m, 0.52, 0.12, 0.5, 0.05, sx0 + 0.12, fy + 0.3, zs, seatS);
    cbox(m, 0.14, 0.62, 0.5, 0.06, sx0 - 0.2, fy + 0.62, zs, seatS, 0, 0.22);
    cbox(m, 0.1, 0.18, 0.28, 0.04, sx0 - 0.28, fy + 1.02, zs, seatS, 0, 0.12);
  }

  // ---- 룸미러·햇빛가리개 ----
  const rg = cab.glass[0];
  cbox(m, 0.035, rg.h + 0.018, rg.w + 0.02, 0.012, rg.c.x + 0.019, rg.c.y, 0, IN.plastic);
  box(m, 0.004, rg.h, rg.w, rg.c.x + 0.002, rg.c.y, 0, IN.mirror);
  const stemY = Math.max(0.03, cab.roofY - rg.c.y - rg.h / 2);
  box(m, 0.018, stemY, 0.022, rg.c.x + 0.045, cab.roofY - stemY / 2, 0, IN.plastic);
  const visY = cab.roofY - 0.03;
  const visX = cab.wsTop[0] - 0.14;
  for (const z of [eye.z, -eye.z]) cbox(m, 0.22, 0.02, 0.38, 0.01, visX, visY, z, cab.light ? IN.head : IN.headDark);

  // ---- 버스·트럭·승합: 운전실 벽 (차체 안쪽 면이 없을 때) ----
  if (!model.interior.getAttribute("position")?.count) cabinWalls(m, cab);

  // ---- 운전대 ----
  const wheelMat = createVehicleMaterial({ clearcoat: false });
  const wheelGroup = new THREE.Group();
  wheelGroup.position.copy(cab.wheel.pos);
  wheelGroup.rotation.z = -cab.wheel.tilt;
  const spin = new THREE.Group();
  wheelGroup.add(spin);
  const wm = new Mesher();
  const R = cab.wheel.r;
  const rim = new THREE.TorusGeometry(R, big ? 0.018 : 0.02, 10, 40);
  rim.rotateY(Math.PI / 2);
  wm.geo(rim, IN.leather);
  // 가운데 (에어백) + 살
  cbox(wm, 0.05, R * 0.55, R * 0.7, 0.03, 0.01, 0, 0, IN.leather);
  box(wm, 0.006, R * 0.12, R * 0.22, -0.018, R * 0.02, 0, IN.trim);
  for (const s of [-1, 1]) cbox(wm, 0.025, 0.03, R * 0.62, 0.01, 0.004, -R * 0.08, s * R * 0.62, IN.leather);
  cbox(wm, 0.025, R * 0.62, 0.035, 0.01, 0.004, -R * 0.62, 0, IN.leather);
  for (const s of [-1, 1]) box(wm, 0.012, 0.012, 0.05, -0.016, -R * 0.08, s * R * 0.42, IN.trim);
  const wheelMesh = new THREE.Mesh(wm.build(), wheelMat);
  spin.add(wheelMesh);
  // 운전대 기둥
  cyl(m, 0.035, 0.34, cab.wheel.pos.x + 0.16, cab.wheel.pos.y - 0.07, cab.wheel.pos.z, "x", IN.plastic, 10, 0.045);
  group.add(wheelGroup);

  // 실내는 클리어코트 없이 (화면을 넓게 덮으니 가볍게)
  const material = createVehicleMaterial({ lamps: true, clearcoat: false });
  const mesh = new THREE.Mesh(m.build(), material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);
  return { group, wheel: spin, material, screen, display, bvm };
}

/** 상자형 운전실 벽: 천장, 앞유리 옆 기둥, 문 안쪽, 뒷벽 */
function cabinWalls(m: Mesher, cab: CabinSpec) {
  const hw = cab.dash.w / 2 + 0.08;
  const [wx, wy] = cab.wsBase;
  const [tx, ty] = cab.wsTop;
  const back = cab.eye.x - 0.9;
  const len = wx - back;
  // 천장
  box(m, len + 0.1, 0.04, hw * 2, (wx + back) / 2, cab.roofY + 0.02, 0, IN.headDark);
  // 앞유리 위 테
  box(m, 0.12, 0.1, hw * 2, tx - 0.04, ty - 0.03, 0, IN.plastic);
  for (const s of [-1, 1]) {
    // 앞유리 옆 기둥
    const a = new THREE.Vector3(wx, wy, s * (hw - 0.04));
    const b = new THREE.Vector3(tx, ty, s * (hw - 0.04));
    const l = a.distanceTo(b);
    const g = new THREE.BoxGeometry(l, 0.1, 0.08);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), b.clone().sub(a).normalize());
    g.applyQuaternion(q);
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, a.z);
    m.geo(g, IN.plastic);
    // 문 안쪽 (창 아래)
    box(m, len, cab.beltY - cab.floorY, 0.05, (wx + back) / 2, (cab.beltY + cab.floorY) / 2, s * hw, IN.dash);
    box(m, len, 0.05, 0.12, (wx + back) / 2, cab.beltY, s * (hw - 0.04), IN.plastic);
    // 문 뒤 기둥
    box(m, 0.12, cab.roofY - cab.beltY, 0.08, back + 0.06, (cab.roofY + cab.beltY) / 2, s * (hw - 0.02), IN.plastic);
  }
  // 뒷벽
  box(m, 0.05, cab.roofY - cab.floorY, hw * 2, back, (cab.roofY + cab.floorY) / 2, 0, IN.dash);
  // 바닥
  box(m, len, 0.04, hw * 2, (wx + back) / 2, cab.floorY, 0, IN.floor);
}
