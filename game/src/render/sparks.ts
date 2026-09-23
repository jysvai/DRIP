// 불꽃: 차가 가드레일·중앙분리대에 긁히면 닿은 모서리에서 튀는 쇳불똥. 밤·터널에서는 빛 번짐(후처리)으로 더 빛난다.
// 위치는 절대 좌표(동·북·높이)로 들고 있다가 그릴 때마다 떠다니는 원점에 맞춰 옮긴다.

import * as THREE from "three";
import type { World } from "./world";

const MAX = 320;
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
  private next = 0;
  private alive = 0;
  private points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private tmp = new THREE.Vector3();

  constructor(private world: World) {
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.09,
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
  }

  /**
   * 화면 좌표 p에서 count개를 뿌린다. dir: 차가 가는 방향(화면 좌표, 단위), speed: m/s, out: 벽에서 튕겨 나오는 쪽(화면 좌표, 단위).
   * 불똥은 차 속도의 일부로 앞으로 날아가며 벽 반대쪽·위로 흩어진다.
   */
  emit(p: THREE.Vector3, dir: THREE.Vector3, speed: number, out: THREE.Vector3, count: number) {
    const o = this.world.origin;
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.e[i] = p.x + o.e;
      this.n[i] = -p.z + o.n;
      this.z[i] = p.y;
      const fwd = speed * (0.55 + Math.random() * 0.35);
      const side = 1.5 + Math.random() * 4;
      const up = 0.8 + Math.random() * 3.2;
      // 화면 좌표 (x = 동, z = -북)
      const vx = dir.x * fwd + out.x * side + (Math.random() - 0.5) * 2;
      const vzScene = dir.z * fwd + out.z * side + (Math.random() - 0.5) * 2;
      this.ve[i] = vx;
      this.vn[i] = -vzScene;
      this.vz[i] = up;
      this.life0[i] = this.life[i] = 0.25 + Math.random() * 0.45;
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
