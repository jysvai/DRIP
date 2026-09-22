// 차종 데이터(vehicles.json)로 3D 모델을 코드로 만든다.
// 모델 좌표: +X 앞, +Y 위, +Z 오른쪽. 원점은 차 길이의 가운데, 바닥 높이.
// 차체는 단면을 이어 붙인 매끈한 몸체(vehicleGeom.ts)에 등화·그릴·번호판 무늬를 붙여 만든다.
// 꼭짓점마다 재질값을 넣어서 재질 하나(carMaterials.ts)로 도색·유리·크롬·등화를 함께 그린다.
// 바퀴는 돌리고 꺾을 수 있게 따로 그린다 (wheels 명세 + wheelGeometry).

import * as THREE from "three";
import { createVehicleMaterial, vehicleUniforms } from "./carMaterials";
import {
  Loft,
  Mesher,
  TAG,
  box,
  cbox,
  cyl,
  decalPoly,
  decalPolyPair,
  decalStrip,
  decalStripPair,
  ellipsoid,
  paintSurf,
  profile,
  surfacePoint,
  util,
  type Proj,
  type Surf,
  type YZ,
} from "./vehicleGeom";

const { lerp, clamp, smooth } = util;

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

/** 바퀴 하나 (모델 좌표). 왼쪽 바퀴(z < 0)는 휠 면이 -z를 본다 */
export interface WheelSpec {
  x: number;
  z: number;
  /** 반지름 = 바퀴 중심 높이 */
  r: number;
  /** 타이어 폭 */
  w: number;
  /** 앞바퀴: 조향한다 */
  steer: boolean;
  /** 대형차 철제 휠 */
  heavy: boolean;
}

/** 운전석 배치 (모델 좌표) */
export interface CabinSpec {
  kind: "car" | "van" | "truck" | "bus";
  /** 운전자 눈 */
  eye: THREE.Vector3;
  /** 보닛 시점 카메라 */
  hoodEye: THREE.Vector3;
  /** 운전대 가운데, 기울기(rad, 운전자 쪽으로 누운 정도), 반지름 */
  wheel: { pos: THREE.Vector3; tilt: number; r: number };
  /** 대시보드: 앞끝 x0(앞유리 아래), 뒤끝 x1, 윗면 높이 y, 폭 w, 가운데 z (없으면 0) */
  dash: { x0: number; x1: number; y: number; w: number; z?: number };
  /** 앞유리 아래·위 (x, y) */
  wsBase: [number, number];
  wsTop: [number, number];
  roofY: number;
  beltY: number;
  floorY: number;
  /** 거울 카메라 위치: 왼쪽·오른쪽 사이드미러, 실내 룸미러 */
  mirrorL: THREE.Vector3;
  mirrorR: THREE.Vector3;
  mirrorC: THREE.Vector3;
  /** 거울 유리 (뒤를 보는 면의 가운데, 폭(z), 높이(y)): 룸미러, 왼쪽, 오른쪽 순서 */
  glass: MirrorGlass[];
  /** 밝은 천장 (아니면 검은 천장) */
  light: boolean;
}

export interface MirrorGlass {
  c: THREE.Vector3;
  w: number;
  h: number;
}

export interface VehicleModel {
  type: VehicleType;
  /** 가까이서 그리는 차체 전부 (바퀴 빼고). 속성: position, normal, color, surf */
  body: THREE.BufferGeometry;
  /** 중간 거리용 단순한 차체 (바퀴 포함) */
  mid: THREE.BufferGeometry;
  /** 운전석 시점에서 보이는 차 안쪽 면 (천장·기둥·문 안쪽) */
  interior: THREE.BufferGeometry;
  wheels: WheelSpec[];
  cabin: CabinSpec;
  /** 예전 방식 호환: 도색 부분 (vertex color = 밝기) */
  paint: THREE.BufferGeometry;
  /** 예전 방식 호환: 도색이 아닌 부분 전부 (바퀴 포함) */
  fixed: THREE.BufferGeometry;
  /** 전조등·제동등·방향지시등 위치 (모델 좌표) */
  headLights: THREE.Vector3[];
  brakeLights: THREE.Vector3[];
  signalLeft: THREE.Vector3[];
  signalRight: THREE.Vector3[];
  lightSize: number;
}

// ---------- 재질값 ----------

const S = {
  paint: paintSurf(1),
  paintShade: paintSurf(0.8),
  glass: { color: 0x0b1117, r: 0.04, m: 0.2, c: 1, tag: TAG.GLASS } as Surf,
  glassPriv: { color: 0x05080b, r: 0.04, m: 0.25, c: 1, tag: TAG.GLASS } as Surf,
  chrome: { color: 0xe3e6ea, r: 0.08, m: 1, c: 0, tag: 0 } as Surf,
  satin: { color: 0x9ba1a8, r: 0.28, m: 1, c: 0, tag: 0 } as Surf,
  darkChrome: { color: 0x4a4f56, r: 0.18, m: 1, c: 0, tag: 0 } as Surf,
  gloss: { color: 0x0b0c0e, r: 0.12, m: 0.1, c: 1, tag: 0 } as Surf,
  trim: { color: 0x1c1d1f, r: 0.66, m: 0, c: 0, tag: 0 } as Surf,
  clad: { color: 0x202123, r: 0.72, m: 0, c: 0, tag: 0 } as Surf,
  mesh: { color: 0x0f1012, r: 0.42, m: 0.35, c: 0.3, tag: 0 } as Surf,
  under: { color: 0x151617, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  well: { color: 0x0b0b0c, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  seam: { color: 0x0e0f10, r: 0.85, m: 0, c: 0, tag: 0 } as Surf,
  headHousing: { color: 0x8c96a1, r: 0.12, m: 1, c: 1, tag: TAG.HEAD } as Surf,
  headLens: { color: 0x2a3036, r: 0.05, m: 0.6, c: 1, tag: TAG.HEAD } as Surf,
  lampBand: { color: 0x0c0d0f, r: 0.08, m: 0.3, c: 1, tag: 0 } as Surf,
  drl: { color: 0xf2f6ff, r: 0.15, m: 0.1, c: 1, tag: TAG.DRL } as Surf,
  tail: { color: 0x8e0d14, r: 0.12, m: 0.1, c: 1, tag: TAG.TAIL } as Surf,
  tailSmoke: { color: 0x44070b, r: 0.1, m: 0.2, c: 1, tag: TAG.TAIL } as Surf,
  brake: { color: 0x9a0e15, r: 0.12, m: 0.1, c: 1, tag: TAG.BRAKE } as Surf,
  sigL: { color: 0xe38b1d, r: 0.15, m: 0.25, c: 1, tag: TAG.SIG_L } as Surf,
  sigR: { color: 0xe38b1d, r: 0.15, m: 0.25, c: 1, tag: TAG.SIG_R } as Surf,
  reverse: { color: 0xdfe2e6, r: 0.08, m: 0.7, c: 1, tag: TAG.REVERSE } as Surf,
  reflector: { color: 0x7a1116, r: 0.3, m: 0.2, c: 0.5, tag: 0 } as Surf,
  plateText: { color: 0x131517, r: 0.6, m: 0, c: 0, tag: 0 } as Surf,
  caliper: { color: 0x80868d, r: 0.35, m: 0.8, c: 0, tag: 0 } as Surf,
  caliperRed: { color: 0xb3151d, r: 0.3, m: 0.1, c: 1, tag: 0 } as Surf,
  mirrorGlass: { color: 0x7c8894, r: 0.02, m: 1, c: 0, tag: 0 } as Surf,
  rubber: { color: 0x151617, r: 0.9, m: 0, c: 0, tag: 0 } as Surf,
  steel: { color: 0x6c7075, r: 0.5, m: 0.7, c: 0, tag: 0 } as Surf,
  chassis: { color: 0x26272a, r: 0.7, m: 0.3, c: 0, tag: 0 } as Surf,
  alu: { color: 0xd0d4d8, r: 0.35, m: 0.8, c: 0, tag: 0 } as Surf,
  bed: { color: 0x17181a, r: 0.85, m: 0, c: 0, tag: 0 } as Surf,
  tapeRed: { color: 0xc8161e, r: 0.3, m: 0.2, c: 0.6, tag: 0 } as Surf,
  tapeWhite: { color: 0xe8e8e2, r: 0.3, m: 0.2, c: 0.6, tag: 0 } as Surf,
  bumperGrey: { color: 0x3b3e42, r: 0.6, m: 0.1, c: 0.2, tag: 0 } as Surf,
  marker: { color: 0xf09a20, r: 0.3, m: 0.1, c: 1, tag: TAG.GLOW } as Surf,
  destLed: { color: 0xffa21a, r: 0.4, m: 0, c: 0, tag: TAG.GLOW } as Surf,
  // 실내
  inHead: { color: 0xb3afa6, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  inHeadDark: { color: 0x2b2c2f, r: 0.95, m: 0, c: 0, tag: 0 } as Surf,
  inPillar: { color: 0x3a3b3e, r: 0.9, m: 0, c: 0, tag: 0 } as Surf,
  inDoor: { color: 0x222326, r: 0.75, m: 0, c: 0.2, tag: 0 } as Surf,
  inFloor: { color: 0x141516, r: 1, m: 0, c: 0, tag: 0 } as Surf,
};

function surf(color: number, r = 0.5, m = 0, c = 0, tag: number = TAG.NONE): Surf {
  return { color, r, m, c, tag };
}

function plateSurf(t: VehicleType): Surf {
  return surf(plateColor(t), 0.45, 0, 0.4);
}

// ---------- 공통 도구 ----------

type Pt = [number, number];

class VB {
  /** 가까이서만 그리는 것 */
  m = new Mesher();
  /** 가까이·중간 거리 모두 그리는 것 (등화·그릴·번호판·짐칸) */
  core = new Mesher();
  /** 중간 거리에서만 그리는 것 */
  mid = new Mesher();
  /** 실내 안쪽 면 */
  inner = new Mesher();
  head: THREE.Vector3[] = [];
  brake: THREE.Vector3[] = [];
  sigL: THREE.Vector3[] = [];
  sigR: THREE.Vector3[] = [];
  wheels: WheelSpec[] = [];
  cabin!: CabinSpec;
  constructor(
    readonly t: VehicleType,
    readonly rand: () => number,
  ) {}

  /** 몸체 겉면 위의 점 (등화 위치 등) */
  at(body: Loft, proj: "front" | "rear", u: number, v: number, out: THREE.Vector3[]) {
    const p = surfacePoint(body, proj, u, v, 0.02);
    if (p) out.push(p.p);
    else out.push(new THREE.Vector3(proj === "front" ? body.front + 0.02 : body.rear - 0.02, v, u));
  }
}

function plateColor(t: VehicleType): number {
  return t.plate === "yellow" ? 0xf2c21b : t.plate === "ev" ? 0x4c9fe0 : 0xf2f2ee;
}

/** 번호판: 판 + 글자 (12가 3456). 글자는 획 테두리로 (멀리서 막대처럼 보이지 않게). text: 글자를 넣을 곳 (없으면 m) */
function plate(m: Mesher, body: Loft | null, proj: "front" | "rear", t: VehicleType, y: number, x?: number, w = 0.52, h = 0.11, text: Mesher = m) {
  const k = w / 0.52;
  const ink = S.plateText;
  // 글자 가운데 (u), 반폭 a: 숫자 둘, 한글 하나, 숫자 넷
  const glyphs: [number, number][] = [
    [-0.205, 0.018],
    [-0.162, 0.018],
    [-0.1, 0.024],
    [-0.02, 0.018],
    [0.023, 0.018],
    [0.066, 0.018],
    [0.109, 0.018],
  ].map(([u, a]) => [u * k + 0.045 * k, a * k] as [number, number]);
  const c = h * 0.31;
  const st = 0.0065 * k;
  const strokes: [number, number, number, number][] = [];
  glyphs.forEach(([u, a], i) => {
    if (i === 2) {
      // 한글: ㄱ + ㅏ
      strokes.push([u - a, y + c - st, u + a * 0.2, y + c], [u + a * 0.2 - st, y - c, u + a * 0.2, y + c], [u + a - st, y - c, u + a, y + c], [u + a * 0.45, y - st / 2, u + a - st, y + st / 2]);
    } else {
      strokes.push([u - a, y - c, u - a + st, y + c], [u + a - st, y - c, u + a, y + c], [u - a, y + c - st, u + a, y + c], [u - a, y - c, u + a, y - c + st]);
    }
  });
  if (body) {
    decalPoly(m, body, proj, rect(-w / 2, y - h / 2, w / 2, y + h / 2), plateSurf(t), 0.012, 0);
    // 앞에서 보면 +z가 왼쪽이다
    const f = proj === "front" ? -1 : 1;
    for (const [u0, v0, u1, v1] of strokes) decalPoly(text, body, proj, rect(Math.min(f * u0, f * u1), v0, Math.max(f * u0, f * u1), v1), ink, 0.015, 0);
  } else if (x !== undefined) {
    const s = proj === "front" ? 1 : -1;
    box(m, 0.012, h, w, x, y, 0, plateSurf(t));
    // 뒤쪽 번호판은 보는 쪽에서 좌우가 바뀐다
    for (const [u0, v0, u1, v1] of strokes) box(text, 0.006, v1 - v0, u1 - u0, x + s * 0.008, (v0 + v1) / 2, -s * (u0 + u1) / 2, ink);
  }
}

function circle(cu: number, cv: number, ru: number, rv: number, n = 12): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cu + Math.cos(a) * ru, cv + Math.sin(a) * rv]);
  }
  return out;
}

