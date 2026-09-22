// 날씨 화면: 잿빛 하늘과 안개(가시거리), 흐린 날 약한 햇빛, 빗줄기.
// 빗줄기는 카메라 둘레 상자 안에서 떨어지는 짧은 선이다. 빗방울은 땅에 대해 멈춰 있고(차가 달리면 뒤로 스친다),
// 상자를 벗어나면 반대쪽에서 다시 나온다. 차 안(운전석 시점)이나 차체를 뚫고 내리지 않게 차 둘레는 비운다.

import * as THREE from "three";
import type { Weather } from "../sim/weather";
import type { World } from "./world";

const OVERCAST = new THREE.Color(0xa7afb6);
const MIST = new THREE.Color(0xc9ced1);
const NIGHT = new THREE.Color(0x06090e);
const BOX = new THREE.Vector3(44, 22, 44);
/** 빗방울 떨어지는 속도 (m/s) */
const FALL = 8.5;
/** 줄 길이를 정하는 노출 시간 (초): 상대 속도 × 이 값 */
const STREAK_SEC = 0.03;

const VERT = /* glsl */ `
uniform vec3 uOffset;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uStreak;
uniform vec3 uCarPos;
uniform vec2 uCarDir;
uniform vec3 uCarHalf;
attribute float aEnd;
varying float vFade;
void main() {
  vec3 p = mod(position + uOffset - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 wp = uCenter + p;
  // 차 둘레(차체 + 여유)는 비운다
  vec2 rel = wp.xz - uCarPos.xz;
  float along = dot(rel, uCarDir);
  float side = dot(rel, vec2(-uCarDir.y, uCarDir.x));
  bool inCar = abs(along) < uCarHalf.x && abs(side) < uCarHalf.y && wp.y < uCarPos.y + uCarHalf.z;
  wp -= uStreak * aEnd;
  vFade = (1.0 - smoothstep(0.25, 0.5, length(p.xz) / uBox.x)) * (1.0 - smoothstep(0.3, 0.5, abs(p.y) / uBox.y));
  gl_Position = inCar ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vFade);
}`;

export class WeatherView {
  private rain: THREE.LineSegments | null = null;
  private uniforms = {
    uOffset: { value: new THREE.Vector3() },
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: BOX.clone() },
    uStreak: { value: new THREE.Vector3() },
    uCarPos: { value: new THREE.Vector3() },
    uCarDir: { value: new THREE.Vector2(1, 0) },
    uCarHalf: { value: new THREE.Vector3(2.7, 1.2, 2) },
    uColor: { value: new THREE.Color(0xc8d2dc) },
    uOpacity: { value: 0.3 },
  };
  private fallY = 0;
  private lastE = NaN;
  private lastN = NaN;
  private vel = new THREE.Vector3();
  private dir = new THREE.Vector2(1, 0);

  constructor(
    private world: World,
    readonly weather: Weather,
  ) {
    if (weather.rain > 0) this.makeRain(Math.round(3000 + 9000 * weather.rain));
  }

  /** 하늘·안개. World.setNight 뒤에 한 번 부른다 */
  apply(night: number) {
    const w = this.weather;
    const scene = this.world.scene;
    const fog = scene.fog as THREE.Fog;
    if (w.overcast > 0) {
      const gray = (w.kind === "fog" ? MIST : OVERCAST).clone().lerp(NIGHT, Math.pow(Math.min(1, night), 0.6));
      fog.color.lerp(gray, Math.min(1, w.overcast * 1.1));
    }
    // 가시거리: 물체가 거의 다 흐려지는 거리가 가시거리쯤이 되게
    fog.far = Math.min(fog.far, w.visibilityM * 1.15);
    fog.near = Math.min(fog.near, w.visibilityM * 0.08);
    this.world.setOvercast(w.overcast, fog.color);
    const u = this.uniforms;
    const dark = Math.min(1, night);
    u.uColor.value.setRGB(0.78, 0.82, 0.86).multiplyScalar(1 - 0.55 * dark);
    u.uOpacity.value = (0.22 + 0.16 * w.rain) * (1 - 0.35 * dark);
  }

  /** 젖은 노면이 비출 하늘: 위는 지금 안개(하늘)색, 지평선 아래는 어둡게. apply 뒤에 부른다 */
  roadEnvironment(): THREE.Texture {
    const sky = (this.world.scene.fog as THREE.Fog).color;
    const g = new THREE.SphereGeometry(100, 24, 12);
    const p = g.getAttribute("position");
    const col = new Float32Array(p.count * 3);
    const top = sky.clone();
    const ground = sky.clone().multiplyScalar(0.18);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 100;
      if (y >= 0) c.copy(top).multiplyScalar(0.85 + 0.15 * y);
      else c.copy(top).lerp(ground, Math.min(1, -y * 5));
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const pmrem = new THREE.PMREMGenerator(this.world.renderer);
    const rt = pmrem.fromScene(scene, 0.02, 0.1, 300, { size: 128 });
    pmrem.dispose();
    g.dispose();
    return rt.texture;
  }

  /** 빗줄기: 원점(플레이어 위치)·카메라·차 위치로 맞춘다. dt 초 */
  update(dt: number, car: THREE.Object3D, carHeading: number, carLen: number, carWidth: number, carHeight: number, inTunnel: boolean) {
    if (!this.rain) return;
    const o = this.world.origin;
    if (dt > 0 && Number.isFinite(this.lastE)) {
      const ve = (o.e - this.lastE) / dt;
      const vn = (o.n - this.lastN) / dt;
      // 순간이동(사고 뒤 다시 출발)은 무시
      if (Math.hypot(ve, vn) < 90) this.vel.set(ve, 0, -vn);
    }
    this.lastE = o.e;
    this.lastN = o.n;
    this.fallY = (this.fallY + FALL * dt) % BOX.y;
    const u = this.uniforms;
    const m = (x: number, b: number) => ((x % b) + b) % b;
    u.uOffset.value.set(m(-o.e, BOX.x), m(-this.fallY, BOX.y), m(o.n, BOX.z));
    u.uCenter.value.copy(this.world.camera.position);
    // 빗방울이 카메라에 대해 움직이는 방향: 아래로 떨어지고, 차가 달리는 만큼 뒤로
    u.uStreak.value.set(-this.vel.x, -FALL, -this.vel.z).multiplyScalar(STREAK_SEC);
    u.uCarPos.value.copy(car.position);
    this.dir.set(Math.cos(carHeading), -Math.sin(carHeading));
    u.uCarDir.value.copy(this.dir);
    u.uCarHalf.value.set(carLen / 2 + 0.4, carWidth / 2 + 0.35, carHeight + 0.3);
    // 터널 안에는 비가 오지 않는다
    this.rain.visible = !inTunnel;
  }

  private makeRain(n: number) {
    const pos = new Float32Array(n * 6);
    const end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * BOX.x;
      const y = Math.random() * BOX.y;
      const z = Math.random() * BOX.z;
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    // 상자가 카메라를 따라다니므로 잘라내지 않는다
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false });
    this.rain = new THREE.LineSegments(g, mat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 5;
    this.world.scene.add(this.rain);
  }
}
