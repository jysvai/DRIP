// 렌더러·하늘·조명·안개. 좌표는 매 프레임 플레이어 위치를 원점으로 옮겨서(떠다니는 원점) 먼 곳에서도 떨림이 없게 한다.
// 화면 좌표: X = 동쪽 - 원점, Y = 고도(m), Z = -(북쪽 - 원점)
// 차 재질의 반사(환경맵)도 여기서 만든다: 낮 하늘·밤·터널 세 가지를 미리 구워 두고 상황에 맞게 바꿔 끼운다.

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { PostFx } from "./postfx";

export interface Origin {
  e: number;
  n: number;
}

/**
 * 그래픽 품질. low: 그림자·반사 코팅·후처리 없이 가깝게만 그려 가볍게, high: 전부,
 * ultra: 고사양 PC용으로 더 멀리·더 촘촘히·더 선명하게 (먼 산까지 숲, 넓고 고운 그림자, 선명한 거울)
 */
export type Quality = "low" | "medium" | "high" | "ultra";
/** 메뉴에서 고르는 값: auto는 기기에 맞춰 고른다 (render/gfx.ts) */
export type QualityChoice = Quality | "auto";
export const QUALITY_ORDER: Quality[] = ["low", "medium", "high", "ultra"];
export const QUALITY_LABELS: Record<Quality, string> = { low: "낮음", medium: "보통", high: "높음", ultra: "최고" };

export interface QualitySettings {
  /** 화면 해상도 배율 상한 */
  pixelRatio: number;
  /** 끊길 때 해상도를 여기까지 낮춘다 (pixelRatio에 곱하는 값) */
  minScale: number;
  /** 해 그림자 (0이면 끔)와 그림자가 드리우는 범위 (차 둘레 ±m) */
  shadowMap: number;
  shadowRadius: number;
  shadowExtent: number;
  /** 길과 풍경을 그리는 거리 (m). 안개가 이보다 가까우면 안개까지만 */
  viewDistance: number;
  /** 나무: 조각마다 심을 수 있는 수 중 몇 할을 그릴지, 제 모양으로 그리는 조각 수(앞뒤로), 그림자를 드리우는 조각 수 */
  treeDensity: number;
  treeNear: number;
  treeShadow: number;
  /** 비·눈 입자 비율 */
  particles: number;
  /** 차 도장 클리어코트 */
  clearcoat: boolean;
  /** 차를 제 모양으로 그리는 거리 / 단순 모양으로 그리는 거리 / 상자로라도 그리는 거리 (m) */
  lodNear: number;
  lodMid: number;
  drawDistance: number;
  /** 거울을 몇 프레임에 한 번 다시 그리는지, 거울 해상도 배율 */
  mirrorEvery: number;
  mirrorScale: number;
  /** 후처리 (밤 빛 번짐, 가장자리 다듬기) */
  post: boolean;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  low: {
    pixelRatio: 1,
    minScale: 0.6,
    shadowMap: 0,
    shadowRadius: 0,
    shadowExtent: 0,
    viewDistance: 1500,
    treeDensity: 0.4,
    treeNear: 1,
    treeShadow: 0,
    particles: 0.45,
    clearcoat: false,
    lodNear: 30,
    lodMid: 160,
    drawDistance: 900,
    mirrorEvery: 3,
    mirrorScale: 0.6,
    post: false,
  },
  medium: {
    pixelRatio: 1.25,
    minScale: 0.7,
    shadowMap: 1024,
    shadowRadius: 2,
    shadowExtent: 55,
    viewDistance: 2000,
    treeDensity: 0.6,
    treeNear: 1,
    treeShadow: 1,
    particles: 0.7,
    clearcoat: true,
    lodNear: 45,
    lodMid: 240,
    drawDistance: 1200,
    mirrorEvery: 2,
    mirrorScale: 0.8,
    post: false,
  },
  high: {
    pixelRatio: 1.75,
    minScale: 0.75,
    shadowMap: 2048,
    shadowRadius: 3,
    shadowExtent: 70,
    viewDistance: 2600,
    treeDensity: 0.77,
    treeNear: 2,
    treeShadow: 1,
    particles: 1,
    clearcoat: true,
    lodNear: 70,
    lodMid: 320,
    drawDistance: 1400,
    mirrorEvery: 1,
    mirrorScale: 1,
    post: true,
  },
  ultra: {
    pixelRatio: 2,
    minScale: 0.8,
    shadowMap: 4096,
    shadowRadius: 3,
    shadowExtent: 110,
    viewDistance: 3300,
    treeDensity: 1,
    treeNear: 4,
    treeShadow: 2,
    particles: 1,
    clearcoat: true,
    lodNear: 110,
    lodMid: 520,
    drawDistance: 2000,
    mirrorEvery: 1,
    mirrorScale: 1.3,
    post: true,
  },
};

