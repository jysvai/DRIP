// 차종 데이터(vehicles.json)로 저폴리 3D 모델을 코드로 만든다.
// 모델 좌표: +X 앞, +Y 위, +Z 오른쪽. 원점은 차 길이의 가운데, 바닥 높이.
// 도색 부분(paint)과 고정 색 부분(fixed)을 따로 만들어서, 도색은 인스턴스마다 색을 바꿔 칠한다.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface VehicleType {
  id: string;
  name: string;
  category: string;
  body: string;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  paint: string | string[];
  plate: "white" | "yellow" | "ev";
  ev?: boolean;
  heavy?: boolean;
  extras?: string[];
  sign?: string;
  livery?: string;
  cargo?: string;
  axles?: number;
  maxSpeed: number;
  accel: number;
  share: number;
}

export interface VehicleCatalog {
  palettes: Record<string, string[]>;
  types: VehicleType[];
}

export interface VehicleModel {
  type: VehicleType;
  paint: THREE.BufferGeometry;
  fixed: THREE.BufferGeometry;
  /** 전조등·제동등·방향지시등 위치 (모델 좌표) */
  headLights: THREE.Vector3[];
  brakeLights: THREE.Vector3[];
  signalLeft: THREE.Vector3[];
  signalRight: THREE.Vector3[];
  lightSize: number;
}

const C = {
  glass: 0x1d2630,
  glassDark: 0x10151b,
  tire: 0x161718,
  rim: 0x9aa0a6,
  rimDark: 0x3a3d41,
  trim: 0x222325,
  chassis: 0x2a2b2d,
  grille: 0x1a1b1d,
  headlight: 0xe8eef2,
  taillight: 0x6e0f14,
  signal: 0xc77a12,
  plateWhite: 0xf1f1ec,
  plateYellow: 0xf0c419,
  plateEv: 0x5aa9e6,
  chrome: 0xc9ccd0,
  cargoGray: 0x8a8f94,
  cargoBlue: 0x2d5e9e,
  alu: 0xd3d6d9,
  wood: 0x8c6a45,
  steel: 0x6c7075,
  black: 0x111111,
};

class Builder {
  paint: THREE.BufferGeometry[] = [];
  fixed: THREE.BufferGeometry[] = [];
  head: THREE.Vector3[] = [];
  brake: THREE.Vector3[] = [];
  sigL: THREE.Vector3[] = [];
  sigR: THREE.Vector3[] = [];

  add(g: THREE.BufferGeometry, color: number | null, target: "paint" | "fixed") {
    let geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute("uv");
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    const count = geo.getAttribute("position").count;
    const col = new Float32Array(count * 3);
    const c = new THREE.Color(color ?? 0xffffff);
    if (color === null) c.setScalar(1);
    for (let i = 0; i < count; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    (target === "paint" ? this.paint : this.fixed).push(geo);
    if (geo !== g) g.dispose();
  }

  /** 가운데 좌표(x, y, z)와 크기로 상자 */
  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: number | "paint", shade = 1) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    if (color === "paint") this.add(g, shade === 1 ? null : new THREE.Color(shade, shade, shade).getHex(), "paint");
    else this.add(g, color, "fixed");
  }

  /** 옆모양(x 앞, y 위) 다각형을 폭 w로 뽑아낸다 */
  profile(pts: [number, number][], w: number, color: number | "paint", zc = 0, bevel = 0.04, shade = 1) {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const depth = Math.max(0.01, w - bevel * 2);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      // 모서리를 깎아도 옆면이 주어진 윤곽에 그대로 오게 (안 그러면 전조등·그릴·유리가 차체 속에 묻힌다)
      bevelOffset: -bevel,
      bevelSegments: 1,
      curveSegments: 4,
    });
    g.translate(0, 0, zc - depth / 2);
    if (color === "paint") this.add(g, shade === 1 ? null : new THREE.Color(shade, shade, shade).getHex(), "paint");
    else this.add(g, color, "fixed");
  }

  cylinder(r: number, len: number, x: number, y: number, z: number, axis: "x" | "y" | "z", color: number | "paint", seg = 12) {
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    if (axis === "x") g.rotateZ(Math.PI / 2);
    if (axis === "z") g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    if (color === "paint") this.add(g, null, "paint");
    else this.add(g, color, "fixed");
  }

  wheel(x: number, z: number, r: number, width: number, dual = false) {
    const side = Math.sign(z);
    this.cylinder(r, width, x, r, z, "z", C.tire, 14);
    this.cylinder(r * 0.62, 0.02, x, r, z + side * (width / 2 + 0.005), "z", dual ? C.rimDark : C.rim, 10);
    if (dual) this.cylinder(r, width, x, r, z - side * (width + 0.02), "z", C.tire, 14);
  }

  build(type: VehicleType, lightSize: number): VehicleModel {
    const paint = this.paint.length ? mergeGeometries(this.paint)! : new THREE.BufferGeometry();
    const fixed = mergeGeometries(this.fixed)!;
    this.paint.forEach((g) => g.dispose());
    this.fixed.forEach((g) => g.dispose());
    paint.computeBoundingSphere();
    fixed.computeBoundingSphere();
    return { type, paint, fixed, headLights: this.head, brakeLights: this.brake, signalLeft: this.sigL, signalRight: this.sigR, lightSize };
  }
}

