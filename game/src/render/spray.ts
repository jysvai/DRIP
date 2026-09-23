// 비 오는 날 차가 튀기는 물보라. 뒷바퀴 뒤에서 뿌옇게 일어나 뒤로 퍼지며 옅어진다.
// 빠를수록, 차가 클수록(트럭·버스) 많고 짙다. 앞차 물보라 때문에 앞이 뿌예지는 것까지. 터널 안에서는 없다.
// 입자는 장면 좌표에 있고, 장면 원점이 플레이어를 따라 움직이므로 매 프레임 원점이 움직인 만큼 되돌린다.

import * as THREE from "three";
import type { World } from "./world";

const CAP = 5000;

/** 물보라를 일으키는 차 하나: 노면 위 자리·방향 행렬(모델 x 앞, y 위, z 오른쪽), 속도(m/s), 크기 */
export interface SpraySource {
  m: THREE.Matrix4;
  v: number;
  len: number;
  width: number;
  /** 트럭·버스 */
  big: boolean;
}

const VERT = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
uniform float uScale;
uniform float uFogNear;
uniform float uFogFar;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = -mv.z;
  // 멀수록 안개에 묻힌다
  vA = aAlpha * (1.0 - smoothstep(uFogNear, uFogFar, dist));
  gl_PointSize = max(1.0, aSize * uScale / max(dist, 0.5));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float a = vA * (1.0 - r2) * (1.0 - r2);
  gl_FragColor = vec4(uColor, a);
}`;

export class SprayView {
  private pos = new Float32Array(CAP * 3);
  private vel = new Float32Array(CAP * 3);
  private ground = new Float32Array(CAP);
  private age = new Float32Array(CAP);
  private life = new Float32Array(CAP);
  private size0 = new Float32Array(CAP);
  private dense = new Float32Array(CAP);
  private alpha = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private n = 0;
  private points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private origin = { e: 0, n: 0, init: false };
  private debt = new WeakMap<THREE.Matrix4, number>();
  /** 노면 젖은 정도(비 0.5, 폭우 1). 0이면 물보라 없음 */
  wet = 0;
  /** 그래픽 품질에 따른 입자 비율 */
  private amount = 1;

  constructor(private world: World) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color(0xb8bec4) }, uScale: { value: 600 }, uFogNear: { value: 60 }, uFogFar: { value: 400 } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    // 점 크기: 그리는 화면(본 화면·거울) 높이와 시야각에 맞춘다
    this.points.onBeforeRender = (r, _s, cam) => {
      const h = r.getRenderTarget()?.height ?? r.domElement.height;
      const fov = (cam as THREE.PerspectiveCamera).fov ?? 60;
      this.mat.uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
    };
    world.scene.add(this.points);
    world.onQuality((_, s) => (this.amount = s.particles));
  }

  get count() {
    return this.n;
  }

  /** dt 초 진행. covered: 터널 안(새로 일지 않음), light: 밝기 0~1 */
  update(dt: number, sources: SpraySource[], covered: boolean, light: number) {
    const o = this.world.origin;
    if (!this.origin.init) {
      this.origin = { e: o.e, n: o.n, init: true };
    }
    // 장면 원점이 움직인 만큼 입자를 되돌린다 (장면 x = e - 원점e, z = -(n - 원점n))
    const de = o.e - this.origin.e;
    const dn = o.n - this.origin.n;
    this.origin.e = o.e;
    this.origin.n = o.n;
    if (dt <= 0 && this.n === 0) return;

    // ---- 새 입자 ----
    if (this.wet > 0 && !covered) for (const s of sources) this.emit(s, dt);

    // ---- 움직임: 공기 저항으로 느려지며 퍼지고, 천천히 가라앉는다 ----
    const drag = Math.exp(-dt * 1.6);
    const P = this.pos;
    const V = this.vel;
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const k = i * 3;
      V[k] *= drag;
      V[k + 1] = V[k + 1] * drag - 0.6 * dt;
      V[k + 2] *= drag;
      P[k] += V[k] * dt - de;
      P[k + 1] = Math.max(this.ground[i] + 0.05, P[k + 1] + V[k + 1] * dt);
      P[k + 2] += V[k + 2] * dt + dn;
      const t = this.age[i] / this.life[i];
      this.size[i] = this.size0[i] * (1 + 3.2 * t);
      this.alpha[i] = this.dense[i] * Math.min(1, this.age[i] / 0.12) * Math.pow(1 - t, 1.5);
      i++;
    }

    // ---- 그리기 ----
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    this.points.visible = this.n > 0;
    if (this.n > 0) {
      for (const name of ["position", "aAlpha", "aSize"]) {
        const attr = g.getAttribute(name) as THREE.BufferAttribute;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, this.n * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
    const fog = this.world.scene.fog as THREE.Fog | null;
    if (fog) {
      this.mat.uniforms.uColor.value.copy(fog.color).multiplyScalar(1.12 * light + 0.04);
      this.mat.uniforms.uFogNear.value = fog.near;
      this.mat.uniforms.uFogFar.value = fog.far;
    }
  }

  /** 차 한 대가 dt 동안 튀기는 물보라 */
  private emit(s: SpraySource, dt: number) {
    const spd = Math.max(0, s.v - 6) / 25;
    if (spd <= 0) return;
    const rate = this.wet * (s.big ? 130 : 50) * spd * spd * this.amount;
    let debt = (this.debt.get(s.m) ?? 0) + rate * dt;
    const e = s.m.elements;
    // 모델 축: x 앞, y 위, z 오른쪽
    const fx = e[0];
    const fy = e[1];
    const fz = e[2];
    const rx = e[8];
    const rz = e[10];
    while (debt >= 1 && this.n < CAP) {
      debt -= 1;
      const i = this.n++;
      const side = Math.random() < 0.5 ? -1 : 1;
      const back = -s.len / 2 + 0.25 + Math.random() * 0.4;
      const across = side * (s.width / 2 - 0.25 - Math.random() * 0.2);
      const up = 0.25 + Math.random() * 0.35;
      const k = i * 3;
      this.pos[k] = e[12] + fx * back + rx * across;
      this.pos[k + 1] = e[13] + fy * back + up;
      this.pos[k + 2] = e[14] + fz * back + rz * across;
      this.ground[i] = e[13] + fy * back;
      // 바퀴가 뒤·옆·위로 흩뿌리고, 공기에 실려 차를 조금 따라간다
      const fwd = s.v * (0.45 + Math.random() * 0.2);
      const out = side * (0.4 + Math.random() * 1.2);
      this.vel[k] = fx * fwd + rx * out + (Math.random() - 0.5) * 0.8;
      this.vel[k + 1] = 0.5 + Math.random() * 1.1;
      this.vel[k + 2] = fz * fwd + rz * out + (Math.random() - 0.5) * 0.8;
      this.age[i] = 0;
      this.life[i] = (s.big ? 1.5 : 1.0) + Math.random() * 0.8;
      this.size0[i] = (s.big ? 1.8 : 1.1) + Math.random() * (s.big ? 0.6 : 0.5);
      this.dense[i] = Math.min(0.9, (s.big ? 0.8 : 0.5) * (0.7 + 0.3 * this.wet) * Math.min(1, spd * 1.2));
      this.size[i] = this.size0[i];
      this.alpha[i] = 0;
    }
    this.debt.set(s.m, Math.min(debt, 3));
  }

  /** i번 입자를 없앤다 (마지막 입자를 그 자리로) */
  private kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    const a = i * 3;
    const b = j * 3;
    for (let c = 0; c < 3; c++) {
      this.pos[a + c] = this.pos[b + c];
      this.vel[a + c] = this.vel[b + c];
    }
    this.ground[i] = this.ground[j];
    this.age[i] = this.age[j];
    this.life[i] = this.life[j];
    this.size0[i] = this.size0[j];
    this.dense[i] = this.dense[j];
    this.size[i] = this.size[j];
    this.alpha[i] = this.alpha[j];
  }
}