function rect(u0: number, v0: number, u1: number, v1: number): Pt[] {
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

function closeLoop(p: Pt[]): Pt[] {
  return [...p, p[0]];
}

// ---------- 몸체 윤곽 ----------

/** 둥근 모서리가 끝면에서 들어간 깊이 (초타원). d: 끝에서 잰 거리, len: 둥근 길이, depth: 깊이 */
function corner(d: number, len: number, depth: number, p = 2.2): number {
  if (d >= len || len <= 0) return 0;
  const u = 1 - d / len;
  return depth * (1 - (1 - u ** p) ** (1 / p));
}

/** 몸체 윤곽. f = 앞끝에서 잰 길이 비율 (0 앞 … 1 뒤) */
interface Profile {
  xF: number;
  len: number;
  /** 아래 몸체 윗선 (보닛·벨트라인·트렁크) */
  top: (f: number) => number;
  bottom: (f: number) => number;
  /** 가장 넓은 곳의 반폭 */
  hw: (f: number) => number;
  /** 유리 위 지붕선. top보다 낮으면 유리 없음 */
  roof: (f: number) => number;
  crown: (f: number) => number;
  /** 유리가 위로 갈수록 안으로 들어오는 정도 */
  tumble: number;
  /** 벨트라인 턱 (옆면에서 유리까지 들어온 폭) */
  shelf: number;
  rail: number;
  /** 지붕 모서리 둥근 폭 (앞유리 옆에서는 좁게: A필러) */
  round: (f: number) => number;
  /** 유리 옆면 중간 점 높이 비율 */
  gA: [number, number];
  arches: { x: number; r: number; yc: number }[];
  tireW: number;
  /** 바퀴 위 펜더가 휠아치보다 적어도 이만큼 높다 */
  fender: number;
}

/** 단면 점 번호 */
const J = { UNDER: 0, WELL: 1, WELL_TOP: 2, LIP: 3, LOW: 4, SIDE1: 5, SIDE2: 6, SHOULDER: 7, SHOULDER2: 8, SHELF: 9, G1: 10, G2: 11, G3: 12, RAIL: 13, ROOF: 14 };

function makeSection(P: Profile) {
  return (x: number): YZ[] => {
    const f = (P.xF - x) / P.len;
    const yT = P.top(f);
    const yB = P.bottom(f);
    const hw = P.hw(f);
    let yA = -1;
    for (const a of P.arches) {
      const dx = Math.abs(x - a.x);
      if (dx < a.r) yA = Math.max(yA, a.yc + Math.sqrt(a.r * a.r - dx * dx));
    }
    const yW = Math.max(yB, yA);
    const wIn = Math.max(0.12, hw - P.tireW - 0.07);
    const yTs = yA > 0 ? Math.max(yT, yW + P.fender) : yT;
    const y4 = Math.max(yW + 0.03, yB + 0.07);
    const yS = Math.max(yTs - 0.05, y4 + 0.03);
    const y5 = lerp(y4, yS, 0.4);
    const y6 = lerp(y4, yS, 0.78);
    const y8 = Math.max(yTs - 0.012, yS + 0.004);
    const y9 = Math.max(yTs, y8 + 0.002);
    const gh = Math.max(0, P.roof(f) - yT);
    const be = smooth(gh / 0.35);
    const tb = P.tumble * be;
    const cr = P.crown(f);
    const gB = hw - P.shelf;
    const zs = [gB, gB - tb * 0.45, gB - tb * 0.85, gB - tb - P.rail * be, Math.max(0.05, gB - tb - P.round(f)), 0];
    const ys = [yT + 0.004 * be, yT + gh * P.gA[0], yT + gh * P.gA[1], yT + gh - 0.018 * be, yT + gh, yT + gh];
    const pts: YZ[] = [
      [yB, 0],
      [yB, wIn],
      [yW, wIn],
      [yW, hw - 0.06],
      [y4, hw - 0.038],
      [y5, hw - 0.011],
      [y6, hw],
      [yS, hw - 0.01],
      [y8, hw - 0.045],
      [y9, hw - P.shelf * 0.75],
    ];
    for (let k = 0; k < 6; k++) {
      const z = zs[k];
      pts.push([ys[k] + cr * (1 - (z / gB) ** 2), z]);
    }
    return pts;
  };
}

/** 중간 거리용: 단면 점 일부만 */
const MID_KEEP = [0, 1, 2, 3, 4, 6, 7, 9, 10, 12, 13, 14, 15];

/**
 * 무늬(등화·그릴 등)를 두 번 붙인다: 가까이서 보는 몸체(b.m)에는 곱게,
 * 중간 거리 몸체(b.mid)에는 덜 쪼개서 (중간 거리 차가 많을 때 삼각형을 아낀다)
 */
function dual(b: VB, body: Loft) {
  return {
    poly(proj: Proj, pts: Pt[], s: Surf, off = 0.01, lv = 1) {
      decalPoly(b.m, body, proj, pts, s, off, lv);
      decalPoly(b.mid, body, proj, pts, s, off, Math.max(0, lv - 1));
    },
    polyPair(proj: Proj, pts: Pt[], s: Surf | [Surf, Surf], off = 0.012, lv = 1) {
      decalPolyPair(b.m, body, proj, pts, s, off, lv);
      decalPolyPair(b.mid, body, proj, pts, s, off, Math.max(0, lv - 1));
    },
    strip(proj: Proj, line: Pt[], w: number, s: Surf, off = 0.008, seg = 0.06) {
      decalStrip(b.m, body, proj, line, w, s, off, seg);
      decalStrip(b.mid, body, proj, line, w, s, off, seg * 3);
    },
    stripPair(proj: Proj, line: Pt[], w: number, s: Surf | [Surf, Surf], off = 0.008, seg = 0.06) {
      decalStripPair(b.m, body, proj, line, w, s, off, seg);
      decalStripPair(b.mid, body, proj, line, w, s, off, seg * 3);
    },
  };
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
  deck?: number; // 트렁크 높이 (없으면 해치백·SUV)
  ground: number; // 차체 바닥 높이
  wheelR: number; // 바퀴 반지름 (m)
  bed?: boolean; // 픽업 적재함
  grille?: boolean;
  tumble?: number;
  /** 뒷유리 곡선 (클수록 완만하게 내려오다 끝에서 꺾인다) */
  rearP?: number;
  noseC?: number;
  /** 승합·미니버스: 옆 창 기둥 수 (B필러 뒤로 고르게) */
  pillars?: number;
}

const SHAPES: Record<string, CarShape> = {
  microcar: { hood: 0.2, roofF: 0.36, roofR: 0.86, glassR: 0.96, belt: 0.58, nose: 0.47, tail: 0.6, ground: 0.1, wheelR: 0.29, grille: true, tumble: 0.14 },
  box_micro: { hood: 0.16, roofF: 0.27, roofR: 0.95, glassR: 0.985, belt: 0.52, nose: 0.44, tail: 0.55, ground: 0.1, wheelR: 0.29, grille: true, tumble: 0.08 },
  hatch: { hood: 0.27, roofF: 0.42, roofR: 0.84, glassR: 0.95, belt: 0.62, nose: 0.47, tail: 0.62, ground: 0.1, wheelR: 0.31, grille: true, tumble: 0.15 },
  sedan: { hood: 0.29, roofF: 0.44, roofR: 0.71, glassR: 0.84, belt: 0.64, nose: 0.47, tail: 0.64, deck: 0.7, ground: 0.1, wheelR: 0.32, grille: true, tumble: 0.17, rearP: 1.25 },
  fastback: { hood: 0.3, roofF: 0.45, roofR: 0.66, glassR: 0.9, belt: 0.64, nose: 0.45, tail: 0.66, deck: 0.7, ground: 0.1, wheelR: 0.33, grille: true, tumble: 0.18, rearP: 1.6 },
  sedan_large: { hood: 0.3, roofF: 0.45, roofR: 0.72, glassR: 0.84, belt: 0.65, nose: 0.49, tail: 0.66, deck: 0.71, ground: 0.1, wheelR: 0.34, grille: true, tumble: 0.17, rearP: 1.25 },
  coupe: { hood: 0.33, roofF: 0.48, roofR: 0.64, glassR: 0.9, belt: 0.63, nose: 0.43, tail: 0.64, deck: 0.68, ground: 0.09, wheelR: 0.34, grille: true, tumble: 0.19, rearP: 1.6 },
  sports: { hood: 0.33, roofF: 0.47, roofR: 0.6, glassR: 0.92, belt: 0.62, nose: 0.36, tail: 0.66, deck: 0.66, ground: 0.08, wheelR: 0.34, grille: false, tumble: 0.2, rearP: 1.8, noseC: 0.2 },
  wagon: { hood: 0.29, roofF: 0.44, roofR: 0.92, glassR: 0.975, belt: 0.64, nose: 0.47, tail: 0.66, ground: 0.1, wheelR: 0.33, grille: true, tumble: 0.15 },
  suv_small: { hood: 0.26, roofF: 0.4, roofR: 0.87, glassR: 0.95, belt: 0.6, nose: 0.52, tail: 0.64, ground: 0.13, wheelR: 0.35, grille: true, tumble: 0.13 },
  suv_mid: { hood: 0.26, roofF: 0.4, roofR: 0.9, glassR: 0.96, belt: 0.6, nose: 0.55, tail: 0.66, ground: 0.13, wheelR: 0.37, grille: true, tumble: 0.12 },
  suv_large: { hood: 0.26, roofF: 0.39, roofR: 0.92, glassR: 0.97, belt: 0.6, nose: 0.57, tail: 0.67, ground: 0.13, wheelR: 0.39, grille: true, tumble: 0.11 },
  suv_coupe: { hood: 0.27, roofF: 0.41, roofR: 0.7, glassR: 0.93, belt: 0.6, nose: 0.55, tail: 0.68, ground: 0.13, wheelR: 0.39, grille: true, tumble: 0.14, rearP: 1.5 },
  suv_boxy: { hood: 0.22, roofF: 0.3, roofR: 0.93, glassR: 0.96, belt: 0.58, nose: 0.6, tail: 0.65, ground: 0.15, wheelR: 0.4, grille: true, tumble: 0.05, noseC: 0.06 },
  pickup: { hood: 0.24, roofF: 0.35, roofR: 0.55, glassR: 0.58, belt: 0.58, nose: 0.57, tail: 0.58, ground: 0.14, wheelR: 0.39, bed: true, grille: true, tumble: 0.1 },
  mpv: { hood: 0.17, roofF: 0.28, roofR: 0.95, glassR: 0.985, belt: 0.56, nose: 0.46, tail: 0.6, ground: 0.1, wheelR: 0.36, grille: true, tumble: 0.1 },
  van: { hood: 0.1, roofF: 0.2, roofR: 0.97, glassR: 0.99, belt: 0.55, nose: 0.44, tail: 0.58, ground: 0.1, wheelR: 0.37, grille: true, tumble: 0.08 },
  ev_sedan: { hood: 0.27, roofF: 0.42, roofR: 0.64, glassR: 0.93, belt: 0.63, nose: 0.44, tail: 0.68, deck: 0.7, ground: 0.1, wheelR: 0.34, grille: false, tumble: 0.18, rearP: 1.7 },
  ev_hatch_suv: { hood: 0.24, roofF: 0.37, roofR: 0.93, glassR: 0.975, belt: 0.6, nose: 0.47, tail: 0.64, ground: 0.12, wheelR: 0.36, grille: false, tumble: 0.12 },
  ev_crossover: { hood: 0.26, roofF: 0.4, roofR: 0.76, glassR: 0.94, belt: 0.61, nose: 0.47, tail: 0.66, ground: 0.12, wheelR: 0.36, grille: false, tumble: 0.15, rearP: 1.4 },
  ev_suv: { hood: 0.23, roofF: 0.35, roofR: 0.94, glassR: 0.975, belt: 0.58, nose: 0.55, tail: 0.66, ground: 0.13, wheelR: 0.38, grille: false, tumble: 0.1 },
  van_tall: { hood: 0.11, roofF: 0.22, roofR: 0.975, glassR: 0.99, belt: 0.44, nose: 0.37, tail: 0.5, ground: 0.07, wheelR: 0.37, grille: true, tumble: 0.06, noseC: 0.12, pillars: 3 },
  minibus: { hood: 0.075, roofF: 0.15, roofR: 0.975, glassR: 0.99, belt: 0.47, nose: 0.36, tail: 0.5, ground: 0.08, wheelR: 0.4, grille: true, tumble: 0.06, noseC: 0.1, pillars: 4 },
};

type Front = "slim" | "bar" | "twin" | "pixel" | "round" | "split";
type Grille = "wide" | "tiger" | "crest" | "kidney" | "box" | "big" | "none";
type Rear = "bar" | "twin" | "cluster" | "vertical" | "pixel";

interface CarStyle {
  front: Front;
  grille: Grille;
  rear: Rear;
  /** 크롬 창틀·벨트 몰딩 */
  chrome?: boolean;
  roof?: "paint" | "glass" | "black";
  /** 검정 휠아치·하단 (SUV) */
  clad?: boolean;
  /** 뒤 쪽창이 있는 창 배치 */
  six?: boolean;
  caliper?: "red" | "grey";
  /** 가운데를 잇는 앞 주간등 */
  bar?: boolean;
  spoiler?: boolean;
  /** 뒷좌석 짙은 유리 */
  privacy?: boolean;
}

const BODY_STYLE: Record<string, CarStyle> = {
  microcar: { front: "slim", grille: "tiger", rear: "cluster" },
  box_micro: { front: "slim", grille: "tiger", rear: "vertical", six: true },
  hatch: { front: "slim", grille: "wide", rear: "cluster", six: true },
  sedan: { front: "slim", grille: "wide", rear: "bar" },
  fastback: { front: "slim", grille: "tiger", rear: "bar" },
  sedan_large: { front: "bar", grille: "wide", rear: "bar", chrome: true },
  coupe: { front: "slim", grille: "tiger", rear: "bar", caliper: "red" },
  sports: { front: "round", grille: "none", rear: "bar", caliper: "red", spoiler: true },
  wagon: { front: "slim", grille: "wide", rear: "cluster", six: true, chrome: true },
  suv_small: { front: "split", grille: "wide", rear: "bar", clad: true, six: true, bar: true },
  suv_mid: { front: "slim", grille: "tiger", rear: "vertical", clad: true, six: true, privacy: true },
  suv_large: { front: "split", grille: "big", rear: "vertical", six: true, chrome: true, privacy: true },
  suv_coupe: { front: "slim", grille: "kidney", rear: "cluster" },
  suv_boxy: { front: "round", grille: "box", rear: "vertical", six: true, privacy: true },
  pickup: { front: "slim", grille: "box", rear: "vertical", clad: true },
  mpv: { front: "slim", grille: "wide", rear: "bar", six: true, chrome: true, privacy: true },
  van: { front: "bar", grille: "wide", rear: "vertical", six: true, privacy: true },
  ev_sedan: { front: "bar", grille: "none", rear: "bar", roof: "glass" },
  ev_hatch_suv: { front: "pixel", grille: "none", rear: "pixel", six: true, clad: true, roof: "glass" },
  ev_crossover: { front: "slim", grille: "none", rear: "bar", clad: true },
  ev_suv: { front: "split", grille: "none", rear: "vertical", six: true, clad: true },
  van_tall: { front: "slim", grille: "wide", rear: "vertical", privacy: true },
  minibus: { front: "bar", grille: "wide", rear: "vertical", privacy: true },
};

const TYPE_STYLE: Record<string, Partial<CarStyle>> = {
  sedan_mid: { front: "bar", rear: "bar" },
  taxi_private: { front: "bar", rear: "bar" },
  taxi_corp: { front: "bar", rear: "bar" },
  police_patrol: { front: "bar", rear: "bar" },
  sedan_luxury: { front: "twin", grille: "crest", rear: "twin", chrome: true },
  sedan_flagship: { front: "twin", grille: "crest", rear: "twin", chrome: true },
  suv_luxury: { front: "twin", grille: "crest", rear: "twin", chrome: true },
  sedan_import_mid: { front: "slim", grille: "wide", rear: "cluster", chrome: true },
  sedan_import_compact: { front: "slim", grille: "kidney", rear: "cluster" },
  suv_import: { front: "slim", grille: "kidney", rear: "cluster", chrome: true },
  micro_suv: { front: "round", grille: "tiger", rear: "vertical", clad: true, six: false },
  ev_micro: { front: "round", grille: "none", rear: "vertical", clad: true },
  ev_small_suv: { front: "split", grille: "none", rear: "bar", bar: true },
  taxi_ev_suv: { front: "split", grille: "none", rear: "bar", bar: true },
  ev_sedan_compact: { front: "slim", grille: "none", rear: "cluster", roof: "glass" },
  ev_suv_mid: { front: "slim", grille: "none", rear: "cluster", roof: "glass" },
  fcev_suv: { front: "slim", grille: "wide", rear: "bar" },
  taxi_deluxe: { chrome: true },
  suv_coupe: { roof: "paint" },
};

function styleOf(t: VehicleType): CarStyle {
  return { ...(BODY_STYLE[t.body] ?? BODY_STYLE.sedan), ...(TYPE_STYLE[t.id] ?? {}) };
}

function buildCar(t: VehicleType, b: VB) {
  const sh = SHAPES[t.body] ?? SHAPES.sedan;
  const st = styleOf(t);
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const xF = L / 2;
  const X = (f: number) => xF - f * L;
  const F = (x: number) => (xF - x) / L;
  const W2 = W / 2 - 0.005;
  const yb = 0.09 + sh.ground * H * 0.65;
  const wr = sh.wheelR;
  const tireW = 0.19 + W * 0.025;
  const xf = xF - (L - t.wheelbase) * 0.46;
  const xr = xf - t.wheelbase;
  const Ra = wr + 0.05;
  const yBelt = sh.belt * H;
  const yNose = sh.nose * H;
  const hasDeck = sh.deck !== undefined;
  const yDeck = hasDeck ? sh.deck! * H : yBelt + 0.05;
  const yTail = sh.tail * H;
  const fh = sh.hood;
  const fRF = sh.roofF;
  const fRR = sh.roofR;
  const fGR = sh.glassR;
  const yBeltR = hasDeck ? yDeck - 0.02 : yBelt + 0.045;
  const sporty = t.body === "sports" || t.body === "coupe";

  const top = (f: number) => {
    let y: number;
    if (f <= fh) {
      const u = f / fh;
      y = yNose + (yBelt - yNose) * (1 - (1 - u) ** 1.7);
    } else if (f <= fGR) {
      const u = (f - fh) / (fGR - fh);
      y = yBelt + (yBeltR - yBelt) * u ** 1.4;
    } else {
      const u = (f - fGR) / Math.max(0.001, 1 - fGR);
      y = yBeltR + (yDeck - yBeltR) * smooth(u * 2.2);
    }
    const dF = f * L;
    // 보닛 앞끝이 둥글게 앞면으로 넘어간다
    y -= corner(dF, 0.2, 0.075);
    const dR = (1 - f) * L;
    if (dR < 0.3) y = lerp(y, yTail, smooth(1 - dR / 0.3) ** 1.5);
    y -= corner(dR, 0.12, 0.04);
    return y;
  };
  const bottom = (f: number) => yb + 0.1 * (1 - clamp((f * L) / 0.45, 0, 1)) ** 2 + 0.11 * (1 - clamp(((1 - f) * L) / 0.5, 0, 1)) ** 2;
  const noseC = sh.noseC ?? 0.17;
  // 위에서 보면: 앞뒤 모서리가 둥글고 (초타원) 앞쪽이 조금 좁아진다
  const hwAt = (f: number) => {
    const dF = f * L;
    const dR = (1 - f) * L;
    let w = W2 - corner(dF, noseC * 1.2, noseC * 1.2) - corner(dR, 0.2, 0.18);
    if (dF < 0.9) w -= noseC * 0.5 * (1 - dF / 0.9) ** 2;
    if (dR < 0.7) w -= 0.05 * (1 - dR / 0.7) ** 2;
    return w;
  };
  const yRoofAt = (u: number) => H - 0.01 - 0.035 * u * u;
  const roof = (f: number) => {
    if (f <= fh || f >= fGR) return -1;
    if (f < fRF) {
      const u = (f - fh) / (fRF - fh);
      return lerp(top(f), yRoofAt(0), 1 - (1 - u) ** 1.35);
    }
    if (f <= fRR) return yRoofAt((f - fRF) / (fRR - fRF));
    const u = (f - fRR) / (fGR - fRR);
    return lerp(yRoofAt(1), top(f), u ** (sh.rearP ?? 1.15));
  };
  const crown = (f: number) => (f < fGR ? 0.028 : 0.018);
  const arches = [
    { x: xf, r: Ra, yc: wr + 0.012 },
    { x: xr, r: Ra, yc: wr + 0.012 },
  ];
  const P: Profile = {
    xF,
    len: L,
    top,
    bottom,
    hw: hwAt,
    roof,
    crown,
    tumble: sh.tumble ?? 0.15,
    shelf: 0.06,
    rail: 0.025,
    // A필러는 가늘게, 지붕 옆은 둥글게
    round: (f) => lerp(0.085, 0.15, smooth((f - fRF) / 0.08)),
    gA: [0.5, 0.9],
    arches,
    tireW,
    fender: sporty ? 0.13 : 0.1,
  };
  const section = makeSection(P);

  // 창 배치
  const vanLike = !!sh.pillars;
  const xB = vanLike ? X(fRF) - 0.85 : X(lerp(fRF, fRR, sh.bed ? 0.9 : 0.42));
  // 승합·미니버스: B필러 뒤 창 기둥
  const pillarXs: number[] = [];
  for (let i = 1; i <= (sh.pillars ?? 0); i++) pillarXs.push(lerp(xB, X(fGR) + 0.35, i / ((sh.pillars ?? 0) + 1)));
  const six = !!st.six && !sh.bed;
  const xCb = X(lerp(fRF, fRR, 0.76));
  const xC = (j: number) => X(fRR + (fGR - fRR) * 0.12) + (j - J.G1) * 0.1;
  const inArch = (x: number) => arches.some((a) => Math.abs(x - a.x) < a.r);
  const zoneOf = (f: number) => (f <= fh || f >= fGR ? "body" : f < fRF ? "ws" : f < fRR ? "roof" : "rear");
  const sideWin = (xm: number, j: number): Surf => {
    const f = F(xm);
    if (Math.abs(xm - xB) < 0.045) return S.gloss;
    if (pillarXs.some((p) => Math.abs(xm - p) < 0.04)) return S.gloss;
    if (sh.bed && f > fRR) return S.paint;
    if (six) {
      if (Math.abs(xm - xCb) < 0.035) return S.gloss;
      if (f >= fRR) return S.paint;
    } else if (xm < xC(j)) return S.paint;
    return st.privacy && xm < xB ? S.glassPriv : S.glass;
  };
  const roofSurf = st.roof === "glass" ? S.glass : st.roof === "black" ? S.gloss : S.paint;
  const surfAt = (xa: number, xb: number, j: number): Surf | null => {
    const xm = (xa + xb) / 2;
    const f = F(xm);
    const zone = zoneOf(f);
    const ends = xF - xm < 0.32 || xm + xF < 0.32;
    switch (j) {
      case J.UNDER:
        return S.under;
      case J.WELL:
        return S.well;
      case J.WELL_TOP:
        return inArch(xm) ? S.well : S.under;
      case J.LIP:
        return st.clad || ends ? S.clad : S.paint;
      case J.SHELF:
        return zone === "body" ? S.paint : st.chrome ? S.chrome : S.gloss;
      case J.G1:
      case J.G2:
        return zone === "body" ? S.paint : zone === "ws" ? S.glass : sideWin(xm, j);
      case J.G3:
        return zone === "body" ? S.paint : zone === "ws" ? S.glass : sideWin(xm, j);
      case J.RAIL:
        return zone === "roof" && st.roof === "black" ? S.gloss : S.paint;
      case J.ROOF:
        return zone === "ws" || zone === "rear" ? S.glass : zone === "roof" ? roofSurf : S.paint;
      default:
        return S.paint;
    }
  };
  const cap = (j: number) => (j <= J.WELL_TOP ? S.under : j === J.LIP ? S.clad : S.paint);

  // 마디
  const stations: number[] = [];
  for (const d of [0, 0.004, 0.015, 0.035, 0.065, 0.1, 0.15, 0.21, 0.3, 0.45]) stations.push(xF - d, -xF + d);
  for (const f of [fh * 0.55, fh * 0.8, fh]) stations.push(X(f));
  for (const u of [0.2, 0.45, 0.72, 1]) stations.push(X(fh + (fRF - fh) * u));
  stations.push(X(lerp(fRF, fRR, 0.2)), X(lerp(fRF, fRR, 0.62)), X(fRR), xB + 0.045, xB - 0.045);
  if (six) stations.push(xCb + 0.035, xCb - 0.035);
  else for (let j = J.G1; j <= J.G3; j++) stations.push(xC(j));
  for (const p of pillarXs) stations.push(p + 0.04, p - 0.04);
  for (const u of [0.33, 0.66, 1]) stations.push(X(fRR + (fGR - fRR) * u));
  stations.push(X(lerp(fGR, 1, 0.45)));
  const archSt = (list: number[], angles: number[]) => {
    for (const a of arches) {
      for (const deg of angles) list.push(a.x + a.r * Math.cos((deg * Math.PI) / 180));
      list.push(a.x + a.r + 0.006, a.x + a.r - 0.006, a.x - a.r + 0.006, a.x - a.r - 0.006);
    }
  };
  archSt(stations, [30, 60, 90, 120, 150]);
  // 모서리: 차체 아래끝, 어깨선, 창틀, 유리 아래·위 (법선을 나눠 선이 또렷하다)
  const body = new Loft({ stations, section, surf: surfAt, capFront: cap, capRear: cap, creases: [J.LIP, J.SHOULDER, J.SHELF, J.G1, J.RAIL] });

  // 실내 안쪽 면: 천장·기둥은 밝은 천 (스포츠카·경찰차는 검정)
  const light = !sporty && !t.id.startsWith("police");
  const innerSurf = (_xa: number, _xb: number, j: number, outer: Surf | null): Surf | null => {
    if (!outer || outer.tag === TAG.GLASS) return null;
    if (j <= J.WELL_TOP) return S.inFloor;
    if (j <= J.SHOULDER2) return S.inDoor;
    if (j === J.SHELF) return S.inPillar;
    return light ? S.inHead : S.inHeadDark;
  };
  body.build(b.m, { m: b.inner, x0: X(fh) + 0.05, x1: X(fGR) - 0.02, surf: innerSurf });

  // 중간 거리 몸체
  const midSt: number[] = [];
  for (const d of [0, 0.02, 0.1, 0.25]) midSt.push(xF - d, -xF + d);
  midSt.push(X(fh * 0.6), X(fh), X((fh + fRF) / 2), X(fRF), X(fRR), xB + 0.045, xB - 0.045, X((fRR + fGR) / 2), X(fGR), X(lerp(fGR, 1, 0.45)));
  if (six) midSt.push(xCb + 0.035, xCb - 0.035);
  else midSt.push(xC(J.G2));
  archSt(midSt, [60, 120]);
  new Loft({
    stations: midSt,
    section: (x) => {
      const s = section(x);
      return MID_KEEP.map((k) => s[k]);
    },
    surf: (xa, xb, j) => surfAt(xa, xb, MID_KEEP[j]),
    capFront: (j) => cap(MID_KEEP[j]),
    capRear: (j) => cap(MID_KEEP[j]),
  }).build(b.mid);

  // ---- 앞 ----
  const yF0 = top(0.2 / L);
  const yL = yF0 - 0.075;
  const core = b.core;
  const D = dual(b, body);
  const plateY = st.grille === "crest" ? yb + 0.17 : yb + 0.24;
  const sigR = S.sigR;
  const sigL = S.sigL;
  const lampPair = (pts: Pt[], s: Surf, off = 0.014, lv = 2) => D.polyPair("front", pts, s, off, lv);
  const stripPair = (line: Pt[], w: number, s: Surf | [Surf, Surf], off = 0.016) => D.stripPair("front", line, w, s, off);
  switch (st.front) {
    case "slim":
      lampPair([[0.4 * W2, yL - 0.035], [0.93 * W2, yL - 0.022], [1.0 * W2, yL + 0.035], [0.44 * W2, yL + 0.03]], S.headHousing);
      stripPair([[0.46 * W2, yL + 0.021], [0.97 * W2, yL + 0.029]], 0.014, S.drl);
      stripPair([[0.84 * W2, yL - 0.012], [0.97 * W2, yL - 0.006]], 0.014, [sigR, sigL]);
      for (const c of [0.56, 0.67, 0.78]) lampPair(rect(c * W2 - 0.03, yL - 0.022, c * W2 + 0.03, yL + 0.008), S.headLens, 0.018, 1);
      break;
    case "bar":
      stripPair([[0, yF0 - 0.012], [0.93 * W2, yF0 - 0.02]], 0.04, S.lampBand, 0.012);
      stripPair([[0, yF0 - 0.012], [0.92 * W2, yF0 - 0.02]], 0.014, S.drl, 0.016);
      lampPair([[0.5 * W2, yL - 0.1], [0.95 * W2, yL - 0.08], [0.99 * W2, yL - 0.005], [0.52 * W2, yL - 0.03]], S.headHousing);
      for (const c of [0.62, 0.74, 0.86]) lampPair(rect(c * W2 - 0.032, yL - 0.072 + (c - 0.62) * 0.08, c * W2 + 0.032, yL - 0.04 + (c - 0.62) * 0.08), S.headLens, 0.018, 1);
      stripPair([[0.72 * W2, yL - 0.125], [0.88 * W2, yL - 0.115]], 0.016, [sigR, sigL]);
      break;
    case "twin":
      lampPair([[0.44 * W2, yL - 0.05], [1.0 * W2, yL - 0.035], [1.02 * W2, yL + 0.07], [0.44 * W2, yL + 0.058]], S.headHousing);
      stripPair([[0.47 * W2, yL + 0.035], [0.99 * W2, yL + 0.047]], 0.02, S.drl);
      stripPair([[0.49 * W2, yL - 0.022], [0.99 * W2, yL - 0.012]], 0.02, S.drl);
      stripPair([[0.9 * W2, yL + 0.012], [1.0 * W2, yL + 0.018]], 0.014, [sigR, sigL]);
      break;
    case "pixel":
      lampPair(rect(0.56 * W2, yL - 0.05, 0.96 * W2, yL + 0.04), S.gloss, 0.013, 2);
      for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) lampPair(rect((0.6 + c * 0.075) * W2, yL - 0.03 + r * 0.04, (0.6 + c * 0.075) * W2 + 0.028, yL - 0.03 + r * 0.04 + 0.024), c === 4 && r === 0 ? S.headLens : S.drl, 0.017, 1);
      stripPair([[0.6 * W2, yL - 0.075], [0.9 * W2, yL - 0.075]], 0.012, [sigR, sigL]);
      break;
    case "round":
      lampPair(circle(0.7 * W2, yL, 0.085, 0.085, 14), S.headHousing, 0.014, 2);
      D.stripPair("front", closeLoop(circle(0.7 * W2, yL, 0.088, 0.088, 14)), 0.014, S.chrome, 0.016, 0.04);
      D.stripPair("front", closeLoop(circle(0.7 * W2, yL, 0.055, 0.055, 12)), 0.012, S.drl, 0.018, 0.04);
      stripPair([[0.6 * W2, yL - 0.12], [0.8 * W2, yL - 0.12]], 0.018, [sigR, sigL]);
      break;
    case "split":
      if (st.bar) stripPair([[0, yF0 - 0.008], [0.99 * W2, yF0 - 0.012]], 0.016, S.drl, 0.014);
      else stripPair([[0.36 * W2, yF0 - 0.02], [0.99 * W2, yF0 - 0.012]], 0.02, S.drl, 0.014);
      lampPair([[0.62 * W2, yL - 0.2], [0.95 * W2, yL - 0.18], [0.96 * W2, yL - 0.1], [0.64 * W2, yL - 0.11]], S.headHousing);
      for (const c of [0.72, 0.85]) lampPair(rect(c * W2 - 0.03, yL - 0.17, c * W2 + 0.03, yL - 0.13), S.headLens, 0.018, 1);
      stripPair([[0.88 * W2, yF0 - 0.04], [0.99 * W2, yF0 - 0.036]], 0.014, [sigR, sigL]);
      break;
  }
  // 그릴
  const gTop = st.front === "split" || st.front === "bar" ? yL - 0.005 : yL + 0.01;
  const gBot = plateY + 0.075;
  const frontPoly = (pts: Pt[], s: Surf, off = 0.01, lv = 1) => D.poly("front", pts, s, off, lv);
  const frontStrip = (line: Pt[], w: number, s: Surf, off = 0.014) => D.strip("front", line, w, s, off);
  switch (st.grille) {
    case "wide": {
      const g: Pt[] = [[-0.36 * W2, gTop], [0.36 * W2, gTop], [0.44 * W2, (gTop + gBot) / 2], [0.4 * W2, gBot], [-0.4 * W2, gBot], [-0.44 * W2, (gTop + gBot) / 2]];
      frontPoly(g, S.mesh);
      if (st.chrome) frontStrip(closeLoop(g), 0.018, S.chrome);
      for (let k = 1; k < 4; k++) {
        const v = lerp(gBot, gTop, k / 4);
        frontStrip([[-0.39 * W2, v], [0.39 * W2, v]], 0.008, S.darkChrome, 0.013);
      }
      frontPoly([[-0.44 * W2, yb + 0.06], [0.44 * W2, yb + 0.06], [0.4 * W2, yb + 0.15], [-0.4 * W2, yb + 0.15]], S.mesh);
      break;
    }
    case "tiger": {
      const g: Pt[] = [[-0.3 * W2, yL + 0.028], [0.3 * W2, yL + 0.028], [0.26 * W2, yL - 0.045], [0.09 * W2, yL - 0.065], [-0.09 * W2, yL - 0.065], [-0.26 * W2, yL - 0.045]];
      frontPoly(g, S.mesh);
      frontStrip(closeLoop(g), 0.012, S.chrome);
      frontPoly([[-0.55 * W2, yb + 0.06], [0.55 * W2, yb + 0.06], [0.6 * W2, gBot + 0.02], [-0.6 * W2, gBot + 0.02]], S.mesh);
      break;
    }
    case "crest": {
      const g: Pt[] = [[-0.25 * W2, yL + 0.05], [0.25 * W2, yL + 0.05], [0.33 * W2, yL - 0.09], [0.1 * W2, yb + 0.26], [-0.1 * W2, yb + 0.26], [-0.33 * W2, yL - 0.09]];
      frontPoly(g, S.mesh, 0.01, 2);
      frontStrip(closeLoop(g), 0.024, S.chrome, 0.015);
      for (let k = 1; k < 4; k++) {
        const v = lerp(yb + 0.3, yL + 0.03, k / 4);
        frontStrip([[-0.25 * W2, v], [0.25 * W2, v]], 0.007, S.satin, 0.013);
      }
      frontPoly([[-0.6 * W2, yb + 0.06], [0.6 * W2, yb + 0.06], [0.56 * W2, yb + 0.11], [-0.56 * W2, yb + 0.11]], S.mesh);
      break;
    }
    case "kidney":
      for (const s of [-1, 1]) {
        const g = circle(s * 0.13 * W2, yL - 0.035, 0.1 * W2, 0.075, 14);
        frontPoly(g, S.mesh);
        frontStrip(closeLoop(g), 0.014, S.chrome);
      }
      frontPoly([[-0.5 * W2, yb + 0.06], [0.5 * W2, yb + 0.06], [0.45 * W2, gBot], [-0.45 * W2, gBot]], S.mesh);
      break;
    case "box": {
      const g = rect(-0.46 * W2, yL - 0.12, 0.46 * W2, yL + 0.06);
      frontPoly(g, S.mesh);
      frontStrip(closeLoop(g), 0.02, S.chrome);
      for (let k = 1; k < 3; k++) frontStrip([[-0.45 * W2, lerp(yL - 0.12, yL + 0.06, k / 3)], [0.45 * W2, lerp(yL - 0.12, yL + 0.06, k / 3)]], 0.014, S.satin, 0.013);
      frontPoly(rect(-0.8 * W2, yb + 0.02, 0.8 * W2, yb + 0.14), S.trim, 0.012, 1);
      break;
    }
    case "big": {
      const g: Pt[] = [[-0.5 * W2, gTop + 0.01], [0.5 * W2, gTop + 0.01], [0.56 * W2, gBot], [-0.56 * W2, gBot]];
      frontPoly(g, S.mesh, 0.01, 2);
      frontStrip(closeLoop(g), 0.02, S.chrome);
      for (let k = 1; k < 5; k++) {
        const v = lerp(gBot, gTop, k / 5);
        frontStrip([[-0.53 * W2, v], [0.53 * W2, v]], 0.012, S.satin, 0.013);
      }
      frontPoly([[-0.5 * W2, yb + 0.05], [0.5 * W2, yb + 0.05], [0.45 * W2, yb + 0.14], [-0.45 * W2, yb + 0.14]], S.mesh);
      break;
    }
    case "none":
      frontPoly([[-0.46 * W2, yb + 0.07], [0.46 * W2, yb + 0.07], [0.4 * W2, yb + 0.17], [-0.4 * W2, yb + 0.17]], S.gloss);
      break;
  }
  if (st.grille !== "none") decalPoly(b.m, body, "front", circle(0, st.grille === "crest" ? yL + 0.075 : yL + 0.045, 0.05, 0.024, 10), S.chrome, 0.018, 0);
  plate(core, body, "front", t, plateY, undefined, 0.52, 0.11, b.m);

  // 전조등·방향지시등 위치
  b.at(body, "front", 0.7 * W2, yL, b.head);
  b.at(body, "front", -0.7 * W2, yL, b.head);
  b.at(body, "front", 0.92 * W2, yL - 0.01, b.sigR);
  b.at(body, "front", -0.92 * W2, yL - 0.01, b.sigL);

  // ---- 뒤 ----
  const yR0 = top(1 - 0.12 / L);
  const yRL = yR0 - 0.1;
  const rearPair = (pts: Pt[], s: Surf | [Surf, Surf], off = 0.012, lv = 1) => D.polyPair("rear", pts, s, off, lv);
  const rearStripPair = (line: Pt[], w: number, s: Surf | [Surf, Surf], off = 0.016) => D.stripPair("rear", line, w, s, off);
  const rearStrip = (line: Pt[], w: number, s: Surf, off = 0.016) => D.strip("rear", line, w, s, off);
  const lowSignals = () => rearStripPair([[0.66 * W2, yb + 0.3], [0.92 * W2, yb + 0.3]], 0.03, [sigR, sigL]);
  const reverse = () => rearPair(rect(0.36 * W2, yb + 0.26, 0.5 * W2, yb + 0.31), S.reverse, 0.014, 0);
  switch (st.rear) {
    case "bar":
      rearStrip([[-0.97 * W2, yRL + 0.02], [0.97 * W2, yRL + 0.02]], 0.028, S.tail);
      rearPair([[0.6 * W2, yRL - 0.045], [1.0 * W2, yRL - 0.035], [1.03 * W2, yRL + 0.045], [0.64 * W2, yRL + 0.04]], S.tailSmoke);
      lowSignals();
      reverse();
      break;
    case "twin":
      rearStripPair([[0.44 * W2, yRL + 0.035], [1.0 * W2, yRL + 0.04]], 0.022, S.tail);
      rearStripPair([[0.46 * W2, yRL - 0.02], [1.0 * W2, yRL - 0.015]], 0.022, S.tail);
      if (t.id === "sedan_flagship") rearStrip([[-0.44 * W2, yRL + 0.035], [0.44 * W2, yRL + 0.035]], 0.01, S.tail);
      lowSignals();
      reverse();
      break;
    case "cluster":
      rearPair([[0.5 * W2, yRL - 0.045], [0.9 * W2, yRL - 0.065], [1.03 * W2, yRL - 0.02], [1.03 * W2, yRL + 0.05], [0.52 * W2, yRL + 0.04]], S.tail);
      rearPair(rect(0.56 * W2, yRL - 0.035, 0.7 * W2, yRL - 0.005), S.reverse, 0.016, 0);
      rearStripPair([[0.74 * W2, yRL + 0.02], [0.98 * W2, yRL + 0.022]], 0.02, [sigR, sigL], 0.018);
      break;
    case "vertical":
      rearPair([[0.8 * W2, yRL - 0.3], [1.02 * W2, yRL - 0.28], [1.03 * W2, yRL + 0.06], [0.78 * W2, yRL + 0.05]], S.tail);
      rearStripPair([[0.5 * W2, yRL + 0.035], [0.8 * W2, yRL + 0.04]], 0.02, S.tail);
      rearStripPair([[0.86 * W2, yRL - 0.2], [0.98 * W2, yRL - 0.19]], 0.03, [sigR, sigL], 0.018);
      reverse();
      break;
    case "pixel":
      rearPair(rect(0.5 * W2, yRL - 0.05, 0.97 * W2, yRL + 0.05), S.gloss, 0.012, 0);
      for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) rearPair(rect((0.54 + c * 0.085) * W2, yRL - 0.035 + r * 0.045, (0.54 + c * 0.085) * W2 + 0.03, yRL - 0.035 + r * 0.045 + 0.026), S.tail, 0.016, 0);
      lowSignals();
      reverse();
      break;
  }
  // 반사판, 디퓨저, 머플러, 번호판, 엠블럼
  rearStripPair([[0.72 * W2, yb + 0.17], [0.9 * W2, yb + 0.17]], 0.025, S.reflector, 0.012);
  D.poly("rear", [[-0.7 * W2, yb + 0.05], [0.7 * W2, yb + 0.05], [0.66 * W2, yb + 0.13], [-0.66 * W2, yb + 0.13]], S.trim, 0.01, 1);
  if (!t.ev) for (const s of [-1, 1]) decalPoly(b.m, body, "rear", circle(s * 0.55 * W2, yb + 0.09, 0.045, 0.03, 10), S.chrome, 0.016, 0);
  const plateYR = hasDeck ? yR0 - 0.3 : lerp(yb, yR0, 0.5);
  plate(core, body, "rear", t, plateYR, undefined, 0.52, 0.11, b.m);
  decalPoly(b.m, body, "rear", circle(0, yRL + 0.07, 0.045, 0.022, 10), S.chrome, 0.018, 0);
  // 보조 제동등: 뒷유리 위
  const yCH = roof(fRR + (fGR - fRR) * 0.1) - 0.04;
  if (!sh.bed) D.strip("rear", [[-0.16, yCH], [0.16, yCH]], 0.022, S.brake, 0.02);
  b.at(body, "rear", 0.8 * W2, yRL, b.brake);
  b.at(body, "rear", -0.8 * W2, yRL, b.brake);
  b.at(body, "rear", 0.9 * W2, yRL + 0.01, b.sigR);
  b.at(body, "rear", -0.9 * W2, yRL + 0.01, b.sigL);

  // ---- 옆: 문 틈, 손잡이, 창틀 ----
  const m = b.m;
  const xA = Math.min(X(fh) - 0.06, xf - Ra - 0.06);
  const seam = (line: Pt[]) => decalStripPair(m, body, "right", line, 0.006, S.seam, 0.004, 0.08);
  seam([[xA, yb + 0.14], [xA + 0.02, top(F(xA)) - 0.02]]);
  seam([[xB, yb + 0.12], [xB, top(F(xB)) - 0.01]]);
  const rr = Ra + 0.045;
  const rd: Pt[] = [];
  const xRD = xr + rr * Math.cos((70 * Math.PI) / 180);
  if (!sh.bed) {
    rd.push([xRD, top(F(xRD)) - 0.01]);
    for (let a = 70; a >= 10; a -= 15) rd.push([xr + rr * Math.cos((a * Math.PI) / 180), wr + 0.012 + rr * Math.sin((a * Math.PI) / 180)]);
    seam(rd);
  }
  const handle = st.chrome ? S.chrome : paintSurf(0.72, 0.6);
  const yH = yBelt - 0.09;
  for (const hx of [xB + 0.3, sh.bed ? null : xRD + 0.3]) {
    if (hx === null) continue;
    decalPolyPair(m, body, "right", rect(hx - 0.11, yH - 0.016, hx + 0.11, yH + 0.016), handle, 0.008, 0);
  }
  if (st.chrome) {
    // 창 윗선 크롬
    const xs0 = X(fRF) - 0.02;
    const xs1 = six ? X(fRR) + 0.02 : xC(J.G3) + 0.02;
    const line: Pt[] = [];
    for (let k = 0; k <= 8; k++) {
      const x = lerp(xs0, xs1, k / 8);
      const s = section(x);
      line.push([x, s[J.RAIL][0] - 0.012]);
    }
    decalStripPair(m, body, "right", line, 0.016, S.chrome, 0.006, 0.12);
  }
  if (st.clad) {
    // 휠아치 테두리
    for (const a of arches) {
      const arc: Pt[] = [];
      for (let d = 0; d <= 180; d += 20) arc.push([a.x + (a.r + 0.03) * Math.cos((d * Math.PI) / 180), a.yc + (a.r + 0.03) * Math.sin((d * Math.PI) / 180)]);
      decalStripPair(m, body, "right", arc, 0.06, S.clad, 0.006, 0.07);
    }
  }

  // ---- 사이드미러: 문 앞 모서리 벨트라인 위, 뒤를 보는 유리 ----
  const xm = X(fh) - 0.2;
  const ym = yBelt + 0.1;
  const zm = hwAt(fh) + 0.08;
  const mirrorSurf = st.roof === "black" ? S.gloss : S.paint;
  const glassW = 0.2;
  const glassH = 0.095;
  for (const s of [-1, 1]) {
    const z = s * zm;
    ellipsoid(m, 0.075, 0.064, 0.118, xm + 0.005, ym, z, mirrorSurf, 10, 6);
    cbox(m, 0.07, 0.128, 0.236, 0.028, xm - 0.03, ym, z, mirrorSurf);
    box(m, 0.006, glassH + 0.012, glassW + 0.014, xm - 0.066, ym, z, S.trim);
    box(m, 0.004, glassH, glassW, xm - 0.07, ym, z, S.mirrorGlass);
    // 받침 (문에 붙는 부분)
    cbox(m, 0.1, 0.03, 0.1, 0.01, xm - 0.02, ym - 0.045, s * (zm - 0.13), S.trim);
    // 옆 방향지시등
    box(m, 0.03, 0.016, 0.09, xm + 0.06, ym - 0.03, s * (zm + 0.06), s < 0 ? sigL : sigR, 0.5);
    cbox(b.mid, 0.14, 0.12, 0.23, 0.04, xm - 0.01, ym, z, mirrorSurf);
  }

  // ---- 브레이크 캘리퍼 ----
  const calS = st.caliper === "red" ? S.caliperRed : S.caliper;
  for (const a of arches) for (const s of [-1, 1]) box(m, 0.13, 0.17, 0.05, a.x + 0.05, wr + 0.08, s * (W2 - 0.02 - tireW * 0.62), calS, 0, 0.5);

  // ---- 바퀴 ----
  for (const x of [xf, xr]) for (const s of [-1, 1]) b.wheels.push({ x, z: s * (W2 - 0.015 - tireW / 2), r: wr, w: tireW, steer: x === xf, heavy: false });

  // ---- 부가물 ----
  const ex = t.extras ?? [];
  const xRoof = X((fRF + fRR) / 2);
  if (ex.includes("taxiSign")) {
    const col = t.sign === "모범" ? 0xe7c55a : t.sign === "개인" ? 0xf2d23c : 0xf5f5f0;
    cbox(core, 0.24, 0.18, 0.6, 0.04, xRoof + 0.1, H + 0.12, 0, surf(col, 0.4, 0, 0.5, TAG.GLOW));
    box(core, 0.26, 0.04, 0.62, xRoof + 0.1, H + 0.02, 0, S.trim);
  }
  if (ex.includes("goldStripe")) decalStripPair(m, body, "right", [[xF - 0.5, yBelt - 0.13], [-xF + 0.5, yBelt - 0.11]], 0.035, surf(0xc8a24a, 0.3, 0.9, 0.5), 0.006, 0.2);
  if (ex.includes("roofRack")) for (const s of [-1, 1]) box(core, X(fRF) - X(fRR), 0.04, 0.04, xRoof, H + 0.05, s * (W2 - 0.25), S.satin);
  if (ex.includes("lightBar")) {
    const xb = xRoof + 0.1;
    cbox(core, 0.28, 0.1, 0.56, 0.03, xb, H + 0.07, -0.29, surf(0xc81818, 0.2, 0, 1, TAG.BEACON_A));
    cbox(core, 0.28, 0.1, 0.56, 0.03, xb, H + 0.07, 0.29, surf(0x1a48d0, 0.2, 0, 1, TAG.BEACON_B));
    box(core, 0.3, 0.035, 1.16, xb, H + 0.01, 0, S.trim);
  }
  if (t.livery === "police") {
    decalStripPair(m, body, "right", [[xF - 0.35, yBelt - 0.24], [-xF + 0.35, yBelt - 0.22]], 0.17, surf(0x1f3f8f, 0.35, 0.2, 1), 0.006, 0.15);
    decalStripPair(m, body, "right", [[xF - 0.35, yBelt - 0.12], [-xF + 0.35, yBelt - 0.1]], 0.04, surf(0xf2c230, 0.35, 0.2, 1), 0.007, 0.15);
  }
  if (t.livery === "ambulance") {
    decalStripPair(m, body, "right", [[xF - 0.5, yBelt - 0.18], [-xF + 0.3, yBelt - 0.18]], 0.16, surf(0xd42a2a, 0.35, 0.2, 1), 0.006, 0.15);
    decalStripPair(m, body, "right", [[xF - 0.5, yBelt - 0.32], [-xF + 0.3, yBelt - 0.32]], 0.05, surf(0xf2c230, 0.35, 0.2, 1), 0.007, 0.15);
  }
  if (t.livery === "expatrol") decalStripPair(m, body, "right", [[xF - 0.4, yBelt - 0.18], [-xF + 0.4, yBelt - 0.17]], 0.12, surf(0x1f5fb0, 0.35, 0.2, 1), 0.006, 0.15);
  if (sh.bed) {
    // 적재함: 위에서 보면 검은 바닥
    const x0 = X(fGR) - 0.08;
    const x1 = -xF + 0.1;
    D.poly("top", rect(x1, -(W2 - 0.1), x0, W2 - 0.1), S.bed, 0.006, 2);
    if (ex.includes("arrowBoard")) {
      box(core, 0.08, 1.0, 1.6, x1 + 0.3, yBelt + 0.6, 0, S.trim);
      box(core, 0.02, 0.5, 1.2, x1 + 0.25, yBelt + 0.62, 0, surf(0xf6d44a, 0.4, 0, 0, TAG.BEACON_A));
    }
  }
  if (st.spoiler) cbox(core, 0.2, 0.03, W - 0.3, 0.012, -xF + 0.2, yDeck + 0.08, 0, S.gloss);

  // ---- 운전석 ----
  const eyeY = yBelt + (H - yBelt) * 0.42;
  const eye = new THREE.Vector3(vanLike ? X(fRF) - 0.5 : X(fRF) - 0.6 - (H - 1.45) * 0.4, eyeY, vanLike ? -W2 + 0.45 : -W2 * 0.42);
  b.cabin = {
    kind: t.body === "van" || t.body === "mpv" || vanLike ? "van" : "car",
    eye,
    hoodEye: new THREE.Vector3(X(fh) + 0.1, top(fh) + 0.3, 0),
    // 승합은 운전대가 더 눕고 낮아 계기판을 가리지 않는다
    wheel: { pos: new THREE.Vector3(eye.x + 0.47, eyeY - (vanLike ? 0.4 : 0.36), eye.z), tilt: vanLike ? 0.55 : 0.42, r: 0.18 },
    // 승합·미니버스는 앉는 자리가 높아 대시보드도 앞유리 아래끝보다 높게 (계기판이 시야 아래로 잘리지 않게)
    dash: { x0: X(fh) + 0.02, x1: eye.x + 0.62, y: vanLike ? Math.max(top(fh) + 0.04, eyeY - 0.34) : top(fh) + 0.04, w: 2 * (hwAt(fh) - 0.12) },
    wsBase: [X(fh), top(fh)],
    wsTop: [X(fRF), yRoofAt(0)],
    roofY: H - 0.06,
    beltY: yBelt,
    floorY: yb + 0.12,
    mirrorL: new THREE.Vector3(xm, ym, -zm - 0.05),
    mirrorR: new THREE.Vector3(xm, ym, zm + 0.05),
    mirrorC: new THREE.Vector3(X(fRF) - 0.03, H - 0.145, 0),
    glass: [
      { c: new THREE.Vector3(X(fRF) - 0.031, H - 0.145, 0), w: 0.21, h: 0.066 },
      { c: new THREE.Vector3(xm - 0.0725, ym, -zm), w: glassW, h: glassH },
      { c: new THREE.Vector3(xm - 0.0725, ym, zm), w: glassW, h: glassH },
    ],
    light,
  };
}