// ---------- 승용차 ----------

interface CarShape {
  hood: number; // 앞끝에서 앞유리 아래까지 (길이 비율)
  roofF: number; // 앞끝에서 지붕 앞까지
  roofR: number; // 앞끝에서 지붕 뒤까지
  glassR: number; // 앞끝에서 뒷유리 아래까지
  belt: number; // 창문 아래선 높이 (전고 비율)
  nose: number; // 앞끝 높이
  tail: number; // 뒤끝 높이
  deck?: number; // 트렁크 높이 (없으면 belt)
  ground: number; // 차체 바닥 높이
  wheelR: number; // 바퀴 반지름 (m)
  bed?: boolean; // 픽업 적재함
  grille?: boolean;
}

const SHAPES: Record<string, CarShape> = {
  microcar: { hood: 0.2, roofF: 0.36, roofR: 0.86, glassR: 0.96, belt: 0.58, nose: 0.47, tail: 0.6, ground: 0.1, wheelR: 0.29, grille: true },
  box_micro: { hood: 0.16, roofF: 0.27, roofR: 0.95, glassR: 0.985, belt: 0.52, nose: 0.44, tail: 0.55, ground: 0.1, wheelR: 0.29, grille: true },
  hatch: { hood: 0.27, roofF: 0.42, roofR: 0.84, glassR: 0.95, belt: 0.62, nose: 0.47, tail: 0.62, ground: 0.1, wheelR: 0.31, grille: true },
  sedan: { hood: 0.29, roofF: 0.44, roofR: 0.71, glassR: 0.84, belt: 0.64, nose: 0.47, tail: 0.64, deck: 0.7, ground: 0.1, wheelR: 0.32, grille: true },
  fastback: { hood: 0.3, roofF: 0.45, roofR: 0.66, glassR: 0.9, belt: 0.64, nose: 0.45, tail: 0.66, deck: 0.7, ground: 0.1, wheelR: 0.33, grille: true },
  sedan_large: { hood: 0.3, roofF: 0.45, roofR: 0.72, glassR: 0.84, belt: 0.65, nose: 0.49, tail: 0.66, deck: 0.71, ground: 0.1, wheelR: 0.34, grille: true },
  coupe: { hood: 0.33, roofF: 0.48, roofR: 0.64, glassR: 0.9, belt: 0.63, nose: 0.43, tail: 0.64, deck: 0.68, ground: 0.09, wheelR: 0.34, grille: true },
  sports: { hood: 0.33, roofF: 0.47, roofR: 0.6, glassR: 0.92, belt: 0.62, nose: 0.36, tail: 0.66, deck: 0.66, ground: 0.08, wheelR: 0.34, grille: false },
  wagon: { hood: 0.29, roofF: 0.44, roofR: 0.92, glassR: 0.975, belt: 0.64, nose: 0.47, tail: 0.66, ground: 0.1, wheelR: 0.33, grille: true },
  suv_small: { hood: 0.26, roofF: 0.4, roofR: 0.87, glassR: 0.95, belt: 0.6, nose: 0.52, tail: 0.64, ground: 0.13, wheelR: 0.35, grille: true },
  suv_mid: { hood: 0.26, roofF: 0.4, roofR: 0.9, glassR: 0.96, belt: 0.6, nose: 0.55, tail: 0.66, ground: 0.13, wheelR: 0.37, grille: true },
  suv_large: { hood: 0.26, roofF: 0.39, roofR: 0.92, glassR: 0.97, belt: 0.6, nose: 0.57, tail: 0.67, ground: 0.13, wheelR: 0.39, grille: true },
  suv_coupe: { hood: 0.27, roofF: 0.41, roofR: 0.7, glassR: 0.93, belt: 0.6, nose: 0.55, tail: 0.68, ground: 0.13, wheelR: 0.39, grille: true },
  suv_boxy: { hood: 0.22, roofF: 0.3, roofR: 0.93, glassR: 0.96, belt: 0.58, nose: 0.6, tail: 0.65, ground: 0.15, wheelR: 0.4, grille: true },
  pickup: { hood: 0.24, roofF: 0.35, roofR: 0.55, glassR: 0.58, belt: 0.58, nose: 0.57, tail: 0.58, ground: 0.14, wheelR: 0.39, bed: true, grille: true },
  mpv: { hood: 0.17, roofF: 0.28, roofR: 0.95, glassR: 0.985, belt: 0.56, nose: 0.46, tail: 0.6, ground: 0.1, wheelR: 0.36, grille: true },
  van: { hood: 0.1, roofF: 0.2, roofR: 0.97, glassR: 0.99, belt: 0.55, nose: 0.44, tail: 0.58, ground: 0.1, wheelR: 0.37, grille: true },
  ev_sedan: { hood: 0.27, roofF: 0.42, roofR: 0.64, glassR: 0.93, belt: 0.63, nose: 0.44, tail: 0.68, deck: 0.7, ground: 0.1, wheelR: 0.34, grille: false },
  ev_hatch_suv: { hood: 0.24, roofF: 0.37, roofR: 0.93, glassR: 0.975, belt: 0.6, nose: 0.47, tail: 0.64, ground: 0.12, wheelR: 0.36, grille: false },
  ev_crossover: { hood: 0.26, roofF: 0.4, roofR: 0.76, glassR: 0.94, belt: 0.61, nose: 0.47, tail: 0.66, ground: 0.12, wheelR: 0.36, grille: false },
  ev_suv: { hood: 0.23, roofF: 0.35, roofR: 0.94, glassR: 0.975, belt: 0.58, nose: 0.55, tail: 0.66, ground: 0.13, wheelR: 0.38, grille: false },
};

