// 도로를 200m 조각으로 잘라, 플레이어 주변 조각만 3D로 만든다. 전국 어느 노선이든 같은 방식으로 이어서 불러온다.
// 조각 안 좌표: x = 동쪽 - 조각 기준점, y = 고도, z = -(북쪽 - 조각 기준점)

import * as THREE from "three";
import { LANE_WIDTH, LEFT_SHOULDER, RIGHT_SHOULDER, Structure, type Road } from "../road/road";
import { arrowBoardTexture, enforcementSigns, planSigns, workZoneSigns, type SignSpec } from "./signs";
import { coneLine, END_TAPER_M, type WorkZone } from "../sim/workzones";
import type { Enforcement } from "../sim/cameras";
import { incidentBlockS, incidentVehicleS, type Incident } from "../sim/incidents";
import { iceAt, type IcePatch } from "../sim/ice";
import { expansionJoints, RUMBLE } from "../road/surface";
import type { World } from "./world";

export const CHUNK = 200;
const ROW = 5; // 노면 가로줄 간격 (m)
const TERRAIN_ROW = 20;
const BEHIND = 400;
/** 조각마다 심을 수 있는 나무 수 (품질의 treeDensity만큼 그린다) */
const TREE_CAP = 300;

/** 조각 하나의 나무 무리: 가까우면 제 모양, 멀면 단순한 모양으로 바꿔 그린다 */
interface TreeSet {
  mesh: THREE.InstancedMesh;
  n: number;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
}

/** 버스전용차로 등 차선 색을 바꾸는 구간 */
export interface LaneOverride {
  s0: number;
  s1: number;
  boundary: number; // k번째 차선 (1 = 1·2차로 사이)
  color: number;
}

interface Row {
  s: number;
  e: number;
  n: number;
  z: number;
  te: number;
  tn: number;
  w: number;
  lanes: number;
  structure: Structure;
  kappa: number;
}

// 가로 위치 (d, 오른쪽 +)
function layout(w: number) {
  const ourL = -w / 2;
  const ourR = w / 2;
  const oppInner = ourL - LEFT_SHOULDER * 3; // 반대편 노란선 (분리대 폭 3m)
  return {
    ourL,
    ourR,
    shoulderR: ourR + RIGHT_SHOULDER,
    shoulderL: ourL - LEFT_SHOULDER,
    barrier: ourL - LEFT_SHOULDER * 1.5,
    oppInner,
    oppOuter: oppInner - w,
    oppShoulder: oppInner - w - RIGHT_SHOULDER,
  };
}

class Geo {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  get empty() {
    return this.idx.length === 0;
  }

  mesh(mat: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return new THREE.Mesh(g, mat);
  }
}

const tmpColor = new THREE.Color();

/** 이음매 없이 반복되는 부드러운 값 잡음 (cells × cells 격자를 보간) */
export function tiledNoise(size: number, cells: number, rand: () => number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cells;
    const y0 = Math.floor(gy);
    const ty = gy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const x0 = Math.floor(gx);
      const tx = gx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const x1 = (x0 + 1) % cells;
      const top = grid[y0 * cells + x0] * (1 - sx) + grid[y0 * cells + x1] * sx;
      const bot = grid[y1 * cells + x0] * (1 - sx) + grid[y1 * cells + x1] * sx;
      out[y * size + x] = top * (1 - sy) + bot * sy;
    }
  }
  return out;
}