/** 캠핑카: 승합차 앞부분 + 뒤 거주 상자 (운전실 위로 튀어나온 침실) */
function buildCamper(t: VehicleType, b: VB) {
  const cabH = 2.45;
  buildCar({ ...t, height: cabH, body: "van_tall" }, b);
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const xF = L / 2;
  const x0 = xF - 1.75;
  const x1 = -xF;
  const y0 = 0.5;
  const wall = paintSurf(0.97);
  const core = b.core;
  cbox(core, x0 - x1, H - y0, W, 0.08, (x0 + x1) / 2, (H + y0) / 2, 0, wall);
  profile(core, [[x0 + 0.02, H - 0.02], [x0 + 0.02, cabH - 0.02], [x0 + 1.05, cabH + 0.1], [x0 + 0.95, H - 0.22]], W - 0.06, wall, 0, 0.08);
  box(core, 0.03, 0.32, W - 0.4, x0 + 1.02, cabH + 0.32, 0, S.glassPriv, 0, -0.35);
  for (const s of [-1, 1]) {
    for (const x of [x0 - 0.9, x1 + 1.3]) box(core, 0.9, 0.55, 0.012, x, 1.75, s * (W / 2 + 0.004), S.glassPriv);
    box(core, L * 0.62, 0.08, 0.012, (x0 + x1) / 2, 1.15, s * (W / 2 + 0.005), surf(0x7a8c8f, 0.4, 0.2, 0.5));
    box(core, L * 0.62, 0.035, 0.013, (x0 + x1) / 2, 1.28, s * (W / 2 + 0.006), surf(0xc8702a, 0.4, 0.2, 0.5));
  }
  box(core, 0.75, 1.75, 0.012, x0 - 2.1, y0 + 0.95, W / 2 + 0.005, surf(0xe2e3e1, 0.4, 0, 0.3));
  box(core, 0.35, 0.5, 0.012, x0 - 2.1, 1.75, W / 2 + 0.008, S.glassPriv);
  // 뒤: 등·번호판·사다리
  b.brake.length = 0;
  for (const list of [b.sigL, b.sigR]) for (let i = list.length - 1; i >= 0; i--) if (list[i].x < 0) list.splice(i, 1);
  for (const s of [-1, 1]) {
    box(core, 0.04, 0.4, 0.14, x1 - 0.01, 0.95, s * (W / 2 - 0.12), S.tail);
    box(core, 0.04, 0.12, 0.14, x1 - 0.015, 0.68, s * (W / 2 - 0.12), s < 0 ? S.sigL : S.sigR);
    b.brake.push(new THREE.Vector3(x1 - 0.04, 1.0, s * (W / 2 - 0.12)));
    (s < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(x1 - 0.04, 0.68, s * (W / 2 - 0.12)));
  }
  plate(core, null, "rear", t, 0.62, x1 - 0.02, 0.52, 0.11);
  box(core, 0.012, 1.6, 0.9, x1 - 0.006, 1.45, 0.2, S.seam);
  for (const z of [-0.5, -0.3]) box(core, 0.04, 2.2, 0.03, x1 - 0.04, 1.6, z, S.steel);
}