function plateColor(t: VehicleType): number {
  return t.plate === "yellow" ? C.plateYellow : t.plate === "ev" ? C.plateEv : C.plateWhite;
}

function buildCar(t: VehicleType, b: Builder) {
  const sh = SHAPES[t.body] ?? SHAPES.sedan;
  const L = t.length;
  const H = t.height;
  const W = t.width;
  const front = L / 2;
  const X = (f: number) => front - f * L; // 앞끝에서의 비율 → x
  const y0 = sh.ground * H + 0.12;
  const belt = sh.belt * H;
  const deck = (sh.deck ?? sh.belt) * H;

  // 차체 아래 (도색)
  const lower: [number, number][] = [
    [X(0), y0 + 0.05],
    [X(0) + 0.02, sh.nose * H],
    [X(0) - 0.12, sh.nose * H + 0.05],
    [X(sh.hood), belt],
    [X(sh.glassR), sh.bed ? belt : Math.max(belt, deck)],
    [X(1) + 0.12, sh.tail * H],
    [X(1), sh.tail * H - 0.06],
    [X(1), y0 + 0.05],
  ];
  b.profile(lower, W, "paint", 0, 0.06);
  // 문 아래 검은 몰딩과 범퍼 하단
  b.box(L * 0.97, 0.12, W + 0.01, 0, y0 + 0.02, 0, C.trim);

  // 유리 온실
  const green: [number, number][] = [
    [X(sh.hood) - 0.02, belt - 0.01],
    [X(sh.roofF), H - 0.03],
    [X(sh.roofR), H - 0.03],
    [X(sh.glassR) + 0.02, sh.bed ? belt - 0.01 : Math.max(belt, deck) - 0.01],
  ];
  b.profile(green, W - 0.16, C.glass, 0, 0.03);
  // 지붕 (도색)
  const roofLen = X(sh.roofF) - X(sh.roofR);
  b.box(roofLen * 0.96, 0.05, W - 0.14, (X(sh.roofF) + X(sh.roofR)) / 2, H - 0.02, 0, "paint");
  // A·B 필러
  const pillar = (x: number) => b.box(0.08, H - belt, 0.02, x, (H + belt) / 2, 0, "paint");
  pillar((X(sh.roofF) + X(sh.roofR)) / 2);
  for (const side of [-1, 1]) {
    b.box(0.06, H - belt - 0.02, 0.03, (X(sh.roofF) + X(sh.roofR)) / 2, (H + belt) / 2, side * (W / 2 - 0.08), "paint");
  }

  // 픽업 적재함
  if (sh.bed) {
    const x0 = X(sh.glassR) - 0.1;
    const x1 = X(1) + 0.05;
    const len = x0 - x1;
    b.box(len, 0.06, W - 0.1, (x0 + x1) / 2, belt + 0.02, 0, C.trim);
    if (t.extras?.includes("arrowBoard")) {
      b.box(0.08, 1.0, 1.6, x1 + 0.3, belt + 0.6, 0, C.black);
      b.box(0.02, 0.5, 1.2, x1 + 0.25, belt + 0.62, 0, 0xf6d44a);
    }
  }

  // 앞: 그릴, 전조등, 번호판
  if (sh.grille !== false) b.box(0.04, 0.22, W * 0.5, X(0) + 0.01, sh.nose * H - 0.18, 0, C.grille);
  else b.box(0.03, 0.06, W * 0.7, X(0) + 0.01, sh.nose * H - 0.04, 0, C.headlight); // 전기차 일자 램프
  for (const side of [-1, 1]) {
    b.box(0.06, 0.1, 0.34, X(0) - 0.02, sh.nose * H - 0.02, side * (W / 2 - 0.25), C.headlight);
    b.head.push(new THREE.Vector3(X(0) + 0.03, sh.nose * H - 0.02, side * (W / 2 - 0.25)));
    b.box(0.3, 0.08, 0.06, X(sh.hood) - 0.05, belt + 0.02, side * (W / 2 + 0.03), "paint"); // 사이드미러
  }
  b.box(0.02, 0.11, 0.52, X(0) + 0.015, y0 + 0.22, 0, plateColor(t));

  // 뒤: 후미등, 번호판
  const tailY = sh.tail * H - 0.12;
  for (const side of [-1, 1]) {
    b.box(0.05, 0.12, 0.42, X(1) - 0.005, tailY, side * (W / 2 - 0.26), C.taillight);
    b.brake.push(new THREE.Vector3(X(1) - 0.04, tailY, side * (W / 2 - 0.26)));
    (side < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(X(1) - 0.045, tailY + 0.01, side * (W / 2 - 0.12)));
    (side < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(X(0) + 0.02, sh.nose * H - 0.03, side * (W / 2 - 0.12)));
  }
  if (t.body === "ev_sedan" || t.body === "ev_hatch_suv" || t.body === "ev_crossover") {
    b.box(0.04, 0.05, W * 0.7, X(1) - 0.005, tailY + 0.05, 0, C.taillight); // 일자 후미등
  }
  b.box(0.02, 0.11, 0.52, X(1) - 0.015, y0 + 0.28, 0, plateColor(t));

  // 바퀴
  const wr = sh.wheelR;
  const xf = front - (L - t.wheelbase) * 0.46;
  for (const x of [xf, xf - t.wheelbase]) {
    for (const side of [-1, 1]) b.wheel(x, side * (W / 2 - 0.12), wr, 0.22);
  }

  // 부가물
  const ex = t.extras ?? [];
  if (ex.includes("taxiSign")) {
    const col = t.sign === "모범" ? 0xe7c55a : t.sign === "개인" ? 0xf2d23c : 0xf5f5f0;
    b.box(0.26, 0.2, 0.62, (X(sh.roofF) + X(sh.roofR)) / 2 + 0.1, H + 0.1, 0, col);
    b.box(0.27, 0.05, 0.63, (X(sh.roofF) + X(sh.roofR)) / 2 + 0.1, H + 0.03, 0, C.trim);
  }
  if (ex.includes("goldStripe")) {
    for (const side of [-1, 1]) b.box(L * 0.8, 0.05, 0.01, 0, belt - 0.12, side * (W / 2 + 0.005), 0xc8a24a);
  }
  if (ex.includes("roofRack")) {
    for (const side of [-1, 1]) b.box(roofLen, 0.04, 0.04, (X(sh.roofF) + X(sh.roofR)) / 2, H + 0.05, side * (W / 2 - 0.2), C.trim);
  }
  if (ex.includes("lightBar")) {
    const xb = (X(sh.roofF) + X(sh.roofR)) / 2 + 0.1;
    b.box(0.28, 0.1, 0.6, xb, H + 0.05, -0.32, 0xd02020);
    b.box(0.28, 0.1, 0.6, xb, H + 0.05, 0.32, 0x1f4fd6);
  }
  if (t.livery === "police") {
    for (const side of [-1, 1]) {
      b.box(L * 0.9, 0.18, 0.01, 0, belt - 0.2, side * (W / 2 + 0.006), 0x1f3f8f);
      b.box(L * 0.9, 0.05, 0.012, 0, belt - 0.07, side * (W / 2 + 0.007), 0xf2c230);
    }
  }
  if (t.livery === "expatrol") {
    for (const side of [-1, 1]) b.box(L * 0.85, 0.12, 0.01, 0, belt - 0.15, side * (W / 2 + 0.006), 0x1f5fb0);
  }
}