/** 낮 안개가 끝나는 거리 (m): 품질이 높으면 더 멀리까지 맑게 보인다 */
const DAY_FOG_FAR = 2600;

export const FOG_COLOR = new THREE.Color(0xc3ccd3);
const NIGHT_FOG = new THREE.Color(0x06090e);
const SUN_COLOR = new THREE.Color(0xfff4e2);
const MOON_COLOR = new THREE.Color(0x8fa6cc);
const HEMI_SKY = new THREE.Color(0xdde7f0);
const HEMI_SKY_NIGHT = new THREE.Color(0x40506c);

interface EnvMat {
  mat: THREE.MeshStandardMaterial;
  k: number;
}

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  origin: Origin = { e: 0, n: 0 };
  private sky: Sky;
  private sunDir = new THREE.Vector3();
  /** 밝기 (1 = 한낮). 해가 낮거나 밤이거나 터널 안이면 작아진다 */
  daylight = 1;
  /** 밤 정도 (0 = 낮, 1 = 밤). 하늘·안개·달빛과 차 등화에 쓴다 */
  night = 0;
  /** 터널 안 정도 (0~1). 터널은 밤에도 조명으로 밝다 */
  tunnel = 0;
  /** 흐린 정도 (0~1, 날씨). 해가 약해지고, 0.5부터는 하늘 대신 잿빛 배경에 차에 비치는 하늘도 잿빛 */
  overcast = 0;
  private overcastSky = new THREE.Color();
  /** 플레이어 차가 향한 방향 (화면 좌표 y축 회전). 터널 반사를 길 방향에 맞춘다 */
  heading = 0;
  quality: Quality;
  settings: QualitySettings;
  /** 끊길 때 낮추는 해상도 배율 (1 = 품질의 pixelRatio 그대로) */
  resolutionScale = 1;
  private fogLimit = { far: Infinity, near: Infinity };
  /** 후처리 (high에서만) */
  readonly post: PostFx;
  private qualityListeners: ((q: Quality, s: QualitySettings) => void)[] = [];
  private mirrorListeners: ((on: boolean) => void)[] = [];
  private pmrem: THREE.PMREMGenerator;
  private env: { day: THREE.WebGLRenderTarget | null; night: THREE.WebGLRenderTarget | null; tunnel: THREE.WebGLRenderTarget | null } = { day: null, night: null, tunnel: null };
  private envDirty = true;
  private envMats: EnvMat[] = [];
  private envSky: Sky;

  /** initial: 처음 품질. low면 계단 현상 방지(MSAA)를 끈다 (나중에 바꿀 수 없다) */
  constructor(container: HTMLElement, initial: Quality = "high") {
    this.quality = initial;
    this.settings = QUALITY[initial];
    this.renderer = new THREE.WebGLRenderer({ antialias: initial !== "low", powerPreference: "high-performance" });
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 4200);
    this.scene.fog = new THREE.Fog(FOG_COLOR, 250, 2600);

    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.8;
    this.scene.add(this.sky);
    // 반사용 하늘: 해 원반은 빼고(반사가 번쩍이지 않게) 같은 하늘
    this.envSky = new Sky();
    this.envSky.scale.setScalar(150);

    this.hemi = new THREE.HemisphereLight(0xdde7f0, 0x5b5a4c, 1.25);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e2, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.post = new PostFx(this.renderer);
    this.setSun(38, 150);
    this.setQuality(this.quality);

    addEventListener("resize", () => this.resize());
  }

  /** 태양 고도·방위각(도) */
  setSun(elevation: number, azimuth: number) {
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.envDirty = true;
  }

  /** 시간대에 맞춰 하늘·안개·그림자를 정한다. 첫 화면을 그리기 전에 부른다 (그림자를 켜고 끄면 셰이더를 다시 만든다) */
  setNight(night: number) {
    const n = Math.max(0, Math.min(1, night));
    this.night = n;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(FOG_COLOR).lerp(NIGHT_FOG, Math.pow(n, 0.6));
    this.refreshFog();
    // 해가 진 뒤에는 하늘 셰이더 대신 어두운 배경
    this.sky.visible = n < 0.6;
    this.scene.background = this.sky.visible ? null : fog.color;
    this.applyShadow();
    this.envDirty = true;
  }

  /** 흐린 날씨: sky는 하늘(안개)색. setNight 뒤에 부른다 */
  setOvercast(k: number, sky: THREE.Color) {
    this.overcast = Math.max(0, Math.min(1, k));
    this.overcastSky.copy(sky);
    if (this.overcast >= 0.5) {
      this.sky.visible = false;
      this.scene.background = (this.scene.fog as THREE.Fog).color;
    }
    this.envDirty = true;
  }

  /**
   * 그래픽 품질을 바꾼다 (해상도·그림자·도장 코팅·차 그리는 거리·거울·후처리).
   * 언제 불러도 되지만 그림자를 켜고 끄면 셰이더를 다시 만들어 잠깐 멈출 수 있다.
   */
  setQuality(q: Quality) {
    this.quality = q;
    const s = (this.settings = QUALITY[q]);
    this.resolutionScale = 1;
    this.applyPixelRatio();
    if (s.shadowMap && this.sun.shadow.mapSize.x !== s.shadowMap) {
      this.sun.shadow.mapSize.set(s.shadowMap, s.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    if (s.shadowExtent) {
      const sc = this.sun.shadow.camera;
      sc.left = sc.bottom = -s.shadowExtent;
      sc.right = sc.top = s.shadowExtent;
      sc.far = 330 + s.shadowExtent;
      sc.updateProjectionMatrix();
    }
    this.sun.shadow.radius = s.shadowRadius;
    this.applyShadow();
    this.refreshFog();
    for (const e of this.envMats) this.applyCoat(e.mat);
    this.post.enabled = s.post;
    for (const cb of this.qualityListeners) cb(q, s);
  }

  /** 해상도 배율을 바꾼다 (끊길 때 품질의 minScale까지 낮춘다) */
  setResolutionScale(k: number) {
    const v = Math.max(this.settings.minScale, Math.min(1, k));
    if (Math.abs(v - this.resolutionScale) < 0.01) return;
    this.resolutionScale = v;
    this.applyPixelRatio();
  }

  private applyPixelRatio() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.settings.pixelRatio) * this.resolutionScale);
    this.resize();
  }

  /** 날씨 가시거리: 안개가 이 거리(far)에서 다 흐려지고 near부터 흐려지기 시작한다 */
  setVisibility(far: number, near: number) {
    this.fogLimit = { far, near };
    this.refreshFog();
  }

  /**
   * 안개 거리 = 밤(어두우면 가깝게)·날씨 가시거리·품질의 그리는 거리 중 가장 가까운 것.
   * 그리는 거리 너머는 만들지 않으니 안개로 가린다. 높은 품질일수록 낮에 더 멀리까지 맑다.
   */
  private refreshFog() {
    const fog = this.scene.fog as THREE.Fog;
    const n = this.night;
    const day = Math.max(DAY_FOG_FAR, this.settings.viewDistance);
    fog.far = Math.min(day - (day - 900) * n, this.fogLimit.far, this.settings.viewDistance);
    fog.near = Math.min(250 - 200 * n, this.fogLimit.near, fog.far * 0.3);
  }

  /** 지금 보이는 거리 (m): 안개 끝 (날씨·밤·품질에 따라) */
  get visibleDistance(): number {
    return (this.scene.fog as THREE.Fog).far;
  }

  /** 품질이 바뀌면 부른다 (바로 한 번 부른다) */
  onQuality(cb: (q: Quality, s: QualitySettings) => void) {
    this.qualityListeners.push(cb);
    cb(this.quality, this.settings);
  }

  /** 거울(뒤를 보는 카메라)을 그리기 전(true)·후(false)에 부른다. 앞쪽에만 있는 것을 잠시 뺄 때 쓴다 */
  onMirrorPass(cb: (on: boolean) => void) {
    this.mirrorListeners.push(cb);
  }

  mirrorPass(on: boolean) {
    for (const cb of this.mirrorListeners) cb(on);
  }

  private applyShadow() {
    this.sun.castShadow = this.night < 0.5 && this.settings.shadowMap > 0;
  }

  private applyCoat(mat: THREE.MeshStandardMaterial) {
    const pm = mat as THREE.MeshPhysicalMaterial;
    if (pm.isMeshPhysicalMaterial && pm.userData.coat !== false) pm.clearcoat = this.settings.clearcoat ? 1 : 0;
  }

  /**
   * 차 재질을 등록하면 하늘·밤·터널에 맞는 반사를 넣고 품질에 맞춰 클리어코트를 켜고 끈다.
   * k: 반사 세기 배율
   */
  registerVehicleMaterial(mat: THREE.MeshStandardMaterial, k = 1) {
    this.envMats.push({ mat, k });
    this.applyCoat(mat);
    this.applyEnv(true);
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, this.renderer.getPixelRatio());
  }

  /** 원점을 옮긴 뒤 해·그림자 카메라를 카메라 근처로 맞춘다 */
  update(focus: THREE.Vector3) {
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(focus);
    this.sky.position.copy(this.camera.position);
    const k = this.daylight;
    const n = this.night * (1 - this.tunnel);
    this.sun.color.copy(SUN_COLOR).lerp(MOON_COLOR, n);
    this.hemi.color.copy(HEMI_SKY).lerp(HEMI_SKY_NIGHT, n);
    // 밤에는 해 대신 약한 달빛. 터널 안은 밤에도 조명 때문에 낮의 터널과 같다
    this.sun.intensity = (2.4 * k * (1 - n) + 0.3 * n) * (1 - 0.8 * this.overcast);
    this.hemi.intensity = ((0.25 + 1.0 * k) * (1 - n) + (0.013 + 1.79 * k) * n) * (1 + 0.15 * this.overcast);
    this.renderer.toneMappingExposure = (0.9 + (1 - k) * 0.5) * (1 - n) + 1.15 * n;
    this.applyEnv(false);
  }

  /** 지금 상황의 반사 환경맵과 세기 */
  private applyEnv(force: boolean) {
    if (this.envDirty) {
      this.buildEnv();
      this.envDirty = false;
      force = true;
    }
    const inTunnel = this.tunnel > 0.5;
    const tex = (inTunnel ? this.env.tunnel : this.night > 0.6 ? this.env.night : this.env.day)?.texture ?? null;
    // 해가 낮을수록, 밤일수록 반사가 약하다. 터널 안은 조명 반사
    const level = inTunnel ? 0.9 : this.night > 0.6 ? 0.8 : 0.2 + 0.45 * Math.min(1, this.daylight);
    for (const e of this.envMats) {
      const m = e.mat;
      if (force || m.envMap !== tex) m.envMap = tex;
      m.envMapIntensity = e.k * level;
      m.envMapRotation.y = inTunnel ? this.heading : 0;
    }
  }

  /** 반사용 환경맵 세 가지를 굽는다 */
  private buildEnv() {
    const r = this.renderer;
    const prev = r.toneMapping;
    for (const key of ["day", "night", "tunnel"] as const) this.env[key]?.dispose();
    this.env.day = this.pmrem.fromScene(this.dayEnvScene(), 0.02, 0.1, 400, { size: 256 });
    this.env.night = this.pmrem.fromScene(this.nightEnvScene(), 0.03, 0.1, 400, { size: 128 });
    this.env.tunnel = this.pmrem.fromScene(this.tunnelEnvScene(), 0.02, 0.1, 400, { size: 128 });
    r.toneMapping = prev;
  }

  private dayEnvScene(): THREE.Scene {
    const s = new THREE.Scene();
    // 흐린 날은 잿빛 하늘이 비친다
    if (this.overcast >= 0.5) {
      const c = this.overcastSky;
      s.add(gradientDome(c.getHex(), c.clone().multiplyScalar(0.9).getHex(), c.clone().multiplyScalar(0.2).getHex()));
      return s;
    }
    const src = this.sky.material.uniforms;
    const u = this.envSky.material.uniforms;
    for (const k of Object.keys(src)) {
      const v = src[k].value;
      if (v && typeof v === "object" && "copy" in v) (u[k].value as THREE.Vector3).copy(v as THREE.Vector3);
      else u[k].value = v;
    }
    u.showSunDisc.value = 0;
    s.add(this.envSky);
    // 땅 (길·풀 평균 색)과 지평선 숲 띠: 차 옆면에 지평선이 비친다
    const d = Math.min(1, this.daylight);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(300, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3e423d).multiplyScalar(0.4 + 0.6 * d), side: THREE.DoubleSide }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.5;
    s.add(ground);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(200, 200, 12, 48, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3a4a3c).multiplyScalar(0.35 + 0.65 * d), side: THREE.BackSide }));
    band.position.y = 3.5;
    s.add(band);
    return s;
  }

  private nightEnvScene(): THREE.Scene {
    const s = new THREE.Scene();
    s.add(gradientDome(0x0b1220, 0x151c28, 0x030405));
    return s;
  }

  private tunnelEnvScene(): THREE.Scene {
    // 길 방향(x) 터널: 벽·천장과 두 줄 조명
    const s = new THREE.Scene();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(400, 7, 12), new THREE.MeshBasicMaterial({ color: 0x4a463e, side: THREE.BackSide }));
    wall.position.y = 2;
    s.add(wall);
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1cf).multiplyScalar(6) });
    for (const z of [-3.2, 3.2]) {
      for (let x = -190; x <= 190; x += 8) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.4), lampMat);
        lamp.position.set(x, 5.3, z);
        s.add(lamp);
      }
    }
    return s;
  }

  toScene(e: number, n: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(e - this.origin.e, z, -(n - this.origin.n));
  }
}

/** 위·지평선·아래 세 색으로 칠한 큰 공 (밤 반사용) */
function gradientDome(top: number, horizon: number, bottom: number): THREE.Mesh {
  const g = new THREE.SphereGeometry(100, 24, 12);
  const p = g.getAttribute("position");
  const col = new Float32Array(p.count * 3);
  const a = new THREE.Color(top);
  const h = new THREE.Color(horizon);
  const b = new THREE.Color(bottom);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 100;
    if (y >= 0) c.copy(h).lerp(a, Math.pow(y, 0.6));
    else c.copy(h).lerp(b, Math.min(1, -y * 6));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
}

/** 노면·흙 같은 곳에 쓰는 잔잔한 무늬 텍스처 */
export function noiseTexture(size: number, base: number, amp: number, seed = 1, streaks = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size, size);
  let x = seed * 1234567;
  const rand = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
  for (let i = 0; i < size * size; i++) {
    let v = base + (rand() - 0.5) * amp;
    if (streaks) v += Math.sin((i % size) * 0.3) * amp * 0.08;
    const b = Math.max(0, Math.min(255, v));
    img.data[i * 4] = b;
    img.data[i * 4 + 1] = b;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