// ---------- 큰 차 공통 ----------

/** 두 점을 잇는 둥근 막대 */
function rod(m: Mesher, a: THREE.Vector3, b: THREE.Vector3, r: number, s: Surf, seg = 8) {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  m.geo(g, s);
}

/** 큰 차 사이드미러: 큰 거울 + 아래 보조 거울 + 팔. 뒤를 보는 유리 명세를 돌려준다 */
function bigMirror(m: Mesher, x: number, y: number, z: number, side: number, from: THREE.Vector3[]): MirrorGlass {
  const w = 0.2;
  const h = 0.32;
  cbox(m, 0.07, h + 0.03, w + 0.03, 0.025, x + 0.035, y, z, S.trim);
  box(m, 0.004, h, w, x - 0.001, y, z, S.mirrorGlass);
  const y2 = y - h / 2 - 0.11;
  cbox(m, 0.06, 0.15, w, 0.025, x + 0.03, y2, z, S.trim);
  box(m, 0.004, 0.12, w - 0.03, x - 0.001, y2, z, S.mirrorGlass);
  const inner = z - side * (w / 2 - 0.02);
  for (const [i, p] of from.entries()) rod(m, p, new THREE.Vector3(x + 0.04, i === 0 ? y + h / 2 - 0.03 : y2, inner), 0.016, S.trim);
  return { c: new THREE.Vector3(x - 0.004, y, z), w, h };
}