// ---------- 버스 ----------

function buildBus(t: VehicleType, b: Builder) {
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const front = L / 2;
  const y0 = 0.35;
  const wr = t.body === "minibus" || t.body === "van_tall" || t.body === "camper" ? 0.4 : 0.52;
  const isVan = t.body === "van_tall" || t.body === "camper";
  const nose = isVan ? 0.7 : 0;
  // 몸체
  const body: [number, number][] = isVan
    ? [
        [front, y0],
        [front, H * 0.38],
        [front - 0.55, H * 0.46],
        [front - nose - 0.25, H * 0.62],
        [front - nose - 0.05, H],
        [-front, H],
        [-front, y0],
      ]
    : [
        [front, y0],
        [front, H * 0.35],
        [front - 0.12, H * 0.96],
        [front - 0.35, H],
        [-front + 0.1, H],
        [-front, H - 0.1],
        [-front, y0],
      ];
  b.profile(body, W, "paint", 0, 0.05);
  // 앞유리
  if (isVan) {
    b.profile(
      [
        [front - 0.58, H * 0.47],
        [front - nose - 0.22, H * 0.64],
        [front - nose - 0.05, H * 0.9],
        [front - 0.62, H * 0.5],
      ],
      W - 0.12,
      C.glass,
      0,
      0.02,
    );
  } else {
    b.box(0.06, H * 0.5, W - 0.16, front - 0.05, H * 0.66, 0, C.glass);
  }
  // 옆 창 띠
  const winY0 = t.body === "double_decker" ? H * 0.18 + 0.4 : isVan ? H * 0.52 : t.body === "city_bus" ? H * 0.42 : H * 0.5;
  const winY1 = t.body === "double_decker" ? H * 0.48 : H * 0.9;
  const winFront = front - (isVan ? nose + 0.5 : 0.7);
  const winBack = -front + 0.35;
  for (const side of [-1, 1]) {
    b.box(winFront - winBack, winY1 - winY0, 0.02, (winFront + winBack) / 2, (winY0 + winY1) / 2, side * (W / 2 + 0.005), C.glassDark);
    if (t.body === "double_decker") {
      b.box(winFront - winBack, H * 0.3, 0.02, (winFront + winBack) / 2, H * 0.78, side * (W / 2 + 0.005), C.glassDark);
    }
    // 창 기둥
    const n = Math.floor((winFront - winBack) / 1.4);
    for (let i = 1; i < n; i++) {
      const x = winBack + (i * (winFront - winBack)) / n;
      b.box(0.08, winY1 - winY0, 0.03, x, (winY0 + winY1) / 2, side * (W / 2 + 0.008), "paint");
    }
  }
  // 도장 띠 (회사마다 다른 색 줄무늬 느낌)
  const stripe = t.livery === "express" ? 0x1f5aa6 : t.livery === "premium" ? 0xc8a24a : t.livery === "airport" ? 0x2aa6c8 : t.livery === "tour" ? 0xf5f5f0 : t.livery === "metro" ? 0xf5f5f0 : null;
  if (stripe !== null) {
    for (const side of [-1, 1]) {
      b.box(L * 0.92, 0.18, 0.012, -0.1, H * 0.34, side * (W / 2 + 0.008), stripe);
      if (t.livery === "tour") b.box(L * 0.6, 0.5, 0.013, -L * 0.15, H * 0.25, side * (W / 2 + 0.009), 0xf0a51e);
    }
  }
  if (t.livery === "ambulance") {
    for (const side of [-1, 1]) {
      b.box(L * 0.9, 0.2, 0.012, 0, H * 0.4, side * (W / 2 + 0.008), 0xd42a2a);
      b.box(L * 0.9, 0.08, 0.013, 0, H * 0.3, side * (W / 2 + 0.009), 0xf2c230);
    }
  }
  if (t.body === "camper") {
    // 운전석 위로 튀어나온 침실
    b.box(1.0, 0.7, W - 0.05, front - nose - 0.4, H - 0.35, 0, "paint", 0.95);
    for (const side of [-1, 1]) b.box(L * 0.7, 0.1, 0.012, -0.5, H * 0.45, side * (W / 2 + 0.008), 0x7a8c8f);
  }
  // 앞 등·번호판·범퍼
  for (const side of [-1, 1]) {
    b.box(0.05, 0.14, 0.34, front + 0.01, H * 0.26, side * (W / 2 - 0.3), C.headlight);
    b.head.push(new THREE.Vector3(front + 0.05, H * 0.26, side * (W / 2 - 0.3)));
    b.box(0.05, 0.3, 0.2, -front - 0.01, H * 0.3, side * (W / 2 - 0.2), C.taillight);
    b.brake.push(new THREE.Vector3(-front - 0.04, H * 0.3, side * (W / 2 - 0.2)));
    (side < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(-front - 0.045, H * 0.3 + 0.2, side * (W / 2 - 0.2)));
    (side < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(front + 0.02, H * 0.26 + 0.12, side * (W / 2 - 0.12)));
    b.box(0.5, 0.2, 0.06, front - 0.4, H * 0.75, side * (W / 2 + 0.1), C.trim); // 큰 사이드미러
  }
  b.box(0.1, 0.3, W, front, y0 + 0.1, 0, C.trim);
  b.box(0.02, 0.2, 0.6, front + 0.06, y0 + 0.25, 0, plateColor(t));
  b.box(0.02, 0.2, 0.6, -front - 0.02, y0 + 0.5, 0, plateColor(t));
  if (t.extras?.includes("lightBar")) {
    b.box(0.3, 0.12, 0.7, front - nose - 0.3, H + 0.06, -0.38, 0xd02020);
    b.box(0.3, 0.12, 0.7, front - nose - 0.3, H + 0.06, 0.38, 0x1f4fd6);
  }
  // 바퀴
  const wb = t.wheelbase;
  const xf = front - (isVan ? 1.0 : 2.4);
  const axles = [xf, xf - wb];
  if (L > 12.4) axles.push(xf - wb - 1.3);
  axles.forEach((x, i) => {
    for (const side of [-1, 1]) b.wheel(x, side * (W / 2 - 0.2), wr, 0.3, i > 0 && !isVan);
  });
}

