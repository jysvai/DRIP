// 시내 풍경: 도로망(CityNet)을 200m 칸으로 나눠 플레이어 둘레 칸만 3D로 만든다.
// 칸 하나에: 땅, 차도(한 방향 차도마다 띠), 차선·정지선·횡단보도, 보도·연석·분리대, 교차로 바닥·모서리 보도,
// 건물(길을 따라 늘어선 상자, 고층 지역일수록 높게), 가로수·가로등, 신호등(가로형 4색, 신호 계획에 따라 켜진다).
// 칸 안 좌표: x = 동쪽 - 칸 기준점, y = 높이, z = -(북쪽 - 칸 기준점). 경로(플레이어가 달리는 한 줄 도로)와 상관없이 그린다.
// 국도 지역(지형 격자가 있는 곳): 땅이 지형을 따라 산·골짜기가 되고, 도로 옆은 둑·깎기로 이어진다. 비탈은 숲(나무), 평평한 골짜기는 논밭·비닐하우스,
// 강·호수는 물. 시가지(OSM 주거·상업·공업 땅)와 이름 있는 곳이 모인 읍내만 건물·보도가 있고 밖은 포장 갓길. 가까운 칸 너머는 먼 산 한 장(100m 격자)으로 그린다.

import * as THREE from "three";
import type { World } from "./world";
import { asphaltTexture, disposeGroup, grayTexture, makeBroadleafGeometry, makePineGeometry, tiledNoise, xorshift } from "./roadChunks";
import type { CityEdge, Dem } from "../city/graph";
import type { CityNet, Link, LinkGeom } from "../city/net";
import { CENTER_GAP, CITY_LANE, CROSSWALK, STOP_GAP } from "../city/net";
import type { Signals } from "../city/signals";
import { convexHull, pointAt, type PolyPoint } from "../city/geom";

const TILE = 200;
const GROUND_CELL = 20;
/** 칸을 만드는 거리 (안개 끝과 이것 중 가까운 것) */
const MAX_RADIUS = 900;
/** 신호등을 켜고 끄는 거리 */
const LAMP_RADIUS = 450;
/** 국도: 먼 산 (가까운 칸이 없는 곳까지, 100m 격자). 가까운 칸 안쪽은 비운다 */
const FAR_RADIUS = 2800;
const FAR_CELL = 100;
const FAR_HOLE = 780;
/** 국도: 보도 없는 곳의 포장 갓길 폭 (m) */
const SHOULDER = 1.2;

/** 국도 땅 색 */
const LAND = {
  forest: new THREE.Color(0.19, 0.29, 0.15),
  forestLight: new THREE.Color(0.27, 0.36, 0.19),
  paddy: new THREE.Color(0.4, 0.5, 0.25),
  field: new THREE.Color(0.52, 0.5, 0.33),
  fallow: new THREE.Color(0.47, 0.41, 0.31),
  verge: new THREE.Color(0.4, 0.47, 0.27),
  town: new THREE.Color(0.6, 0.58, 0.55),
  water: new THREE.Color(0.33, 0.45, 0.5),
};
const enum Land {
  Water,
  Town,
  Forest,
  Field,
}

/** 등급별 보도 폭 (m) */
function sidewalkWidth(cls: string): number {
  if (cls.endsWith("l")) return 1.2;
  return { p: 4.5, s: 3.5, r: 2.5, t: 2, m: 0 }[cls[0]] ?? 2.5;
}

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** 값 노이즈: cell m 격자 점마다 난수를 부드럽게 이은 0~1 */
function vnoise(x: number, y: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const h = (a: number, b: number) => hash((a * 73856093) ^ (b * 19349663) ^ seed);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * sx;
  const b = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
}

/** 꼭짓점 모음 → 메시 */
class G {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, u = 0, w = 0): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, w);
    return this.pos.length / 3 - 1;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
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

/** 보도블록: 30cm 네모 블록 줄눈 */
function paverTexture(): THREE.CanvasTexture {
  const size = 256;
  const rand = xorshift(11);
  const blotch = tiledNoise(size, 6, rand);
  return grayTexture(size, (i) => {
    const x = i % size;
    const y = Math.floor(i / size);
    const joint = x % 32 < 2 || (y + (Math.floor(x / 32) % 2) * 16) % 32 < 2;
    return (joint ? 120 : 196) + (blotch[i] - 0.5) * 30 + (rand() - 0.5) * 18;
  });
}

/** 국도 차도 가운데에서 갓길 바깥(+1.3m)까지 */
function roadHalf(e: CityEdge): number {
  return (e.oneway ? (e.lanes * CITY_LANE) / 2 : e.lanes * CITY_LANE + CENTER_GAP / 2) + SHOULDER + 1.3;
}

