// 불꽃: 차가 가드레일·중앙분리대에 긁히면 닿은 모서리에서 튀는 쇳불똥. 밤·터널에서는 빛 번짐(후처리)으로 더 빛나고,
// 닿은 곳에 깜빡이는 주황 불빛이 차 옆면과 난간을 비춘다.
// 위치는 절대 좌표(동·북·높이)로 들고 있다가 그릴 때마다 떠다니는 원점에 맞춰 옮긴다.

import * as THREE from "three";
import type { World } from "./world";

const MAX = 640;

/** 가운데가 밝고 가장자리로 흐려지는 둥근 점 */
function dotTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
const G = 9.81;

export class Sparks {
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  /** 절대 좌표 (e, z, n)와 속도 (ve, vz, vn), 남은 수명·처음 수명 */
  private e = new Float64Array(MAX);
  private n = new Float64Array(MAX);
  private z = new Float32Array(MAX);
  private ve = new Float32Array(MAX);
  private vn = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private life0 = new Float32Array(MAX);
  /** 떨어지면 튀어 오르는 노면 높이 */
  private ground = new Float32Array(MAX);
  private next = 0;
  private alive = 0;
  private points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private tmp = new THREE.Vector3();
  /** 닿은 곳을 비추는 불빛 (조명 수가 바뀌면 셰이더를 다시 만들므로 처음부터 넣어 두고 세기만 바꾼다) */
  private light = new THREE.PointLight(0xff8a2a, 0, 7, 2);
  private lightAbs = { e: 0, n: 0, z: 0 };
  private lightLevel = 0;

  constructor(private world: World) {
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      map: dotTexture(),
      size: 0.11,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    world.scene.add(this.points);
    world.scene.add(this.light);
  }

  /**
   * 화면 좌표 p에서 count개를 뿌린다. dir: 차가 가는 방향(화면 좌표, 단위), speed: m/s, out: 벽에서 튕겨 나오는 쪽(화면 좌표, 단위),
   * ground: 노면 높이. 불똥은 차보다 느리게 앞으로 날아가(차에서 보면 뒤로 흩날린다) 조금 위·바깥으로 퍼지고 노면에서 튄다.
   */
  emit(p: THREE.Vector3, dir: THREE.Vector3, speed: number, out: THREE.Vector3, count: number, ground: number) {
    const o = this.world.origin;
    this.lightAbs = { e: p.x + o.e, n: -p.z + o.n, z: p.y + 0.1 };
    this.lightLevel = Math.min(1, this.lightLevel + count * 0.08);
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.e[i] = p.x + o.e;
      this.n[i] = -p.z + o.n;
      this.z[i] = p.y;
      const fwd = speed * (0.35 + Math.random() * 0.45);
      const side = 0.3 + Math.random() * 1.6;
      const up = 0.6 + Math.random() * 2.6;
      // 화면 좌표 (x = 동, z = -북)
      const vx = dir.x * fwd + out.x * side + (Math.random() - 0.5) * 0.8;
      const vzScene = dir.z * fwd + out.z * side + (Math.random() - 0.5) * 0.8;
      this.ve[i] = vx;
      this.vn[i] = -vzScene;
      this.vz[i] = up;
      this.life0[i] = this.life[i] = 0.3 + Math.random() * 0.5;
      this.ground[i] = ground;
    }
  }

  update(dt: number) {
    const o = this.world.origin;
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      // 공기 저항과 중력
      const drag = Math.exp(-dt * 2.2);
      this.ve[i] *= drag;
      this.vn[i] *= drag;
      this.vz[i] = this.vz[i] * drag - G * dt;
      this.e[i] += this.ve[i] * dt;
      this.n[i] += this.vn[i] * dt;
      this.z[i] += this.vz[i] * dt;
      if (this.z[i] < this.ground[i] + 0.02 && this.vz[i] < 0) {
        this.z[i] = this.ground[i] + 0.02;
        this.vz[i] *= -0.35;
      }
      this.pos[i * 3] = this.e[i] - o.e;
      this.pos[i * 3 + 1] = this.z[i];
      this.pos[i * 3 + 2] = -(this.n[i] - o.n);
      // 흰 노랑에서 주황·빨강으로 식는다
      const f = Math.max(0, this.life[i] / this.life0[i]);
      const hot = f * f;
      this.col[i * 3] = 4 * (0.6 + 0.4 * f);
      this.col[i * 3 + 1] = 4 * (0.18 + 0.62 * hot);
      this.col[i * 3 + 2] = 4 * 0.35 * hot * hot;
      const fade = Math.min(1, f * 3);
      this.col[i * 3] *= fade;
      this.col[i * 3 + 1] *= fade;
      this.col[i * 3 + 2] *= fade;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    // 불빛: 뿌리는 동안 깜빡이며 켜지고, 멈추면 금방 꺼진다
    this.lightLevel *= Math.exp(-dt * 10);
    const L = this.light;
    L.intensity = this.lightLevel > 0.02 ? this.lightLevel * (6 + 5 * Math.random()) : 0;
    L.position.set(this.lightAbs.e - o.e, this.lightAbs.z, -(this.lightAbs.n - o.n));
    if (alive) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }

  /** 살아 있는 불똥 수 */
  get count() {
    return this.alive;
  }

  /** 차 모델 좌표의 점을 화면 좌표로 */
  worldPoint(obj: THREE.Object3D, x: number, y: number, z: number): THREE.Vector3 {
    return obj.localToWorld(this.tmp.set(x, y, z));
  }
}