// ---------- 트럭 ----------

function cab(b: Builder, t: VehicleType, x0: number, len: number, W: number, H: number, y0: number, wr: number) {
  // 캡오버 운전석: 앞이 거의 수직인 상자
  const front = x0;
  const pts: [number, number][] = [
    [front, y0],
    [front, y0 + H * 0.45],
    [front - 0.1, y0 + H * 0.97],
    [front - 0.25, y0 + H],
    [front - len, y0 + H],
    [front - len, y0],
  ];
  b.profile(pts, W, "paint", 0, 0.05);
  // 앞유리: 앞면 기울기에 맞춰 살짝 눕힌 판
  const lean = Math.atan2(0.1, H * 0.52);
  const glass = new THREE.BoxGeometry(0.05, H * 0.42, W - 0.24);
  glass.rotateZ(lean);
  glass.translate(front - 0.048 + 0.02, y0 + H * 0.7, 0);
  b.add(glass, C.glass, "fixed");
  for (const side of [-1, 1]) {
    b.box(len * 0.55, H * 0.38, 0.02, front - len * 0.4, y0 + H * 0.72, side * (W / 2 + 0.005), C.glass);
    b.box(0.05, 0.14, 0.3, front + 0.01, y0 + 0.28, side * (W / 2 - 0.3), C.headlight);
    b.head.push(new THREE.Vector3(front + 0.05, y0 + 0.28, side * (W / 2 - 0.3)));
    (side < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(front + 0.03, y0 + 0.45, side * (W / 2 - 0.15)));
    b.box(0.35, 0.4, 0.05, front - 0.2, y0 + H * 0.75, side * (W / 2 + 0.15), C.trim);
  }
  b.box(0.06, 0.25, W - 0.5, front + 0.005, y0 + H * 0.28, 0, C.grille);
  b.box(0.1, 0.25, W, front - 0.02, y0 - 0.02, 0, C.trim);
  b.box(0.02, 0.18, 0.55, front + 0.07, y0 + 0.05, 0, plateColor(t));
  void wr;
}