/** 건물 벽: 창 8열 × 8층. glass면 유리벽(가는 창틀), 아니면 콘크리트 벽에 창. lit이면 밤에 불 켜진 창만 */
function facadeTexture(glass: boolean, lit: boolean): THREE.CanvasTexture {
  const W = 512;
  const c = document.createElement("canvas");
  c.width = c.height = W;
  const g = c.getContext("2d")!;
  const rand = xorshift(glass ? 21 : 23);
  g.fillStyle = lit ? "#000" : glass ? "#8a97a3" : "#d8d4cc";
  g.fillRect(0, 0, W, W);
  const cw = W / 8;
  const ch = W / 8;
  for (let fy = 0; fy < 8; fy++) {
    for (let fx = 0; fx < 8; fx++) {
      const x0 = fx * cw;
      const y0 = fy * ch;
      const [wx, wy, ww, wh] = glass ? [x0 + 2, y0 + 3, cw - 4, ch - 10] : [x0 + cw * 0.18, y0 + ch * 0.22, cw * 0.64, ch * 0.52];
      if (lit) {
        const on = rand() < 0.42;
        g.fillStyle = on ? (rand() < 0.7 ? "#ffd896" : "#e8f0ff") : "#000";
        g.fillRect(wx, wy, ww, wh);
        continue;
      }
      // 유리: 위가 조금 밝게 (하늘이 비친다)
      const grad = g.createLinearGradient(0, wy, 0, wy + wh);
      const base = glass ? 70 + rand() * 25 : 55 + rand() * 25;
      grad.addColorStop(0, `rgb(${base + 40},${base + 52},${base + 64})`);
      grad.addColorStop(1, `rgb(${base},${base + 8},${base + 18})`);
      g.fillStyle = grad;
      g.fillRect(wx, wy, ww, wh);
      if (!glass && rand() < 0.3) {
        // 블라인드
        g.fillStyle = "rgba(230,225,210,0.55)";
        g.fillRect(wx, wy, ww, wh * (0.3 + rand() * 0.5));
      }
    }
    if (glass) {
      // 층 사이 띠
      g.fillStyle = lit ? "#000" : "#5d6770";
      g.fillRect(0, fy * ch + ch - 7, W, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface Building {
  x: number;
  y: number;
  /** 길 방향 단위벡터 */
  ux: number;
  uy: number;
  /** 길 따라 반 폭, 안쪽 반 깊이 */
  a: number;
  b: number;
  base: number;
  h: number;
  glass: boolean;
  tint: number;
  /** 아래층 넓은 몸통 위에 좁은 탑 */
  tower: boolean;
}

interface LampRef {
  jid: number;
  approach: number;
  kind: 0 | 1 | 2 | 3;
  index: number;
  mesh: THREE.InstancedMesh;
  /** 지금 칠한 상태 (-1 아직) */
  on: number;
}

interface Tile {
  group: THREE.Group;
  x0: number;
  y0: number;
  lamps: LampRef[];
  lampMeshes: THREE.InstancedMesh[];
}

const WHITE = new THREE.Color(0.93, 0.93, 0.9);
const YELLOW = new THREE.Color(0.96, 0.72, 0.12);
const LAMP_ON = [new THREE.Color(1, 0.12, 0.06).multiplyScalar(4), new THREE.Color(1, 0.62, 0.05).multiplyScalar(4), new THREE.Color(0.1, 1, 0.55).multiplyScalar(4), new THREE.Color(0.1, 1, 0.55).multiplyScalar(4)];
const LAMP_OFF = [new THREE.Color(0.16, 0.03, 0.02), new THREE.Color(0.14, 0.1, 0.02), new THREE.Color(0.02, 0.1, 0.06), new THREE.Color(0.02, 0.1, 0.06)];

export class CityScene {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private mats: Record<string, THREE.Material>;
  private treeGeo = makeBroadleafGeometry();
  private pineGeo = makePineGeometry();
  /** 국도 지역이면 지형 격자 */
  private readonly dem: Dem | null;
  private readonly rural: boolean;
  private townCache = new Map<number, boolean>();
  private cityCache = new Map<number, boolean>();
  private zq: PolyPoint = { x: 0, y: 0, tx: 1, ty: 0 };
  private far: { mesh: THREE.Mesh; x0: number; y0: number } | null = null;
  private lampGeo = new THREE.CircleGeometry(0.14, 14);
  private arrowGeo = arrowGeometry();
  /** 건물은 링크마다 한 번 만들어 두고, 겹치지 않게 차지한 칸(4m)을 적어 둔다 */
  private buildings = new Map<number, Building[]>();
  private occupied = new Set<number>();
  /** 고층 지역: 250m 칸마다 이름 있는 건물·역 수 */
  private density = new Map<number, number>();
  private nodeGrid = new Map<number, number[]>();
  private readonly ox: number;
  private readonly oy: number;
  private night = -1;
  /** 칸을 만들 때 버스전용차로 등 (고속도로 조각과 같은 이름으로 둔다) */
  overrides: unknown[] = [];

  constructor(
    private net: CityNet,
    private signals: Signals,
    private world: World,
    /** 신호 시각 (s) */
    private clock: () => number,
  ) {
    world.scene.add(this.group);
    const [ox, oy] = net.graph.origin;
    this.ox = ox;
    this.oy = oy;
    this.dem = net.graph.dem;
    this.rural = net.graph.kind === "rural" && !!this.dem;
    const asphalt = asphaltTexture();
    const paver = paverTexture();
    const noise = grayTexture(128, (() => {
      const r = xorshift(5);
      const b = tiledNoise(128, 5, r);
      return (i: number) => 150 + (b[i] - 0.5) * 60 + (r() - 0.5) * 40;
    })());
    this.mats = {
      road: new THREE.MeshStandardMaterial({ vertexColors: true, map: asphalt, roughness: 0.93, metalness: 0 }),
      marks: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      walk: new THREE.MeshStandardMaterial({ vertexColors: true, map: paver, roughness: 0.9 }),
      concrete: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
      ground: new THREE.MeshStandardMaterial({ vertexColors: true, map: noise, roughness: 1 }),
      // 유리 외벽: 비출 하늘이 없어서 금속성을 낮게 둔다 (높으면 낮에도 까맣다)
      office: new THREE.MeshStandardMaterial({ vertexColors: true, map: facadeTexture(true, false), emissiveMap: facadeTexture(true, true), emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.45, metalness: 0.05 }),
      plain: new THREE.MeshStandardMaterial({ vertexColors: true, map: facadeTexture(false, false), emissiveMap: facadeTexture(false, true), emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.85 }),
      roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 }),
      lightHead: new THREE.MeshBasicMaterial({ color: 0x9a9a92 }),
      tree: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
      lamp: new THREE.MeshBasicMaterial({ toneMapped: false }),
      water: new THREE.MeshStandardMaterial({ color: 0x5d7a86, roughness: 0.16, metalness: 0.15 }),
    };
    // 찾기 칸: 교차점 (땅 높이), 고층 지역
    net.graph.nodes.forEach((n, i) => {
      // 다리 위 점은 땅 높이로 쓰지 않는다
      if (n.edges.every((e) => net.graph.edges[e].bridge)) return;
      const k = this.cell(n.x, n.y, 100);
      let list = this.nodeGrid.get(k);
      if (!list) this.nodeGrid.set(k, (list = []));
      list.push(i);
    });
    for (const p of net.graph.places) {
      if (p.kind !== "건물" && p.kind !== "역") continue;
      const k = this.cell(p.x, p.y, 250);
      this.density.set(k, (this.density.get(k) ?? 0) + (p.kind === "역" ? 2 : 1));
    }
  }

  private cell(x: number, y: number, size: number): number {
    return (Math.floor(x / size) + 20000) * 100000 + (Math.floor(y / size) + 20000);
  }

  // ---------------- 고속도로 조각과 같은 이름의 설정 ----------------

  setWorkZones(_zones: unknown[]) {}
  setIncidents(_list: unknown[], _night: boolean) {}
  setIce(_patches: unknown[], _sky: THREE.Texture | null) {}
  setEnforcement(_e: unknown) {}

  setWet(k: number, sky: THREE.Texture | null) {
    const road = this.mats.road as THREE.MeshStandardMaterial;
    const marks = this.mats.marks as THREE.MeshStandardMaterial;
    const walk = this.mats.walk as THREE.MeshStandardMaterial;
    road.color.setScalar(1 - 0.4 * k);
    road.roughness = 0.93 - 0.6 * k;
    road.envMap = k > 0 ? sky : null;
    road.envMapIntensity = 0.7 * k;
    marks.color.setScalar(1 - 0.15 * k);
    marks.roughness = 0.7 - 0.35 * k;
    marks.envMap = road.envMap;
    marks.envMapIntensity = 0.5 * k;
    walk.color.setScalar(1 - 0.3 * k);
    walk.roughness = 0.9 - 0.4 * k;
    road.needsUpdate = marks.needsUpdate = walk.needsUpdate = true;
  }

  setSnow(k: number) {
    for (const m of [this.mats.ground, this.mats.tree, this.mats.roof, this.mats.walk, this.mats.concrete] as THREE.MeshStandardMaterial[]) {
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

  // ---------------- 칸 관리 ----------------

  /** 플레이어 둘레 칸을 만들고 먼 칸은 지운다. s는 쓰지 않는다 (월드 원점이 플레이어 자리) */
  update(_s: number, maxBuild = 2) {
    const px = this.world.origin.e - this.ox;
    const py = this.world.origin.n - this.oy;
    const R = Math.min(MAX_RADIUS, this.world.visibleDistance + 100);
    const ix0 = Math.floor((px - R) / TILE);
    const ix1 = Math.floor((px + R) / TILE);
    const iy0 = Math.floor((py - R) / TILE);
    const iy1 = Math.floor((py + R) / TILE);
    const dist = (ix: number, iy: number) => Math.hypot((ix + 0.5) * TILE - px, (iy + 0.5) * TILE - py);
    for (const [key, t] of this.tiles) {
      const ix = Math.round(t.x0 / TILE);
      const iy = Math.round(t.y0 / TILE);
      if (dist(ix, iy) > R + TILE * 1.2) {
        this.group.remove(t.group);
        disposeGroup(t.group);
        this.tiles.delete(key);
      }
    }
    const want: [number, number, number][] = [];
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const d = dist(ix, iy);
        if (d > R + TILE * 0.7 || this.tiles.has(`${ix},${iy}`)) continue;
        want.push([d, ix, iy]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, ix, iy] of want.slice(0, maxBuild)) {
      const t = this.build(ix, iy);
      t.group.traverse((o) => {
        if (o === t.group) return;
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      });
      this.tiles.set(`${ix},${iy}`, t);
      this.group.add(t.group);
    }
    const o = this.world.origin;
    for (const t of this.tiles.values()) t.group.position.set(t.x0 + this.ox - o.e, 0, -(t.y0 + this.oy - o.n));
    if (this.rural) {
      this.updateFar(px, py);
      if (this.far) this.far.mesh.position.set(this.far.x0 + this.ox - o.e, 0, -(this.far.y0 + this.oy - o.n));
    }
    this.updateLamps(px, py);
    // 밤: 창에 불, 가로등 머리
    const n = Math.round(this.world.night * 20) / 20;
    if (n !== this.night) {
      this.night = n;
      (this.mats.office as THREE.MeshStandardMaterial).emissiveIntensity = 1.4 * n;
      (this.mats.plain as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 * n;
      (this.mats.lightHead as THREE.MeshBasicMaterial).color.setRGB(0.6 + 2.4 * n, 0.6 + 2.1 * n, 0.55 + 1.5 * n);
    }
  }

  prime(s: number) {
    this.update(s, 999);
  }

  get pending(): number {
    return this.tiles.size;
  }

  /** 신호등 불: 가까운 칸만, 바뀐 것만 */
  private updateLamps(px: number, py: number) {
    const t = this.clock();
    const cache = new Map<number, string>();
    for (const tile of this.tiles.values()) {
      if (Math.hypot(tile.x0 + TILE / 2 - px, tile.y0 + TILE / 2 - py) > LAMP_RADIUS + TILE) continue;
      const dirty = new Set<THREE.InstancedMesh>();
      for (const L of tile.lamps) {
        const key = L.jid * 64 + L.approach;
        let state = cache.get(key);
        if (state === undefined) {
          const s = this.signals.lamps(L.jid, L.approach, t);
          state = `${+s.red}${+s.yellow}${+s.left}${+s.green}`;
          cache.set(key, state);
        }
        const on = state[L.kind] === "1" ? 1 : 0;
        if (L.on === on) continue;
        L.on = on;
        L.mesh.setColorAt(L.index, on ? LAMP_ON[L.kind] : LAMP_OFF[L.kind]);
        dirty.add(L.mesh);
      }
      for (const m of dirty) m.instanceColor!.needsUpdate = true;
    }
  }

  // ---------------- 칸 만들기 ----------------

  private build(ix: number, iy: number): Tile {
    const x0 = ix * TILE;
    const y0 = iy * TILE;
    const net = this.net;
    const group = new THREE.Group();
    const b = {
      road: new G(),
      marks: new G(),
      walk: new G(),
      concrete: new G(),
      ground: new G(),
      office: new G(),
      plain: new G(),
      roof: new G(),
      metal: new G(),
      head: new G(),
      water: new G(),
    };
    const inTile = (x: number, y: number) => x >= x0 && x < x0 + TILE && y >= y0 && y < y0 + TILE;
    // 이 칸에 걸친 링크
    const links = new Set<number>();
    for (const e of net.graph.edgesIn(x0 - 5, y0 - 5, x0 + TILE + 5, y0 + TILE + 5)) {
      for (const k of [0, 1]) {
        const l = net.dirLink[e * 2 + k];
        if (l >= 0) links.add(l);
      }
    }
    const trees: THREE.Matrix4[] = [];
    for (const id of links) this.drawLink(net.links[id], x0, y0, inTile, b, trees);
    // 교차로 (가운데가 이 칸에 있는 것)
    const lamps: { jid: number; approach: number; kind: 0 | 1 | 2 | 3; m: THREE.Matrix4 }[] = [];
    for (const j of net.junctions) {
      if (j.minor || !inTile(j.x, j.y)) continue;
      this.drawJunction(j.id, x0, y0, b, lamps);
    }
    // 건물: 이 칸 둘레 링크들이 세운 것 중 가운데가 이 칸 안인 것
    const near = new Set<number>();
    for (const e of net.graph.edgesIn(x0 - 80, y0 - 80, x0 + TILE + 80, y0 + TILE + 80)) {
      for (const k of [0, 1]) {
        const l = net.dirLink[e * 2 + k];
        if (l >= 0) near.add(l);
      }
    }
    for (const id of [...near].sort((a, c) => a - c)) {
      for (const bd of this.buildingsOf(id)) if (inTile(bd.x, bd.y)) this.drawBuilding(bd, x0, y0, b);
    }
    const pines: THREE.Matrix4[] = [];
    if (this.rural) {
      this.drawRuralGround(x0, y0, b, trees, pines);
      this.greenhouses(x0, y0, inTile, b.concrete);
    } else this.drawGround(x0, y0, b.ground);

    const add = (g: G, mat: THREE.Material, cast: boolean, receive = true) => {
      if (g.empty) return;
      const m = g.mesh(mat);
      m.castShadow = cast;
      m.receiveShadow = receive;
      group.add(m);
    };
    add(b.ground, this.mats.ground, false);
    add(b.road, this.mats.road, false);
    add(b.marks, this.mats.marks, false);
    add(b.walk, this.mats.walk, false);
    add(b.concrete, this.mats.concrete, true);
    add(b.office, this.mats.office, true);
    add(b.plain, this.mats.plain, true);
    add(b.roof, this.mats.roof, false);
    add(b.metal, this.mats.metal, true);
    add(b.head, this.mats.lightHead, false, false);
    add(b.water, this.mats.water, false);
    for (const [list, geo] of [
      [trees, this.treeGeo],
      [pines, this.pineGeo],
    ] as const) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, this.mats.tree, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.castShadow = true;
      inst.receiveShadow = true;
      group.add(inst);
    }
    // 신호등 불 (둥근 등 셋, 화살표 등 하나)
    const tile: Tile = { group, x0, y0, lamps: [], lampMeshes: [] };
    const circles = lamps.filter((l) => l.kind !== 2);
    const arrows = lamps.filter((l) => l.kind === 2);
    for (const [list, geo] of [
      [circles, this.lampGeo],
      [arrows, this.arrowGeo],
    ] as const) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, this.mats.lamp, list.length);
      list.forEach((l, i) => {
        inst.setMatrixAt(i, l.m);
        inst.setColorAt(i, LAMP_OFF[l.kind]);
        tile.lamps.push({ jid: l.jid, approach: l.approach, kind: l.kind, index: i, mesh: inst, on: -1 });
      });
      inst.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      inst.frustumCulled = false;
      group.add(inst);
      tile.lampMeshes.push(inst);
    }
    return tile;
  }

  /** 링크 모양 위 s(모양 거리)의 점과 높이 */
  private at(geo: LinkGeom, s: number, out: PolyPoint & { z?: number }): PolyPoint & { z: number } {
    pointAt(geo.pts, geo.cum, s, out);
    const f = Math.max(0, Math.min(geo.z.length - 1, (s / Math.max(1e-6, geo.length)) * (geo.z.length - 1)));
    const i = Math.floor(f);
    out.z = geo.z[i] + (geo.z[Math.min(i + 1, geo.z.length - 1)] - geo.z[i]) * (f - i);
    return out as PolyPoint & { z: number };
  }

  /** 링크 하나: 이 칸이 맡은 토막(가운데가 칸 안)만 그린다 */
  private drawLink(l: Link, x0: number, y0: number, inTile: (x: number, y: number) => boolean, b: Record<string, G>, trees: THREE.Matrix4[]) {
    const net = this.net;
    const geo = net.geom(l.id);
    const n = geo.pts.length / 2;
    if (n < 2) return;
    const sc = geo.scale;
    const jTo = l.to >= 0 ? net.junctions[l.to] : null;
    const jFrom = l.from >= 0 ? net.junctions[l.from] : null;
    const realTo = !!jTo && !jTo.minor;
    const realFrom = !!jFrom && !jFrom.minor;
    const sigTo = realTo && jTo!.signal;
    const sigFrom = realFrom && jFrom!.signal;
    // 차선을 긋는 범위 (교차로 안은 빼고), 정지선, 횡단보도, 보도가 끝나는 곳
    const sStop = (l.length - l.stopDist) * sc;
    const sStart = l.startDist * sc;
    const mA = realFrom ? sStart : 0;
    const mB = realTo ? sStop : geo.length;
    const wA = sigFrom ? sStart - STOP_GAP * sc : realFrom ? sStart : 0;
    const wB = sigTo ? sStop + STOP_GAP * sc : realTo ? sStop : geo.length;
    // 점마다: 폭(차로 수 변화는 ±15m로 부드럽게), 왼쪽으로 더 까는 폭, 분리대 반 폭, 보도 폭
    const lanesAt = (s: number) => net.spanAt(l.id, s / sc).lanes;
    const width = new Float64Array(n);
    const leftX = new Float64Array(n);
    const median = new Float64Array(n);
    const sw = new Float64Array(n);
    const kind = new Uint8Array(n); // 0 왕복 한 줄, 1 짝 있음, 2 일방
    for (let k = 0; k < n; k++) {
      const s = geo.cum[k];
      let sum = 0;
      let cnt = 0;
      for (let d = -15; d <= 15; d += 5) {
        sum += lanesAt(Math.max(0, Math.min(geo.length, s + d)));
        cnt++;
      }
      width[k] = (sum / cnt) * CITY_LANE;
      const sp = net.spanAt(l.id, s / sc);
      if (sp.twoWay) {
        kind[k] = 0;
        leftX[k] = CENTER_GAP / 2 + 0.02;
      } else if (sp.sep > 0) {
        kind[k] = 1;
        median[k] = Math.max(0, (sp.sep - sp.lanes * CITY_LANE) / 2);
        leftX[k] = Math.min(median[k], 0.6);
      } else {
        kind[k] = 2;
        leftX[k] = 0.3;
      }
      sw[k] = this.rural && !this.town(geo.pts[2 * k], geo.pts[2 * k + 1]) ? 0 : sidewalkWidth(sp.cls);
    }
    const P = geo.pts;
    const q: PolyPoint & { z?: number } = { x: 0, y: 0, tx: 1, ty: 0 };
    // 이 칸이 맡은 토막들 (연속한 토막끼리 묶음)
    const runs: [number, number][] = [];
    for (let k = 0; k + 1 < n; k++) {
      const mx = (P[2 * k] + P[2 * k + 2]) / 2;
      const my = (P[2 * k + 1] + P[2 * k + 3]) / 2;
      if (!inTile(mx, my)) continue;
      const last = runs[runs.length - 1];
      if (last && last[1] === k) last[1] = k + 1;
      else runs.push([k, k + 1]);
    }
    if (!runs.length) return;
    // 점 k의 방향 (앞뒤 점)
    const dir = (k: number): [number, number] => {
      const a = Math.max(0, k - 1);
      const c = Math.min(n - 1, k + 1);
      const dx = P[2 * c] - P[2 * a];
      const dy = P[2 * c + 1] - P[2 * a + 1];
      const L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };
    const ox = this.ox;
    const oy = this.oy;
    const uvOf = (X: number, Y: number): [number, number] => [(((X + ox) % 1000) + 1000) / 4, (((Y + oy) % 1000) + 1000) / 4];
    const road = b.road;
    const asphalt = new THREE.Color(0.6, 0.6, 0.6);
    /** 띠: 점 k0~k1, 가로 dL~dR(k), 높이 h */
    const strip = (g: G, k0: number, k1: number, dL: (k: number) => number, dR: (k: number) => number, h: number, color: THREE.Color, planar: boolean, sLo = -Infinity, sHi = Infinity) => {
      let prev: [number, number] | null = null;
      for (let k = k0; k <= k1; k++) {
        let s = geo.cum[k];
        // 범위 끝은 잘라 맞춘다
        if (s < sLo) {
          if (k + 1 <= k1 && geo.cum[k + 1] > sLo) s = sLo;
          else continue;
        }
        if (s > sHi) {
          if (prev && geo.cum[k - 1] < sHi) s = sHi;
          else break;
        }
        this.at(geo, s, q);
        const [tx, ty] = s === geo.cum[k] ? dir(k) : [q.tx, q.ty];
        const rx = ty;
        const ry = -tx;
        const zl = q.z! + h;
        const lx = q.x + rx * dL(k);
        const ly = q.y + ry * dL(k);
        const Rx = q.x + rx * dR(k);
        const Ry = q.y + ry * dR(k);
        const [ul, vl] = planar ? uvOf(lx, ly) : [0, s / 4];
        const [ur, vr] = planar ? uvOf(Rx, Ry) : [1, s / 4];
        const a = g.v(lx - x0, zl, -(ly - y0), 0, 1, 0, color, ul, vl);
        const c = g.v(Rx - x0, zl, -(Ry - y0), 0, 1, 0, color, ur, vr);
        if (prev) g.quad(prev[0], prev[1], c, a);
        prev = [a, c];
        if (s === sHi) break;
      }
    };
    /** 세운 면: 가로 d에서 높이 h0~h1 (normalSign: 오른쪽을 보면 +1) */
    const wall = (g: G, k0: number, k1: number, d: (k: number) => number, h0: number, h1: number, side: 1 | -1, color: THREE.Color, sLo = -Infinity, sHi = Infinity) => {
      let prev: [number, number] | null = null;
      for (let k = k0; k <= k1; k++) {
        let s = geo.cum[k];
        if (s < sLo) {
          if (k + 1 <= k1 && geo.cum[k + 1] > sLo) s = sLo;
          else continue;
        }
        if (s > sHi) {
          if (prev && geo.cum[k - 1] < sHi) s = sHi;
          else break;
        }
        this.at(geo, s, q);
        const [tx, ty] = s === geo.cum[k] ? dir(k) : [q.tx, q.ty];
        const rx = ty * side;
        const ry = -tx * side;
        const X = q.x + ty * d(k);
        const Y = q.y - tx * d(k);
        const bot = g.v(X - x0, q.z! + h0, -(Y - y0), rx, 0, -ry, color, s / 2, 0);
        const top = g.v(X - x0, q.z! + h1, -(Y - y0), rx, 0, -ry, color, s / 2, 1);
        if (prev) {
          if (side > 0) g.quad(prev[0], bot, top, prev[1]);
          else g.quad(bot, prev[0], prev[1], top);
        }
        prev = [bot, top];
        if (s === sHi) break;
      }
    };

    const curbD = (k: number) => width[k] / 2 + 0.25;
    for (const [k0, k1] of runs) {
      // 차도 (오른쪽은 연석 밑까지, 왼쪽은 중앙선·분리대 틈까지)
      strip(road, k0, k1, (k) => -width[k] / 2 - leftX[k], (k) => curbD(k) + 0.1, 0.02, asphalt, true);
      // 보도·연석 (오른쪽)
      const walkC = new THREE.Color(0.8, 0.77, 0.73);
      const curbC = new THREE.Color(0.72, 0.72, 0.7);
      if (!this.rural) {
        strip(b.walk, k0, k1, curbD, (k) => curbD(k) + sw[k], 0.15, walkC, true, wA, wB);
        wall(b.concrete, k0, k1, curbD, 0.0, 0.15, -1, curbC, wA, wB);
        wall(b.concrete, k0, k1, (k) => curbD(k) + sw[k], -2.5, 0.15, 1, curbC, wA, wB);
      } else {
        // 국도: 읍내는 보도, 밖은 연석 없는 포장 갓길
        const shoulderC = new THREE.Color(0.5, 0.5, 0.49);
        const skirtC = new THREE.Color(0.58, 0.58, 0.56);
        for (let k = k0; k < k1; k++) {
          if (sw[k] > 0) {
            strip(b.walk, k, k + 1, curbD, (kk) => curbD(kk) + sw[kk], 0.15, walkC, true, wA, wB);
            wall(b.concrete, k, k + 1, curbD, 0.0, 0.15, -1, curbC, wA, wB);
            wall(b.concrete, k, k + 1, (kk) => curbD(kk) + sw[kk], -2.5, 0.15, 1, curbC, wA, wB);
          } else {
            strip(road, k, k + 1, curbD, (kk) => curbD(kk) + SHOULDER, 0.02, shoulderC, true);
            // 땅이 차도보다 낮은 곳(둑·높이가 다른 상·하행 사이)은 옹벽으로 보인다. 땅이 높으면 묻힌다
            wall(b.concrete, k, k + 1, (kk) => curbD(kk) + SHOULDER, -4, 0.02, 1, skirtC);
          }
          if (kind[k] !== 0) wall(b.concrete, k, k + 1, (kk) => -width[kk] / 2 - leftX[kk], -4, 0.02, -1, skirtC);
        }
      }
      // 분리대 (짝 있는 넓은 곳): 연석으로 쌓고 넓으면 풀
      for (let k = k0; k < k1; k++) {
        if (kind[k] !== 1 || median[k] < 0.45) continue;
        const green = median[k] > 1.6;
        const mc = green ? new THREE.Color(0.33, 0.42, 0.27) : new THREE.Color(0.66, 0.66, 0.64);
        strip(b.concrete, k, k + 1, (kk) => -width[kk] / 2 - median[kk] - 0.02, (kk) => -width[kk] / 2 - 0.12, 0.18, mc, false, mA, mB);
        wall(b.concrete, k, k + 1, (kk) => -width[kk] / 2 - 0.12, 0, 0.18, 1, curbC, mA, mB);
      }
      // 가로수·가로등 (큰길 보도)
      for (let k = k0; k < k1; k++) {
        const s = geo.cum[k];
        if (s < wA + 10 || s > wB - 10) continue;
        const big = sw[k] >= 3.4;
        const every = 9;
        if (big && Math.floor(s / every) !== Math.floor(geo.cum[k + 1] / every)) {
          const idx = Math.floor(geo.cum[k + 1] / every);
          const r = hash(l.id * 7919 + idx);
          if (r > 0.12) {
            this.at(geo, idx * every, q);
            const d = curbD(k) + 1.1;
            const X = q.x + q.ty * d;
            const Y = q.y - q.tx * d;
            const sc2 = 0.62 + 0.25 * r;
            trees.push(new THREE.Matrix4().compose(new THREE.Vector3(X - x0, q.z! + 0.15, -(Y - y0)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.28), new THREE.Vector3(sc2, sc2 * 1.1, sc2)));
          }
        }
        const lamp = 31;
        const phase = hash(l.id) * lamp;
        if (Math.floor((s + phase) / lamp) !== Math.floor((geo.cum[k + 1] + phase) / lamp) && l.cls[0] !== "t" && sw[k] > 0) {
          this.at(geo, geo.cum[k + 1], q);
          this.streetLight(q, curbD(k) + 0.5, x0, y0, b.metal, b.head);
        }
      }
      // 차선
      const [ma, mb] = [mA, mB];
      if (mb <= ma) continue;
      const lo = Math.max(ma, geo.cum[k0]);
      const hi = Math.min(mb, geo.cum[k1]);
      if (hi <= lo) continue;
      const lanesHere = (s: number) => lanesAt(s);
      // 오른쪽 끝 흰 실선
      this.line(geo, lo, hi, (s) => this.widthAt(width, geo, s) / 2 - 0.3, 0.15, WHITE, x0, y0, b.marks);
      // 왼쪽 끝: 왕복 한 줄은 노란 실선(겹선의 한 줄), 짝 있으면 노란 실선, 일방은 흰 실선
      const kk = Math.min(n - 1, Math.max(0, Math.round((lo / geo.length) * (n - 1))));
      const leftColor = kind[kk] === 2 ? WHITE : YELLOW;
      const leftD = kind[kk] === 0 ? (s: number) => -this.widthAt(width, geo, s) / 2 - 0.1 : (s: number) => -this.widthAt(width, geo, s) / 2 + 0.15;
      this.line(geo, lo, hi, leftD, 0.15, leftColor, x0, y0, b.marks);
      // 차로 사이: 3m 긋고 5m 띄운 점선, 정지선 앞 30m는 실선 (진로변경 제한선)
      const solidFrom = sigTo ? sStop - 30 : Infinity;
      const phase = hash(l.id * 3) * 8;
      for (let i = 1; i < 6; i++) {
        const dAt = (s: number) => -this.widthAt(width, geo, s) / 2 + i * CITY_LANE;
        const has = (s: number) => lanesHere(s) > i;
        // 점선
        const first = Math.floor((lo - phase) / 8) * 8 + phase;
        for (let s = first; s < hi; s += 8) {
          const a = Math.max(lo, s);
          const c = Math.min(hi, s + 3, solidFrom);
          if (c > a && has((a + c) / 2)) this.line(geo, a, c, dAt, 0.12, WHITE, x0, y0, b.marks);
        }
        if (solidFrom < hi) {
          const a = Math.max(lo, solidFrom);
          if (hi > a && has((a + hi) / 2)) this.line(geo, a, hi, dAt, 0.15, WHITE, x0, y0, b.marks);
        }
      }
    }
    // 정지선·횡단보도: 그 자리를 맡은 칸이 그린다
    const owns = (s: number) => {
      this.at(geo, s, q);
      return inTile(q.x, q.y);
    };
    if (sigTo && sStop > 0 && owns(sStop)) {
      this.patch(geo, sStop - 0.5, sStop, (s) => -this.widthAt(width, geo, s) / 2 - 0.02, (s) => this.widthAt(width, geo, s) / 2 + 0.05, WHITE, x0, y0, b.marks);
      this.crosswalk(geo, sStop + STOP_GAP * sc, sStop + (STOP_GAP + CROSSWALK) * sc, width, x0, y0, b.marks);
    }
    if (sigFrom && sStart > 0 && owns(Math.max(0, sStart - (STOP_GAP + CROSSWALK) * sc))) {
      this.crosswalk(geo, Math.max(0, sStart - (STOP_GAP + CROSSWALK) * sc), Math.max(0, sStart - STOP_GAP * sc), width, x0, y0, b.marks);
    }
  }

  private widthAt(width: Float64Array, geo: LinkGeom, s: number): number {
    const f = Math.max(0, Math.min(width.length - 1, (s / Math.max(1e-6, geo.length)) * (width.length - 1)));
    const i = Math.floor(f);
    return width[i] + (width[Math.min(i + 1, width.length - 1)] - width[i]) * (f - i);
  }

  /** 노면 표시 선 하나: s0~s1, 가로 가운데 d(s), 폭 w */
  private line(geo: LinkGeom, s0: number, s1: number, d: (s: number) => number, w: number, c: THREE.Color, x0: number, y0: number, g: G) {
    this.patch(geo, s0, s1, (s) => d(s) - w / 2, (s) => d(s) + w / 2, c, x0, y0, g);
  }

  /** 노면 위 조각: s0~s1 (2m마다 꺾음), 가로 dL(s)~dR(s) */
  private patch(geo: LinkGeom, s0: number, s1: number, dL: (s: number) => number, dR: (s: number) => number, c: THREE.Color, x0: number, y0: number, g: G) {
    if (s1 <= s0) return;
    const q: PolyPoint & { z?: number } = { x: 0, y: 0, tx: 1, ty: 0 };
    const parts = Math.max(1, Math.ceil((s1 - s0) / 2));
    let prev: [number, number] | null = null;
    for (let i = 0; i <= parts; i++) {
      const s = s0 + ((s1 - s0) * i) / parts;
      this.at(geo, s, q);
      const l = dL(s);
      const r = dR(s);
      const a = g.v(q.x + q.ty * l - x0, q.z! + 0.03, -(q.y - q.tx * l - y0), 0, 1, 0, c);
      const b = g.v(q.x + q.ty * r - x0, q.z! + 0.03, -(q.y - q.tx * r - y0), 0, 1, 0, c);
      if (prev) g.quad(prev[0], prev[1], b, a);
      prev = [a, b];
    }
  }

  /** 횡단보도: 길 방향으로 긴 흰 막대 (폭 0.5m, 1m 간격) */
  private crosswalk(geo: LinkGeom, s0: number, s1: number, width: Float64Array, x0: number, y0: number, g: G) {
    const w = this.widthAt(width, geo, (s0 + s1) / 2);
    for (let d = -w / 2 + 0.3; d + 0.5 <= w / 2 + 0.1; d += 1) {
      this.patch(geo, s0, s1, () => d, () => d + 0.5, WHITE, x0, y0, g);
    }
  }

  /** 가로등: 보도 d 자리에 9m 기둥, 차도 쪽으로 2.2m 팔, 끝에 등 */
  private streetLight(q: PolyPoint & { z?: number }, d: number, x0: number, y0: number, metal: G, head: G) {
    const X = q.x + q.ty * d;
    const Y = q.y - q.tx * d;
    const z = q.z! + 0.15;
    const c = new THREE.Color(0.55, 0.57, 0.58);
    box(metal, X - x0, z + 4.5, -(Y - y0), 0.16, 9, 0.16, 0, c);
    // 팔: 차도 쪽(왼쪽 = -오른쪽 법선)으로
    const ax = X - q.ty * 1.1;
    const ay = Y + q.tx * 1.1;
    // 상자 x축을 차도 쪽 (-ty, tx)로
    const yaw = Math.atan2(q.tx, -q.ty);
    box(metal, ax - x0, z + 8.9, -(ay - y0), 2.2, 0.1, 0.1, yaw, c);
    const hx = X - q.ty * 2.2;
    const hy = Y + q.tx * 2.2;
    box(head, hx - x0, z + 8.8, -(hy - y0), 0.7, 0.12, 0.32, yaw, WHITE);
  }

  /** 교차로: 바닥, 모서리 보도, 신호등 */
  private drawJunction(jid: number, x0: number, y0: number, b: Record<string, G>, lamps: { jid: number; approach: number; kind: 0 | 1 | 2 | 3; m: THREE.Matrix4 }[]) {
    const net = this.net;
    const j = net.junctions[jid];
    const q: PolyPoint & { z?: number } = { x: 0, y: 0, tx: 1, ty: 0 };
    const pts: [number, number][] = [];
    let zSum = 0;
    let zN = 0;
    const edge = (lid: number, inbound: boolean) => {
      const l = net.links[lid];
      const geo = net.geom(lid);
      const s = inbound ? (l.length - l.stopDist) * geo.scale : l.startDist * geo.scale;
      this.at(geo, s, q);
      const w = net.spanAt(lid, s / geo.scale).lanes * CITY_LANE;
      const left = -w / 2 - 0.3;
      const right = w / 2 + 0.25;
      pts.push([q.x + q.ty * left, q.y - q.tx * left], [q.x + q.ty * right, q.y - q.tx * right]);
      zSum += q.z!;
      zN++;
    };
    for (const id of j.inbound) edge(id, true);
    for (const id of j.outbound) edge(id, false);
    if (pts.length >= 3) {
      const hull = convexHull(pts);
      const z = zSum / Math.max(1, zN) + 0.012;
      const c = new THREE.Color(0.6, 0.6, 0.6);
      const ox = this.ox;
      const oy = this.oy;
      const base = hull.map(([X, Y]) => b.road.v(X - x0, z, -(Y - y0), 0, 1, 0, c, (((X + ox) % 1000) + 1000) / 4, (((Y + oy) % 1000) + 1000) / 4));
      for (let i = 1; i + 1 < base.length; i++) b.road.tri(base[0], base[i], base[i + 1]);
    }
    // 모서리 보도: 우회전 이동마다 들어오는 링크 보도 끝 → 나가는 링크 보도 시작
    for (const mid of j.movements) {
      const mv = net.movements[mid];
      if (mv.turn !== "R") continue;
      this.corner(mv.from, mv.to, x0, y0, b);
    }
    if (!j.signal) return;
    // 신호등: 접근로마다 건너편 오른쪽 모서리 기둥에서 차로 위로 팔을 내밀고 가로형 4색 등
    const plan = this.signals.plan(jid);
    if (!plan) return;
    plan.approaches.forEach((group, a) => {
      // 가장 넓은 링크 기준
      const lid = group.slice().sort((x, y) => net.links[y].lanes - net.links[x].lanes)[0];
      const l = net.links[lid];
      const geo = net.geom(lid);
      const sStop = (l.length - l.stopDist) * geo.scale;
      this.at(geo, sStop, q);
      const hx = q.tx;
      const hy = q.ty;
      const w = l.lanes * CITY_LANE;
      const straight = net.movementsFrom(lid).find((m) => m.turn === "S");
      let px: number;
      let py: number;
      let pz: number;
      if (straight) {
        const o = net.links[straight.to];
        const og = net.geom(o.id);
        const so = Math.max(0, o.startDist * og.scale - (STOP_GAP + CROSSWALK) * og.scale - 0.8);
        const oq = this.at(og, so, { x: 0, y: 0, tx: 1, ty: 0 });
        const d = o.lanesStart * CITY_LANE * 0.5 + 1.2;
        px = oq.x + oq.ty * d;
        py = oq.y - oq.tx * d;
        pz = oq.z + 0.15;
      } else {
        const ahead = l.stopDist * 2 + 4;
        const d = w / 2 + 1.2;
        px = q.x + hx * ahead + hy * d;
        py = q.y + hy * ahead - hx * d;
        pz = q.z! + 0.15;
      }
      const dark = new THREE.Color(0.2, 0.21, 0.22);
      const pole = new THREE.Color(0.58, 0.6, 0.6);
      box(b.metal, px - x0, pz + 3.5, -(py - y0), 0.26, 7, 0.26, 0, pole);
      // 팔: 기둥에서 접근로 차로 가운데 위까지 (진행 방향 왼쪽으로)
      const reach = Math.min(13, w * 0.55 + 1.5);
      // 상자 x축을 팔 방향(진행 방향 왼쪽 (-hy, hx))으로
      const yaw = Math.atan2(hx, -hy);
      const armX = px - hy * (reach / 2);
      const armY = py + hx * (reach / 2);
      box(b.metal, armX - x0, pz + 6.7, -(armY - y0), reach, 0.18, 0.18, yaw, pole);
      // 등 상자: 팔 끝, 접근로를 바라본다 (앞면 법선 = -진행 방향)
      const cx = px - hy * reach;
      const cy = py + hx * reach;
      const cz = pz + 6.25;
      // 등 면(+z)이 접근로 쪽 (-hx, -hy)을 보게
      const faceYaw = Math.atan2(-hx, hy);
      box(b.metal, cx - x0, cz, -(cy - y0), 1.75, 0.52, 0.34, yaw, dark);
      // 등 네 개: 운전자가 볼 때 왼쪽부터 적·황·좌회전·녹 (운전자 오른쪽 = 진행 방향 오른쪽 (hy, -hx))
      const offs = [-0.6, -0.2, 0.2, 0.6];
      offs.forEach((o, kind) => {
        const lx = cx + hy * o - hx * 0.18;
        const ly = cy - hx * o - hy * 0.18;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(lx - x0, cz, -(ly - y0)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceYaw), new THREE.Vector3(1, 1, 1));
        lamps.push({ jid, approach: a, kind: kind as 0 | 1 | 2 | 3, m });
      });
    });
  }

  /** 교차로 모서리 보도: 들어오는 링크 a의 오른쪽 보도 끝과 나가는 링크 b의 오른쪽 보도 시작을 잇는다 (안쪽은 둥근 연석) */
  private corner(a: number, bId: number, x0: number, y0: number, b: Record<string, G>) {
    const net = this.net;
    const la = net.links[a];
    const lb = net.links[bId];
    const ga = net.geom(a);
    const gb = net.geom(bId);
    const ja = net.junctions[la.to];
    const sig = ja.signal;
    const sa = (la.length - la.stopDist) * ga.scale + (sig ? STOP_GAP * ga.scale : 0);
    const sb = lb.startDist * gb.scale - (sig ? STOP_GAP * gb.scale : 0);
    const pa = this.at(ga, sa, { x: 0, y: 0, tx: 1, ty: 0 });
    const pb = this.at(gb, sb, { x: 0, y: 0, tx: 1, ty: 0 });
    const wa = net.spanAt(a, sa / ga.scale).lanes * CITY_LANE / 2 + 0.25;
    const wb = net.spanAt(bId, sb / gb.scale).lanes * CITY_LANE / 2 + 0.25;
    const swa = sidewalkWidth(la.cls);
    const swb = sidewalkWidth(lb.cls);
    // 안쪽(연석)과 바깥쪽 끝점
    const ai = [pa.x + pa.ty * wa, pa.y - pa.tx * wa];
    const ao = [pa.x + pa.ty * (wa + swa), pa.y - pa.tx * (wa + swa)];
    const bi = [pb.x + pb.ty * wb, pb.y - pb.tx * wb];
    const bo = [pb.x + pb.ty * (wb + swb), pb.y - pb.tx * (wb + swb)];
    // 두 연석선이 만나는 곳을 조절점으로 (못 만나면 가운데)
    const meet = (p: number[], d1: number[], r: number[], d2: number[]): number[] => {
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-3) return [(p[0] + r[0]) / 2, (p[1] + r[1]) / 2];
      const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / den;
      if (t < 0 || t > 60) return [(p[0] + r[0]) / 2, (p[1] + r[1]) / 2];
      return [p[0] + d1[0] * t, p[1] + d1[1] * t];
    };
    const ci = meet(ai, [pa.tx, pa.ty], bi, [pb.tx, pb.ty]);
    const co = meet(ao, [pa.tx, pa.ty], bo, [pb.tx, pb.ty]);
    const za = pa.z + 0.15;
    const zb = pb.z + 0.15;
    const walkC = new THREE.Color(0.8, 0.77, 0.73);
    const curbC = new THREE.Color(0.72, 0.72, 0.7);
    const N = 8;
    let prev: [number, number, number, number] | null = null;
    const ox = this.ox;
    const oy = this.oy;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const bez = (p0: number[], c: number[], p1: number[]) => [(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]];
      const I = bez(ai, ci, bi);
      const O = bez(ao, co, bo);
      const z = za + (zb - za) * t;
      const vi = b.walk.v(I[0] - x0, z, -(I[1] - y0), 0, 1, 0, walkC, (((I[0] + ox) % 1000) + 1000) / 4, (((I[1] + oy) % 1000) + 1000) / 4);
      const vo = b.walk.v(O[0] - x0, z, -(O[1] - y0), 0, 1, 0, walkC, (((O[0] + ox) % 1000) + 1000) / 4, (((O[1] + oy) % 1000) + 1000) / 4);
      const cb = b.concrete.v(I[0] - x0, z - 0.15, -(I[1] - y0), 0, 1, 0, curbC);
      const ct = b.concrete.v(I[0] - x0, z, -(I[1] - y0), 0, 1, 0, curbC);
      if (prev) {
        b.walk.quad(prev[0], vi, vo, prev[1]);
        b.walk.quad(prev[0], prev[1], vo, vi);
        b.concrete.quad(prev[2], cb, ct, prev[3]);
        b.concrete.quad(prev[2], prev[3], ct, cb);
      }
      prev = [vi, vo, cb, ct];
    }
  }

  // ---------------- 건물 ----------------

  /** 링크 오른쪽에 늘어선 건물 (처음 부를 때 만든다) */
  private buildingsOf(id: number): Building[] {
    const have = this.buildings.get(id);
    if (have) return have;
    const out: Building[] = [];
    this.buildings.set(id, out);
    const net = this.net;
    const l = net.links[id];
    if (l.cls.endsWith("l") || l.cls[0] === "t" || l.cls[0] === "m") return out;
    const geo = net.geom(id);
    const sc = geo.scale;
    const s0 = l.startDist * sc + 6;
    const s1 = (l.length - l.stopDist) * sc - 6;
    const rand = xorshift(id * 31 + 7);
    const q: PolyPoint & { z?: number } = { x: 0, y: 0, tx: 1, ty: 0 };
    let s = s0 + rand() * 6;
    while (s < s1 - 8) {
      const front = 12 + rand() * 26;
      const depth = 12 + rand() * 20;
      const gap = 1 + rand() * 5;
      const mid = s + front / 2;
      if (mid > s1) break;
      this.at(geo, mid, q);
      const sp = net.spanAt(id, mid / sc);
      const w = sp.lanes * CITY_LANE;
      const back = w / 2 + 0.25 + sidewalkWidth(sp.cls) + 1 + rand() * 3;
      const cx = q.x + q.ty * (back + depth / 2);
      const cy = q.y - q.tx * (back + depth / 2);
      const bd: Building = { x: cx, y: cy, ux: q.tx, uy: q.ty, a: front / 2, b: depth / 2, base: 0, h: 0, glass: false, tint: rand(), tower: false };
      if ((!this.rural || this.town(cx, cy)) && this.fits(bd)) {
        const dens = this.density.get(this.cell(cx, cy, 250)) ?? 0;
        const tall = Math.min(1, dens / 8);
        const cls = sp.cls[0];
        const floors = this.rural && !this.bigTown(cx, cy)
          ? 1 + rand() * 3 + tall * 6 * rand()
          : cls === "p"
            ? 5 + rand() * 12 + tall * 22 * rand()
            : cls === "s"
              ? 4 + rand() * 9 + tall * 18 * rand()
              : 3 + rand() * 5 + tall * 8 * rand();
        bd.h = Math.max(7, floors * 3.4);
        bd.glass = bd.h > 42 || (tall > 0.5 && rand() < 0.5);
        bd.tower = bd.h > 50 && rand() < 0.6;
        bd.base = this.groundAt(cx, cy) + 0.8;
        out.push(bd);
        this.occupy(bd);
      }
      s += front + gap;
    }
    return out;
  }

  /** 건물이 도로·다른 건물에 닿지 않는지 */
  private fits(bd: Building): boolean {
    const net = this.net;
    const lx = -bd.uy;
    const ly = bd.ux;
    const corners: [number, number][] = [];
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [0, 0],
      [0, -1],
      [0, 1],
    ]) {
      corners.push([bd.x + bd.ux * bd.a * su + lx * bd.b * sv, bd.y + bd.uy * bd.a * su + ly * bd.b * sv]);
    }
    for (const [x, y] of corners) if (this.occupied.has(this.cell(x, y, 4))) return false;
    const r = Math.hypot(bd.a, bd.b) + 30;
    for (const id of net.graph.edgesIn(bd.x - r, bd.y - r, bd.x + r, bd.y + r)) {
      const e = net.graph.edges[id];
      const half = (e.oneway ? (e.lanes * CITY_LANE) / 2 : e.lanes * CITY_LANE + CENTER_GAP) + sidewalkWidth(e.cls) + 1.5 + (e.oneway ? 0 : 0);
      const p = e.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        for (const [x, y] of corners) {
          const dx = p[i + 2] - p[i];
          const dy = p[i + 3] - p[i + 1];
          const L2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / L2));
          const ex = p[i] + dx * t - x;
          const ey = p[i + 1] + dy * t - y;
          if (ex * ex + ey * ey < half * half) return false;
        }
      }
    }
    // 교차로 가운데와 너무 가까우면
    for (const n of this.nodesNear(bd.x, bd.y)) {
      const node = net.graph.nodes[n];
      if (node.degree >= 3 && Math.hypot(node.x - bd.x, node.y - bd.y) < 22) return false;
    }
    return true;
  }

  private occupy(bd: Building) {
    const lx = -bd.uy;
    const ly = bd.ux;
    for (let su = -bd.a; su <= bd.a; su += 2) {
      for (let sv = -bd.b; sv <= bd.b; sv += 2) {
        this.occupied.add(this.cell(bd.x + bd.ux * su + lx * sv, bd.y + bd.uy * su + ly * sv, 4));
      }
    }
  }

  private nodesNear(x: number, y: number): number[] {
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(this.nodeGrid.get(this.cell(x + dx * 100, y + dy * 100, 100)) ?? []));
    return out;
  }

  /**
   * 땅 표면 높이: 교차점 높이를 거리로 섞어 0.8m 내리되, 가장 가까운 도로(다리 빼고)보다 0.6m 아래로.
   * 도로는 교차점 사이를 곧게 가서, 긴 토막 가운데에서는 옆 골목 교차점으로 섞은 땅이 도로보다 높을 수 있다
   */
  private groundAt(x: number, y: number): number {
    if (this.dem) return this.ruralGround(x, y).z;
    const z = this.groundZ(x, y) - 0.8;
    const g = this.net.graph;
    const near = g.nearestEdge(x, y, 45, (e) => !e.bridge);
    if (!near) return z;
    return Math.min(z, g.edgeZ(near.edge, near.u) - 0.6);
  }

  // ---------------- 국도 땅 ----------------

  /**
   * 국도 땅 높이: 지형 격자. 도로(다리 빼고) 가까이는 도로보다 조금 낮게 깔고, 도로 가장자리에서 40m에 걸쳐 지형으로 이어
   * 둑(도로가 높을 때)·깎기(도로가 낮을 때)가 된다. road: 도로 가장자리에서 떨어진 거리 (도로 위면 0 이하)
   */
  private ruralGround(x: number, y: number): { z: number; road: number } {
    const zd = this.dem!.height(x, y);
    const g = this.net.graph;
    let best: { edge: CityEdge; u: number; dist: number } | null = null;
    // 땅 한 칸(20m) 안에 걸친 도로 가운데 가장 낮은 것보다 땅이 높으면 그 도로를 덮는다
    // (예: 9m 떨어진 상·하행 차도의 높이가 1m 넘게 다르면). 그 아래로 맞추고, 높은 쪽 차도 가장자리는 옹벽으로 보인다
    let cap = Infinity;
    for (const id of g.edgesIn(x - 60, y - 60, x + 60, y + 60)) {
      const e = g.edges[id];
      if (e.bridge) continue;
      const r = g.nearestEdge(x, y, 60, (f) => f.id === id);
      if (!r) continue;
      if (!best || r.dist < best.dist) best = r;
      if (r.dist - roadHalf(e) < GROUND_CELL) cap = Math.min(cap, this.drawnZ(e, r.u) - 0.35);
    }
    if (!best) return { z: zd, road: Infinity };
    const d = best.dist - roadHalf(best.edge);
    const rz = this.drawnZ(best.edge, best.u) - 0.35;
    if (d <= 0) return { z: Math.min(rz, cap), road: d };
    const t = Math.min(1, d / 40);
    return { z: Math.min(rz + (zd - rz) * t * t * (3 - 2 * t), cap), road: d };
  }

  /** 그린 차도 높이: 링크 모양의 높이(앞뒤 20m 평균)라 토막 높이 굴곡보다 둥글다. 땅이 차도 위로 솟지 않게 이것에 맞춘다 */
  private drawnZ(e: CityEdge, u: number): number {
    const net = this.net;
    for (const fwd of [true, false]) {
      const lid = net.dirLink[e.id * 2 + (fwd ? 0 : 1)];
      if (lid < 0) continue;
      const sp = net.links[lid].spans.find((x) => x.edge === e.id);
      if (sp) return net.pointOnLink(lid, sp.u0 + (fwd ? u : e.length - u), this.zq).z;
    }
    return net.graph.edgeZ(e, u);
  }

  /** 읍내·마을: 시가지(주거·상업·공업 용도 땅)거나 이름 있는 건물이 모인 곳 */
  private town(x: number, y: number): boolean {
    const k = this.cell(x, y, 75);
    let v = this.townCache.get(k);
    if (v === undefined) {
      let d = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) d += this.density.get(this.cell(x + dx * 250, y + dy * 250, 250)) ?? 0;
      v = d >= 4 || this.dem!.urban(x, y) >= 0.5;
      this.townCache.set(k, v);
    }
    return v;
  }

  /** 도시 (서울 강동구, 미사·구리 같은 신도시): 둘레 800m가 거의 다 시가지면 시내처럼 높은 건물 */
  private bigTown(x: number, y: number): boolean {
    const k = this.cell(x, y, 250);
    let v = this.cityCache.get(k);
    if (v === undefined) {
      const dem = this.dem!;
      let u = 0;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) u += dem.urban(x + i * 200, y + j * 200);
      v = u / 25 >= 0.7;
      this.cityCache.set(k, v);
    }
    return v;
  }

  /** 땅 종류: 물, 읍내, 숲(비탈), 논밭(평평한 골짜기) */
  private land(x: number, y: number): Land {
    const dem = this.dem!;
    if (dem.water(x, y) >= 0.5) return Land.Water;
    if (this.town(x, y)) return Land.Town;
    const sl = dem.slope(x, y);
    if (sl > 0.16 || sl > 0.06 + 0.12 * vnoise(x, y, 170, 11)) return Land.Forest;
    return Land.Field;
  }

  private landColor(kind: Land, x: number, y: number, out: THREE.Color): THREE.Color {
    if (kind === Land.Water) return out.copy(LAND.water);
    if (kind === Land.Town) return out.copy(LAND.town);
    if (kind === Land.Forest) return out.copy(LAND.forest).lerp(LAND.forestLight, vnoise(x, y, 60, 5));
    // 논밭: 80m 조각마다 논·밭·묵은 땅
    const r = hash((Math.floor(x / 80) * 92821) ^ (Math.floor(y / 80) * 68917));
    return out.copy(r < 0.5 ? LAND.paddy : r < 0.85 ? LAND.field : LAND.fallow).lerp(LAND.verge, 0.3 * vnoise(x, y, 30, 9));
  }

  /** 국도 칸의 땅(20m 격자, 비탈 그늘), 물, 숲 나무 */
  private drawRuralGround(x0: number, y0: number, b: Record<string, G>, broad: THREE.Matrix4[], pines: THREE.Matrix4[]) {
    const n = TILE / GROUND_CELL;
    const z: number[][] = [];
    const kind: Land[][] = [];
    const road: number[][] = [];
    for (let i = 0; i <= n; i++) {
      z.push([]);
      kind.push([]);
      road.push([]);
      for (let j = 0; j <= n; j++) {
        const X = x0 + i * GROUND_CELL;
        const Y = y0 + j * GROUND_CELL;
        const gr = this.ruralGround(X, Y);
        z[i].push(gr.z);
        road[i].push(gr.road);
        kind[i].push(this.land(X, Y));
      }
    }
    const c = new THREE.Color();
    const nrm = (i: number, j: number): [number, number, number] => {
      const gx = (z[Math.min(n, i + 1)][j] - z[Math.max(0, i - 1)][j]) / ((Math.min(n, i + 1) - Math.max(0, i - 1)) * GROUND_CELL);
      const gy = (z[i][Math.min(n, j + 1)] - z[i][Math.max(0, j - 1)]) / ((Math.min(n, j + 1) - Math.max(0, j - 1)) * GROUND_CELL);
      const L = Math.hypot(gx, 1, gy);
      return [-gx / L, 1 / L, gy / L];
    };
    const g = b.ground;
    const idx: number[][] = [];
    for (let i = 0; i <= n; i++) {
      idx.push([]);
      for (let j = 0; j <= n; j++) {
        const X = x0 + i * GROUND_CELL;
        const Y = y0 + j * GROUND_CELL;
        const k = kind[i][j];
        // 도로 옆 둑·깎기는 풀
        if (road[i][j] < 12 && k !== Land.Water && k !== Land.Town) c.copy(LAND.verge);
        else this.landColor(k === Land.Water ? Land.Field : k, X, Y, c);
        const [nx, ny, nz] = nrm(i, j);
        idx[i].push(g.v(X - x0, z[i][j], -(Y - y0), nx, ny, nz, c, (X + this.ox) / 16, (Y + this.oy) / 16));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const wet = [kind[i][j], kind[i + 1][j], kind[i + 1][j + 1], kind[i][j + 1]].filter((k) => k === Land.Water).length;
        if (wet >= 3) {
          // 물: 네 모서리 중 가장 낮은 높이로 평평하게
          const zw = Math.min(z[i][j], z[i + 1][j], z[i + 1][j + 1], z[i][j + 1]) + 0.05;
          const w = b.water;
          const q = [
            [i, j],
            [i + 1, j],
            [i + 1, j + 1],
            [i, j + 1],
          ].map(([a, cc]) => w.v(a * GROUND_CELL, zw, -cc * GROUND_CELL, 0, 1, 0, LAND.water));
          w.quad(q[0], q[1], q[2], q[3]);
        } else g.quad(idx[i][j], idx[i + 1][j], idx[i + 1][j + 1], idx[i][j + 1]);
      }
    }
    // 숲: 20m 칸마다 한 그루 (도로 옆 12m·물·읍내는 비운다). 조림지(노이즈)는 침엽수, 나머지는 활엽수
    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const r = hash(((Math.floor(x0 / GROUND_CELL) + i) * 7331) ^ ((Math.floor(y0 / GROUND_CELL) + j) * 30637));
        const X = x0 + (i + 0.2 + 0.6 * r) * GROUND_CELL;
        const Y = y0 + (j + 0.2 + 0.6 * hash(r * 1e9)) * GROUND_CELL;
        if (this.land(X, Y) !== Land.Forest) continue;
        const gr = this.ruralGround(X, Y);
        if (gr.road < 12) continue;
        const pine = vnoise(X, Y, 140, 3) > 0.58;
        const s = (pine ? 1.2 : 1.35) + 0.5 * r;
        m.compose(new THREE.Vector3(X - x0, gr.z - 0.2, -(Y - y0)), qt.setFromAxisAngle(up, r * 40), new THREE.Vector3(s, s * (0.9 + 0.3 * r), s));
        (pine ? pines : broad).push(m.clone());
      }
    }
  }

  /** 비닐하우스: 평평한 논밭 조각 일부에 가까운 도로와 나란히 몇 동 */
  private greenhouses(x0: number, y0: number, inTile: (x: number, y: number) => boolean, g: G) {
    const P = 90;
    const white = new THREE.Color(0.86, 0.88, 0.87);
    const top = new THREE.Color(0.93, 0.94, 0.93);
    for (let px = Math.floor(x0 / P); px <= Math.floor((x0 + TILE) / P); px++) {
      for (let py = Math.floor(y0 / P); py <= Math.floor((y0 + TILE) / P); py++) {
        const r = hash((px * 48611) ^ (py * 96769) ^ 77);
        if (r > 0.1) continue;
        const cx = (px + 0.5) * P;
        const cy = (py + 0.5) * P;
        if (!inTile(cx, cy) || this.land(cx, cy) !== Land.Field || this.dem!.slope(cx, cy) > 0.04) continue;
        const near = this.net.graph.nearestEdge(cx, cy, 200);
        if (!near || near.dist < 28) continue;
        // 가까운 도로 방향
        const e = near.edge;
        const p = e.pts;
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const d = Math.hypot((p[i] + p[i + 2]) / 2 - cx, (p[i + 1] + p[i + 3]) / 2 - cy);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        const yaw = Math.atan2(p[best + 3] - p[best + 1], p[best + 2] - p[best]);
        const ux = Math.cos(yaw);
        const uy = Math.sin(yaw);
        const count = 3 + Math.floor(r * 30);
        for (let k = 0; k < count; k++) {
          const off = (k - (count - 1) / 2) * 9;
          const hx = cx - uy * off;
          const hy = cy + ux * off;
          if (this.land(hx, hy) !== Land.Field || this.ruralGround(hx, hy).road < 18) continue;
          const zb = this.ruralGround(hx, hy).z;
          // 몸통 + 둥근 지붕을 낮은 상자 둘로
          box(g, hx - x0, zb + 0.8, -(hy - y0), 40, 1.6, 7, yaw, white);
          box(g, hx - x0, zb + 2.0, -(hy - y0), 40, 0.8, 4.6, yaw, top);
        }
      }
    }
  }

  /** 먼 산: 플레이어 둘레 FAR_RADIUS를 100m 격자 한 장으로 (가까운 칸 안쪽은 비우고, 가까운 칸과 겹치는 곳은 낮춘다) */
  private updateFar(px: number, py: number) {
    if (this.far && Math.hypot(px - this.far.x0, py - this.far.y0) < 300) return;
    if (this.far) {
      this.group.remove(this.far.mesh);
      this.far.mesh.geometry.dispose();
    }
    const dem = this.dem!;
    const cx = Math.round(px / FAR_CELL) * FAR_CELL;
    const cy = Math.round(py / FAR_CELL) * FAR_CELL;
    const n = Math.ceil(FAR_RADIUS / FAR_CELL);
    const g = new G();
    const c = new THREE.Color();
    const ids: number[][] = [];
    for (let i = -n; i <= n; i++) {
      const row: number[] = [];
      for (let j = -n; j <= n; j++) {
        const X = cx + i * FAR_CELL;
        const Y = cy + j * FAR_CELL;
        const d = Math.hypot(X - cx, Y - cy);
        const z = dem.height(X, Y) - 3 - 12 * Math.max(0, Math.min(1, (MAX_RADIUS + 100 - d) / 250));
        const h = FAR_CELL;
        const gx = (dem.height(X + h, Y) - dem.height(X - h, Y)) / (2 * h);
        const gy = (dem.height(X, Y + h) - dem.height(X, Y - h)) / (2 * h);
        const L = Math.hypot(gx, 1, gy);
        this.landColor(this.land(X, Y), X, Y, c);
        row.push(g.v(X - cx, z, -(Y - cy), -gx / L, 1 / L, gy / L, c, (X + this.ox) / 16, (Y + this.oy) / 16));
      }
      ids.push(row);
    }
    for (let i = 0; i < 2 * n; i++) {
      for (let j = 0; j < 2 * n; j++) {
        const d = Math.hypot((i - n + 0.5) * FAR_CELL, (j - n + 0.5) * FAR_CELL);
        if (d < FAR_HOLE || d > FAR_RADIUS) continue;
        g.quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
      }
    }
    const mesh = g.mesh(this.mats.ground);
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.far = { mesh, x0: cx, y0: cy };
  }

  /** 땅 높이: 가까운 교차점 높이의 거리 가중 평균 */
  private groundZ(x: number, y: number): number {
    const g = this.net.graph;
    let sw = 0;
    let sz = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (const n of this.nodeGrid.get(this.cell(x + dx * 100, y + dy * 100, 100)) ?? []) {
          const p = g.nodes[n];
          const d2 = (p.x - x) ** 2 + (p.y - y) ** 2 + 400;
          const w = 1 / (d2 * d2);
          sw += w;
          sz += w * p.z;
        }
      }
    }
    return sw > 0 ? sz / sw : 20;
  }

  private drawBuilding(bd: Building, x0: number, y0: number, b: Record<string, G>) {
    const lx = -bd.uy;
    const ly = bd.ux;
    const g = bd.glass ? b.office : b.plain;
    const tints = bd.glass ? [0xb6c4d2, 0x9fb1c2, 0xc9d3dc, 0x8fa3b3] : [0xe8e1d4, 0xd6cabb, 0xbfb7ad, 0xe2d6c6, 0xc4a28a, 0xa9aeb2];
    const color = new THREE.Color(tints[Math.floor(bd.tint * tints.length) % tints.length]);
    const roofC = new THREE.Color(0.5, 0.5, 0.49);
    const z0 = bd.base - 3;
    const block = (a: number, bb: number, zb: number, zt: number) => {
      const cs: [number, number][] = [
        [bd.x - bd.ux * a - lx * bb, bd.y - bd.uy * a - ly * bb],
        [bd.x + bd.ux * a - lx * bb, bd.y + bd.uy * a - ly * bb],
        [bd.x + bd.ux * a + lx * bb, bd.y + bd.uy * a + ly * bb],
        [bd.x - bd.ux * a + lx * bb, bd.y - bd.uy * a + ly * bb],
      ];
      // 벽 (반시계로 돌며 바깥 = 오른쪽)
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = cs[i];
        const [cx, cy] = cs[(i + 1) % 4];
        const len = Math.hypot(cx - ax, cy - ay);
        const nx = (cy - ay) / len;
        const ny = -(cx - ax) / len;
        const u1 = len / 24;
        const v0 = (zb - bd.base) / 26.4;
        const v1 = (zt - bd.base) / 26.4;
        const p0 = g.v(ax - x0, zb, -(ay - y0), nx, 0, -ny, color, 0, v0);
        const p1 = g.v(cx - x0, zb, -(cy - y0), nx, 0, -ny, color, u1, v0);
        const p2 = g.v(cx - x0, zt, -(cy - y0), nx, 0, -ny, color, u1, v1);
        const p3 = g.v(ax - x0, zt, -(ay - y0), nx, 0, -ny, color, 0, v1);
        g.quad(p0, p1, p2, p3);
      }
      const r = cs.map(([x, y]) => b.roof.v(x - x0, zt, -(y - y0), 0, 1, 0, roofC));
      b.roof.quad(r[0], r[1], r[2], r[3]);
    };
    if (bd.tower) {
      const podium = Math.min(18, bd.h * 0.25);
      block(bd.a, bd.b, z0, bd.base + podium);
      block(bd.a * 0.7, bd.b * 0.75, bd.base + podium, bd.base + bd.h);
    } else {
      block(bd.a, bd.b, z0, bd.base + bd.h);
      // 옥상 기계실
      if (bd.h > 20) box(b.roof, bd.x - x0, bd.base + bd.h + 1.5, -(bd.y - y0), bd.a * 0.5, 3, bd.b * 0.5, Math.atan2(bd.uy, bd.ux), roofC);
    }
  }

  /** 땅: 20m 격자, 교차점 높이를 부드럽게 이은 면을 0.8m 낮춰 깐다 */
  private drawGround(x0: number, y0: number, g: G) {
    const n = TILE / GROUND_CELL;
    const c = new THREE.Color(0.62, 0.6, 0.57);
    const idx: number[][] = [];
    for (let i = 0; i <= n; i++) {
      idx.push([]);
      for (let j = 0; j <= n; j++) {
        const X = x0 + i * GROUND_CELL;
        const Y = y0 + j * GROUND_CELL;
        const z = this.groundAt(X, Y);
        idx[i].push(g.v(X - x0, z, -(Y - y0), 0, 1, 0, c, (X + this.ox) / 16, (Y + this.oy) / 16));
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) g.quad(idx[i][j], idx[i + 1][j], idx[i + 1][j + 1], idx[i][j + 1]);
  }
}