/** 뒤 반사띠 (빨강·흰색 번갈아) */
function reflectTape(m: Mesher, x: number, y: number, W: number, s: number) {
  const n = Math.max(4, Math.round(W / 0.25));
  const seg = W / n;
  for (let i = 0; i < n; i++) {
    const z = -W / 2 + seg * (i + 0.5);
    box(m, 0.008, 0.05, seg - 0.004, x + s * 0.004, y, z, i % 2 ? S.tapeWhite : S.tapeRed);
  }
}

/** 차체 틀·연료탱크·공기탱크·옆 보호대·흙받이 (프레임 트럭 공통) */
function chassis(b: VB, x0: number, x1: number, frameY: number, W: number, gaps: [number, number][], tank = true) {
  // 프레임은 모든 거리, 탱크·보호대는 가까이서만
  for (const s of [-1, 1]) box(b.core, x0 - x1, 0.2, 0.08, (x0 + x1) / 2, frameY, s * 0.42, S.chassis);
  const m = b.m;
  const free = (xa: number, xb: number) => !gaps.some(([g0, g1]) => xa < g1 && xb > g0);
  if (tank) {
    // 연료탱크 (알루미늄, 왼쪽), 배터리 상자 (오른쪽): 운전실 바로 뒤, 바퀴를 피해서
    let x = x0 - 0.05;
    while (x - 1.0 > x1 && !free(x - 1.0, x)) x -= 0.2;
    if (x - 1.0 > x1) {
      const g = new THREE.CylinderGeometry(0.26, 0.26, 0.95, 14);
      g.rotateZ(Math.PI / 2);
      g.translate(x - 0.5, frameY - 0.22, -W / 2 + 0.36);
      m.geo(g, S.alu);
      for (const dx of [0.02, 0.98]) box(m, 0.03, 0.54, 0.5, x - dx, frameY - 0.22, -W / 2 + 0.36, S.chassis);
      cbox(m, 0.8, 0.42, 0.5, 0.03, x - 0.5, frameY - 0.2, W / 2 - 0.36, S.chassis);
    }
  }
  // 옆 보호대: 바퀴 사이 난간 두 줄
  for (const [a, c] of gapsBetween(x0, x1, gaps)) {
    if (a - c < 0.6) continue;
    for (const s of [-1, 1]) {
      for (const dy of [-0.16, -0.36]) box(m, a - c, 0.05, 0.03, (a + c) / 2, frameY + dy, s * (W / 2 - 0.04), S.steel);
    }
  }
}

/** [x0, x1] 구간에서 gaps(바퀴)를 뺀 빈 구간들 (앞 → 뒤) */
function gapsBetween(x0: number, x1: number, gaps: [number, number][]): [number, number][] {
  const g = [...gaps].sort((a, b) => b[1] - a[1]);
  const out: [number, number][] = [];
  let cur = x0;
  for (const [g0, g1] of g) {
    if (g1 < cur && g1 > x1) out.push([cur, Math.max(x1, g1)]);
    cur = Math.min(cur, g0);
  }
  if (cur > x1) out.push([cur, x1]);
  return out;
}

/** 흙받이 (뒷바퀴 뒤) */
function mudflaps(m: Mesher, x: number, r: number, W: number, tireSpan: number) {
  for (const s of [-1, 1]) box(m, 0.02, r * 1.1, tireSpan, x, r * 0.62, s * (W / 2 - 0.08 - tireSpan / 2), S.rubber);
}

/** 큰 차 바퀴 명세 (복륜이면 안쪽 바퀴도) */
function heavyWheels(b: VB, xs: number[], r: number, W: number, tw: number, steerCount: number, dual: (i: number) => boolean) {
  xs.forEach((x, i) => {
    for (const s of [-1, 1]) {
      b.wheels.push({ x, z: s * (W / 2 - 0.02 - tw / 2), r, w: tw, steer: i < steerCount, heavy: true });
      if (dual(i)) b.wheels.push({ x, z: s * (W / 2 - 0.04 - tw * 1.5), r, w: tw, steer: false, heavy: true });
    }
  });
}

/** 실내 안쪽 면 재질 (차체 겉면 번호별) */
function innerSurfOf(light: boolean) {
  return (_xa: number, _xb: number, j: number, outer: Surf | null): Surf | null => {
    if (!outer || outer.tag === TAG.GLASS) return null;
    if (j <= J.WELL_TOP) return S.inFloor;
    if (j <= J.SHOULDER2) return S.inDoor;
    if (j === J.SHELF) return S.inPillar;
    return light ? S.inHead : S.inHeadDark;
  };
}

/** 휠아치 마디 */
function archStations(list: number[], arches: { x: number; r: number }[], angles: number[]) {
  for (const a of arches) {
    for (const deg of angles) list.push(a.x + a.r * Math.cos((deg * Math.PI) / 180));
    list.push(a.x + a.r + 0.006, a.x + a.r - 0.006, a.x - a.r + 0.006, a.x - a.r - 0.006);
  }
}

// ---------- 버스 (고속·광역·2층) ----------

function buildBus(t: VehicleType, b: VB) {
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const xF = L / 2;
  const W2 = W / 2 - 0.005;
  const X = (f: number) => xF - f * L;
  const F = (x: number) => (xF - x) / L;
  const city = t.body === "city_bus";
  const double = t.body === "double_decker";
  const coach = !city && !double;
  const wr = 0.52;
  const tw = 0.3;
  const yb = 0.34;
  // 창 아랫선: 고속버스는 높고(짐칸), 광역버스는 낮다. 2층버스는 윗층 창
  const yBelt = double ? 2.25 : city ? 1.2 : 1.8;
  const yWs = double ? 0.95 : city ? 0.85 : 1.0;
  const yRoof = H - 0.01;
  // 옆 창 윗선 (그 위는 지붕 띠)
  const winTop = H - (double ? 0.42 : 0.55);
  const gTop = (winTop - yBelt) / (yRoof - yBelt);
  const wsLen = 0.55;
  const fWs = wsLen / L;
  const top = (f: number) => {
    const d = f * L;
    // 앞에서는 운전석 창이 깊게 내려온다
    let y = lerp(yWs, yBelt, smooth(clamp((d - 0.1) / 1.4, 0, 1)));
    y -= corner(d, 0.08, 0.03);
    return y;
  };
  const roof = (f: number) => yRoof - corner(f * L, wsLen, 0.32) - corner((1 - f) * L, 0.3, 0.12);
  const hwAt = (f: number) => W2 - corner(f * L, 0.16, 0.12) - corner((1 - f) * L, 0.12, 0.08);
  const xf = xF - (coach ? 2.55 : 2.35);
  const axles = [xf, xf - t.wheelbase];
  if (L > 12.4) axles.push(xf - t.wheelbase - 1.3);
  const arches = axles.map((x) => ({ x, r: wr + 0.07, yc: wr + 0.03 }));
  const P: Profile = {
    xF,
    len: L,
    top,
    bottom: () => yb,
    hw: hwAt,
    roof,
    crown: () => 0.05,
    tumble: 0.06,
    shelf: 0.02,
    rail: 0.02,
    round: () => 0.2,
    gA: [gTop * 0.5, gTop],
    arches,
    tireW: tw * 2 + 0.04,
    fender: 0.05,
  };
  const section = makeSection(P);
  // 옆 창 기둥 (검정, 유리와 한 면처럼)
  const winF = X(fWs) - 0.15;
  const winR = -xF + 0.35;
  const nWin = Math.max(3, Math.round((winF - winR) / 1.45));
  const pillars: number[] = [];
  for (let i = 1; i < nWin; i++) pillars.push(winF - ((winF - winR) * i) / nWin);
  const inArch = (x: number) => arches.some((a) => Math.abs(x - a.x) < a.r);
  const surfAt = (xa: number, xb: number, j: number): Surf | null => {
    const xm = (xa + xb) / 2;
    const f = F(xm);
    const ws = f < fWs;
    const rear = xm < winR;
    switch (j) {
      case J.UNDER:
        return S.under;
      case J.WELL:
        return S.well;
      case J.WELL_TOP:
        return inArch(xm) ? S.well : S.under;
      case J.LIP:
        return S.clad;
      case J.SHELF:
        return ws || rear ? S.paint : S.gloss;
      case J.G1:
      case J.G2:
        if (ws) return S.glass;
        if (rear) return S.paint;
        return pillars.some((p) => Math.abs(xm - p) < 0.05) ? S.gloss : S.glassPriv;
      case J.G3:
        return ws ? S.glass : S.paint;
      case J.RAIL:
        return ws ? S.glass : S.paint;
      case J.ROOF:
        return ws ? S.glass : S.paint;
      default:
        return S.paint;
    }
  };
  const capF = (j: number) => (j <= J.WELL_TOP ? S.under : j === J.LIP ? S.clad : j >= J.G1 ? S.glass : S.paint);
  const capR = (j: number) => (j <= J.WELL_TOP ? S.under : j === J.LIP ? S.clad : city && j >= J.G1 && j < J.RAIL ? S.glassPriv : S.paint);
  const stations: number[] = [];
  for (const d of [0, 0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.32, 0.45, 0.6, 0.85, 1.2, 1.6]) stations.push(xF - d);
  for (const d of [0, 0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.3, 0.5]) stations.push(-xF + d);
  stations.push(winF, winR + 0.05, winR - 0.05);
  for (const p of pillars) stations.push(p - 0.05, p + 0.05);
  archStations(stations, arches, [30, 60, 90, 120, 150]);
  const body = new Loft({ stations, section, surf: surfAt, capFront: capF, capRear: capR, creases: [J.LIP, J.SHELF, J.G1, J.RAIL] });
  body.build(b.m, { m: b.inner, x0: xF - 0.03, x1: xF - 2.6, surf: innerSurfOf(true) });
  const midSt = [xF, xF - 0.03, xF - 0.12, xF - 0.35, xF - 0.6, -xF, -xF + 0.05, -xF + 0.2, winF, winR];
  archStations(midSt, arches, [60, 120]);
  new Loft({
    stations: midSt,
    section: (x) => {
      const s = section(x);
      return MID_KEEP.map((k) => s[k]);
    },
    surf: (xa, xb, j) => {
      const s = surfAt(xa, xb, MID_KEEP[j]);
      return s === S.gloss ? S.glassPriv : s;
    },
    capFront: (j) => capF(MID_KEEP[j]),
    capRear: (j) => capR(MID_KEEP[j]),
  }).build(b.mid);

  const core = b.core;
  const m = b.m;
  const D = dual(b, body);
  const front = (pts: Pt[], s: Surf, off = 0.012, lv = 1) => D.poly("front", pts, s, off, lv);
  const frontPair = (pts: Pt[], s: Surf | [Surf, Surf], off = 0.014, lv = 1) => D.polyPair("front", pts, s, off, lv);
  const rearPoly = (pts: Pt[], s: Surf, off = 0.012, lv = 1) => D.poly("rear", pts, s, off, lv);
  const rearPair = (pts: Pt[], s: Surf | [Surf, Surf], off = 0.014, lv = 1) => D.polyPair("rear", pts, s, off, lv);
  // ---- 앞: 행선지 표시(주황 LED), 범퍼, 전조등, 그릴, 번호판, 와이퍼 ----
  const yDest = yRoof - 0.36;
  front(rect(-W2 + 0.25, yDest - 0.1, W2 - 0.25, yDest + 0.1), S.gloss, 0.014, 2);
  for (let i = 0; i < 7; i++) front(rect(-0.62 + i * 0.18, yDest - 0.045, -0.5 + i * 0.18, yDest + 0.045), S.destLed, 0.018, 0);
  const yLamp = yb + 0.38;
  front(rect(-W2, yb + 0.02, W2, yb + 0.26), S.trim, 0.01, 2);
  frontPair([[0.6 * W2, yLamp - 0.07], [0.97 * W2, yLamp - 0.06], [0.99 * W2, yLamp + 0.08], [0.62 * W2, yLamp + 0.07]], S.headHousing, 0.016, 2);
  for (const c of [0.7, 0.8, 0.9]) frontPair(rect(c * W2 - 0.035, yLamp - 0.035, c * W2 + 0.035, yLamp + 0.035), S.headLens, 0.02, 1);
  frontPair(rect(0.62 * W2, yLamp + 0.1, 0.96 * W2, yLamp + 0.125), S.drl, 0.02, 1);
  frontPair(rect(0.86 * W2, yLamp - 0.13, 0.97 * W2, yLamp - 0.09), [S.sigR, S.sigL], 0.018, 1);
  front(rect(-0.5 * W2, yb + 0.3, 0.5 * W2, yWs - 0.12), S.mesh, 0.012, 2);
  for (let k = 1; k < 4; k++) decalStrip(m, body, "front", [[-0.5 * W2, lerp(yb + 0.3, yWs - 0.12, k / 4)], [0.5 * W2, lerp(yb + 0.3, yWs - 0.12, k / 4)]], 0.012, S.satin, 0.016);
  front(circle(0, yWs - 0.06, 0.07, 0.03, 12), S.chrome, 0.02, 0);
  plate(core, body, "front", t, yb + 0.16, undefined, 0.52, 0.11, core);
  for (const z of [-0.45, 0.35]) decalStrip(m, body, "front", [[z - 0.35, yWs + 0.05], [z + 0.35, yWs + 0.09]], 0.016, S.trim, 0.02);
  b.head.push(new THREE.Vector3(xF + 0.02, yLamp, -0.8 * W2), new THREE.Vector3(xF + 0.02, yLamp, 0.8 * W2));
  b.sigL.push(new THREE.Vector3(xF + 0.02, yLamp - 0.11, -0.92 * W2));
  b.sigR.push(new THREE.Vector3(xF + 0.02, yLamp - 0.11, 0.92 * W2));
  // ---- 뒤: 세로 등, 엔진 그릴, 번호판, 뒷창(고속버스는 작게) ----
  const yT = yb + 0.75;
  rearPair([[0.84 * W2, yT - 0.3], [0.98 * W2, yT - 0.3], [0.98 * W2, yT + 0.45], [0.84 * W2, yT + 0.45]], S.tailSmoke, 0.014, 1);
  rearPair(rect(0.86 * W2, yT + 0.12, 0.97 * W2, yT + 0.4), S.tail, 0.018, 1);
  rearPair(rect(0.86 * W2, yT - 0.04, 0.97 * W2, yT + 0.1), [S.sigR, S.sigL], 0.018, 1);
  rearPair(rect(0.86 * W2, yT - 0.26, 0.97 * W2, yT - 0.08), S.reverse, 0.018, 1);
  rearPoly(rect(-0.62 * W2, yb + 0.35, 0.62 * W2, yb + 0.95), S.mesh, 0.012, 2);
  for (let k = 1; k < 6; k++) decalStrip(m, body, "rear", [[-0.6 * W2, lerp(yb + 0.35, yb + 0.95, k / 6)], [0.6 * W2, lerp(yb + 0.35, yb + 0.95, k / 6)]], 0.01, S.paint, 0.016);
  if (coach) rearPoly(rect(-0.62 * W2, yBelt + 0.25, 0.62 * W2, yRoof - 0.45), S.glassPriv, 0.012, 2);
  rearPoly(rect(-0.18, yRoof - 0.28, 0.18, yRoof - 0.24), S.brake, 0.016, 0);
  plate(core, body, "rear", t, yb + 0.2, undefined, 0.52, 0.11, core);
  rearPoly(rect(-W2, yb + 0.02, W2, yb + 0.12), S.trim, 0.01, 2);
  for (const s of [-1, 1]) {
    b.brake.push(new THREE.Vector3(-xF - 0.02, yT + 0.26, s * 0.92 * W2));
    (s < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(-xF - 0.02, yT + 0.03, s * 0.92 * W2));
  }
  // ---- 옆: 문(오른쪽), 짐칸 문, 색띠 ----
  const side = (pts: Pt[], s: Surf, off = 0.008, lv = 1) => decalPoly(m, body, "right", pts, s, off, lv);
  const sideBoth = (line: Pt[], w: number, s: Surf, off = 0.007) => decalStripPair(m, body, "right", line, w, s, off, 0.2);
  const doors = city ? [xF - 0.42, 0.4] : [xF - 0.42];
  for (const d0 of doors) {
    const d1 = d0 - 0.98;
    side(rect(d1, yb + 0.12, d0, yBelt + (yRoof - yBelt) * 0.75), S.trim, 0.008, 2);
    side(rect(d1 + 0.05, yb + 0.5, (d0 + d1) / 2 - 0.02, yBelt + (yRoof - yBelt) * 0.7), S.glassPriv, 0.012, 2);
    side(rect((d0 + d1) / 2 + 0.02, yb + 0.5, d0 - 0.05, yBelt + (yRoof - yBelt) * 0.7), S.glassPriv, 0.012, 2);
  }
  if (coach) {
    // 짐칸 문 틈
    const bays = [arches[0].x - arches[0].r - 0.1, arches[1].x + arches[1].r + 0.1];
    const n = 3;
    for (let i = 0; i <= n; i++) {
      const x = lerp(bays[0], bays[1], i / n);
      sideBoth([[x, yb + 0.2], [x, yBelt - 0.15]], 0.008, S.seam);
    }
    sideBoth([[bays[0], yBelt - 0.15], [bays[1], yBelt - 0.15]], 0.008, S.seam);
    sideBoth([[bays[0], yb + 0.2], [bays[1], yb + 0.2]], 0.008, S.seam);
  }
  if (double) {
    // 아래층 창
    sideBoth([[xF - 1.4, (yWs + 1.9) / 2], [-xF + 0.5, (yWs + 1.9) / 2]], 1.9 - yWs - 0.25, S.glassPriv, 0.008);
    for (let x = xF - 2.8; x > -xF + 1; x -= 1.45) sideBoth([[x, yWs + 0.15], [x, 1.8]], 0.08, S.gloss, 0.012);
  }
  const stripe = t.livery === "express" ? 0x1f5aa6 : t.livery === "premium" ? 0xc8a24a : t.livery === "airport" ? 0x2aa6c8 : t.livery === "tour" ? 0xf0a51e : null;
  if (stripe !== null) {
    sideBoth([[xF - 1.5, yBelt - 0.3], [-xF + 0.3, yBelt - 0.4]], 0.14, surf(stripe, 0.35, 0.2, 1), 0.007);
    if (t.livery === "tour") sideBoth([[xF - 1.5, yb + 0.5], [-xF + 0.8, yBelt - 0.6]], 0.3, surf(0xd23a6e, 0.35, 0.2, 1), 0.008);
  }
  // 옆 표시등 (주황)
  for (let x = xF - 1.2; x > -xF + 0.5; x -= 2.2) for (const s of [-1, 1]) box(m, 0.08, 0.035, 0.012, x, yb + 0.28, s * (hwAt(F(x)) - 0.03), S.marker);
  // ---- 토끼귀 거울 (지붕 앞 모서리에서 앞으로 내려온다) ----
  const glass: MirrorGlass[] = [];
  for (const s of [-1, 1]) {
    const root = new THREE.Vector3(xF - 0.25, yRoof - 0.12, s * (W2 - 0.12));
    const g = bigMirror(m, xF + 0.42, yRoof - 0.95, s * (W2 + 0.02), s, [root, new THREE.Vector3(xF - 0.05, yRoof - 0.35, s * (W2 - 0.05))]);
    rod(m, root, new THREE.Vector3(xF + 0.3, yRoof - 0.05, s * (W2 - 0.02)), 0.022, S.trim);
    rod(m, new THREE.Vector3(xF + 0.3, yRoof - 0.05, s * (W2 - 0.02)), new THREE.Vector3(xF + 0.46, yRoof - 0.78, s * (W2 + 0.01)), 0.022, S.trim);
    box(b.mid, 0.08, 0.5, 0.22, xF + 0.46, yRoof - 1.0, s * (W2 + 0.02), S.trim);
    glass.push(g);
  }
  // ---- 바퀴 ----
  heavyWheels(b, axles, wr, W, tw, 1, (i) => i === 1);
  // ---- 운전석 ----
  const eye = new THREE.Vector3(xF - 1.05, double ? 2.05 : city ? 2.0 : 2.25, -W2 + 0.55);
  const rm = new THREE.Vector3(xF - 0.35, yRoof - 0.3, 0);
  b.cabin = {
    kind: "bus",
    eye,
    hoodEye: new THREE.Vector3(xF + 0.05, yWs + 0.2, 0),
    wheel: { pos: new THREE.Vector3(eye.x + 0.52, eye.y - 0.45, eye.z), tilt: 1.0, r: 0.24 },
    dash: { x0: xF - 0.25, x1: eye.x + 0.7, y: eye.y - 0.55, w: 1.15, z: eye.z + 0.2 },
    wsBase: [xF, yWs],
    wsTop: [xF - wsLen * 0.6, yRoof - 0.1],
    roofY: yRoof - 0.15,
    beltY: yBelt,
    floorY: eye.y - 1.15,
    mirrorL: glass[0].c.clone().setZ(glass[0].c.z - 0.05),
    mirrorR: glass[1].c.clone().setZ(glass[1].c.z + 0.05),
    mirrorC: rm,
    glass: [{ c: rm.clone().setX(rm.x - 0.001), w: 0.3, h: 0.09 }, glass[0], glass[1]],
    light: true,
  };
}