export function xorshift(seed: number): () => number {
  let x = seed * 1234567;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

export function grayTexture(size: number, value: (i: number) => number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const b = Math.max(0, Math.min(255, value(i)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 아스팔트: 골재 알갱이, 얼룩, 패인 곳 (4m마다 반복) */
export function asphaltTexture(): THREE.CanvasTexture {
  const size = 512;
  const rand = xorshift(3);
  const blotch = tiledNoise(size, 5, rand);
  const fine = tiledNoise(size, 40, rand);
  return grayTexture(size, (i) => {
    const v = 150 + (blotch[i] - 0.5) * 34 + (fine[i] - 0.5) * 22 + (rand() - 0.5) * 46;
    const r = rand();
    if (r < 0.012) return v + 50; // 밝은 골재
    if (r < 0.022) return v - 40; // 패인 곳
    return v;
  });
}

/** 풀밭: 덤불 덩어리와 잔디 결 (30m마다 반복) */
function grassTexture(): THREE.CanvasTexture {
  const size = 256;
  const rand = xorshift(7);
  const clump = tiledNoise(size, 6, rand);
  const tuft = tiledNoise(size, 48, rand);
  return grayTexture(size, (i) => 160 + (clump[i] - 0.5) * 80 + (tuft[i] - 0.5) * 50 + (rand() - 0.5) * 50);
}

/** 중앙분리대 눈부심 방지판: 0.5m마다 세운 날개판과 위아래 테 (사이로 건너편이 보인다) */
function glareTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 32;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 22, h);
  g.fillRect(0, 0, w, 3);
  g.fillRect(0, h - 3, w, 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 노면요철: 가로로 판 홈이 약 31cm마다 (4m에 13줄). 홈 안쪽은 어둡고 가장자리는 조금 밝다 */
function rumbleTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 208;
  const g = c.getContext("2d")!;
  g.fillStyle = "#9a9a98";
  g.fillRect(0, 0, 8, 208);
  for (let k = 0; k < 13; k++) {
    const y = k * 16;
    g.fillStyle = "#6a6b6b";
    g.fillRect(0, y + 3, 8, 7);
    g.fillStyle = "#5c5d5d";
    g.fillRect(0, y + 4, 8, 4);
    g.fillStyle = "#adadaa";
    g.fillRect(0, y + 10, 8, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export class RoadChunks {
  group = new THREE.Group();
  private chunks = new Map<number, THREE.Group & { userData: { e0: number; n0: number } }>();
  private signs: SignSpec[];
  private mats: Record<string, THREE.Material>;
  private signMats = new Map<THREE.Texture, THREE.Material>();
  private pineGeo: THREE.BufferGeometry;
  private broadGeo: THREE.BufferGeometry;
  private pineFar: THREE.BufferGeometry;
  private broadFar: THREE.BufferGeometry;
  private trees = new Map<number, TreeSet[]>();
  private noiseWallBlocks = new Set<number>();
  overrides: LaneOverride[] = [];
  /** 단속 카메라: 고정식은 오른쪽 기둥과 팔, 구간단속 시점·종점은 도로를 건너는 문형 구조물 */
  private enforcement: Enforcement = { fixed: [], sections: [] };
  private workZones: WorkZone[] = [];
  private coneGeo = makeConeGeometry();
  private arrowMats = new Map<string, THREE.MeshBasicMaterial>();
  /** 돌발상황: 안전삼각대, 밤에는 불꽃신호, 대피했거나 차 옆에 선 사람 */
  private incidents: Incident[] = [];
  private ice: IcePatch[] = [];
  private incidentNight = false;
  private triangleGeo = makeTriangleGeometry();
  private personGeo = makePersonGeometry();
  private flareMat = new THREE.MeshBasicMaterial({ color: 0xff3b1a, toneMapped: false });
  private triangleMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  /** 교량 신축이음 위치 (road/surface.ts) */
  private joints: { s: number; strength: number }[] = [];

  /** 공사 구간과 그 표지를 넣는다 (조각을 만들기 전에 부른다) */
  setWorkZones(zones: WorkZone[]) {
    this.workZones = zones;
    this.signs = [...this.signs, ...workZoneSigns(zones, this.road)].sort((a, b) => a.s - b.s);
  }

  /** 돌발상황을 넣는다 (조각을 만들기 전에 부른다). 밤이면 삼각대 옆에 불꽃신호를 더한다 */
  setIncidents(list: Incident[], night: boolean) {
    this.incidents = list;
    this.incidentNight = night;
  }

  /** 젖은 노면 (0~1): 아스팔트가 짙어지고 물기에 하늘이 비친다 (멀리 볼수록 번들거린다). 차선도 조금 어두워진다 */
  setWet(k: number, sky: THREE.Texture | null) {
    const surface = this.mats.surface as THREE.MeshStandardMaterial;
    const marks = this.mats.marks as THREE.MeshStandardMaterial;
    surface.color.setScalar(1 - 0.4 * k);
    surface.roughness = 0.95 - 0.6 * k;
    surface.envMap = k > 0 ? sky : null;
    surface.envMapIntensity = 0.7 * k;
    marks.color.setScalar(1 - 0.15 * k);
    marks.roughness = 0.7 - 0.35 * k;
    marks.envMap = surface.envMap;
    marks.envMapIntensity = 0.5 * k;
    const rumble = this.mats.rumble as THREE.MeshStandardMaterial;
    rumble.color.setScalar(1 - 0.35 * k);
    rumble.roughness = 0.95 - 0.5 * k;
    rumble.envMap = surface.envMap;
    rumble.envMapIntensity = 0.5 * k;
    surface.needsUpdate = marks.needsUpdate = rumble.needsUpdate = true;
  }

  /** 눈이 쌓인다: 땅·나무·콘크리트(방호벽 윗면 등)의 위를 보는 면이 하얘진다. k 0~1 (노면은 제설돼 젖은 채로 둔다) */
  setSnow(k: number) {
    for (const m of [this.mats.terrain, this.mats.tree, this.mats.concrete] as THREE.MeshStandardMaterial[]) {
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uSnow = { value: k };
        sh.fragmentShader = sh.fragmentShader.replace("void main() {", "uniform float uSnow;\nvoid main() {").replace(
          "#include <lights_physical_fragment>",
          `{
            vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
            float cover = uSnow * smoothstep(0.2, 0.75, dot(normal, upV));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.9, 0.93), cover);
          }
          #include <lights_physical_fragment>`,
        );
      };
      m.customProgramCacheKey = () => `snow${k}`;
      m.needsUpdate = true;
    }
  }

  /** 새벽 결빙: 언 곳 노면에 얇은 얼음막 (조금 어둡고 반들거린다). 조각을 만들기 전에 부른다 */
  setIce(patches: IcePatch[], sky: THREE.Texture | null) {
    this.ice = patches;
    (this.mats.ice as THREE.MeshStandardMaterial).envMap = sky;
  }

  /** 단속 카메라와 그 표지를 넣는다 (조각을 만들기 전에 부른다) */
  setEnforcement(e: Enforcement) {
    this.enforcement = e;
    this.signs = [...this.signs, ...enforcementSigns(e, this.road)].sort((a, b) => a.s - b.s);
  }

  constructor(
    private road: Road,
    private world: World,
  ) {
    this.world.scene.add(this.group);
    this.signs = planSigns(road);
    const asphalt = asphaltTexture();
    const grass = grassTexture();
    this.mats = {
      surface: new THREE.MeshStandardMaterial({ vertexColors: true, map: asphalt, roughness: 0.95, metalness: 0 }),
      marks: new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      concrete: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide }),
      terrain: new THREE.MeshStandardMaterial({ vertexColors: true, map: grass, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
      tunnel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff1cf, side: THREE.DoubleSide }),
      ice: new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.32, envMapIntensity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      tree: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
      post: new THREE.MeshStandardMaterial({ color: 0x8e9396, roughness: 0.5, metalness: 0.6 }),
      cone: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }),
      // 양면 투명은 three.js가 뒷면·앞면 두 번에 나눠 그리며 매번 셰이더를 다시 고른다 (얇은 망이라 한 번에 그려도 같다)
      glare: new THREE.MeshStandardMaterial({ vertexColors: true, map: glareTexture(), transparent: true, depthWrite: false, roughness: 0.7, side: THREE.DoubleSide, forceSinglePass: true }),
      rumble: new THREE.MeshStandardMaterial({ vertexColors: true, map: rumbleTexture(), roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      signBack: new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide }),
    };
    this.joints = expansionJoints(road);
    this.pineGeo = makePineGeometry();
    this.broadGeo = makeBroadleafGeometry();
    this.pineFar = makePineGeometry(true);
    this.broadFar = makeBroadleafGeometry(true);
    // 방음벽 구간: IC·JC 근처(도시 부근)일수록 자주
    for (let b = 0; b * 400 < road.length; b++) {
      const s = b * 400;
      const nearJ = road.junctions.some((j) => Math.abs(j.s - s) < 2500);
      if (hash(b * 31 + road.length) < (nearJ ? 0.3 : 0.06)) this.noiseWallBlocks.add(b);
    }
  }

  /** 플레이어 위치에 맞춰 조각을 만들고 지운다. 한 프레임에 최대 maxBuild개만 만든다 */
  update(s: number, maxBuild = 2) {
    // 화살표 차량 뒤판은 깜빡인다
    const blink = Math.floor(performance.now() / 450) % 2 === 0 ? 1 : 0.18;
    for (const m of this.arrowMats.values()) m.color.setScalar(blink);
    // 불꽃신호는 일렁인다
    const t = performance.now() / 1000;
    this.flareMat.color.setRGB(1, 0.2 + 0.12 * Math.sin(t * 23) + 0.08 * Math.sin(t * 37), 0.08).multiplyScalar(0.8 + 0.4 * Math.abs(Math.sin(t * 13)));
    // 안개 끝(밤·날씨·품질)까지만 만든다. 그 너머는 안개에 가려 보이지 않는다
    const ahead = this.world.visibleDistance + 100;
    const k0 = Math.max(0, Math.floor((s - BEHIND) / CHUNK));
    const k1 = Math.min(Math.floor(this.road.length / CHUNK), Math.floor((s + ahead) / CHUNK));
    for (const [k, g] of this.chunks) {
      if (k < k0 - 1 || k > k1 + 1) {
        this.group.remove(g);
        disposeGroup(g);
        this.chunks.delete(k);
        this.trees.delete(k);
      }
    }
    // 가까운 조각부터
    const want: number[] = [];
    for (let k = k0; k <= k1; k++) if (!this.chunks.has(k)) want.push(k);
    const sk = Math.floor(s / CHUNK);
    want.sort((a, b) => Math.abs(a - sk) - Math.abs(b - sk));
    for (const k of want.slice(0, maxBuild)) {
      const g = this.build(k);
      // 조각 안 물체는 조각과 함께만 움직인다: 자기 행렬은 한 번만 계산해 둔다
      g.traverse((o) => {
        if (o === g) return;
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      });
      this.chunks.set(k, g);
      this.group.add(g);
    }
    // 떠다니는 원점에 맞춰 위치 갱신
    const o = this.world.origin;
    for (const g of this.chunks.values()) g.position.set(g.userData.e0 - o.e, 0, -(g.userData.n0 - o.n));
    this.updateTrees(sk);
  }

  /**
   * 나무: 가까운 조각만 제 모양(잎 뭉치가 둥근)으로, 먼 조각은 면이 적은 모양으로 그린다.
   * 그림자는 해 그림자 범위에 드는 가까운 조각만 드리운다. 몇 그루를 그릴지는 품질에 따른다.
   */
  private updateTrees(sk: number) {
    const set = this.world.settings;
    for (const [k, sets] of this.trees) {
      const dk = Math.abs(k - sk);
      const near = dk <= set.treeNear;
      const shadow = set.shadowMap > 0 && dk <= set.treeShadow;
      for (const t of sets) {
        const geo = near ? t.near : t.far;
        if (t.mesh.geometry !== geo) t.mesh.geometry = geo;
        t.mesh.count = Math.round(t.n * set.treeDensity);
        t.mesh.castShadow = shadow;
      }
    }
  }

  /** 시작할 때 주변을 한 번에 다 만든다 */
  prime(s: number) {
    this.update(s, 999);
  }

  get pending(): number {
    return this.chunks.size;
  }

  private rows(s0: number, s1: number, step: number): Row[] {
    const out: Row[] = [];
    const r = this.road;
    for (let s = s0; s <= s1 + 1e-6; s += step) {
      const ss = Math.min(s, r.length - 0.01);
      const p = r.sample(ss);
      const i = r.index(ss);
      out.push({
        s: ss,
        e: p.e,
        n: p.n,
        z: p.z,
        te: p.te,
        tn: p.tn,
        w: r.widthAt(ss),
        lanes: r.lanes[i],
        structure: r.structure[i] as Structure,
        kappa: p.kappa,
      });
    }
    return out;
  }

  private build(k: number) {
    const road = this.road;
    const s0 = k * CHUNK;
    const s1 = Math.min(road.length - 0.01, s0 + CHUNK);
    const base = road.sample(s0);
    const e0 = base.e;
    const n0 = base.n;
    const group = new THREE.Group() as THREE.Group & { userData: { e0: number; n0: number } };
    group.userData = { e0, n0 };
    const rows = this.rows(s0, s1, ROW);
    // 조각 좌표로 (s, d, 높이) → Vector3
    const P = (row: Row, d: number, h: number, out = new THREE.Vector3()) =>
      out.set(row.e + d * row.tn - e0, row.z + h, -(row.n - d * row.te - n0));

    const surface = new Geo();
    const marks = new Geo();
    const concrete = new Geo();
    const metal = new Geo();
    const tunnel = new Geo();
    const lamps = new Geo();

    // ---- 노면 ----
    const asphaltOur = new THREE.Color(0x646668);
    const asphaltOpp = new THREE.Color(0x616365);
    const shoulderCol = new THREE.Color(0x6a6c6c);
    const medianCol = new THREE.Color(0x77776f);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const strip = (geo: Geo, dA: (r: Row, L: ReturnType<typeof layout>) => number, dB: (r: Row, L: ReturnType<typeof layout>) => number, h: number, color: THREE.Color, skip?: (r: Row) => boolean) => {
      let prev: [number, number] | null = null;
      for (const row of rows) {
        if (skip && skip(row)) {
          prev = null;
          continue;
        }
        const L = layout(row.w);
        const da = dA(row, L);
        const db = dB(row, L);
        P(row, da, h, a);
        P(row, db, h, b);
        const i0 = geo.vertex(a.x, a.y, a.z, 0, 1, 0, color, da / 4, row.s / 4);
        const i1 = geo.vertex(b.x, b.y, b.z, 0, 1, 0, color, db / 4, row.s / 4);
        if (prev) geo.quad(prev[0], prev[1], i1, i0);
        prev = [i0, i1];
      }
    };
    const inTunnel = (r: Row) => r.structure === Structure.Tunnel;
    // 차로 노면: 바퀴가 지나는 두 줄은 닳아 밝고, 차로 가운데는 기름이 떨어져 어둡다
    const TRACK = [0, 0.24, 0.5, 0.76];
    const SHADE = [0.97, 1.07, 0.86, 1.07];
    const maxLanes = Math.max(...rows.map((r) => r.lanes));
    const laned = (base: THREE.Color, sideSign: 1 | -1) => {
      let prev: number[] | null = null;
      const col = new THREE.Color();
      for (const row of rows) {
        const L = layout(row.w);
        const lw = row.w / Math.max(1, row.lanes);
        const ids: number[] = [];
        for (let j = 0; j <= maxLanes * 4; j++) {
          const li = Math.floor(j / 4);
          const f = li >= row.lanes ? row.lanes : li + TRACK[j % 4];
          // sideSign 1 = 우리 쪽(왼쪽 끝에서 오른쪽으로), -1 = 반대쪽(중앙에서 바깥으로)
          const d = sideSign > 0 ? L.ourL + f * lw : L.oppInner - f * lw;
          col.copy(base).multiplyScalar(li >= row.lanes ? 0.97 : SHADE[j % 4]);
          P(row, d, 0, a);
          ids.push(surface.vertex(a.x, a.y, a.z, 0, 1, 0, col, d / 4, row.s / 4));
        }
        if (prev) {
          for (let j = 0; j < ids.length - 1; j++) {
            if (sideSign > 0) surface.quad(prev[j], prev[j + 1], ids[j + 1], ids[j]);
            else surface.quad(prev[j + 1], prev[j], ids[j], ids[j + 1]);
          }
        }
        prev = ids;
      }
    };
    laned(asphaltOur, 1);
    strip(surface, (_, L) => L.ourR, (_, L) => L.shoulderR, 0, shoulderCol);
    strip(surface, (_, L) => L.oppInner, (_, L) => L.ourL, 0, medianCol, inTunnel);
    strip(surface, (_, L) => L.shoulderL - 0.4, (_, L) => L.ourL, 0.001, shoulderCol, (r) => !inTunnel(r));
    laned(asphaltOpp, -1);
    strip(surface, (_, L) => L.oppShoulder, (_, L) => L.oppOuter, 0, shoulderCol);
    strip(surface, (_, L) => L.oppInner, (_, L) => L.oppInner + 1.4, 0.001, shoulderCol, (r) => !inTunnel(r));
    // 갓길 노면요철 (졸음운전 방지 럼블 스트립): 바깥 차선 바로 옆 갓길에 가로 홈 띠. 터널 안에는 없다
    const rumbleGeo = new Geo();
    const rumbleCol = new THREE.Color(0x8a8b8b);
    strip(rumbleGeo, (_, L) => L.ourR + RUMBLE.right[0], (_, L) => L.ourR + RUMBLE.right[1], 0.002, rumbleCol, inTunnel);
    strip(rumbleGeo, (_, L) => L.ourL - RUMBLE.left[1], (_, L) => L.ourL - RUMBLE.left[0], 0.002, rumbleCol, inTunnel);
    // 교량 신축이음: 노면을 가로지르는 철판 띠 (우리 쪽과 반대편)
    for (const j of this.joints) {
      if (j.strength < 0.5 || j.s < s0 || j.s >= s1) continue;
      const [ra, rb] = [this.rows(j.s - 0.2, j.s - 0.2, 1)[0], this.rows(j.s + 0.2, j.s + 0.2, 1)[0]];
      const steel = new THREE.Color(0x5d6064);
      const gap = new THREE.Color(0x1d1e20);
      for (const [dA, dB] of [
        [(L: ReturnType<typeof layout>) => L.shoulderL, (L: ReturnType<typeof layout>) => L.shoulderR],
        [(L: ReturnType<typeof layout>) => L.oppShoulder, (L: ReturnType<typeof layout>) => L.oppInner + 1.4],
      ]) {
        const La = layout(ra.w);
        const Lb = layout(rb.w);
        P(ra, dA(La), 0.004, a);
        P(ra, dB(La), 0.004, b);
        const i0 = metal.vertex(a.x, a.y, a.z, 0, 1, 0, steel);
        const i1 = metal.vertex(b.x, b.y, b.z, 0, 1, 0, steel);
        P(rb, dA(Lb), 0.004, a);
        P(rb, dB(Lb), 0.004, b);
        const i2 = metal.vertex(b.x, b.y, b.z, 0, 1, 0, steel);
        const i3 = metal.vertex(a.x, a.y, a.z, 0, 1, 0, steel);
        metal.quad(i0, i1, i2, i3);
        // 가운데 틈 (고무 씰)
        const rc = this.rows(j.s, j.s, 1)[0];
        const Lc = layout(rc.w);
        P(rc, dA(Lc), 0.005, a);
        P(rc, dB(Lc), 0.005, b);
        const g0 = marks.vertex(a.x, a.y, a.z, 0, 1, 0, gap);
        const g1 = marks.vertex(b.x, b.y, b.z, 0, 1, 0, gap);
        const rd = this.rows(j.s + 0.04, j.s + 0.04, 1)[0];
        const Ld = layout(rd.w);
        P(rd, dA(Ld), 0.005, a);
        P(rd, dB(Ld), 0.005, b);
        const g2 = marks.vertex(b.x, b.y, b.z, 0, 1, 0, gap);
        const g3 = marks.vertex(a.x, a.y, a.z, 0, 1, 0, gap);
        marks.quad(g0, g1, g2, g3);
      }
    }

    // 새벽 결빙: 우리 쪽 노면(차로+갓길)에 얇은 얼음막
    const iceGeo = new Geo();
    if (this.ice.some((p) => p.s1 > s0 && p.s0 < s1)) strip(iceGeo, (_, L) => L.ourL, (_, L) => L.shoulderR, 0.003, shoulderCol, (r) => !iceAt(this.ice, r.s));

    // ---- 차선 ----
    const white = new THREE.Color(0xf2f2ee);
    const yellow = new THREE.Color(0xf2b705);
    const blue = new THREE.Color(0x2463d8);
    const H = 0.012;
    const line = (dCenter: (r: Row) => number, width: number, color: (r: Row) => THREE.Color, dashed: (r: Row) => boolean, visible: (r: Row) => boolean) => {
      // 점선은 전역 s 기준 10m 칠하고 10m 비운다
      let prev: [number, number] | null = null;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const on = visible(row) && (!dashed(row) || row.s % 20 < 10.01);
        const nextOn = i + 1 < rows.length && visible(rows[i + 1]) && (!dashed(rows[i + 1]) || rows[i + 1].s % 20 < 10.01);
        if (!on && !(prev && nextOn)) {
          prev = null;
          continue;
        }
        const dc = dCenter(row);
        const c = color(row);
        P(row, dc - width / 2, H, a);
        P(row, dc + width / 2, H, b);
        const i0 = marks.vertex(a.x, a.y, a.z, 0, 1, 0, c);
        const i1 = marks.vertex(b.x, b.y, b.z, 0, 1, 0, c);
        if (prev && on) marks.quad(prev[0], prev[1], i1, i0);
        prev = on ? [i0, i1] : null;
      }
    };
    const W = (r: Row) => r.w;
    // 우리 차로
    line((r) => -W(r) / 2 + 0.13, 0.15, () => yellow, () => false, () => true);
    line((r) => W(r) / 2 - 0.13, 0.2, () => white, () => false, () => true);
    for (let kk = 1; kk <= 7; kk++) {
      const override = this.overrides.find((o) => o.boundary === kk && o.s1 > s0 && o.s0 < s1);
      line(
        (r) => -W(r) / 2 + kk * LANE_WIDTH,
        0.15,
        (r) => (override && r.s >= override.s0 && r.s <= override.s1 ? blue : white),
        (r) => r.structure !== Structure.Tunnel,
        (r) => kk * LANE_WIDTH < r.w - 1.2,
      );
    }
    // 반대편 차로
    const opp = (r: Row) => layout(r.w);
    line((r) => opp(r).oppInner - 0.13, 0.15, () => yellow, () => false, (r) => !inTunnel(r));
    line((r) => opp(r).oppOuter + 0.13, 0.2, () => white, () => false, (r) => !inTunnel(r));
    for (let kk = 1; kk <= 7; kk++) {
      line((r) => opp(r).oppInner - kk * LANE_WIDTH, 0.15, () => white, () => true, (r) => !inTunnel(r) && kk * LANE_WIDTH < r.w - 1.2);
    }

    // ---- 중앙분리대 (뉴저지형 콘크리트 + 초록 눈부심 방지망) ----
    const nj: [number, number][] = [
      [-0.3, 0],
      [-0.22, 0.08],
      [-0.1, 0.33],
      [-0.08, 0.82],
      [0.08, 0.82],
      [0.1, 0.33],
      [0.22, 0.08],
      [0.3, 0],
    ];
    const concreteCol = new THREE.Color(0xb9b7ae);
    this.sweep(concrete, rows, P, (r) => layout(r.w).barrier, nj, concreteCol, inTunnel);
    const glare = new Geo();
    this.panel(glare, rows, P, (r) => layout(r.w).barrier, 0.82, 1.5, new THREE.Color(0x3f7d4f), inTunnel, 0.5);

    // ---- 오른쪽: 가드레일 / 교량 난간 / 방음벽 ----
    const isBridge = (r: Row) => r.structure === Structure.Bridge;
    const railCol = new THREE.Color(0xaeb2b4);
    const guardD = (r: Row) => layout(r.w).shoulderR + 0.45;
    const oppGuardD = (r: Row) => layout(r.w).oppShoulder - 0.45;
    this.panel(metal, rows, P, guardD, 0.5, 0.82, railCol, (r) => isBridge(r) || inTunnel(r));
    this.panel(metal, rows, P, oppGuardD, 0.5, 0.82, railCol, (r) => isBridge(r) || inTunnel(r));
    const parapet: [number, number][] = [
      [-0.18, 0],
      [-0.12, 1.05],
      [0.18, 1.05],
      [0.18, 0],
    ];
    this.sweep(concrete, rows, P, guardD, parapet, concreteCol, (r) => !isBridge(r));
    this.sweep(concrete, rows, P, oppGuardD, parapet.map(([d, h]) => [-d, h] as [number, number]), concreteCol, (r) => !isBridge(r));
    // 가드레일 기둥 (4m 간격)
    const postGeo = new Geo();
    const postCol = new THREE.Color(0x8e9396);
    for (let s = Math.ceil(s0 / 4) * 4; s < s1; s += 4) {
      const i = Math.min(rows.length - 1, Math.round((s - s0) / ROW));
      const row = rows[i];
      if (row.structure !== Structure.Normal) continue;
      for (const d of [guardD(row) + 0.12, oppGuardD(row) - 0.12]) this.box(postGeo, P(row, d, 0.45), 0.12, 0.9, 0.12, row, postCol);
    }
    // 방음벽
    const wallCol = new THREE.Color(0x8c877c);
    const wallRow = (r: Row) => this.noiseWallBlocks.has(Math.floor(r.s / 400)) && r.structure === Structure.Normal;
    this.panel(concrete, rows, P, (r) => layout(r.w).shoulderR + 1.8, 0, 4.6, wallCol, (r) => !wallRow(r));
    for (let s = Math.ceil(s0 / 4) * 4; s < s1; s += 4) {
      const row = rows[Math.min(rows.length - 1, Math.round((s - s0) / ROW))];
      if (wallRow(row)) this.box(postGeo, P(row, layout(row.w).shoulderR + 1.75, 2.35), 0.2, 4.7, 0.2, row, new THREE.Color(0x55585a));
    }

    // ---- 터널 ----
    const hasTunnel = rows.some(inTunnel);
    if (hasTunnel) this.buildTunnel(tunnel, lamps, rows, P, s0, s1);

    // ---- 교량 하부 ----
    const bridgeCol = new THREE.Color(0x9c9a92);
    this.panel(concrete, rows, P, (r) => layout(r.w).shoulderR + 0.6, -2.2, 0, bridgeCol, (r) => !isBridge(r));
    this.panel(concrete, rows, P, (r) => layout(r.w).oppShoulder - 0.6, -2.2, 0, bridgeCol, (r) => !isBridge(r));
    // 교량 바닥 판
    strip(concrete, (_, L) => L.oppShoulder - 0.6, (_, L) => L.shoulderR + 0.6, -2.2, bridgeCol, (r) => !isBridge(r));
    for (let s = Math.ceil(s0 / 40) * 40; s < s1; s += 40) {
      const row = rows[Math.min(rows.length - 1, Math.round((s - s0) / ROW))];
      if (!isBridge(row)) continue;
      const ground = Math.min(road.terrainRel(row.s, 7), road.terrainRel(row.s, 8)); // ±45m 지점 지형
      const hgt = -2.2 - ground;
      if (hgt < 1) continue;
      const L = layout(row.w);
      for (const d of [L.ourR - 2, (L.ourL + L.oppInner) / 2, L.oppOuter + 2]) {
        this.box(postGeo, P(row, d, -2.2 - hgt / 2), 1.6, hgt, 1.6, row, bridgeCol);
      }
    }

    // ---- 단속 카메라 ----
    const poleCol = new THREE.Color(0x9a9fa2);
    const camCol = new THREE.Color(0xe9e9e2);
    const lensCol = new THREE.Color(0x15181a);
    // 카메라 몸통과 다가오는 차 쪽을 보는 렌즈
    const camera = (s: number, d: number, h: number) => {
      const row = this.rows(s, s, 1)[0];
      const front = this.rows(s - 0.4, s - 0.4, 1)[0];
      this.box(postGeo, P(row, d, h), 0.75, 0.42, 0.42, row, camCol);
      this.box(postGeo, P(front, d, h - 0.02), 0.08, 0.26, 0.26, front, lensCol);
    };
    for (const cam of this.enforcement.fixed) {
      if (cam.s < s0 || cam.s >= s1) continue;
      const row = this.rows(cam.s, cam.s, 1)[0];
      if (row.structure === Structure.Tunnel) continue;
      const L = layout(row.w);
      const base = L.shoulderR + 1.3;
      const reach = Math.min(row.w * 0.55, 7);
      this.box(postGeo, P(row, base, 3.6), 0.32, 7.2, 0.32, row, poleCol);
      this.box(postGeo, P(row, base - reach / 2, 7), 0.2, 0.22, reach, row, poleCol);
      camera(cam.s, base - reach + 0.6, 6.5);
    }
    for (const sec of this.enforcement.sections) {
      for (const s of [sec.s0, sec.s1]) {
        if (s < s0 || s >= s1) continue;
        const row = this.rows(s, s, 1)[0];
        if (row.structure === Structure.Tunnel) continue;
        const L = layout(row.w);
        const right = L.shoulderR + 1.3;
        const left = L.ourL - 0.9;
        for (const d of [right, left]) this.box(postGeo, P(row, d, 3.8), 0.35, 7.6, 0.35, row, poleCol);
        this.box(postGeo, P(row, (right + left) / 2, 7.4), 0.5, 0.5, right - left, row, poleCol);
        const lw = row.w / Math.max(1, row.lanes);
        for (let i = 0; i < row.lanes; i++) camera(s - 0.3, L.ourL + lw * (i + 0.5), 6.85);
      }
    }

    // ---- 공사 구간: 라바콘 줄과 화살표 차량 ----
    const conePos: THREE.Vector3[] = [];
    const truckCol = new THREE.Color(0xf0b41c);
    const cabCol = new THREE.Color(0xe9e6dc);
    const beaconCol = new THREE.Color(0xff8a00);
    for (const z of this.workZones) {
      if (z.s1 + END_TAPER_M < s0 || z.s0 > s1) continue;
      // 테이퍼에서는 6m, 막힌 구간에서는 12m마다
      for (let s = Math.ceil(Math.max(s0, z.s0) / 6) * 6; s < Math.min(s1, z.s1 + END_TAPER_M); s += 6) {
        if (s > z.sClosed + 6 && s < z.s1 && Math.round(s / 6) % 2) continue;
        const line = coneLine(road, z, s);
        if (line === null) continue;
        const row = this.rows(s, s, 1)[0];
        conePos.push(P(row, line + (z.side === "right" ? 0.3 : -0.3), 0));
      }
      // 화살표 차량: 막힌 차로 가운데, 테이퍼가 끝나고 30m 뒤. 뒤판은 열린 쪽을 가리킨다
      const ts = z.sClosed + 30;
      if (ts >= s0 && ts < s1) {
        const lane = -road.widthAt(ts) / 2 + (z.lane - 0.5) * LANE_WIDTH;
        const at = (ds: number) => this.rows(ts + ds, ts + ds, 1)[0];
        this.box(postGeo, P(at(2.2), lane, 0.95), 4.4, 1.0, 2.3, at(2.2), truckCol);
        this.box(postGeo, P(at(5.3), lane, 1.35), 1.8, 2.2, 2.3, at(5.3), cabCol);
        this.box(postGeo, P(at(5.3), lane - 0.6, 2.6), 0.3, 0.2, 0.3, at(5.3), beaconCol);
        this.box(postGeo, P(at(5.3), lane + 0.6, 2.6), 0.3, 0.2, 0.3, at(5.3), beaconCol);
        this.box(postGeo, P(at(0.2), lane, 1.9), 0.15, 1.9, 0.15, at(0.2), new THREE.Color(0x333333));
        for (const w of [-0.95, 0.95]) for (const ds of [0.9, 5.2]) this.box(postGeo, P(at(ds), lane + w, 0.4), 0.8, 0.8, 0.3, at(ds), new THREE.Color(0x151515));
        const dir = z.side === "right" ? "left" : "right";
        let mat = this.arrowMats.get(dir);
        if (!mat) {
          mat = new THREE.MeshBasicMaterial({ map: arrowBoardTexture(dir), side: THREE.DoubleSide, toneMapped: false });
          this.arrowMats.set(dir, mat);
        }
        const board = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), mat);
        const row = at(0);
        board.position.copy(P(row, lane, 2.75));
        board.rotation.y = Math.atan2(-row.te, row.tn);
        group.add(board);
      }
    }
    // ---- 돌발상황: 삼각대·불꽃신호·사람 ----
    const people: { p: THREE.Vector3; yaw: number }[] = [];
    for (const inc of this.incidents) {
      if (inc.s + 20 < s0 || (inc.triangleS ?? incidentBlockS(inc)) - 20 > s1) continue;
      const laneD = (at: number) => (inc.lane === 0 ? layout(road.widthAt(at)).ourR + 1.55 : road.laneCenter(inc.lane, at));
      const ts = inc.triangleS;
      if (ts !== null && ts >= s0 && ts < s1) {
        const row = this.rows(ts, ts, 1)[0];
        const tri = new THREE.Mesh(this.triangleGeo, this.triangleMat);
        tri.position.copy(P(row, laneD(ts), 0));
        tri.rotation.y = Math.atan2(-row.te, row.tn);
        group.add(tri);
        if (this.incidentNight) {
          const flare = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), this.flareMat);
          flare.position.copy(P(row, laneD(ts) + 0.6, 0.1));
          group.add(flare);
        }
      }
      // 사람: 대피했으면 가드레일 밖, 아니면 앞차 옆(오른쪽)이나 뒤에 서 있다
      const front = incidentVehicleS(inc)[0];
      const n = inc.kind === "crash" ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const ps = front - 2 - k * 6;
        if (ps < s0 || ps >= s1) continue;
        const row = this.rows(ps, ps, 1)[0];
        const L = layout(row.w);
        const d = inc.evacuated ? L.shoulderR + 2.2 + k * 0.8 : Math.min(L.shoulderR - 0.3, laneD(ps) + 1.7);
        people.push({ p: P(row, d, 0), yaw: Math.atan2(-row.te, row.tn) + (k ? 2.2 : -0.6) });
      }
    }
    if (people.length) {
      const mesh = new THREE.InstancedMesh(this.personGeo, this.mats.cone, people.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const one = new THREE.Vector3(1, 1, 1);
      people.forEach((h, i) => mesh.setMatrixAt(i, m.compose(h.p, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw), one)));
      mesh.castShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }

    if (conePos.length) {
      const cones = new THREE.InstancedMesh(this.coneGeo, this.mats.cone, conePos.length);
      const m = new THREE.Matrix4();
      conePos.forEach((p, i) => cones.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
      cones.castShadow = true;
      cones.computeBoundingSphere();
      group.add(cones);
    }

    // ---- 지형 ----
    const terrainGroup = this.buildTerrain(k, s0, s1, P);

    const add = (geo: Geo, mat: THREE.Material, shadow: { cast: boolean; receive: boolean }) => {
      if (geo.empty) return;
      const m = geo.mesh(mat);
      m.castShadow = shadow.cast;
      m.receiveShadow = shadow.receive;
      group.add(m);
    };
    add(surface, this.mats.surface, { cast: false, receive: true });
    add(iceGeo, this.mats.ice, { cast: false, receive: true });
    add(rumbleGeo, this.mats.rumble, { cast: false, receive: true });
    add(marks, this.mats.marks, { cast: false, receive: true });
    add(concrete, this.mats.concrete, { cast: true, receive: true });
    add(metal, this.mats.metal, { cast: true, receive: true });
    add(glare, this.mats.glare, { cast: false, receive: true });
    add(postGeo, this.mats.concrete, { cast: true, receive: true });
    add(tunnel, this.mats.tunnel, { cast: false, receive: false });
    add(lamps, this.mats.lamp, { cast: false, receive: false });
    group.add(terrainGroup);

    // ---- 표지판 ----
    for (const sign of this.signs) {
      if (sign.s < s0 || sign.s >= s1) continue;
      this.placeSign(group, sign, P);
    }
    return group;
  }

  /** 단면 모양(d, 높이)을 도로를 따라 쓸어서 만든다 (분리대, 난간) */
  private sweep(
    geo: Geo,
    rows: Row[],
    P: (r: Row, d: number, h: number, out?: THREE.Vector3) => THREE.Vector3,
    dRef: (r: Row) => number,
    section: [number, number][],
    color: THREE.Color,
    skip: (r: Row) => boolean,
  ) {
    let prev: number[] | null = null;
    const v = new THREE.Vector3();
    for (const row of rows) {
      if (skip(row)) {
        prev = null;
        continue;
      }
      const dr = dRef(row);
      const ids: number[] = [];
      for (let i = 0; i < section.length; i++) {
        const [dd, h] = section[i];
        P(row, dr + dd, h, v);
        // 옆면 법선 근사: 단면에서 이웃 점 방향의 수직
        const [pd, ph] = section[Math.max(0, i - 1)];
        const [nd, nh] = section[Math.min(section.length - 1, i + 1)];
        const td = nd - pd;
        const th = nh - ph;
        const nd2 = th;
        const nh2 = -td;
        const len = Math.hypot(nd2, nh2) || 1;
        const nx = ((nd2 / len) * row.tn);
        const nz = -(-(nd2 / len) * row.te);
        tmpColor.copy(color).multiplyScalar(0.85 + 0.15 * (nh2 / len < 0 ? 1 : 0.6));
        ids.push(geo.vertex(v.x, v.y, v.z, -nx, -nh2 / len, -nz, tmpColor));
      }
      if (prev) for (let i = 0; i < section.length - 1; i++) geo.quad(prev[i], prev[i + 1], ids[i + 1], ids[i]);
      prev = ids;
    }
  }

  /** 세로로 선 얇은 판 (가드레일 빔, 방음벽, 눈부심 방지망) */
  private panel(
    geo: Geo,
    rows: Row[],
    P: (r: Row, d: number, h: number, out?: THREE.Vector3) => THREE.Vector3,
    d: (r: Row) => number,
    h0: number,
    h1: number,
    color: THREE.Color,
    skip: (r: Row) => boolean,
    repeat = 0, // 텍스처를 몇 m마다 반복할지 (0이면 텍스처 없음)
  ) {
    let prev: [number, number] | null = null;
    const v = new THREE.Vector3();
    for (const row of rows) {
      if (skip(row)) {
        prev = null;
        continue;
      }
      const dd = d(row);
      const nx = row.tn;
      const nz = row.te;
      P(row, dd, h0, v);
      const u = repeat > 0 ? row.s / repeat : 0;
      const i0 = geo.vertex(v.x, v.y, v.z, nx, 0, nz, color, u, 0);
      P(row, dd, h1, v);
      const i1 = geo.vertex(v.x, v.y, v.z, nx, 0, nz, color, u, 1);
      if (prev) geo.quad(prev[0], prev[1], i1, i0);
      prev = [i0, i1];
    }
  }

  private box(geo: Geo, c: THREE.Vector3, sx: number, sy: number, sz: number, row: Row, color: THREE.Color) {
    // 도로 방향으로 돌린 상자
    const fx = row.te;
    const fz = -row.tn;
    const rx = row.tn;
    const rz = row.te;
    const corners: THREE.Vector3[] = [];
    for (const dy of [-0.5, 0.5])
      for (const df of [-0.5, 0.5])
        for (const dr of [-0.5, 0.5])
          corners.push(new THREE.Vector3(c.x + fx * df * sx + rx * dr * sz, c.y + dy * sy, c.z + fz * df * sx + rz * dr * sz));
    const faces: [number, number, number, number, THREE.Vector3][] = [
      [4, 5, 7, 6, new THREE.Vector3(0, 1, 0)],
      [0, 2, 3, 1, new THREE.Vector3(0, -1, 0)],
      [2, 6, 7, 3, new THREE.Vector3(fx, 0, fz)],
      [0, 1, 5, 4, new THREE.Vector3(-fx, 0, -fz)],
      [1, 3, 7, 5, new THREE.Vector3(rx, 0, rz)],
      [0, 4, 6, 2, new THREE.Vector3(-rx, 0, -rz)],
    ];
    for (const [i0, i1, i2, i3, n] of faces) {
      const ids = [i0, i1, i2, i3].map((i) => geo.vertex(corners[i].x, corners[i].y, corners[i].z, n.x, n.y, n.z, color));
      geo.quad(ids[0], ids[1], ids[2], ids[3]);
    }
  }

  private buildTunnel(
    geo: Geo,
    lamps: Geo,
    rows: Row[],
    P: (r: Row, d: number, h: number, out?: THREE.Vector3) => THREE.Vector3,
    s0: number,
    s1: number,
  ) {
    // 아치 단면: 벽 4.6m + 타원 아치, 꼭대기 약 7.8m
    // 반대편 굴(opp)은 중앙분리대를 벽 삼아 나란히 붙인다
    const section = (w: number, opp = false): [number, number, number][] => {
      const L = layout(w);
      const dl = opp ? L.oppShoulder - 0.6 : L.shoulderL - 0.5;
      const dr = opp ? L.oppInner + 1.15 : L.shoulderR + 0.6; // 우리 굴 벽과 겹치지 않게 0.35m 띄운다
      const cx = (dl + dr) / 2;
      const rx = (dr - dl) / 2;
      const pts: [number, number, number][] = [
        [dl, 0, 0],
        [dl, 1.2, 0],
        [dl, 4.6, 1],
      ];
      for (let i = 1; i < 10; i++) {
        const t = Math.PI - (i / 10) * Math.PI;
        pts.push([cx + Math.cos(t) * rx, 4.6 + Math.sin(t) * 3.2, 1]);
      }
      pts.push([dr, 4.6, 1], [dr, 1.2, 0], [dr, 0, 0]);
      return pts;
    };
    const tile = new THREE.Color(0xd8d5ca);
    const concrete = new THREE.Color(0x77756f);
    const v = new THREE.Vector3();
    for (const opp of [false, true]) {
      let prev: number[] | null = null;
      for (const row of rows) {
        if (row.structure !== Structure.Tunnel) {
          prev = null;
          continue;
        }
        const sec = section(row.w, opp);
        const ids = sec.map(([d, h, kind]) => {
          P(row, d, h, v);
          return geo.vertex(v.x, v.y, v.z, 0, -1, 0, kind === 0 ? tile : concrete);
        });
        if (prev) for (let i = 0; i < sec.length - 1; i++) geo.quad(prev[i], prev[i + 1], ids[i + 1], ids[i]);
        prev = ids;
      }
    }
    // 조명: 양쪽 위에 6m 간격
    for (let s = Math.ceil(s0 / 6) * 6; s < s1; s += 6) {
      const row = rows[Math.min(rows.length - 1, Math.round((s - s0) / ROW))];
      if (row.structure !== Structure.Tunnel) continue;
      const L = layout(row.w);
      for (const d of [L.shoulderL + 1.2, L.shoulderR - 1.4, L.oppInner + 0.2, L.oppShoulder + 1.4]) {
        this.box(lamps, P(row, d, 6.2), 1.4, 0.08, 0.25, row, new THREE.Color(0xffffff));
      }
    }
    // 입구 테두리: 터널이 시작·끝나는 줄에서 두꺼운 콘크리트 테
    const portal = new THREE.Color(0x9d9a90);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const prevRow = rows[i - 1];
      const nextRow = rows[i + 1];
      const isStart = row.structure === Structure.Tunnel && (!prevRow ? this.road.structureAt(row.s - ROW) !== Structure.Tunnel : prevRow.structure !== Structure.Tunnel);
      const isEnd = row.structure === Structure.Tunnel && (!nextRow ? this.road.structureAt(row.s + ROW) !== Structure.Tunnel : nextRow.structure !== Structure.Tunnel);
      if (!isStart && !isEnd) continue;
      for (const opp of [false, true]) {
        const sec = section(row.w, opp);
        const cx = (sec[0][0] + sec[sec.length - 1][0]) / 2;
        const outer = sec.map(([d, h]) => [cx + (d - cx) * 1.18, h * 1.2 + 0.2] as [number, number]);
        // 안쪽 테두리와 바깥 테두리 사이를 채운 고리
        const inner = sec.map(([d, h]) => P(row, d, h, new THREE.Vector3()));
        const out = outer.map(([d, h]) => P(row, d, h, new THREE.Vector3()));
        const n = isStart ? -1 : 1;
        for (let j = 0; j < sec.length - 1; j++) {
          const ids = [inner[j], inner[j + 1], out[j + 1], out[j]].map((p) => geo.vertex(p.x, p.y, p.z, row.te * n, 0, -row.tn * n, portal));
          geo.quad(ids[0], ids[1], ids[2], ids[3]);
        }
      }
    }
  }

  private buildTerrain(k: number, s0: number, s1: number, P: (r: Row, d: number, h: number, out?: THREE.Vector3) => THREE.Vector3): THREE.Group {
    const road = this.road;
    const g = new THREE.Group();
    const offsets = road.terrain.offsets;
    if (!road.terrain.rows.length) return g;
    const rows = this.rows(s0, s1, TERRAIN_ROW);
    // 터널 입구 바로 위에도 줄을 넣어 산이 입구에서 바로 시작하게 한다
    for (const st of road.structures) {
      if (st.kind !== Structure.Tunnel) continue;
      for (const b of [st.s0 + 0.5, st.s1 - 5.5]) {
        if (b > s0 && b < s1) rows.push(this.rows(b, b, 1)[0]);
      }
    }
    rows.sort((a, b) => a.s - b.s);
    const geo = new Geo();
    const right = offsets.map((o, i) => [o, i] as const).filter(([o]) => o > 0);
    const left = offsets.map((o, i) => [o, i] as const).filter(([o]) => o < 0).reverse();
    const grass = new THREE.Color(0x5d7440);
    const forest = new THREE.Color(0x3f5a33);
    const forestLight = new THREE.Color(0x4f6a38);
    const cut = new THREE.Color(0x8d8674);
    const cutGreen = new THREE.Color(0x6f7a4e); // 풀씨를 뿌려 덮은 깎기 비탈
    const field = new THREE.Color(0x7f8a52);
    const paddy = new THREE.Color(0x8e9448);
    const v = new THREE.Vector3();

    // 굽은 길 안쪽에서 지형 줄이 서로 겹치지 않게 d를 줄인다
    const maxInner = (row: Row) => {
      let kmax = Math.abs(row.kappa);
      for (const ds of [-150, 150, -300, 300]) kmax = Math.max(kmax, Math.abs(road.sample(row.s + ds).kappa));
      return kmax > 1e-5 ? 0.6 / kmax : 1e9;
    };

    // 도로 바로 옆 지형 꼭짓점 (터널 위를 덮을 때 쓴다)
    const edges: Record<number, number[]> = { 1: [], [-1]: [] };
    const side = (cols: (readonly [number, number])[], sign: 1 | -1) => {
      let prev: number[] | null = null;
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const L = layout(row.w);
        const bridge = row.structure === Structure.Bridge;
        const tunnelRow = row.structure === Structure.Tunnel;
        const inner = (sign > 0 ? row.kappa < 0 : row.kappa > 0) ? maxInner(row) : 1e9;
        const edgeD = sign > 0 ? L.shoulderR + 1.3 : L.oppShoulder - 1.3;
        const rel0 = road.terrainRel(row.s, cols[0][1]);
        const ids: number[] = [];
        // 도로 바로 옆 (가장자리)
        let edgeH = -0.35;
        if (bridge) edgeH = Math.min(rel0, -3);
        if (tunnelRow) edgeH = Math.max(rel0, 9);
        P(row, edgeD, edgeH, v);
        ids.push(geo.vertex(v.x, v.y, v.z, 0, 1, 0, bridge ? grass : cut, v.x / 30, v.z / 30));
        edges[sign][ri] = ids[0];
        let lastD = Math.abs(edgeD);
        let lastH = edgeH;
        for (const [off, col] of cols) {
          let d = Math.min(Math.abs(off), inner);
          d = Math.max(d, lastD + 2);
          let h = road.terrainRel(row.s, col);
          if (tunnelRow) h = Math.max(h, 9);
          const slope = Math.abs(h - lastH) / Math.max(1, d - lastD);
          const far = Math.abs(off) > 150;
          // 논·밭·숲은 약 160m 덩어리로 정해 점점이 흩어지지 않게 한다. 평평한 곳에만 논밭
          const patch = hash(Math.floor(row.s / 160) * 977 + col * 61 + sign * 7);
          let c = grass;
          if (slope > 0.45 && Math.abs(off) < 120) c = patch < 0.55 ? cutGreen : cut;
          else if (far && slope < 0.1 && patch < 0.3) c = patch < 0.14 ? paddy : field;
          else if (far) c = patch > 0.72 ? forestLight : forest;
          tmpColor.copy(c).multiplyScalar(0.9 + hash(Math.round(row.s / 20) * 131 + col) * 0.2);
          P(row, sign * d, h, v);
          ids.push(geo.vertex(v.x, v.y, v.z, 0, 1, 0, tmpColor, v.x / 30, v.z / 30));
          lastD = d;
          lastH = h;
        }
        // 안개 속으로 이어지는 바깥 테두리
        P(row, sign * Math.min(2600, Math.max(lastD + 50, inner)), lastH, v);
        ids.push(geo.vertex(v.x, v.y, v.z, 0, 1, 0, forest, v.x / 30, v.z / 30));
        if (prev) {
          for (let i = 0; i < ids.length - 1; i++) {
            if (sign > 0) geo.quad(prev[i], prev[i + 1], ids[i + 1], ids[i]);
            else geo.quad(prev[i], ids[i], ids[i + 1], prev[i + 1]);
          }
        }
        prev = ids;
      }
    };
    side(right, 1);
    side(left, -1);
    // 터널 위: 양쪽 지형을 산등성이로 이어 입구 위로 하늘이 보이지 않게 한다
    let prevCap: number[] | null = null;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      if (row.structure !== Structure.Tunnel) {
        prevCap = null;
        continue;
      }
      const L = layout(row.w);
      const dR = L.shoulderR + 1.3;
      const dL = L.oppShoulder - 1.3;
      const capH = Math.max(11, Math.min(road.terrainRel(row.s, right[0][1]), road.terrainRel(row.s, left[0][1])));
      P(row, (dR + dL) / 2, capH, v);
      const c = geo.vertex(v.x, v.y, v.z, 0, 1, 0, forest, v.x / 30, v.z / 30);
      const cur = [edges[-1][ri], c, edges[1][ri]];
      if (prevCap) for (let i = 0; i < 2; i++) geo.quad(prevCap[i], prevCap[i + 1], cur[i + 1], cur[i]);
      prevCap = cur;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(geo.pos, 3));
    bg.setAttribute("color", new THREE.Float32BufferAttribute(geo.col, 3));
    bg.setAttribute("uv", new THREE.Float32BufferAttribute(geo.uv, 2));
    bg.setIndex(geo.idx);
    bg.computeVertexNormals();
    bg.computeBoundingSphere();
    const mesh = new THREE.Mesh(bg, this.mats.terrain);
    mesh.receiveShadow = true;
    g.add(mesh);

    // 나무: 도로에서 35~450m 사이, 가까울수록 촘촘하게. 소나무와 활엽수(참나무 등)를 섞고
    // 섞는 비율은 약 600m마다 달라진다 (소나무 숲, 활엽수 숲, 섞인 숲)
    const count = TREE_CAP;
    const pines = new THREE.InstancedMesh(this.pineGeo, this.mats.tree, count);
    const broads = new THREE.InstancedMesh(this.broadGeo, this.mats.tree, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const tint = new THREE.Color();
    let np = 0;
    let nb = 0;
    for (let i = 0; i < count * 2 && np + nb < count; i++) {
      const r1 = hash(k * 7919 + i * 13);
      const r2 = hash(k * 104729 + i * 17);
      const r3 = hash(k * 1299709 + i * 19);
      const s = s0 + r1 * (s1 - s0);
      const sign = r2 < 0.5 ? 1 : -1;
      const dist = 35 + Math.pow(r3, 1.8) * 420;
      const row = this.rows(s, s, 1)[0];
      if (row.structure === Structure.Tunnel && dist < 60) continue;
      const L = layout(row.w);
      const d = sign > 0 ? L.shoulderR + dist : L.oppShoulder - dist;
      if (Math.abs(d) > ((sign > 0 ? row.kappa < 0 : row.kappa > 0) ? maxInner(row) : 1e9)) continue;
      // 지형 높이 보간
      const offs = offsets;
      let h = 0;
      const absD = Math.abs(d) * Math.sign(d);
      for (let c = 0; c < offs.length - 1; c++) {
        if (absD >= offs[c] && absD <= offs[c + 1]) {
          const t = (absD - offs[c]) / (offs[c + 1] - offs[c]);
          h = road.terrainRel(s, c) * (1 - t) + road.terrainRel(s, c + 1) * t;
          break;
        }
      }
      if (Math.abs(absD) < 45) h = road.terrainRel(s, sign > 0 ? offs.findIndex((o) => o > 0) : offs.findIndex((o) => o > 0) - 1);
      if (row.structure === Structure.Bridge && Math.abs(d) < 60) continue;
      P(row, d, h - 0.3, sc);
      // 지형에서 논·밭으로 칠한 덩어리에는 심지 않는다 (지형 색과 같은 해시)
      if (dist > 150) {
        const col = offs.reduce((best, o, c) => (Math.abs(o - absD) < Math.abs(offs[best] - absD) ? c : best), 0);
        if (hash(Math.floor(s / 160) * 977 + col * 61 + sign * 7) < 0.3) continue;
      }
      const size = 0.7 + hash(i * 31 + k) * 0.8;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(i + k * 3) * 6.28);
      m.compose(sc, q, new THREE.Vector3(size, size * (0.8 + hash(i * 7) * 0.5), size));
      const pineShare = 0.2 + 0.6 * hash(Math.floor(s / 600) * 7 + (sign > 0 ? 1 : 2));
      const pine = hash(i * 53 + k * 11) < pineShare;
      // 나무마다 조금씩 다른 초록 (활엽수는 가끔 누르스름하게)
      const shade = 0.78 + hash(i * 97 + k) * 0.38;
      const warm = pine ? 0 : Math.max(0, hash(i * 71 + k * 5) - 0.75) * 1.2;
      tint.setRGB(shade * (1 + warm * 0.9), shade * (1 + warm * 0.45), shade * (1 - warm * 0.3));
      const target = pine ? pines : broads;
      const idx = pine ? np++ : nb++;
      target.setMatrixAt(idx, m);
      target.setColorAt(idx, tint);
    }
    const sets: TreeSet[] = [];
    for (const [inst, n, near, far] of [
      [pines, np, this.pineGeo, this.pineFar],
      [broads, nb, this.broadGeo, this.broadFar],
    ] as const) {
      inst.count = n;
      inst.castShadow = true;
      inst.receiveShadow = false;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      g.add(inst);
      sets.push({ mesh: inst, n, near, far });
    }
    this.trees.set(k, sets);
    return g;
  }

  private signMat(t: THREE.Texture): THREE.Material {
    let m = this.signMats.get(t);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.28, side: THREE.FrontSide });
      this.signMats.set(t, m);
    }
    return m;
  }

  private placeSign(group: THREE.Group, sign: SignSpec, P: (r: Row, d: number, h: number, out?: THREE.Vector3) => THREE.Vector3) {
    const row = this.rows(sign.s, sign.s, 1)[0];
    const L = layout(row.w);
    const face = Math.atan2(-row.te, row.tn); // 판 앞면(+Z)이 다가오는 차 쪽(-진행방향)을 보게
    // 방음벽 구간: 큰 판은 벽 위에 달고, 기둥 표지는 벽 앞으로
    const wall = this.noiseWallBlocks.has(Math.floor(row.s / 400)) && row.structure === Structure.Normal;
    const obj = new THREE.Group();
    const tex = sign.texture();
    const board = (w: number, h: number, t: THREE.Texture, round = false) => {
      const gfront = round ? new THREE.CircleGeometry(w / 2, 32) : new THREE.PlaneGeometry(w, h);
      const front = new THREE.Mesh(gfront, this.signMat(t));
      const back = new THREE.Mesh(gfront, this.mats.signBack);
      back.rotation.y = Math.PI;
      back.position.z = -0.03;
      const b = new THREE.Group();
      b.add(front, back);
      return b;
    };
    const postMat = this.mats.post;
    const post = (x: number, h: number, r = 0.1) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 8), postMat);
      m.position.set(x, h / 2, 0);
      m.castShadow = true;
      return m;
    };

    let pos: THREE.Vector3;
    switch (sign.kind) {
      case "guide":
      case "distance": {
        pos = P(row, L.shoulderR + (wall ? 1.8 : 3.2), 0);
        const lift = wall ? 5.0 : 2.6;
        const bd = board(sign.w, sign.h, tex);
        bd.position.set(0, lift + sign.h / 2, wall ? 0.15 : 0);
        obj.add(bd, post(-sign.w * 0.3, lift + sign.h * 0.8, 0.12), post(sign.w * 0.3, lift + sign.h * 0.8, 0.12));
        break;
      }
      case "gantry":
      case "slogan": {
        // 우리 차로 위로 가로지르는 문형 구조물
        const dl = L.shoulderL - 0.3;
        const dr = L.shoulderR + 0.8;
        const mid = (dl + dr) / 2;
        pos = P(row, mid, 0);
        const span = dr - dl;
        const beamY = sign.kind === "gantry" ? 7.4 : 6.6;
        obj.add(post(-span / 2, beamY + 0.4, 0.22), post(span / 2, beamY + 0.4, 0.22));
        const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.35, 0.35), postMat);
        beam.position.set(0, beamY, -0.2);
        obj.add(beam);
        const bd = board(sign.w, sign.h, tex);
        // 안내표지는 출구 쪽(오른쪽) 차로 위에 단다
        bd.position.set(sign.kind === "gantry" ? Math.min(span / 2 - sign.w / 2 - 0.5, row.w / 4) : 0, beamY - 0.2 - sign.h / 2 + 0.9, 0);
        obj.add(bd);
        break;
      }
      case "speed": {
        pos = P(row, L.shoulderR + (wall ? 1.1 : 1.6), 0);
        const bd = board(sign.w, sign.h, tex, true);
        bd.position.set(0, 2.4 + sign.h / 2 + (sign.extra ? 0.5 : 0), 0);
        obj.add(bd, post(0, 2.4 + sign.h + (sign.extra ? 0.5 : 0), 0.06));
        if (sign.extra) {
          const ex = board(0.95, 1.18, sign.extra());
          ex.position.set(0, 1.55, 0.01);
          obj.add(ex);
        }
        break;
      }
      case "km": {
        pos = P(row, L.shoulderR + 0.85, 0);
        const bd = board(sign.w, sign.h, tex);
        bd.position.set(0, 1.1 + sign.h / 2, 0);
        obj.add(bd, post(0, 1.1 + sign.h * 0.6, 0.04));
        break;
      }
      case "tunnel": {
        pos = P(row, (L.shoulderL + L.shoulderR) / 2, 0);
        const bd = board(Math.min(sign.w, row.w + 2), sign.h, tex);
        bd.position.set(0, 9.4, 0.4);
        obj.add(bd);
        break;
      }
      case "bridge": {
        pos = P(row, L.shoulderR + 0.3, 0);
        const bd = board(sign.w, sign.h, tex);
        bd.position.set(0, 1.4, 0);
        obj.add(bd, post(-0.8, 1.2, 0.04), post(0.8, 1.2, 0.04));
        break;
      }
    }
    obj.position.copy(pos);
    obj.rotation.y = face;
    group.add(obj);
  }

  dispose() {
    for (const g of this.chunks.values()) disposeGroup(g);
    this.chunks.clear();
    this.world.scene.remove(this.group);
  }
}

