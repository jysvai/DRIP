// 앞유리 빗방울과 와이퍼 (운전석 시점).
// 비가 오면 유리에 방울이 맺힌다. 빠를수록 많이 맺히고, 큰 방울은 맞바람에 위로 밀려 올라간다. 와이퍼가 지나간 자리는 닦인다.
// 한국 차는 왼쪽 운전석: 와이퍼 두 개가 아래에 오른쪽을 보고 누워 있다가 운전석 쪽으로 쓸어 올린다 (운전석 쪽 날이 왼쪽 A필러 가까이까지).
// 비에는 간헐, 폭우에는 빠르게 계속. 터널에서는 새 방울이 없어 유리가 닦이면 멈춘다.
// 유리 좌표: u 오른쪽(차 +z), v 유리를 따라 위, 원점은 앞유리 아래끝 가운데. 단위 m. 방울은 유리 바깥에 있어 기둥·대시보드에 가려진다.

import * as THREE from "three";
import type { CabinSpec } from "./vehicleModels";

const MAX_DROPS = 900;
/** 유리 바깥으로 띄우는 거리 */
const DROP_OUT = 0.012;
const BLADE_OUT = 0.024;

interface Drop {
  u: number;
  v: number;
  r: number;
  age: number;
  /** 맞바람·무게로 미끄러지는 속도 (m/s) */
  vu: number;
  vv: number;
}

interface Blade {
  pu: number;
  pv: number;
  len: number;
  rest: number;
  top: number;
  angle: number;
  pivot: THREE.Group;
}