function rearLights(b: Builder, t: VehicleType, x: number, y: number, W: number) {
  for (const side of [-1, 1]) {
    b.box(0.05, 0.14, 0.3, x - 0.01, y, side * (W / 2 - 0.25), C.taillight);
    b.brake.push(new THREE.Vector3(x - 0.04, y, side * (W / 2 - 0.25)));
    (side < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(x - 0.045, y, side * (W / 2 - 0.05)));
  }
  b.box(0.02, 0.2, 0.55, x - 0.02, y - 0.25, 0, plateColor(t));
  // 후부 반사판 (대형차 의무)
  if (t.heavy) b.box(0.02, 0.08, W - 0.3, x - 0.02, y - 0.12, 0, 0xd8b030);
}

const CONTAINER_COLORS = [0x2c5e9e, 0xb52a2a, 0x2f7a4a, 0x8a8f94, 0xd9d9d6, 0x7b3f2a, 0x1f3e6e, 0xc8702a];

function buildTruck(t: VehicleType, b: Builder, rand: () => number) {
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const front = L / 2;
  const light = t.body === "truck_light";
  const medium = t.body === "truck_medium";
  const wr = light ? 0.36 : medium ? 0.42 : 0.52;
  const frameY = wr + 0.18;
  const cabLen = light ? 1.55 : medium ? 1.9 : 2.3;
  const cabH = light ? 1.55 : medium ? 1.85 : 2.35;
  cab(b, t, front, cabLen, W - (light ? 0.02 : 0), cabH, frameY - 0.05, wr);
  // 뼈대
  b.box(L - 0.3, 0.2, W * 0.55, -0.1, frameY, 0, C.chassis);

  const bodyX0 = front - cabLen - 0.12;
  const bodyX1 = -front;
  const bodyLen = bodyX0 - bodyX1;
  const bodyMid = (bodyX0 + bodyX1) / 2;
  const deckY = frameY + 0.18;
  const cargo = t.cargo ?? "open";
  const topH = H - deckY;

  switch (cargo) {
    case "open":
    case "open_high": {
      const gate = cargo === "open_high" ? 0.9 : 0.5;
      b.box(bodyLen, 0.12, W, bodyMid, deckY, 0, C.cargoGray);
      for (const side of [-1, 1]) b.box(bodyLen, gate, 0.05, bodyMid, deckY + gate / 2, side * (W / 2 - 0.025), rand() < 0.5 ? C.cargoGray : C.cargoBlue);
      b.box(0.05, gate, W, bodyX1 + 0.025, deckY + gate / 2, 0, C.cargoGray);
      b.box(0.05, gate + 0.25, W, bodyX0 - 0.03, deckY + (gate + 0.25) / 2, 0, C.cargoGray);
      // 짐 (포장 화물·팔레트) 몇 개
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const w = 0.8 + rand() * 0.6;
        const h = 0.4 + rand() * (cargo === "open_high" ? 1.2 : 0.8);
        b.box(w, h, W * 0.8, bodyX0 - 0.6 - i * (bodyLen / (n + 0.5)), deckY + h / 2 + 0.06, 0, rand() < 0.5 ? C.wood : 0x3d6e9e);
      }
      break;
    }
    case "box":
    case "fridge":
    case "parcel":
    case "wing": {
      const boxH = Math.max(1.4, topH);
      const col = cargo === "wing" ? C.alu : 0xf2f2ef;
      b.box(bodyLen, boxH, W, bodyMid, deckY + boxH / 2, 0, col);
      if (cargo === "wing") {
        for (const side of [-1, 1]) {
          for (let k = 1; k < 4; k++) b.box(bodyLen, 0.03, 0.012, bodyMid, deckY + (boxH * k) / 4, side * (W / 2 + 0.006), 0xb5b9bd);
          b.box(bodyLen, 0.06, 0.02, bodyMid, deckY + boxH - 0.03, side * (W / 2 + 0.01), 0x9ea3a8);
        }
      }
      if (cargo === "fridge") b.box(0.35, 0.45, W * 0.6, bodyX0 + 0.1, deckY + boxH - 0.3, 0, 0xdcdcdc);
      if (cargo === "parcel") {
        const accents = [0x1f5fb0, 0xe3a21a, 0xd1352a, 0x2a8a52];
        const a = accents[Math.floor(rand() * accents.length)];
        for (const side of [-1, 1]) b.box(bodyLen * 0.9, boxH * 0.3, 0.012, bodyMid, deckY + boxH * 0.3, side * (W / 2 + 0.007), a);
      }
      b.box(0.02, boxH - 0.1, W - 0.1, bodyX1 - 0.005, deckY + boxH / 2, 0, cargo === "wing" ? 0xc3c7cb : 0xe6e6e3);
      break;
    }
    case "dump": {
      // 위가 열린 적재함 + 흙
      const dh = 1.25;
      const shade = 0.85;
      b.box(bodyLen, 0.1, W, bodyMid, deckY + 0.05, 0, "paint", shade);
      for (const side of [-1, 1]) b.box(bodyLen, dh, 0.08, bodyMid, deckY + dh / 2, side * (W / 2 - 0.04), "paint", shade);
      b.box(0.1, dh + 0.35, W, bodyX0 - 0.05, deckY + (dh + 0.35) / 2, 0, "paint", shade);
      b.box(0.08, dh, W, bodyX1 + 0.04, deckY + dh / 2, 0, "paint", shade);
      // 옆면 보강대
      for (const side of [-1, 1]) for (let k = 1; k < 4; k++) b.box(0.08, dh, 0.03, bodyX1 + (bodyLen * k) / 4, deckY + dh / 2, side * (W / 2 + 0.01), "paint", 0.7);
      b.box(bodyLen - 0.2, 0.05, W - 0.18, bodyMid, deckY + dh * 0.75, 0, 0x6e5a42); // 흙
      b.box(bodyLen * 0.5, 0.25, W * 0.6, bodyMid, deckY + dh * 0.75 + 0.12, 0, 0x7a6448);
      break;
    }
    case "mixer": {
      const r = 1.05;
      const g = new THREE.CylinderGeometry(r * 0.55, r, bodyLen * 0.95, 14);
      g.rotateZ(Math.PI / 2 - 0.12); // 좁은 투입구가 뒤쪽 위로
      g.translate(bodyMid, deckY + r + 0.25, 0);
      pushGeo(b, g, 0xf0f0ee);
      for (let k = 0; k < 3; k++) {
        const s = new THREE.TorusGeometry(r * (0.7 + k * 0.1), 0.04, 4, 16);
        s.rotateY(Math.PI / 2);
        s.translate(bodyMid + bodyLen * (0.25 - k * 0.25), deckY + r + 0.25 + (k - 1) * 0.1, 0);
        pushGeo(b, s, rand() < 0.5 ? 0x2d5e9e : 0xd1352a);
      }
      break;
    }
    case "tank": {
      const g = new THREE.CylinderGeometry(1.0, 1.0, bodyLen * 0.97, 16);
      g.rotateZ(Math.PI / 2);
      g.scale(1, 1, W / 2.1);
      g.translate(bodyMid, deckY + 1.0, 0);
      pushGeo(b, g, C.chrome);
      b.box(bodyLen * 0.9, 0.06, 0.4, bodyMid, deckY + 2.02, 0, C.steel);
      break;
    }
    case "crane": {
      b.box(bodyLen, 0.12, W, bodyMid, deckY, 0, C.cargoGray);
      b.box(0.9, 1.0, 1.2, bodyX0 - 0.5, deckY + 0.5, 0, "paint", 0.85);
      b.box(bodyLen * 0.85, 0.4, 0.45, bodyMid + 0.2, deckY + 1.2, 0.3, 0xe3b12c);
      for (const side of [-1, 1]) b.box(bodyLen, 0.35, 0.05, bodyMid, deckY + 0.24, side * (W / 2 - 0.02), C.cargoGray);
      break;
    }
    case "tow": {
      b.box(bodyLen, 0.15, W - 0.2, bodyMid, deckY, 0, C.steel);
      b.box(0.4, 1.4, 0.4, bodyX0 - 0.4, deckY + 0.7, 0, "paint", 0.9);
      b.box(bodyLen * 0.8, 0.2, 0.25, bodyMid - 0.3, deckY + 1.25, 0, 0xe3b12c);
      b.box(0.3, 0.2, W * 0.8, bodyX1 + 0.1, deckY + 0.3, 0, C.steel);
      break;
    }
  }
  rearLights(b, t, bodyX1, frameY + 0.1, W);
  if (t.extras?.includes("lightBar")) {
    b.box(0.3, 0.12, 0.7, front - 0.5, frameY + cabH + 0.02, -0.38, 0xf0a51e);
    b.box(0.3, 0.12, 0.7, front - 0.5, frameY + cabH + 0.02, 0.38, 0xf0a51e);
  }

  // 바퀴: 앞축 1개 + 뒤축들
  const axles = t.axles ?? 2;
  const xf = front - cabLen * 0.55;
  const xs: number[] = [xf];
  if (axles >= 4) xs.push(xf - 1.35); // 앞 2축
  const rearCount = axles - xs.length;
  const xr = xf - t.wheelbase;
  for (let i = 0; i < rearCount; i++) xs.push(xr - i * 1.32);
  xs.forEach((x, i) => {
    for (const side of [-1, 1]) b.wheel(x, side * (W / 2 - 0.2), wr, light ? 0.2 : 0.3, i >= (axles >= 4 ? 2 : 1) && !light);
  });
}

