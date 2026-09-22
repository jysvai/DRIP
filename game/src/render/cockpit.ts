// 운전석 실내: 대시보드(파노라마 디스플레이), 운전대, 가운데 콘솔, 조수석, 룸미러, 햇빛가리개.
// 차종마다 모델의 운전석 배치(CabinSpec)에 맞춰 만든다. 승용차는 차체 안쪽 면(model.interior)이 천장·기둥·문을 이루고,
// 버스·트럭은 여기서 상자형 운전실 벽을 따로 만든다. 한국 차는 왼쪽 운전석(z < 0).
// 좌표: 모델 좌표 (x 앞, y 위, z 오른쪽)

import * as THREE from "three";
import { createVehicleMaterial } from "./carMaterials";
import { Mesher, box, cbox, cyl, profile, TAG, type Surf } from "./vehicleGeom";
import type { CabinSpec, VehicleModel } from "./vehicleModels";

const IN = {
  dash: { color: 0x1d1e21, r: 0.82, m: 0, c: 0, tag: 0 } as Surf,
  dashTop: { color: 0x232427, r: 0.9, m: 0, c: 0, tag: 0 } as Surf,
  trim: { color: 0x9aa0a7, r: 0.3, m: 1, c: 0, tag: 0 } as Surf,
  gloss: { color: 0x0a0b0c, r: 0.1, m: 0.1, c: 1, tag: 0 } as Surf,
  leather: { color: 0x17181a, r: 0.55, m: 0, c: 0.3, tag: 0 } as Surf,
  seat: { color: 0x2a2826, r: 0.75, m: 0, c: 0.1, tag: 0 } as Surf,
  seatLight: { color: 0x8a7d6c, r: 0.7, m: 0, c: 0.1, tag: 0 } as Surf,
  plastic: { color: 0x2c2d30, r: 0.8, m: 0, c: 0, tag: 0 } as Surf,
  head: { color: 0x9c988e, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
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
}

/** 계기판·내비 화면 무늬 (캔버스) */
function screenTexture(wide: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = wide ? 1024 : 512;
  c.height = 160;
  const g = c.getContext("2d")!;
  g.fillStyle = "#05070a";
  g.fillRect(0, 0, c.width, c.height);
  // 계기판: 두 원 (속도·회전수)
  const ring = (x: number, col: string, frac: number) => {
    g.lineWidth = 6;
    g.strokeStyle = "rgba(120,140,160,0.35)";
    g.beginPath();
    g.arc(x, 88, 56, Math.PI * 0.75, Math.PI * 2.25);
    g.stroke();
    g.strokeStyle = col;
    g.beginPath();
    g.arc(x, 88, 56, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * frac));
    g.stroke();
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * (0.75 + 0.15 * i);
      g.strokeStyle = "rgba(200,220,240,0.6)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * 46, 88 + Math.sin(a) * 46);
      g.lineTo(x + Math.cos(a) * 40, 88 + Math.sin(a) * 40);
      g.stroke();
    }
  };
  ring(90, "#58b8ff", 0.55);
  ring(390, "#9ff0c8", 0.3);
  g.fillStyle = "#dfe8f2";
  g.font = "bold 30px sans-serif";
  g.textAlign = "center";
  g.fillText("D", 240, 96);
  g.font = "16px sans-serif";
  g.fillStyle = "#8aa0b4";
  g.fillText("ECO", 240, 124);
  if (wide) {
    // 내비게이션: 어두운 지도 + 파란 경로
    g.fillStyle = "#0b1118";
    g.fillRect(540, 14, 470, 132);
    g.strokeStyle = "#1c2733";
    g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(540 + i * 90, 14);
      g.lineTo(600 + i * 70, 146);
      g.stroke();
    }
    g.strokeStyle = "#3aa0ff";
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(770, 146);
    g.bezierCurveTo(760, 100, 800, 70, 830, 20);
    g.stroke();
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(770, 120);
    g.lineTo(760, 140);
    g.lineTo(780, 140);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildCockpit(model: VehicleModel): Cockpit {
  const cab: CabinSpec = model.cabin;
  const t = model.type;
  const group = new THREE.Group();
  const m = new Mesher();
  const car = cab.kind === "car";
  const big = cab.kind === "bus" || cab.kind === "truck";
  const eye = cab.eye;
  const { x0, x1, y: dy, w } = cab.dash;
  const hw = w / 2;
  const premium = /luxury|flagship|large|import/.test(t.id);

  // ---- 대시보드: 옆모양을 폭만큼 뽑는다 ----
  const dash: [number, number][] = [
    [x0 + 0.02, dy - 0.03],
    [x0 - 0.12, dy + 0.005],
    [x1 + 0.2, dy + 0.03],
    [x1 + 0.06, dy + 0.01],
    [x1, dy - 0.06],
    [x1 + 0.03, dy - 0.2],
    [x1 + 0.14, dy - 0.3],
    [x1 + 0.16, dy - 0.55],
    [x0 + 0.02, dy - 0.55],
  ];
  profile(m, dash, w, IN.dash, 0, 0.02);
  // 대시보드 가운데 장식 띠 (금속) + 무드등
  box(m, 0.012, 0.018, w - 0.1, x1 + 0.035, dy - 0.075, 0, IN.trim);
  if (!big) box(m, 0.006, 0.006, w - 0.2, x1 + 0.03, dy - 0.092, 0, IN.ambient);
  // 송풍구
  for (const z of big ? [eye.z + 0.45, 0.25, 0.6] : [eye.z - 0.24, -0.1, 0.1, -eye.z + 0.24]) {
    cbox(m, 0.02, 0.05, 0.13, 0.01, x1 + 0.03, dy - 0.13, z, IN.gloss);
  }

  // ---- 화면: 계기판 + (승용차) 내비 파노라마 ----
  const wide = !big;
  const sw = wide ? Math.min(0.95, hw + Math.abs(eye.z) - 0.05) : 0.38;
  const sh = wide ? 0.13 : 0.16;
  const sx = x1 + 0.13;
  const sy = dy + (wide ? 0.09 : 0.06);
  const sz = wide ? eye.z - 0.19 + sw / 2 : eye.z;
  // 화면 덮개 (계기판 위 차양)
  cbox(m, 0.12, 0.03, sw + 0.06, 0.012, sx + 0.02, sy + sh / 2 + 0.01, sz, IN.dash);
  cbox(m, 0.03, sh + 0.03, sw + 0.03, 0.01, sx + 0.012, sy, sz, IN.gloss, 0, 0.26);
  if (!wide) cbox(m, 0.16, sh + 0.02, sw + 0.05, 0.02, sx + 0.08, sy - 0.02, sz, IN.dash);
  const screen = new THREE.MeshBasicMaterial({ map: screenTexture(wide), toneMapped: true });
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), screen);
  scr.position.set(sx - 0.004, sy, sz);
  scr.rotation.set(0, -Math.PI / 2, 0);
  scr.rotateX(-0.26);
  group.add(scr);
  if (big) {
    // 큰 차: 가운데 작은 화면
    const s2 = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.13), screen);
    s2.position.set(x1 + 0.1, dy + 0.02, 0.15);
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
    cbox(m, 0.1, 0.3, 0.26, 0.02, x1 + 0.05, dy - 0.33, cz, IN.gloss, 0, -0.35);
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
  const rm = cab.mirrorC;
  cbox(m, 0.03, 0.07, 0.25, 0.02, rm.x + 0.02, rm.y, 0, IN.plastic);
  box(m, 0.005, 0.055, 0.23, rm.x + 0.004, rm.y, 0, IN.mirror);
  box(m, 0.02, rm.y < cab.roofY - 0.02 ? cab.roofY - rm.y : 0.02, 0.02, rm.x + 0.05, (rm.y + cab.roofY) / 2, 0, IN.plastic);
  const visY = cab.roofY - 0.03;
  const visX = cab.wsTop[0] - 0.14;
  for (const z of [eye.z, -eye.z]) cbox(m, 0.22, 0.02, 0.38, 0.01, visX, visY, z, car && premium ? IN.head : IN.plastic);

  // ---- 버스·트럭·승합: 운전실 벽 (차체 안쪽 면이 없을 때) ----
  if (!model.interior.getAttribute("position")?.count) cabinWalls(m, cab);

  // ---- 운전대 ----
  const wheelMat = createVehicleMaterial({});
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

  const material = createVehicleMaterial({ lamps: true });
  const mesh = new THREE.Mesh(m.build(), material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);
  return { group, wheel: spin, material, screen };
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