export function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !(m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) m.geometry.dispose();
    if ((m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) (m as unknown as THREE.InstancedMesh).dispose();
  });
}

function paintPart(g: THREE.BufferGeometry, hex: number, jitter = 0, seed = 0): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  flat.deleteAttribute("uv");
  flat.deleteAttribute("normal");
  const pos = flat.getAttribute("position");
  const c = new THREE.Color(hex);
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // 면마다 밝기를 조금씩 달리해 잎 뭉치 느낌을 낸다
    const f = 1 + (hash(Math.floor(i / 3) * 131 + seed) - 0.5) * jitter;
    arr.set([c.r * f, c.g * f, c.b * f], i * 3);
  }
  flat.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return flat;
}

/** 크기를 흔들어 둥근 도형을 덜 매끈하게 만든다 */
function lumpy(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = Math.round(v.x * 10) * 73 + Math.round(v.y * 10) * 151 + Math.round(v.z * 10) * 283 + seed;
    v.multiplyScalar(1 + (hash(key) - 0.5) * amount);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function makePineGeometry(far = false): THREE.BufferGeometry {
  // 잣나무·낙엽송 조림지 같은 원뿔형 침엽수: 줄기 + 세 층. far: 먼 나무용 (면을 줄이고 밑면 없이)
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, 4, far ? 3 : 5, 1, far);
  trunk.translate(0, 2, 0);
  const tiers = [
    { r: 2.7, h: 4.6, y: 4.4, c: 0x2f5129 },
    { r: 2.1, h: 3.9, y: 6.6, c: 0x355a2c },
    { r: 1.3, h: 3.2, y: 8.7, c: 0x3d6532 },
  ];
  const parts = [paintPart(trunk, 0x5c4432)];
  tiers.forEach((tr, i) => {
    const cone = lumpy(new THREE.ConeGeometry(tr.r, tr.h, far ? 5 : 8, 1, far), 0.16, i * 17);
    cone.translate(0, tr.y, 0);
    parts.push(paintPart(cone, tr.c, 0.22, i));
  });
  const merged = mergeSimple(parts);
  merged.computeVertexNormals();
  return merged;
}