function buildTractor(t: VehicleType, b: Builder, rand: () => number) {
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const front = L / 2;
  const wr = 0.52;
  const frameY = wr + 0.2;
  const cabLen = 2.3;
  cab(b, t, front, cabLen, W, 2.55, frameY - 0.05, wr);
  // 트랙터 뼈대 + 연결부
  const tractorLen = 6.2;
  b.box(tractorLen, 0.22, W * 0.55, front - tractorLen / 2, frameY, 0, C.chassis);
  b.box(1.2, 0.1, 1.2, front - 4.6, frameY + 0.16, 0, C.black);
  // 트랙터 바퀴 (1+2축)
  const txs = [front - 1.3, front - 4.4, front - 5.7];
  txs.forEach((x, i) => {
    for (const side of [-1, 1]) b.wheel(x, side * (W / 2 - 0.2), wr, 0.3, i > 0);
  });
  // 트레일러
  const tx0 = front - 3.2;
  const tx1 = -front;
  const tLen = tx0 - tx1;
  const tMid = (tx0 + tx1) / 2;
  const deckY = frameY + 0.38;
  const cargo = t.cargo ?? "container40";
  b.box(tLen, 0.25, W - 0.05, tMid, deckY - 0.1, 0, C.chassis);
  if (cargo === "container40" || cargo === "container20") {
    const cLen = cargo === "container40" ? Math.min(tLen, 12.19) : Math.min(tLen, 6.06);
    const col = CONTAINER_COLORS[Math.floor(rand() * CONTAINER_COLORS.length)];
    const cH = 2.6;
    const cx = tx1 + cLen / 2 + 0.1;
    b.box(cLen, cH, 2.44, cx, deckY + cH / 2 + 0.05, 0, col);
    for (const side of [-1, 1]) {
      const n = Math.floor(cLen / 0.3);
      for (let k = 0; k < n; k += 2) b.box(0.06, cH - 0.2, 0.01, cx - cLen / 2 + 0.15 + k * 0.3, deckY + cH / 2 + 0.05, side * 1.225, new THREE.Color(col).multiplyScalar(0.8).getHex());
    }
  } else if (cargo === "flatbed") {
    b.box(tLen, 0.12, W, tMid, deckY + 0.06, 0, C.steel);
    const coils = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < coils; i++) {
      const g = new THREE.CylinderGeometry(0.9, 0.9, 1.5, 18, 1, false);
      g.translate(tx1 + 1.4 + i * (tLen - 2.6) / Math.max(1, coils - 1), deckY + 0.9, 0);
      pushGeo(b, g, 0x8e959c);
    }
  } else if (cargo === "tanktrailer") {
    const g = new THREE.CylinderGeometry(1.15, 1.15, tLen * 0.95, 18);
    g.rotateZ(Math.PI / 2);
    g.translate(tMid, deckY + 1.25, 0);
    pushGeo(b, g, C.chrome);
  } else if (cargo === "carcarrier") {
    const lower = deckY + 0.1;
    const upper = deckY + 1.95;
    b.box(tLen, 0.08, W, tMid, upper, 0, C.steel);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) b.box(0.1, upper - lower, 0.08, tx1 + 0.3 + k * (tLen - 0.6) / 5, (upper + lower) / 2, side * (W / 2 - 0.05), C.steel);
    }
    // 실은 차 (작은 상자형)
    for (const deckTop of [lower, upper + 0.04]) {
      for (let k = 0; k < 3; k++) {
        const cx = tx1 + 2.1 + k * (tLen - 4) / 2;
        const col = [0xf4f4f1, 0x1d1e20, 0x9ea2a6, 0x2b3a55][Math.floor(rand() * 4)];
        b.box(3.9, 0.7, 1.8, cx, deckTop + 0.55, 0, col);
        b.box(2.0, 0.5, 1.6, cx - 0.2, deckTop + 1.15, 0, C.glass);
      }
    }
  }
  rearLights(b, t, tx1, deckY + 0.05, W);
  // 트레일러 바퀴
  const trailerAxles = Math.max(2, (t.axles ?? 5) - 3);
  for (let i = 0; i < trailerAxles; i++) {
    const x = tx1 + 1.6 + i * 1.32;
    for (const side of [-1, 1]) b.wheel(x, side * (W / 2 - 0.2), wr, 0.3, true);
  }
  void H;
}

