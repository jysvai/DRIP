// 렌더러·하늘·조명·안개. 좌표는 매 프레임 플레이어 위치를 원점으로 옮겨서(떠다니는 원점) 먼 곳에서도 떨림이 없게 한다.
// 화면 좌표: X = 동쪽 - 원점, Y = 고도(m), Z = -(북쪽 - 원점)

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

export interface Origin {
  e: number;
  n: number;
}

export const FOG_COLOR = new THREE.Color(0xc3ccd3);

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  origin: Origin = { e: 0, n: 0 };
  private sky: Sky;
  private sunDir = new THREE.Vector3();
  /** 터널 안처럼 어두운 곳에서 0에 가까워진다 */
  daylight = 1;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

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
    this.setSun(38, 150);

    addEventListener("resize", () => this.resize());
  }

  /** 태양 고도·방위각(도) */
  setSun(elevation: number, azimuth: number) {
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 원점을 옮긴 뒤 해·그림자 카메라를 카메라 근처로 맞춘다 */
  update(focus: THREE.Vector3) {
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(focus);
    this.sky.position.copy(this.camera.position);
    const k = this.daylight;
    this.sun.intensity = 2.4 * k;
    this.hemi.intensity = 0.25 + 1.0 * k;
    this.renderer.toneMappingExposure = 0.9 + (1 - k) * 0.5;
  }

  toScene(e: number, n: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(e - this.origin.e, z, -(n - this.origin.n));
  }
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