const VERT = /* glsl */ `
attribute float aAlpha;
varying vec2 vUv;
varying float vA;
void main() {
  vUv = uv;
  vA = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

// 방울: 가운데는 뒤 하늘빛이 비치고, 가장자리는 어둡게 굴절, 위 왼쪽에 반짝이는 점
const FRAG = /* glsl */ `
uniform vec3 uTint;
uniform float uLight;
varying vec2 vUv;
varying float vA;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float rim = smoothstep(0.5, 0.98, r);
  float hl = smoothstep(0.32, 0.0, length(p - vec2(-0.32, 0.36)));
  vec3 col = mix(uTint * 1.25 + 0.06, vec3(0.03, 0.035, 0.04), rim * 0.85) + hl * 0.9;
  float a = (1.0 - smoothstep(0.86, 1.0, r)) * (0.16 + 0.55 * rim + 0.6 * hl) * vA;
  gl_FragColor = vec4(col * uLight, a);
}`;

/** 결정적인 난수 (같은 비면 같은 방울 배치) */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WindshieldRain {
  /** 차 모델 좌표 (PlayerView.inner 안에 넣는다) */
  readonly group = new THREE.Group();
  private drops: Drop[] = [];
  private mesh: THREE.InstancedMesh;
  private alpha: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private blades: Blade[] = [];
  /** 앞유리 아래·위 반폭, 유리 길이 */
  private halfBase: number;
  private halfTop: number;
  private len: number;
  private rand = mulberry32(0x5eed);
  private spawnDebt = 0;
  /** 와이퍼 한 번(올라갔다 내려옴) 안에서의 위치 0~1, 쉬는 중이면 -1 */
  private stroke = -1;
  private wait = 0;
  /** 비가 그친 뒤(터널) 닦은 횟수: 두 번 닦으면 쓸지 않는 구석에 방울이 남아도 멈춘다 */
  private dryStrokes = 0;
  rain = 0;
  /** 와이퍼 날이 끝(아래)에 닿을 때마다: 소리용 */
  onStroke: (() => void) | null = null;

  constructor(cab: CabinSpec, width: number) {
    const [bx, by] = cab.wsBase;
    const [tx, ty] = cab.wsTop;
    const dx = tx - bx;
    const dy = ty - by;
    this.len = Math.hypot(dx, dy);
    const d = new THREE.Vector3(dx / this.len, dy / this.len, 0);
    const big = cab.kind === "truck" || cab.kind === "bus";
    // 앞유리 폭: 옆 기둥에 걸치지 않게 조금 안쪽까지. 승용차는 위로 갈수록 좁아진다
    this.halfBase = width / 2 - (big ? 0.16 : 0.26);
    this.halfTop = this.halfBase - (big ? 0.05 : 0.2);

    // 유리 틀: X 오른쪽(+z), Y 유리 따라 위, Z 차 안쪽 (X × Y)
    const frame = new THREE.Group();
    const across = new THREE.Vector3(0, 0, 1);
    frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, d, new THREE.Vector3().crossVectors(across, d)));
    frame.position.set(bx, by, 0);
    this.group.add(frame);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTint: { value: new THREE.Color(0xa0a8b0) }, uLight: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAlpha", this.alpha);
    this.mesh = new THREE.InstancedMesh(geo, this.mat, MAX_DROPS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    frame.add(this.mesh);

    // 와이퍼: 운전석 쪽은 가운데 왼쪽, 조수석 쪽은 가운데 오른쪽에 축. 쉴 때는 둘 다 오른쪽을 본다
    const B = this.halfBase;
    const L = this.len;
    const wiperMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.55, metalness: 0.3 });
    // 큰 차(트럭·버스)는 유리가 높고 아래쪽은 대시보드에 가려 날이 더 길다
    const specs = [
      { pu: -0.45 * B, pv: 0.05, len: big ? Math.min(1.15 * B, 0.8 * L) : Math.min(0.92 * B, 0.85 * L), rest: 0.04, top: 1.85 },
      { pu: 0.22 * B, pv: 0.035, len: big ? Math.min(0.95 * B, 0.75 * L) : Math.min(0.72 * B, 0.72 * L), rest: 0.02, top: 1.72 },
    ];
    for (const s of specs) {
      const pivot = new THREE.Group();
      pivot.position.set(s.pu, s.pv, -BLADE_OUT);
      // 팔(가늘고 위에 뜸) + 고무 날(유리에 닿음) + 축 덮개
      const arm = new THREE.Mesh(new THREE.BoxGeometry(s.len * 0.98, 0.014, 0.012), wiperMat);
      arm.position.set(s.len * 0.49, 0, -0.012);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(s.len * 0.82, 0.022, 0.016), wiperMat);
      blade.position.set(s.len * 0.58, 0, 0.004);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.03, 10), wiperMat);
      cap.rotation.x = Math.PI / 2;
      pivot.add(arm, blade, cap);
      pivot.rotation.z = s.rest;
      frame.add(pivot);
      this.blades.push({ ...s, angle: s.rest, pivot });
    }
  }

  /** 반폭 (유리 따라 v에서) */
  private halfAt(v: number) {
    return this.halfBase + (this.halfTop - this.halfBase) * Math.min(1, Math.max(0, v / this.len));
  }

  /**
   * dt 초 진행. kmh: 차 속도, covered: 터널 안(새 방울 없음), light: 밝기 0~1, tint: 뒤에 비치는 하늘빛(안개 색)
   */
  update(dt: number, kmh: number, covered: boolean, light: number, tint: THREE.Color | null) {
    const rain = covered ? 0 : this.rain;
    // ---- 새 방울: 달릴수록 빗속을 헤치고 나가 더 많이 맞는다 ----
    if (rain > 0) {
      // 버스처럼 큰 유리도 방울 수는 적당히 (보이는 곳은 대시보드 위 일부)
      const area = Math.min(2, (this.halfBase + this.halfTop) * this.len);
      this.spawnDebt += dt * rain * (35 + 1.7 * kmh) * area;
      const big = 1 + 0.25 * Math.max(0, rain - 0.5);
      while (this.spawnDebt >= 1) {
        this.spawnDebt -= 1;
        const v = this.rand() * this.len * 0.98;
        const u = (this.rand() * 2 - 1) * this.halfAt(v);
        const q = this.rand();
        const drop: Drop = { u, v, r: (0.0018 + 0.005 * q * q) * big, age: 0, vu: 0, vv: 0 };
        if (this.drops.length >= MAX_DROPS) this.drops[Math.floor(this.rand() * MAX_DROPS)] = drop;
        else this.drops.push(drop);
      }
    } else this.spawnDebt = 0;

    // ---- 방울 움직임: 큰 방울은 맞바람에 위·바깥으로, 거의 서 있으면 무게로 아래로 ----
    const wind = Math.max(0, kmh - 55);
    for (const p of this.drops) {
      p.age += dt;
      if (wind > 0 && p.r > 0.0032) {
        p.vv = wind * 0.0065 * (p.r / 0.004);
        p.vu = 0.35 * p.vv * (p.u / this.halfBase);
      } else if (kmh < 15 && p.r > 0.0045) {
        p.vv = -0.012;
        p.vu = 0;
      } else {
        p.vv = 0;
        p.vu = 0;
      }
      p.u += p.vu * dt;
      p.v += p.vv * dt;
    }

    // ---- 와이퍼 ----
    this.stepWipers(dt, rain, kmh);

    // 유리 밖으로 나간 방울은 없앤다
    this.drops = this.drops.filter((p) => p.v > -0.01 && p.v < this.len && Math.abs(p.u) < this.halfAt(p.v) + 0.02);

    // ---- 그리기 ----
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const al = this.alpha.array as Float32Array;
    this.drops.forEach((p, i) => {
      const moving = p.vv !== 0 || p.vu !== 0;
      const a = moving ? Math.atan2(p.vv, p.vu) : 0;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const sx = 2 * p.r * (moving ? 1 + Math.min(2.2, Math.abs(p.vv) * 6) : 1);
      const sy = 2 * p.r;
      const o = i * 16;
      arr[o] = c * sx;
      arr[o + 1] = s * sx;
      arr[o + 2] = 0;
      arr[o + 3] = 0;
      arr[o + 4] = -s * sy;
      arr[o + 5] = c * sy;
      arr[o + 6] = 0;
      arr[o + 7] = 0;
      arr[o + 8] = 0;
      arr[o + 9] = 0;
      arr[o + 10] = 1;
      arr[o + 11] = 0;
      arr[o + 12] = p.u;
      arr[o + 13] = p.v;
      arr[o + 14] = -DROP_OUT;
      arr[o + 15] = 1;
      al[i] = Math.min(1, p.age / 0.08);
    });
    this.mesh.count = this.drops.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.mat.uniforms.uLight.value = light;
    if (tint) this.mat.uniforms.uTint.value.copy(tint);
  }

  /** 지금 유리에 있는 방울 수 (시험용) */
  get dropCount() {
    return this.drops.length;
  }

  /** 와이퍼가 움직이는 중인가 */
  get wiping() {
    return this.stroke >= 0;
  }

  private stepWipers(dt: number, rain: number, kmh: number) {
    // 폭우: 빠르게 계속 (한 번 0.95초). 비: 한 번 1.5초에 느리면 오래, 빠르면 짧게 쉰다 (간헐)
    // 터널처럼 비가 그쳤으면 유리에 남은 방울을 두 번 더 닦고 멈춘다
    const heavy = rain >= 0.8;
    if (rain > 0) this.dryStrokes = 0;
    const want = rain > 0 || (this.dryStrokes < 2 && this.drops.length > 12);
    const period = heavy ? 0.95 : 1.5;
    const pause = heavy ? 0 : rain > 0 ? Math.max(0.35, 2.2 - kmh * 0.018) : 1.5;
    if (this.stroke < 0) {
      if (!want) return;
      this.wait += dt;
      if (this.wait < pause) return;
      this.wait = 0;
      this.stroke = 0;
    }
    const prev = this.stroke;
    this.stroke += dt / period;
    const done = this.stroke >= 1;
    if (done) {
      this.stroke = -1;
      if (rain === 0) this.dryStrokes++;
    }
    const f = done ? 0 : (1 - Math.cos(2 * Math.PI * this.stroke)) / 2;
    for (const b of this.blades) {
      const a0 = b.angle;
      const a1 = b.rest + f * (b.top - b.rest);
      b.angle = a1;
      b.pivot.rotation.z = a1;
      this.wipe(b, Math.min(a0, a1) - 0.03, Math.max(a0, a1) + 0.03);
    }
    // 위에 닿았다가 내려오는 두 번 모두 '툭' (올라갈 때 끝: stroke 0.5 지날 때, 내려와 끝: done)
    if ((prev < 0.5 && this.stroke >= 0.5) || done) this.onStroke?.();
  }

  /** 날이 쓸고 간 부채꼴 (축에서 날 길이의 18%부터 끝까지) 안의 방울을 없앤다 */
  private wipe(b: Blade, lo: number, hi: number) {
    const r0 = b.len * 0.18;
    const r1 = b.len + 0.015;
    this.drops = this.drops.filter((p) => {
      const du = p.u - b.pu;
      const dv = p.v - b.pv;
      const r = Math.hypot(du, dv);
      if (r < r0 || r > r1) return true;
      const a = Math.atan2(dv, du);
      return a < lo || a > hi;
    });
  }
}