function pushGeo(b: Builder, g: THREE.BufferGeometry, color: number) {
  b.add(g, color, "fixed");
}

// ---------- 공개 함수 ----------

const BUS_BODIES = new Set(["coach", "city_bus", "double_decker", "minibus", "van_tall", "camper"]);
const TRUCK_BODIES = new Set(["truck_light", "truck_medium", "truck_heavy"]);

export function buildVehicleModel(t: VehicleType, seed = 1): VehicleModel {
  const b = new Builder();
  let x = seed * 9301 + 49297;
  const rand = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
  if (BUS_BODIES.has(t.body)) buildBus(t, b);
  else if (TRUCK_BODIES.has(t.body)) buildTruck(t, b, rand);
  else if (t.body === "tractor_trailer") buildTractor(t, b, rand);
  else buildCar(t, b);
  const big = t.length > 6;
  return b.build(t, big ? 0.22 : 0.14);
}

export function paletteFor(t: VehicleType, catalog: VehicleCatalog): string[] {
  if (Array.isArray(t.paint)) return t.paint;
  return catalog.palettes[t.paint] ?? ["#f4f4f1"];
}

export async function loadCatalog(base = "./data/"): Promise<VehicleCatalog> {
  const res = await fetch(`${base}vehicles.json`);
  if (!res.ok) throw new Error("차종 데이터를 불러오지 못했습니다");
  return (await res.json()) as VehicleCatalog;
}