// ---------- 트럭 ----------

type CabStyle = "light" | "medium" | "heavy";

interface CabOpts {
  front: number;
  len: number;
  W: number;
  /** 운전실 바닥 높이 */
  y0: number;
  H: number;
  xAxle: number;
  wr: number;
  tireW: number;
  style: CabStyle;
}

/** 트럭 운전실 (캡오버): 단면을 이어 만든 둥근 상자, 기운 앞유리, 문 창, 앞바퀴 아치. 운전석 배치도 정한다 */
function truckCab(b: VB, t: VehicleType, o: CabOpts): { body: Loft; yBelt: number; yTop: number } {
  const { front, len, W, y0, H, xAxle, wr, style } = o;
  const light = style === "light";
  const heavy = style === "heavy";
  const W2 = W / 2 - 0.005;
  const X = (f: number) => front - f * len;
  const F = (x: number) => (front - x) / len;
  const yTop = y0 + H;
  const yBelt = y0 + H * (light ? 0.47 : heavy ? 0.44 : 0.46);
  const lean = light ? 0.55 : heavy ? 0.12 : 0.22;
  const wsLen = (yTop - yBelt) * Math.tan(lean) + 0.1;
  const fWs = wsLen / len;
  const rF = light ? 0.24 : 0.14;
  const top = (f: number) => yBelt - corner(f * len, 0.12, 0.05);
  const roofY = (f: number) => {
    const d = f * len;
    const yr = yTop - 0.02 - corner(len - d, 0.1, 0.05);
    if (d >= wsLen) return yr;
    return lerp(top(f), yr, 1 - (1 - d / wsLen) ** 1.35);
  };
  const hwAt = (f: number) => W2 - corner(f * len, rF, rF * 0.75) - corner((1 - f) * len, 0.06, 0.04);
  const ar = wr + 0.07;
  const arches = [{ x: xAxle, r: ar, yc: wr + 0.02 }];
  const P: Profile = {
    xF: front,
    len,
    top,
    bottom: () => y0,
    hw: hwAt,
    roof: roofY,
    crown: () => 0.02,
    tumble: light ? 0.09 : 0.05,
    shelf: 0.02,
    rail: 0.015,
    round: () => (light ? 0.13 : 0.1),
    gA: [0.42, 0.78],
    arches,
    tireW: o.tireW,
    fender: 0.05,
  };
  const section = makeSection(P);
  const fDoor0 = fWs + 0.04;
  const fDoor1 = light ? 0.93 : heavy ? 0.58 : 0.74;
  const surfAt = (xa: number, xb: number, j: number): Surf | null => {
    const xm = (xa + xb) / 2;
    const f = F(xm);
    const ws = f < fWs;
    switch (j) {
      case J.UNDER:
        return S.under;
      case J.WELL:
        return S.well;
      case J.WELL_TOP:
        return Math.abs(xm - xAxle) < ar ? S.well : S.under;
      case J.LIP:
        return S.clad;
      case J.G1:
      case J.G2:
        // 문 창은 앞유리 바로 옆까지 (A필러가 가늘다)
        return f < fDoor1 && f > 0.02 ? S.glass : S.paint;
      case J.ROOF:
        return ws ? S.glass : S.paint;
      default:
        return S.paint;
    }
  };
  const cap = (j: number) => (j <= J.WELL_TOP ? S.under : j === J.LIP ? S.clad : S.paint);
  const stations: number[] = [];
  for (const d of [0, 0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.3]) stations.push(front - d);
  for (const d of [0, 0.015, 0.05, 0.1]) stations.push(front - len + d);
  for (let k = 1; k <= 4; k++) stations.push(front - (wsLen * k) / 4);
  stations.push(X(fDoor0), X(fDoor1), X((fDoor0 + fDoor1) / 2));
  archStations(stations, arches, [30, 60, 90, 120, 150]);
  const body = new Loft({ stations, section, surf: surfAt, capFront: cap, capRear: cap, creases: [J.LIP, J.G1, J.RAIL] });
  body.build(b.m, { m: b.inner, x0: front - 0.03, x1: front - len + 0.03, surf: innerSurfOf(true) });
  const midSt = [front, front - 0.015, front - 0.07, front - 0.2, front - wsLen, X(fDoor0), X(fDoor1), front - len, front - len + 0.05];
  archStations(midSt, arches, [60, 120]);
  new Loft({
    stations: midSt,
    section: (x) => {
      const s = section(x);
      return MID_KEEP.map((k) => s[k]);
    },
    surf: (xa, xb, j) => surfAt(xa, xb, MID_KEEP[j]),
    capFront: (j) => cap(MID_KEEP[j]),
    capRear: (j) => cap(MID_KEEP[j]),
  }).build(b.mid);

  const core = b.core;
  const D = dual(b, body);
  const front1 = (pts: Pt[], s: Surf, off = 0.012, lv = 1) => D.poly("front", pts, s, off, lv);
  const frontPair = (pts: Pt[], s: Surf | [Surf, Surf], off = 0.014, lv = 1) => D.polyPair("front", pts, s, off, lv);
  // ---- 범퍼 (앞으로 조금 나온 검은 상자), 전조등, 그릴 ----
  const bumpH = light ? 0.3 : 0.38;
  const bumpY = y0 + bumpH / 2 - 0.02;
  cbox(core, 0.22, bumpH, W - (light ? 0.1 : 0.04), 0.05, front - 0.04, bumpY, 0, light ? S.clad : S.bumperGrey);
  plate(core, null, "front", t, bumpY - 0.02, front + 0.075, 0.44, 0.18);
  const lampY = light ? yBelt - 0.2 : bumpY + 0.02;
  if (light) {
    // 1톤: 앞면 위 모서리 둥근 전조등, 가운데 작은 그릴
    frontPair([[0.55 * W2, lampY - 0.08], [0.95 * W2, lampY - 0.06], [0.97 * W2, lampY + 0.08], [0.58 * W2, lampY + 0.1]], S.headHousing, 0.016, 2);
    for (const c of [0.68, 0.82]) frontPair(rect(c * W2 - 0.04, lampY - 0.03, c * W2 + 0.04, lampY + 0.04), S.headLens, 0.02, 1);
    frontPair(rect(0.88 * W2, lampY - 0.06, 0.96 * W2, lampY + 0.05), [S.sigR, S.sigL], 0.02, 1);
    front1(rect(-0.45 * W2, lampY - 0.06, 0.45 * W2, lampY + 0.07), S.mesh, 0.012, 2);
    for (let k = 1; k < 3; k++) decalStrip(b.m, body, "front", [[-0.44 * W2, lampY - 0.06 + k * 0.043], [0.44 * W2, lampY - 0.06 + k * 0.043]], 0.012, S.satin, 0.016);
    front1(circle(0, lampY + 0.13, 0.06, 0.025, 12), S.chrome, 0.018, 0);
  } else {
    // 중·대형: 범퍼 안 전조등, 큰 그릴(크롬 가로살), 앞유리 위 햇빛가리개와 표시등
    for (const s of [-1, 1]) {
      const z = s * (W / 2 - 0.3);
      box(core, 0.02, 0.13, 0.36, front + 0.075, lampY, z, S.headHousing);
      for (const dz of [-0.09, 0.05]) box(core, 0.012, 0.08, 0.1, front + 0.088, lampY, z + dz, S.headLens);
      box(core, 0.012, 0.03, 0.3, front + 0.088, lampY + 0.075, z, S.drl);
      box(core, 0.02, 0.1, 0.12, front + 0.075, lampY, s * (W / 2 - 0.08), s < 0 ? S.sigL : S.sigR);
    }
    const g0 = y0 + bumpH + 0.06;
    const g1 = yBelt - 0.14;
    front1(rect(-0.62 * W2, g0, 0.62 * W2, g1), S.mesh, 0.012, 2);
    for (let k = 1; k < 5; k++) D.strip("front", [[-0.62 * W2, lerp(g0, g1, k / 5)], [0.62 * W2, lerp(g0, g1, k / 5)]], 0.022, S.chrome, 0.016);
    D.strip("front", closeLoop(rect(-0.62 * W2, g0, 0.62 * W2, g1)), 0.03, S.chrome, 0.017);
    front1(rect(-0.2, g1 + 0.03, 0.2, g1 + 0.09), S.chrome, 0.018, 0);
    if (heavy) {
      // 햇빛가리개 + 주황 표시등 다섯
      const vx = front - wsLen + 0.02;
      cbox(core, 0.34, 0.05, W - 0.3, 0.02, vx + 0.1, yTop - 0.02, 0, S.paint, 0, -0.18);
      for (let i = -2; i <= 2; i++) box(core, 0.04, 0.035, 0.07, vx + 0.26, yTop - 0.04, i * 0.3, S.marker);
    }
  }
  for (const z of [-0.5, 0.45]) decalStrip(b.m, body, "front", [[z - 0.32, yBelt + 0.05], [z + 0.32, yBelt + 0.09]], 0.018, S.trim, 0.02);
  b.head.push(new THREE.Vector3(front + 0.1, lampY, -(W / 2 - 0.3)), new THREE.Vector3(front + 0.1, lampY, W / 2 - 0.3));
  b.sigL.push(new THREE.Vector3(front + 0.09, lampY, -(W / 2 - 0.08)));
  b.sigR.push(new THREE.Vector3(front + 0.09, lampY, W / 2 - 0.08));
  // ---- 옆: 문 틈, 손잡이, 발판 ----
  const seam = (line: Pt[]) => decalStripPair(b.m, body, "right", line, 0.007, S.seam, 0.005, 0.1);
  const xd0 = X(fDoor0) + 0.04;
  const xd1 = X(fDoor1) - 0.04;
  seam([[xd0, y0 + 0.12], [xd0, top(fDoor0) + (roofY(fDoor0) - top(fDoor0)) * 0.9]]);
  seam([[xd1, y0 + 0.12], [xd1, top(fDoor1) + (roofY(fDoor1) - top(fDoor1)) * 0.9]]);
  decalPolyPair(b.m, body, "right", rect(xd1 + 0.08, yBelt - 0.14, xd1 + 0.28, yBelt - 0.1), S.trim, 0.008, 0);
  if (!light) for (const s of [-1, 1]) for (const [k, dy] of [0.25, 0.55].entries()) box(b.m, 0.4 - k * 0.06, 0.04, 0.2, xAxle - ar - 0.25, y0 - dy + 0.35, s * (W / 2 - 0.12), S.steel);
  // ---- 사이드미러 (앞유리 옆 기둥에서 팔) ----
  const mx = front - 0.12;
  const my = yBelt + (yTop - yBelt) * 0.35;
  const glass: MirrorGlass[] = [];
  for (const s of [-1, 1]) {
    const z = s * (W2 + (light ? 0.14 : 0.2));
    const from = [new THREE.Vector3(front - wsLen * 0.6, yBelt + (yTop - yBelt) * 0.7, s * (W2 - 0.08)), new THREE.Vector3(front - 0.1, yBelt + 0.05, s * (W2 - 0.06))];
    glass.push(bigMirror(b.m, mx, my, z, s, from));
    box(b.mid, 0.08, 0.5, 0.22, mx + 0.03, my - 0.08, z, S.trim);
  }
  // ---- 운전석 ----
  const eye = new THREE.Vector3(front - wsLen - (light ? 0.42 : 0.62), yBelt + (yTop - yBelt) * 0.42, -W2 + (light ? 0.45 : 0.58));
  const rm = new THREE.Vector3(front - wsLen - 0.12, yTop - 0.2, 0);
  b.cabin = {
    kind: light ? "van" : "truck",
    eye,
    hoodEye: new THREE.Vector3(front + 0.05, yBelt + 0.15, 0),
    wheel: { pos: new THREE.Vector3(eye.x + (light ? 0.46 : 0.5), eye.y - (light ? 0.38 : 0.44), eye.z), tilt: light ? 0.7 : 1.0, r: light ? 0.19 : 0.23 },
    dash: { x0: front - 0.06, x1: eye.x + (light ? 0.6 : 0.72), y: yBelt + 0.03, w: W - 0.24 },
    wsBase: [front - 0.02, yBelt],
    wsTop: [front - wsLen, yTop - 0.03],
    roofY: yTop - 0.06,
    beltY: yBelt,
    floorY: y0 + 0.06,
    mirrorL: glass[0].c.clone().setZ(glass[0].c.z - 0.05),
    mirrorR: glass[1].c.clone().setZ(glass[1].c.z + 0.05),
    mirrorC: rm,
    glass: [{ c: rm.clone().setX(rm.x - 0.001), w: 0.24, h: 0.07 }, glass[0], glass[1]],
    light: true,
  };
  return { body, yBelt, yTop };
}

/** 트럭 뒤: 등 (범퍼 막대 위), 번호판, 반사띠, 뒤 보호대 */
function truckRear(b: VB, t: VehicleType, x: number, y: number, W: number) {
  const m = b.core;
  // 뒤 보호대 (낮은 막대)
  box(m, 0.1, 0.12, W - 0.2, x + 0.12, 0.5, 0, S.steel);
  for (const s of [-1, 1]) {
    box(m, 0.08, 0.3, 0.06, x + 0.2, 0.62, s * 0.7, S.steel);
    const z = s * (W / 2 - 0.22);
    box(m, 0.06, 0.16, 0.36, x - 0.02, y, z, S.trim);
    box(m, 0.012, 0.1, 0.1, x - 0.055, y, z - s * 0.11, S.tail);
    box(m, 0.012, 0.1, 0.1, x - 0.055, y, z, s < 0 ? S.sigL : S.sigR);
    box(m, 0.012, 0.1, 0.1, x - 0.055, y, z + s * 0.11, S.reverse);
    b.brake.push(new THREE.Vector3(x - 0.07, y, z - s * 0.11));
    (s < 0 ? b.sigL : b.sigR).push(new THREE.Vector3(x - 0.07, y, z));
  }
  plate(m, null, "rear", t, y - 0.02, x - 0.04, 0.34, 0.2);
  reflectTape(b.m, x - 0.05, y - 0.14, W - 0.3, -1);
}