export function makeBroadleafGeometry(far = false): THREE.BufferGeometry {
  // 참나무 같은 활엽수: 줄기 + 둥근 잎 뭉치 네 개. far: 먼 나무용 (잎 뭉치를 거친 20면체로)
  const trunk = new THREE.CylinderGeometry(0.2, 0.34, 4.2, far ? 3 : 5, 1, far);
  trunk.translate(0, 2.1, 0);
  const blobs = [
    { x: 0, y: 6.2, z: 0, r: 2.9, c: 0x4a6b31 },
    { x: 1.5, y: 5.2, z: 0.7, r: 2.0, c: 0x44652e },
    { x: -1.3, y: 5.4, z: -0.9, r: 2.1, c: 0x4f7234 },
    { x: 0.2, y: 7.9, z: -0.4, r: 1.8, c: 0x557838 },
  ];
  const parts = [paintPart(trunk, 0x5a4a3a)];
  blobs.forEach((b, i) => {
    const s = lumpy(new THREE.IcosahedronGeometry(b.r, far ? 0 : 1), far ? 0.18 : 0.28, i * 29);
    s.scale(1, 0.85, 1);
    s.translate(b.x, b.y, b.z);
    parts.push(paintPart(s, b.c, 0.3, i + 10));
  });
  const merged = mergeSimple(parts);
  merged.computeVertexNormals();
  return merged;
}