/** 상자 (가운데 x, y, z, 크기 sx·sy·sz, y축 회전 yaw) */
function box(g: G, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, c: THREE.Color) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const P = (dx: number, dy: number, dz: number): [number, number, number] => [x + dx * cos + dz * sin, y + dy, z - dx * sin + dz * cos];
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const faces: [number[], [number, number, number][]][] = [
    [[1, 0, 0], [P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)]],
    [[-1, 0, 0], [P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)]],
    [[0, 1, 0], [P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)]],
    [[0, -1, 0], [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)]],
    [[0, 0, 1], [P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)]],
    [[0, 0, -1], [P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)]],
  ];
  for (const [n, vs] of faces) {
    const nx = n[0] * cos + n[2] * sin;
    const nz = -n[0] * sin + n[2] * cos;
    const ids = vs.map((v) => g.v(v[0], v[1], v[2], nx, n[1], nz, c));
    g.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

/** 좌회전 화살표 등 (지름 약 0.28m) */
function arrowGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.13, 0);
  s.lineTo(-0.02, 0.1);
  s.lineTo(-0.02, 0.04);
  s.lineTo(0.12, 0.04);
  s.lineTo(0.12, -0.04);
  s.lineTo(-0.02, -0.04);
  s.lineTo(-0.02, -0.1);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}