const CONTAINER_COLORS = [0x2c5e9e, 0xb52a2a, 0x2f7a4a, 0x8a8f94, 0xd9d9d6, 0x7b3f2a, 0x1f3e6e, 0xc8702a];
const C = {
  cargoGray: 0x8a8f94,
  cargoBlue: 0x2d5e9e,
  wood: 0x8c6a45,
};

/** 짐 상자 (탑차·윙바디·냉동): 모서리 기둥, 위아래 테, 뒷문 두 짝과 잠금대 */
function cargoBox(b: VB, x0: number, x1: number, y0: number, h: number, W: number, s: Surf, trimS: Surf, wing: boolean) {
  const len = x0 - x1;
  const xc = (x0 + x1) / 2;
  box(b.core, len, h, W, xc, y0 + h / 2, 0, s);
  // 기둥·테·골·문은 가까이서만
  const m = b.m;
  // 모서리 기둥·테
  for (const sz of [-1, 1]) {
    for (const x of [x0, x1]) box(m, 0.07, h + 0.02, 0.07, x - Math.sign(x - xc) * 0.03, y0 + h / 2, sz * (W / 2 - 0.03), trimS);
    box(m, len, 0.08, 0.02, xc, y0 + 0.04, sz * (W / 2 + 0.006), trimS);
    box(m, len, 0.06, 0.02, xc, y0 + h - 0.03, sz * (W / 2 + 0.006), trimS);
    if (wing) {
      // 윙바디: 옆면 가로 골, 지붕 경첩 선
      for (let k = 1; k < 5; k++) box(m, len - 0.1, 0.025, 0.012, xc, y0 + (h * k) / 5, sz * (W / 2 + 0.006), surf(0xb8bcc0, 0.35, 0.8));
    } else {
      for (let x = x0 - 0.6; x > x1 + 0.3; x -= 0.6) box(m, 0.03, h - 0.1, 0.01, x, y0 + h / 2, sz * (W / 2 + 0.004), surf(0xdadbd8, 0.5, 0, 0.3));
    }
  }
  if (wing) box(m, len, 0.04, 0.06, xc, y0 + h + 0.015, 0, trimS);
  // 뒷문: 가운데 틈, 잠금대 네 개, 경첩
  box(m, 0.012, h - 0.12, 0.012, x1 - 0.006, y0 + h / 2, 0, S.seam);
  for (const z of [-0.55, -0.25, 0.25, 0.55]) box(m, 0.02, h - 0.2, 0.025, x1 - 0.015, y0 + h / 2, z * (W / 2.3), S.chrome);
  for (const sz of [-1, 1]) for (const k of [0.2, 0.5, 0.8]) box(m, 0.03, 0.08, 0.06, x1 - 0.015, y0 + h * k, sz * (W / 2 - 0.05), trimS);
}

function buildTruck(t: VehicleType, b: VB) {
  const rand = b.rand;
  const m = b.core;
  const L = t.length;
  const W = t.width;
  const H = t.height;
  const front = L / 2;
  const light = t.body === "truck_light";
  const medium = t.body === "truck_medium";
  const wr = light ? 0.34 : medium ? 0.42 : 0.52;
  const tw = light ? 0.2 : medium ? 0.24 : 0.3;
  const frameY = wr + 0.22;
  const cabLen = light ? 1.65 : medium ? 1.95 : 2.3;
  const cabW = light ? Math.min(W, 1.74) : W;
  const cabY0 = frameY - (light ? 0.12 : 0.02);
  const cabH = light ? 1.52 : medium ? 1.72 : clamp(H - cabY0, 2.1, 2.42);
  const axles = t.axles ?? 2;
  const xf = front - (light ? 0.95 : cabLen * 0.55);
  const xs: number[] = [xf];
  if (axles >= 4) xs.push(xf - 1.35);
  const rearCount = axles - xs.length;
  const xr = xf - t.wheelbase;
  for (let i = 0; i < rearCount; i++) xs.push(xr - i * 1.32);
  const nFront = axles >= 4 ? 2 : 1;
  const style: CabStyle = light ? "light" : medium ? "medium" : "heavy";
  truckCab(b, t, { front, len: cabLen, W: cabW, y0: cabY0, H: cabH, xAxle: xf, wr, tireW: tw + 0.04, style });
  // 둘째 앞축 (4축): 운전실 뒤 바로
  const gaps: [number, number][] = xs.map((x) => [x - wr - 0.1, x + wr + 0.1]);
  const bodyX0 = front - cabLen - 0.1;
  const bodyX1 = -front;
  chassis(b, bodyX0 + 0.1, bodyX1 + 0.1, frameY, W, gaps, !light);
  const bodyLen = bodyX0 - bodyX1;
  const bodyMid = (bodyX0 + bodyX1) / 2;
  const deckY = frameY + 0.16;
  const cargo = t.cargo ?? "open";
  const topH = H - deckY;
  const gs = (c: number) => surf(c, 0.5, 0.6, 0.2);
  // 짐칸 바닥 (가로보가 보이게)
  box(m, bodyLen, 0.08, W - 0.04, bodyMid, deckY - 0.03, 0, S.chassis);
  for (let x = bodyX0 - 0.2; x > bodyX1; x -= 0.45) box(m, 0.06, 0.1, W - 0.1, x, deckY - 0.1, 0, S.chassis);
  switch (cargo) {
    case "open":
    case "open_high": {
      const gate = cargo === "open_high" ? 0.9 : light ? 0.42 : 0.55;
      const sideC = light ? 0x9ea4aa : rand() < 0.5 ? C.cargoGray : C.cargoBlue;
      box(m, bodyLen, 0.06, W, bodyMid, deckY + 0.03, 0, gs(0x6d7277));
      for (const side of [-1, 1]) {
        box(m, bodyLen, gate, 0.04, bodyMid, deckY + gate / 2 + 0.05, side * (W / 2 - 0.02), gs(sideC));
        // 옆판 세로 골·경첩
        for (let x = bodyX0 - 0.3; x > bodyX1 + 0.2; x -= 0.3) box(b.m, 0.04, gate - 0.04, 0.012, x, deckY + gate / 2 + 0.05, side * (W / 2 + 0.004), gs(sideC));
        box(m, bodyLen, 0.04, 0.02, bodyMid, deckY + gate + 0.05, side * (W / 2), S.alu);
      }
      box(m, 0.04, gate, W, bodyX1 + 0.02, deckY + gate / 2 + 0.05, 0, gs(sideC));
      box(m, 0.05, gate + 0.35, W, bodyX0 - 0.03, deckY + (gate + 0.35) / 2 + 0.05, 0, gs(sideC));
      // 짐: 상자·팔레트·덮개
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const w = 0.7 + rand() * 0.6;
        const h = 0.35 + rand() * (cargo === "open_high" ? 1.1 : light ? 0.6 : 0.8);
        const x = bodyX0 - 0.55 - i * (bodyLen / (n + 0.4));
        const k = rand();
        const col = k < 0.35 ? C.wood : k < 0.7 ? 0x3d6e9e : 0x4f6b3a;
        cbox(m, w, h, W * 0.78, k < 0.7 ? 0.02 : 0.12, x, deckY + h / 2 + 0.06, 0, surf(col, k < 0.7 ? 0.8 : 0.6, 0, 0.1));
      }
      break;
    }
    case "box":
    case "fridge":
    case "parcel":
    case "wing": {
      const boxH = Math.max(1.3, topH - 0.02);
      const wing = cargo === "wing";
      const col = wing ? S.alu : surf(0xf2f2ef, 0.4, 0, 0.35);
      cargoBox(b, bodyX0, bodyX1, deckY, boxH, W, col, wing ? surf(0x9ea3a8, 0.35, 0.8) : surf(0xc9ccce, 0.35, 0.7), wing);
      if (cargo === "fridge") {
        // 냉동기: 짐칸 앞 위
        cbox(m, 0.32, 0.5, W * 0.62, 0.04, bodyX0 + 0.16, deckY + boxH - 0.32, 0, surf(0xe4e5e3, 0.5, 0, 0.2));
        box(m, 0.02, 0.36, W * 0.5, bodyX0 + 0.33, deckY + boxH - 0.32, 0, S.mesh);
      }
      if (cargo === "parcel") {
        const accents = [0x1f5fb0, 0xe3a21a, 0xd1352a, 0x2a8a52];
        const a = accents[Math.floor(rand() * accents.length)];
        for (const side of [-1, 1]) box(m, bodyLen * 0.9, boxH * 0.28, 0.012, bodyMid, deckY + boxH * 0.3, side * (W / 2 + 0.012), surf(a, 0.4, 0, 0.5));
      }
      break;
    }
    case "dump": {
      const dh = 1.2;
      const sd = paintSurf(0.85);
      const x0 = bodyX0;
      const x1 = bodyX1;
      box(m, bodyLen, 0.1, W, bodyMid, deckY + 0.05, 0, sd);
      for (const side of [-1, 1]) {
        box(m, bodyLen, dh, 0.08, bodyMid, deckY + dh / 2, side * (W / 2 - 0.04), sd);
        for (let x = x0 - 0.5; x > x1 + 0.3; x -= 0.7) box(m, 0.1, dh - 0.1, 0.05, x, deckY + dh / 2, side * (W / 2 + 0.01), paintSurf(0.7));
        box(m, bodyLen, 0.08, 0.06, bodyMid, deckY + dh, side * (W / 2), paintSurf(0.7));
      }
      // 앞 가리개 (운전실 위로)
      box(m, 0.1, dh + 0.35, W, x0 - 0.05, deckY + (dh + 0.35) / 2, 0, sd);
      box(m, 0.6, 0.06, W, x0 + 0.2, deckY + dh + 0.35, 0, sd);
      box(m, 0.08, dh, W, x1 + 0.04, deckY + dh / 2, 0, sd);
      box(m, bodyLen - 0.2, 0.05, W - 0.18, bodyMid, deckY + dh * 0.75, 0, surf(0x6e5a42, 1));
      cbox(m, bodyLen * 0.5, 0.3, W * 0.6, 0.1, bodyMid, deckY + dh * 0.75 + 0.12, 0, surf(0x7a6448, 1));
      break;
    }
    case "mixer": {
      // 드럼: 배 모양 회전체 + 나선 띠
      const r = 1.05;
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i <= 12; i++) {
        const u = i / 12;
        pts.push(new THREE.Vector2(0.25 + (r - 0.25) * Math.sin(Math.PI * Math.min(1, u * 1.25)) ** 0.7 * (u > 0.8 ? 1 - (u - 0.8) * 2.2 : 1), (u - 0.5) * bodyLen * 0.9));
      }
      const g = new THREE.LatheGeometry(pts, 18);
      g.rotateZ(Math.PI / 2 - 0.12);
      g.translate(bodyMid, deckY + r + 0.2, 0);
      m.geo(g, surf(0xf0f0ee, 0.4, 0.1, 0.5));
      const stripeC = rand() < 0.5 ? 0x2d5e9e : 0xd1352a;
      for (let k = 0; k < 4; k++) {
        const s = new THREE.TorusGeometry(r * (0.82 + 0.06 * Math.sin(k)), 0.05, 4, 20);
        s.rotateY(Math.PI / 2 + 0.35);
        s.translate(bodyMid + bodyLen * (0.3 - k * 0.2), deckY + r + 0.2 + (k - 1.5) * 0.08, 0);
        m.geo(s, surf(stripeC, 0.4, 0.1, 0.5));
      }
      // 투입구·받침대
      cyl(m, 0.25, 0.5, bodyX1 + 0.35, deckY + 1.6, 0, "y", S.steel, 10, 0.4);
      box(m, 0.15, 1.2, 0.2, bodyX1 + 0.6, deckY + 0.6, 0, S.steel);
      box(m, 0.15, 0.8, 0.2, bodyX0 - 0.2, deckY + 0.4, 0, S.steel);
      break;
    }
    case "tank": {
      const g = new THREE.CylinderGeometry(1.0, 1.0, bodyLen * 0.97, 22);
      g.rotateZ(Math.PI / 2);
      g.scale(1, 1, W / 2.1);
      g.translate(bodyMid, deckY + 1.0, 0);
      m.geo(g, S.chrome);
      for (const x of [bodyX0 - 0.1, bodyX1 + 0.1]) {
        const e = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        e.scale(1, 0.25, W / 2.1);
        e.rotateZ(x > bodyMid ? -Math.PI / 2 : Math.PI / 2);
        e.translate(x + (x > bodyMid ? 0.05 : -0.05), deckY + 1.0, 0);
        m.geo(e, S.chrome);
      }
      box(m, bodyLen * 0.9, 0.06, 0.45, bodyMid, deckY + 2.03, 0, S.steel);
      for (let x = bodyX0 - 0.8; x > bodyX1 + 0.5; x -= 1.4) cyl(m, 0.18, 0.1, x, deckY + 2.08, 0, "y", S.steel, 10);
      break;
    }
    case "crane": {
      box(m, bodyLen, 0.12, W, bodyMid, deckY, 0, gs(C.cargoGray));
      cbox(m, 0.9, 1.0, 1.2, 0.08, bodyX0 - 0.5, deckY + 0.5, 0, paintSurf(0.85));
      cbox(m, bodyLen * 0.85, 0.4, 0.45, 0.06, bodyMid + 0.2, deckY + 1.2, 0.3, surf(0xe3b12c, 0.45, 0.1, 0.5));
      for (const side of [-1, 1]) box(m, bodyLen, 0.35, 0.05, bodyMid, deckY + 0.24, side * (W / 2 - 0.02), gs(C.cargoGray));
      break;
    }
    case "tow": {
      box(m, bodyLen, 0.15, W - 0.2, bodyMid, deckY, 0, S.steel);
      cbox(m, 0.4, 1.4, 0.4, 0.05, bodyX0 - 0.4, deckY + 0.7, 0, paintSurf(0.9));
      cbox(m, bodyLen * 0.8, 0.2, 0.25, 0.04, bodyMid - 0.3, deckY + 1.25, 0, surf(0xe3b12c, 0.45, 0.1, 0.5));
      box(m, 0.3, 0.2, W * 0.8, bodyX1 + 0.1, deckY + 0.3, 0, S.steel);
      break;
    }
  }
  truckRear(b, t, bodyX1, frameY + 0.1, W);
  mudflaps(b.m, xs[xs.length - 1] - wr - 0.15, wr, W, light ? 0.24 : 0.62);
  if (t.extras?.includes("lightBar")) {
    const cy = cabY0 + cabH;
    box(m, 0.3, 0.12, 0.7, front - 0.6, cy + 0.06, -0.38, surf(0xf0a51e, 0.2, 0, 1, TAG.BEACON_A));
    box(m, 0.3, 0.12, 0.7, front - 0.6, cy + 0.06, 0.38, surf(0xf0a51e, 0.2, 0, 1, TAG.BEACON_B));
  }
  heavyWheels(b, xs, wr, W, tw, nFront, (i) => i >= nFront && !light);
}