function makeConeGeometry(): THREE.BufferGeometry {
  // 라바콘: 검은 받침 + 주황 원뿔에 흰 반사띠 두 줄
  const bands: [number, number, number][] = [
    [0.04, 0.32, 0xff5a0a],
    [0.32, 0.42, 0xf4f4f0],
    [0.42, 0.52, 0xff5a0a],
    [0.52, 0.6, 0xf4f4f0],
    [0.6, 0.74, 0xff5a0a],
  ];
  const r = (y: number) => 0.2 * (1 - y / 0.8) + 0.02;
  const parts = [paintPart(new THREE.BoxGeometry(0.42, 0.04, 0.42).translate(0, 0.02, 0), 0x1a1a1a)];
  for (const [y0, y1, c] of bands) {
    const g = new THREE.CylinderGeometry(r(y1), r(y0), y1 - y0, 10, 1, true);
    g.translate(0, (y0 + y1) / 2, 0);
    parts.push(paintPart(g, c));
  }
  const merged = mergeSimple(parts);
  merged.computeVertexNormals();
  return merged;
}

function makeTriangleGeometry(): THREE.BufferGeometry {
  // 안전삼각대: 빨간 반사 테두리(바깥 한 변 약 0.45m) + 가운데 형광 주황 + 검은 받침 다리
  const tri = (r: number, y: number) => {
    const sh = new THREE.Shape();
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / 3;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r + y;
      if (i === 0) sh.moveTo(x, z);
      else sh.lineTo(x, z);
    }
    return sh;
  };
  const outer = tri(0.26, 0.2);
  outer.holes.push(tri(0.17, 0.2) as unknown as THREE.Path);
  const parts = [
    paintPart(new THREE.ShapeGeometry(outer), 0xe01818),
    paintPart(new THREE.ShapeGeometry(tri(0.17, 0.2)).translate(0, 0, -0.005), 0xff8a2a),
    paintPart(new THREE.BoxGeometry(0.5, 0.03, 0.2).translate(0, 0.015, -0.05), 0x151515),
  ];
  const merged = mergeSimple(parts);
  merged.computeVertexNormals();
  return merged;
}

function makePersonGeometry(): THREE.BufferGeometry {
  // 사람 (키 약 1.72m): 다리, 몸통, 팔, 머리
  const parts = [
    paintPart(new THREE.BoxGeometry(0.14, 0.82, 0.16).translate(-0.1, 0.41, 0), 0x2b3446),
    paintPart(new THREE.BoxGeometry(0.14, 0.82, 0.16).translate(0.1, 0.41, 0), 0x2b3446),
    paintPart(new THREE.BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.12, 0), 0xd8d4c8),
    paintPart(new THREE.BoxGeometry(0.1, 0.58, 0.12).translate(-0.27, 1.1, 0.02), 0xd8d4c8),
    paintPart(new THREE.BoxGeometry(0.1, 0.58, 0.12).translate(0.27, 1.1, 0.02), 0xd8d4c8),
    paintPart(new THREE.SphereGeometry(0.12, 10, 8).translate(0, 1.6, 0), 0xc99a78),
    paintPart(new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.62, -0.01), 0x1b1b1b),
  ];
  const merged = mergeSimple(parts);
  merged.computeVertexNormals();
  return merged;
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.getAttribute("position").count;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    col.set(p.getAttribute("color").array as Float32Array, o * 3);
    o += p.getAttribute("position").count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
