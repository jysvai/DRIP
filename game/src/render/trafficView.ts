// 교통 차량 그리기. 차종마다 인스턴스 메시 두 개(도색·고정)로 그려서 수백 대도 가볍게 그린다.
// 제동등과 방향지시등은 따로 모아서 켜진 것만 그린다.

import * as THREE from "three";
import type { Road } from "../road/road";
import type { Agent } from "../sim/traffic";
import { buildVehicleModel, type VehicleCatalog, type VehicleModel } from "./vehicleModels";
import type { World } from "./world";

const CAPACITY = 40;
/** 이보다 먼 차는 차종 모양 대신 상자로 그린다 (m) */
const LOD_NEAR = 240;
const FAR_CAPACITY = 900;

interface Pool {
  model: VehicleModel;
  paint: THREE.InstancedMesh;
  fixed: THREE.InstancedMesh;
  n: number;
}

export class TrafficView {
  private pools: Pool[] = [];
  private brake: THREE.InstancedMesh;
  private signal: THREE.InstancedMesh;
  private hazardBar: THREE.InstancedMesh;
  private far: THREE.InstancedMesh;
  private scale = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private color = new THREE.Color();
  private tmp = new THREE.Vector3();
  private world3 = { e: 0, n: 0, z: 0, heading: 0 };

  constructor(
    private world: World,
    private road: Road,
    catalog: VehicleCatalog,
  ) {
    const paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.35 });
    const fixedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
    catalog.types.forEach((t, i) => {
      const model = buildVehicleModel(t, i + 1);
      const paint = new THREE.InstancedMesh(model.paint, paintMat, CAPACITY);
      const fixed = new THREE.InstancedMesh(model.fixed, fixedMat, CAPACITY);
      paint.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
      for (const m of [paint, fixed]) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.count = 0;
        world.scene.add(m);
      }
      this.pools.push({ model, paint, fixed, n: 0 });
    });
    const lightGeo = new THREE.BoxGeometry(0.06, 0.12, 0.26);
    this.brake = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff2a1f, toneMapped: false }), 1600);
    this.signal = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.1, 0.14), new THREE.MeshBasicMaterial({ color: 0xffa31a, toneMapped: false }), 1600);
    this.hazardBar = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.11, 0.62), new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false }), 200);
    const farGeo = new THREE.BoxGeometry(1, 1, 1);
    farGeo.translate(0, 0.5, 0);
    this.far = new THREE.InstancedMesh(farGeo, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 }), FAR_CAPACITY);
    this.far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FAR_CAPACITY * 3), 3);
    for (const m of [this.brake, this.signal, this.hazardBar, this.far]) {
      m.frustumCulled = false;
      m.count = 0;
      world.scene.add(m);
    }
  }

  /** 모델 좌표 → 인스턴스 행렬 */
  private place(a: Agent) {
    const road = this.road;
    const s = a.opposite ? -a.s : a.s;
    const w = road.toWorld(Math.max(0, Math.min(road.length - 1, s)), a.d, this.world3);
    const grade = road.sample(Math.max(0, Math.min(road.length - 1, s))).grade;
    const heading = w.heading + (a.opposite ? Math.PI : 0) + a.yaw;
    this.world.toScene(w.e, w.n, w.z, this.p);
    this.e.set(0, heading, Math.atan(grade) * (a.opposite ? -1 : 1));
    this.q.setFromEuler(this.e);
    this.m.compose(this.p, this.q, this.one);
  }

  update(agents: Agent[], opposite: Agent[], time: number, camera: THREE.Vector3, maxDist = 1400) {
    for (const pool of this.pools) pool.n = 0;
    let nb = 0;
    let ns = 0;
    let nh = 0;
    let nf = 0;
    const blink = Math.floor(time * 1.6) % 2 === 0;
    const pm = new THREE.Matrix4();
    const add = (a: Agent) => {
      const pool = this.pools[a.typeIndex];
      if (!pool) return;
      this.place(a);
      // 아주 먼 차는 그리지 않고, 먼 차는 상자로
      this.tmp.setFromMatrixPosition(this.m);
      const d2 = this.tmp.distanceToSquared(camera);
      if (d2 > maxDist * maxDist) return;
      if (d2 > LOD_NEAR * LOD_NEAR || pool.n >= CAPACITY) {
        if (nf >= FAR_CAPACITY) return;
        this.scale.set(a.len, a.type.height, a.width);
        this.m.scale(this.scale);
        this.far.setMatrixAt(nf, this.m);
        this.far.setColorAt(nf, this.color.set(a.type.category === "화물" ? "#9aa0a6" : a.color));
        nf++;
        return;
      }
      pool.paint.setMatrixAt(pool.n, this.m);
      pool.fixed.setMatrixAt(pool.n, this.m);
      pool.paint.setColorAt(pool.n, this.color.set(a.color));
      pool.n++;
      if (a.brake && !a.opposite) {
        for (const lp of pool.model.brakeLights) {
          if (nb >= 1600) break;
          pm.makeTranslation(lp.x, lp.y, lp.z);
          this.brake.setMatrixAt(nb++, pm.premultiply(this.m));
        }
      }
      const sig = a.hazard ? 2 : a.signal;
      if (sig !== 0 && blink) {
        const lights = sig === 2 ? [...pool.model.signalLeft, ...pool.model.signalRight] : sig < 0 ? pool.model.signalLeft : pool.model.signalRight;
        for (const lp of lights) {
          if (ns >= 1600) break;
          pm.makeTranslation(lp.x, lp.y, lp.z);
          this.signal.setMatrixAt(ns++, pm.premultiply(this.m));
        }
      }
      if (a.type.extras?.includes("lightBar") && blink && nh < 200) {
        pm.makeTranslation(0, a.type.height + 0.05, 0);
        this.hazardBar.setMatrixAt(nh++, pm.premultiply(this.m));
      }
    };
    for (const a of agents) add(a);
    for (const a of opposite) add(a);
    for (const pool of this.pools) {
      pool.paint.count = pool.n;
      pool.fixed.count = pool.n;
      pool.paint.visible = pool.fixed.visible = pool.n > 0;
      if (pool.n > 0) {
        pool.paint.instanceMatrix.needsUpdate = true;
        pool.fixed.instanceMatrix.needsUpdate = true;
        if (pool.paint.instanceColor) pool.paint.instanceColor.needsUpdate = true;
      }
    }
    this.brake.count = nb;
    this.signal.count = ns;
    this.hazardBar.count = nh;
    this.far.count = nf;
    this.far.instanceMatrix.needsUpdate = true;
    if (this.far.instanceColor) this.far.instanceColor.needsUpdate = true;
    this.brake.instanceMatrix.needsUpdate = true;
    this.signal.instanceMatrix.needsUpdate = true;
    this.hazardBar.instanceMatrix.needsUpdate = true;
  }

  /** 몇 종류의 차가 지금 화면에 나오는지 (검수용) */
  visibleTypes(): string[] {
    return this.pools.filter((p) => p.n > 0).map((p) => p.model.type.id);
  }
}