function buildTractor(t: VehicleType, b: VB) {
  const rand = b.rand;
  const m = b.core;
  const L = t.length;
  const W = t.width;
  const front = L / 2;
  const wr = 0.52;
  const tw = 0.3;
  const frameY = wr + 0.24;
  const cabLen = 2.3;
  const txs = [front - 1.3, front - 4.4, front - 5.7];
  const { yTop } = truckCab(b, t, { front, len: cabLen, W, y0: frameY - 0.02, H: 2.5, xAxle: txs[0], wr, tireW: tw + 0.04, style: "heavy" });
  // 지붕 공기 가리개 (짐 높이까지, 평판은 낮은 지붕 그대로)
  const cargo = t.cargo ?? "container40";
  const fh = cargo.startsWith("container") ? 0.55 : cargo === "carcarrier" ? 0.45 : cargo === "flatbed" ? 0 : 0.25;
  const fx = front - 0.5;
  if (fh > 0) profile(m, [[fx, yTop], [fx - 0.2, yTop + 0.08], [fx - 1.55, yTop + fh], [fx - 1.75, yTop + fh], [fx - 1.75, yTop]], W - 0.3, S.paint, 0, 0.1);
  const tractorLen = 6.3;
  const gaps: [number, number][] = txs.map((x) => [x - wr - 0.1, x + wr + 0.1]);
  chassis(b, front - cabLen, front - tractorLen, frameY, W, gaps, true);
  // 오륜 (트레일러 연결판)
  cyl(m, 0.6, 0.08, front - 4.6, frameY + 0.18, 0, "y", S.chassis, 16);
  mudflaps(b.m, txs[2] - wr - 0.15, wr, W, 0.62);
  heavyWheels(b, txs, wr, W, tw, 1, (i) => i > 0);
  // ---- 트레일러 ----
  const tx0 = front - 3.2;
  const tx1 = -front;
  const tLen = tx0 - tx1;
  const tMid = (tx0 + tx1) / 2;
  const deckY = frameY + 0.38;
  box(m, tLen, 0.22, W - 0.05, tMid, deckY - 0.1, 0, S.chassis);
  for (const s of [-1, 1]) box(m, tLen, 0.3, 0.05, tMid, deckY - 0.28, s * 0.45, S.chassis);
  // 받침다리
  for (const s of [-1, 1]) box(m, 0.12, deckY - 0.3, 0.12, tx0 - 1.6, (deckY - 0.3) / 2 + 0.15, s * 0.8, S.steel);
  const trailerAxles = Math.max(2, (t.axles ?? 5) - 3);
  const tws: number[] = [];
  for (let i = 0; i < trailerAxles; i++) tws.push(tx1 + 1.6 + (trailerAxles - 1 - i) * 1.32);
  const tGaps: [number, number][] = tws.map((x) => [x - wr - 0.1, x + wr + 0.1]);
  // 트레일러 옆 보호대
  for (const [a, c] of gapsBetween(tx0 - 1.8, tx1 + 0.3, tGaps)) {
    if (a - c < 0.6) continue;
    for (const s of [-1, 1]) box(m, a - c, 0.08, 0.03, (a + c) / 2, deckY - 0.45, s * (W / 2 - 0.04), S.steel);
  }
  if (cargo === "container40" || cargo === "container20") {
    const cLen = cargo === "container40" ? Math.min(tLen, 12.19) : Math.min(tLen, 6.06);
    const col = CONTAINER_COLORS[Math.floor(rand() * CONTAINER_COLORS.length)];
    const cH = 2.59;
    const cx = tx1 + cLen / 2 + 0.1;
    const cs = surf(col, 0.6, 0.35, 0.1);
    const rib = surf(new THREE.Color(col).multiplyScalar(0.78).getHex(), 0.6, 0.35, 0.1);
    const y0 = deckY + 0.02;
    box(m, cLen, cH, 2.44, cx, y0 + cH / 2, 0, cs);
    // 골판: 옆면 세로 골
    for (const s of [-1, 1]) {
      for (let x = cx - cLen / 2 + 0.2; x < cx + cLen / 2 - 0.15; x += 0.28) box(m, 0.1, cH - 0.24, 0.014, x, y0 + cH / 2, s * 1.222, rib);
      box(m, cLen, 0.1, 0.02, cx, y0 + 0.05, s * 1.225, rib);
      box(m, cLen, 0.1, 0.02, cx, y0 + cH - 0.05, s * 1.225, rib);
    }
    // 모서리 쇠 (주조 모서리)
    for (const x of [cx - cLen / 2 + 0.09, cx + cLen / 2 - 0.09]) for (const y of [y0 + 0.06, y0 + cH - 0.06]) for (const s of [-1, 1]) box(m, 0.18, 0.12, 0.16, x, y, s * 1.15, S.chassis);
    // 뒷문: 잠금대 네 개, 가운데 틈
    const xb = cx - cLen / 2 - 0.006;
    box(m, 0.012, cH - 0.2, 0.012, xb, y0 + cH / 2, 0, S.seam);
    for (const z of [-0.85, -0.3, 0.3, 0.85]) box(m, 0.03, cH - 0.25, 0.04, xb - 0.012, y0 + cH / 2, z, S.steel);
    for (const s of [-1, 1]) box(m, 0.02, 0.35, 0.4, xb, y0 + 0.2, s * 0.6, rib);
  } else if (cargo === "flatbed") {
    box(m, tLen, 0.12, W, tMid, deckY + 0.06, 0, S.steel);
    const coils = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < coils; i++) {
      const g = new THREE.CylinderGeometry(0.9, 0.9, 1.5, 20, 1, false);
      g.translate(tx1 + 1.4 + (i * (tLen - 2.6)) / Math.max(1, coils - 1), deckY + 0.9, 0);
      m.geo(g, surf(0x8e959c, 0.3, 0.9));
      // 받침 나무
      box(m, 1.0, 0.12, 1.6, tx1 + 1.4 + (i * (tLen - 2.6)) / Math.max(1, coils - 1), deckY + 0.15, 0, surf(C.wood, 0.8));
    }
  } else if (cargo === "tanktrailer") {
    const g = new THREE.CylinderGeometry(1.15, 1.15, tLen * 0.93, 24);
    g.rotateZ(Math.PI / 2);
    g.translate(tMid, deckY + 1.25, 0);
    m.geo(g, S.chrome);
    for (const x of [tMid + tLen * 0.465, tMid - tLen * 0.465]) {
      const e = new THREE.SphereGeometry(1.15, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      e.scale(1, 0.25, 1);
      e.rotateZ(x > tMid ? -Math.PI / 2 : Math.PI / 2);
      e.translate(x, deckY + 1.25, 0);
      m.geo(e, S.chrome);
    }
    box(m, tLen * 0.85, 0.05, 0.5, tMid, deckY + 2.42, 0, S.steel);
    for (let x = tMid + tLen * 0.35; x > tMid - tLen * 0.4; x -= 2.2) cyl(m, 0.22, 0.12, x, deckY + 2.45, 0, "y", S.steel, 10);
  } else if (cargo === "carcarrier") {
    // 아래칸 차 지붕 바로 위에 윗칸 (전체 높이 4m 안쪽)
    const lower = deckY + 0.1;
    const upper = lower + 1.35;
    box(m, tLen, 0.08, W, tMid, upper, 0, S.steel);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) box(m, 0.1, upper - lower, 0.08, tx1 + 0.3 + (k * (tLen - 0.6)) / 5, (upper + lower) / 2, side * (W / 2 - 0.05), S.steel);
      box(m, tLen, 0.06, 0.05, tMid, upper + 0.5, side * (W / 2 - 0.05), S.steel);
    }
    for (const deckTop of [lower, upper + 0.04]) {
      for (let k = 0; k < 3; k++) {
        const cx = tx1 + 2.1 + (k * (tLen - 4)) / 2;
        const col = [0xf4f4f1, 0x1d1e20, 0x9ea2a6, 0x2b3a55][Math.floor(rand() * 4)];
        cbox(m, 3.9, 0.62, 1.8, 0.14, cx, deckTop + 0.5, 0, surf(col, 0.3, 0.4, 1));
        cbox(m, 2.0, 0.48, 1.6, 0.14, cx - 0.2, deckTop + 1.02, 0, S.glass);
        for (const dx of [-1.3, 1.3]) for (const s of [-1, 1]) cyl(m, 0.32, 0.2, cx + dx, deckTop + 0.3, s * 0.78, "z", S.rubber, 10);
      }
    }
  }
  truckRear(b, t, tx1, deckY - 0.2, W);
  mudflaps(b.m, tws[tws.length - 1] - wr - 0.15, wr, W, 0.62);
  heavyWheels(b, tws, wr, W, tw, 0, () => true);
}

// ---------- 바퀴 ----------

let wheelGeos: Record<"car" | "heavy" | "carLow" | "heavyLow", THREE.BufferGeometry> | null = null;

/** 반지름 1, 폭 1 바퀴 (축 = z, 휠 면 = +z). 인스턴스 행렬로 크기를 맞춘다 */
export function wheelGeometry(kind: "car" | "heavy" | "carLow" | "heavyLow"): THREE.BufferGeometry {
  if (!wheelGeos) {
    wheelGeos = {
      car: makeWheel(false, false),
      heavy: makeWheel(true, false),
      carLow: makeWheel(false, true),
      heavyLow: makeWheel(true, true),
    };
  }
  return wheelGeos[kind];
}

function lathe(m: Mesher, prof: [number, number][], s: Surf, seg: number) {
  // prof: (반지름, z)
  const g = new THREE.LatheGeometry(
    prof.map(([r, z]) => new THREE.Vector2(r, z)),
    seg,
  );
  g.rotateX(Math.PI / 2);
  m.geo(g, s);
}

function makeWheel(heavy: boolean, low: boolean): THREE.BufferGeometry {
  const m = new Mesher();
  const tire = S.rubber;
  const seg = low ? 10 : heavy ? 16 : 18;
  const rimR = heavy ? 0.6 : 0.68;
  // 타이어 (옆면 둥글게)
  const tp: [number, number][] = low
    ? [
        [rimR, -0.45],
        [1, -0.45],
        [1, 0.45],
        [rimR, 0.45],
      ]
    : [
        [rimR, -0.44],
        [0.84, -0.5],
        [0.96, -0.47],
        [1, -0.38],
        [1, 0.38],
        [0.96, 0.47],
        [0.84, 0.5],
        [rimR, 0.44],
      ];
  lathe(m, tp, tire, seg);
  if (low) {
    const g = new THREE.CircleGeometry(rimR, seg);
    g.translate(0, 0, 0.44);
    m.geo(g, heavy ? surf(0x8d9296, 0.5, 0.6) : S.satin);
    return m.build();
  }
  if (heavy) {
    // 철제 휠: 접시 + 가운데 허브 + 너트
    const disc = surf(0xa8adb2, 0.45, 0.6, 0);
    lathe(
      m,
      [
        [rimR, 0.44],
        [rimR - 0.04, 0.4],
        [0.3, 0.36],
        [0.26, 0.42],
        [0.14, 0.46],
        [0.001, 0.47],
      ],
      disc,
      seg,
    );
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const g = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 5, 1, true);
      g.rotateX(Math.PI / 2);
      g.translate(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.46);
      m.geo(g, S.darkChrome);
    }
    for (let i = 0; i < 6; i++) {
      const a = ((i + 0.5) / 6) * Math.PI * 2;
      const g = new THREE.CircleGeometry(0.06, 8);
      g.translate(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.385);
      m.geo(g, S.well);
    }
    return m.build();
  }
  // 알루미늄 휠: 테 + 5개 살 + 허브 + 안쪽 디스크
  const rim = surf(0xc3c8ce, 0.22, 1, 0.6);
  const dark = surf(0x2a2c30, 0.5, 0.6, 0);
  lathe(
    m,
    [
      [rimR, 0.44],
      [rimR - 0.035, 0.45],
      [rimR - 0.06, 0.41],
      [rimR - 0.06, -0.3],
    ],
    rim,
    seg,
  );
  // 브레이크 디스크 (살 사이로 보인다)
  const disc = new THREE.CircleGeometry(rimR - 0.06, seg);
  disc.translate(0, 0, 0.05);
  m.geo(disc, dark);
  const spokes = 5;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    for (const off of [-0.11, 0.11]) {
      const aa = a + off;
      const w0 = 0.045;
      const w1 = 0.035;
      const r0 = 0.16;
      const r1 = rimR - 0.05;
      const dir = new THREE.Vector3(Math.cos(aa), Math.sin(aa), 0);
      const nrm = new THREE.Vector3(-Math.sin(aa), Math.cos(aa), 0);
      const p = (r: number, w: number, z: number) => dir.clone().multiplyScalar(r).addScaledVector(nrm, w).setZ(z);
      const a0 = p(r0, -w0, 0.4);
      const b0 = p(r0, w0, 0.4);
      const a1 = p(r1, -w1, 0.43);
      const b1 = p(r1, w1, 0.43);
      m.flat(a0, a1, b1, rim);
      m.flat(a0, b1, b0, rim);
      const a0d = a0.clone().setZ(0.28);
      const a1d = a1.clone().setZ(0.33);
      const b0d = b0.clone().setZ(0.28);
      const b1d = b1.clone().setZ(0.33);
      m.flat(a0d, a1d, a1, rim);
      m.flat(a0d, a1, a0, rim);
      m.flat(b0, b1, b1d, rim);
      m.flat(b0, b1d, b0d, rim);
    }
  }
  lathe(
    m,
    [
      [0.2, 0.36],
      [0.17, 0.41],
      [0.08, 0.43],
      [0.001, 0.435],
    ],
    rim,
    seg,
  );
  const cap = new THREE.CircleGeometry(0.06, 10);
  cap.translate(0, 0, 0.437);
  m.geo(cap, S.gloss);
  return m.build();
}

// ---------- 공개 함수 ----------

const BUS_BODIES = new Set(["coach", "city_bus", "double_decker"]);
const TRUCK_BODIES = new Set(["truck_light", "truck_medium", "truck_heavy"]);

/** 바퀴를 행렬에 맞춰 붙인다 (단순 바퀴를 중간 거리 모델에 넣을 때) */
function bakeWheels(m: Mesher, wheels: WheelSpec[], low: boolean) {
  const g0 = low ? wheelGeometry("carLow") : wheelGeometry("car");
  const g1 = low ? wheelGeometry("heavyLow") : wheelGeometry("heavy");
  const mat = new THREE.Matrix4();
  for (const w of wheels) {
    mat.compose(new THREE.Vector3(w.x, w.r, w.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), w.z < 0 ? Math.PI : 0), new THREE.Vector3(w.r, w.r, w.w));
    const g = (w.heavy ? g1 : g0).clone().applyMatrix4(mat);
    appendGeometry(m, g);
  }
}

/** surf 속성이 있는 도형을 그대로 붙인다 */
function appendGeometry(m: Mesher, g: THREE.BufferGeometry) {
  const p = g.getAttribute("position");
  const n = g.getAttribute("normal");
  const c = g.getAttribute("color");
  const s = g.getAttribute("surf");
  for (let i = 0; i < p.count; i++) {
    m.pos.push(p.getX(i), p.getY(i), p.getZ(i));
    m.nor.push(n.getX(i), n.getY(i), n.getZ(i));
    m.col.push(c.getX(i), c.getY(i), c.getZ(i));
    m.srf.push(s.getX(i), s.getY(i), s.getZ(i), s.getW(i));
  }
  g.dispose();
}

/** surf 속성의 도색 표시로 도형을 도색/나머지로 나눈다 (예전 방식 호환) */
function splitPaint(g: THREE.BufferGeometry, paint: boolean): THREE.BufferGeometry {
  const p = g.getAttribute("position");
  const n = g.getAttribute("normal");
  const c = g.getAttribute("color");
  const s = g.getAttribute("surf");
  const out = new Mesher();
  for (let i = 0; i < p.count; i += 3) {
    const isPaint = s.getW(i) > 15.5;
    if (isPaint !== paint) continue;
    for (let k = i; k < i + 3; k++) {
      out.pos.push(p.getX(k), p.getY(k), p.getZ(k));
      out.nor.push(n.getX(k), n.getY(k), n.getZ(k));
      out.col.push(c.getX(k), c.getY(k), c.getZ(k));
      out.srf.push(s.getX(k), s.getY(k), s.getZ(k), s.getW(k));
    }
  }
  return out.build();
}

function merge(list: Mesher[]): THREE.BufferGeometry {
  const all = new Mesher();
  for (const m of list) all.append(m);
  return all.build();
}

function lazy<T>(fn: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= fn());
}

export function buildVehicleModel(t: VehicleType, seed = 1): VehicleModel {
  let x = seed * 9301 + 49297;
  const rand = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
  const b = new VB(t, rand);
  if (BUS_BODIES.has(t.body)) buildBus(t, b);
  else if (TRUCK_BODIES.has(t.body)) buildTruck(t, b);
  else if (t.body === "tractor_trailer") buildTractor(t, b);
  else if (t.body === "camper") buildCamper(t, b);
  else buildCar(t, b);
  const big = t.length > 6;
  const body = lazy(() => merge([b.m, b.core]));
  const mid = lazy(() => {
    const mm = new Mesher();
    mm.append(b.mid.count ? b.mid : b.m);
    mm.append(b.core);
    bakeWheels(mm, b.wheels, true);
    return mm.build();
  });
  const interior = lazy(() => b.inner.build());
  const withWheels = lazy(() => {
    const mm = new Mesher();
    appendGeometry(mm, body().clone());
    bakeWheels(mm, b.wheels, false);
    return mm.build();
  });
  const paint = lazy(() => splitPaint(withWheels(), true));
  const fixed = lazy(() => splitPaint(withWheels(), false));
  const model = {
    type: t,
    wheels: b.wheels,
    cabin: b.cabin,
    headLights: b.head,
    brakeLights: b.brake,
    signalLeft: b.sigL,
    signalRight: b.sigR,
    lightSize: big ? 0.22 : 0.14,
  } as unknown as VehicleModel;
  Object.defineProperties(model, {
    body: { get: body, enumerable: true },
    mid: { get: mid, enumerable: true },
    interior: { get: interior, enumerable: true },
    paint: { get: paint, enumerable: true },
    fixed: { get: fixed, enumerable: true },
  });
  return model;
}

export interface VehicleObjectOptions {
  seed?: number;
  /** 이미 만든 모델을 쓴다 */
  model?: VehicleModel;
  /** 클리어코트 (기본 켬) */
  clearcoat?: boolean;
}

/**
 * 재질까지 입힌 차 한 대 (미리보기·도감용). y=0 바닥, +x 앞.
 * 환경맵은 장면의 scene.environment를 쓴다. userData: { model, material, wheelMaterial, wheels: 바퀴 Object3D[] }
 */
export function createVehicleObject(type: VehicleType, color: string, opts: VehicleObjectOptions = {}): THREE.Group {
  const model = opts.model ?? buildVehicleModel(type, opts.seed ?? 1);
  const mat = createVehicleMaterial({ lamps: true, clearcoat: opts.clearcoat });
  vehicleUniforms(mat).uPaint.value.set(color);
  const wheelMat = createVehicleMaterial({ clearcoat: opts.clearcoat });
  const g = new THREE.Group();
  const body = new THREE.Mesh(model.body, mat);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const wheels: THREE.Object3D[] = [];
  for (const w of model.wheels) {
    const pivot = new THREE.Group();
    pivot.position.set(w.x, w.r, w.z);
    const mesh = new THREE.Mesh(wheelGeometry(w.heavy ? "heavy" : "car"), wheelMat);
    mesh.scale.set(w.r, w.r, w.w);
    if (w.z < 0) mesh.rotation.y = Math.PI;
    mesh.castShadow = true;
    pivot.add(mesh);
    g.add(pivot);
    wheels.push(pivot);
  }
  g.userData = { model, material: mat, wheelMaterial: wheelMat, wheels };
  return g;
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
