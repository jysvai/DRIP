// 교통 차량 그리기. 차종마다 가까이(제 모양)·중간 거리(단순한 모양) 인스턴스 메시로 그리고, 먼 차는 공용 모양 두 가지로 그린다.
// 바퀴는 모든 차가 함께 쓰는 인스턴스 메시 두 개(승용·대형)라서 굴러가고 앞바퀴가 꺾인다.
// 제동등·방향지시등은 인스턴스마다 켜짐 상태를 넘겨서 차 재질이 켠다. 차체는 제동·가속·차로 변경에 따라 조금 기울어진다.

import * as THREE from "three";
import type { Road, RoadSample } from "../road/road";
import type { Agent } from "../sim/traffic";
import { LAMP_ATTR, createVehicleMaterial, setLampLevels } from "./carMaterials";
import { Mesher, TAG, box, paintSurf, type Surf } from "./vehicleGeom";
import { buildVehicleModel, wheelGeometry, type VehicleCatalog, type VehicleModel } from "./vehicleModels";
import type { World } from "./world";

const NEAR_CAP = 32;
const MID_CAP = 96;
const FAR_CAP = 1500;
const WHEEL_CAP = 700;
const GLOW_CAPACITY = 8000;
const REFLECT_CAPACITY = 1500;

/** 젖은 노면에 비친 등화: 등 아래 노면에서 카메라 쪽으로 길게 누운 띠 (화면에서는 세로 줄). 더해서 그린다 */
function reflectMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        vColor = instanceColor;
        // 노면 굴곡·편경사 때문에 노면 아래로 조금 들어가도 보이게, 같은 시선 위에서 카메라 쪽으로 35cm 당긴다 (화면 위치는 그대로)
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        mv.xyz *= max(0.0, 1.0 - 0.35 / max(0.4, length(mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        // 길이: 등 아래에서 곧 밝아졌다가 카메라 쪽으로 옅어진다. 폭: 가운데가 밝다
        float along = smoothstep(0.0, 0.06, vUv.x) * pow(1.0 - vUv.x, 1.6);
        float w = (vUv.y - 0.5) * 2.0;
        float a = along * exp(-w * w * 5.0);
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/** 밤의 전조등·미등 빛 번짐. 가까우면 크기가 m 단위로, 멀어도 몇 픽셀은 남는다 */
function glowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    // height: 그리는 곳(화면·거울·빛 번짐용 작은 화면)의 세로 픽셀, minPx: 가장 작은 점 크기
    uniforms: { height: { value: 800 }, minPx: { value: 3 } },
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      uniform float height;
      uniform float minPx;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // 거리 1m에서 1m가 몇 픽셀인지 = 세로 픽셀 / 2 / tan(fov/2)
        float px = size * 0.5 * height * projectionMatrix[1][1] / max(0.1, -mv.z);
        gl_PointSize = max(px, minPx);
        vColor = color * clamp(px / minPx, 0.4, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - r), 2.2);
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

interface Inst {
  mesh: THREE.InstancedMesh;
  lamp: THREE.InstancedBufferAttribute;
  n: number;
  /** 앞쪽 n개 중 카메라 뒤에 있는 차 수 (뒤차를 먼저 채운다) */
  nb: number;
  cap: number;
}

interface Pool {
  model: VehicleModel;
  near: Inst | null;
  mid: Inst | null;
  /** 바퀴 반지름 (회전 계산 기준) */
  r0: number;
  /** 앞뒤 축 거리 */
  wb: number;
  pivotY: number;
}

/** 한 프레임에 그릴 차 (가까운 순으로 정렬해 앞에서부터 그린다) */
interface Slot {
  a: Agent;
  pool: Pool;
  d2: number;
  m: THREE.Matrix4;
  kappa: number;
  /** 카메라보다 뒤 (거울에 비칠 수 있다) */
  back: boolean;
}

/** 차마다 기억하는 움직임 */
interface Vis {
  t: number;
  spin: number;
  pitch: number;
  pv: number;
  roll: number;
  rv: number;
  yaw: number;
  steer: number;
  color: THREE.Color;
  colorKey: string;
}

// 뒤차 먼저 (거울은 그 앞부분만 그린다), 그 안에서는 가까운 차부터
const byDist = (x: Slot, y: Slot) => (x.back === y.back ? x.d2 - y.d2 : x.back ? -1 : 1);

export class TrafficView {
  private pools: (Pool | null)[] = [];
  private bodyMat: THREE.MeshPhysicalMaterial;
  private wheelMat: THREE.MeshPhysicalMaterial;
  private wheels: { car: Inst; heavy: Inst };
  private far: { car: Inst; tall: Inst };
  private vis = new WeakMap<Agent, Vis>();
  private m = new THREE.Matrix4();
  private bm = new THREE.Matrix4();
  private wm = new THREE.Matrix4();
  private tm = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YZX");
  private p = new THREE.Vector3();
  private sv = new THREE.Vector3();
  private color = new THREE.Color();
  private tmp = new THREE.Vector3();
  private world3 = { e: 0, n: 0, z: 0, heading: 0 };
  private rs = {} as RoadSample;
  private glow: THREE.Points;
  private reflect: THREE.InstancedMesh;
  private nr = 0;
  private rm = new THREE.Matrix4();
  private rx = new THREE.Vector3();
  private ry = new THREE.Vector3();
  private rz = new THREE.Vector3();
  private rc = new THREE.Color();
  /** 노면 젖은 정도 0~1 (비·폭우). 밤에 등화가 노면에 길게 비친다 */
  wet = 0;
  /** 카메라 아래(내 차) 노면 높이: 반사 띠가 오르막·내리막을 따라 기울게 */
  viewGround = 0;
  private glowPos = new Float32Array(GLOW_CAPACITY * 3);
  private glowColor = new Float32Array(GLOW_CAPACITY * 3);
  private glowSize = new Float32Array(GLOW_CAPACITY);
  private ng = 0;
  private lp = new THREE.Vector3();
  private lastTime = -1;
  private dt = 0;
  private slots: Slot[] = [];
  private list: Slot[] = [];
  private kappa = 0;
  private back = false;
  private fwd = new THREE.Vector3();
  private insts: Inst[] = [];

  constructor(
    private world: World,
    private road: Road,
    private catalog: VehicleCatalog,
  ) {
    this.bodyMat = createVehicleMaterial({ lamps: true });
    this.wheelMat = createVehicleMaterial({});
    world.registerVehicleMaterial(this.bodyMat, 1);
    world.registerVehicleMaterial(this.wheelMat, 0.8);
    this.pools = catalog.types.map(() => null);
    this.wheels = {
      car: this.inst(wheelGeometry("car"), WHEEL_CAP, true, this.wheelMat, false, -0.7),
      heavy: this.inst(wheelGeometry("heavy"), WHEEL_CAP, true, this.wheelMat, false, -0.7),
    };
    this.far = {
      car: this.inst(farCar(), FAR_CAP, false, this.bodyMat, true, -0.5),
      tall: this.inst(farTall(), FAR_CAP, false, this.bodyMat, true, -0.5),
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.glowPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.glowColor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("size", new THREE.BufferAttribute(this.glowSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.glow = new THREE.Points(g, glowMaterial());
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 10;
    // 그리는 곳마다 점 크기를 맞춘다 (거울·작은 화면에서 너무 커지지 않게)
    this.glow.onBeforeRender = (r) => {
      const mat = this.glow.material as THREE.ShaderMaterial;
      const full = r.domElement.height;
      const h = r.getRenderTarget()?.height ?? full;
      mat.uniforms.height.value = h;
      mat.uniforms.minPx.value = Math.max(1, (3 * h) / full);
      mat.uniformsNeedUpdate = true;
    };
    world.scene.add(this.glow);
    // 젖은 노면 반사: 길이 방향 x(0~1), 폭 z(-0.5~0.5)로 누운 판
    const rg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
    this.reflect = new THREE.InstancedMesh(rg, reflectMaterial(), REFLECT_CAPACITY);
    this.reflect.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.reflect.setColorAt(0, this.rc.set(0, 0, 0));
    this.reflect.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.reflect.count = 0;
    this.reflect.frustumCulled = false;
    this.reflect.visible = false;
    this.reflect.renderOrder = 9;
    world.scene.add(this.reflect);
    // 거울에는 뒤차만 넘긴다 (앞차까지 꼭짓점 계산을 하지 않게)
    world.onMirrorPass((on) => {
      for (const i of this.insts) if (i.n > 0) i.mesh.count = on ? i.nb : i.n;
    });
  }

  /** 인스턴스 메시 하나 (등화 상태 속성·도색 색 포함) */
  private inst(geo: THREE.BufferGeometry, cap: number, shadow: boolean, mat: THREE.Material, color: boolean, order = -0.6): Inst {
    const g = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "color", "surf"]) g.setAttribute(name, geo.getAttribute(name));
    const lamp = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    lamp.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(LAMP_ATTR, lamp);
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (color) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    // 도로·지형보다 먼저 그려 가려지는 화소를 덜 칠한다 (가까운 것일수록 먼저)
    mesh.renderOrder = order;
    mesh.count = 0;
    mesh.visible = false;
    this.world.scene.add(mesh);
    const inst = { mesh, lamp, n: 0, nb: 0, cap };
    this.insts.push(inst);
    return inst;
  }

  /** 차종 모델은 처음 나올 때 만든다 */
  private pool(i: number): Pool | null {
    const have = this.pools[i];
    if (have !== undefined && have !== null) return have;
    const t = this.catalog.types[i];
    if (!t) return null;
    const model = buildVehicleModel(t, i + 1);
    const w0 = model.wheels[0];
    const xs = model.wheels.map((w) => w.x);
    const p: Pool = { model, near: null, mid: null, r0: w0?.r ?? 0.33, wb: xs.length ? Math.max(...xs) - Math.min(...xs) : t.wheelbase, pivotY: (w0?.r ?? 0.33) + 0.1 };
    this.pools[i] = p;
    return p;
  }

  private addGlow(p: THREE.Vector3, r: number, g: number, b: number, size: number) {
    if (this.ng >= GLOW_CAPACITY) return;
    const i = this.ng++;
    this.glowPos[i * 3] = p.x;
    this.glowPos[i * 3 + 1] = p.y;
    this.glowPos[i * 3 + 2] = p.z;
    this.glowColor[i * 3] = r;
    this.glowColor[i * 3 + 1] = g;
    this.glowColor[i * 3 + 2] = b;
    this.glowSize[i] = size;
  }

  /**
   * 젖은 노면에 비친 등 하나: 등 바로 아래 노면에서 카메라 쪽으로 눕힌 띠. 멀수록, 등이 높을수록 길다.
   * ground: 그 차 노면 높이, k: 밝기 (색에 곱한다)
   */
  private addReflection(p: THREE.Vector3, ground: number, camera: THREE.Vector3, r: number, g: number, b: number, width: number) {
    if (this.nr >= REFLECT_CAPACITY) return;
    const dx = camera.x - p.x;
    const dz = camera.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 3) return;
    const h = Math.max(0.3, p.y - ground);
    const len = Math.min(dist * 0.85, (3 + 0.22 * dist) * Math.min(1.6, h / 0.7));
    // 띠 방향: 등 아래 노면에서 내 차 아래 노면 쪽으로 (기울기 포함). 판의 윗면(+y)이 위를 보게
    const X = this.rx.set(dx, this.viewGround - ground, dz).normalize();
    const Y = this.ry.set(0, 1, 0).addScaledVector(X, -X.y).normalize();
    const Z = this.rz.crossVectors(X, Y);
    this.rm.makeBasis(X.multiplyScalar(len), Y, Z.multiplyScalar(width)).setPosition(p.x, ground + 0.06, p.z);
    const i = this.nr++;
    this.reflect.setMatrixAt(i, this.rm);
    this.reflect.setColorAt(i, this.rc.setRGB(r, g, b));
  }

  /** 밤: 카메라 쪽을 보는 전조등, 카메라 쪽으로 등을 보이는 미등(제동하면 더 밝게). this.m은 크기 조절 전 행렬 */
  private nightLights(a: Agent, model: VehicleModel, camera: THREE.Vector3, night: number) {
    const e = this.m.elements;
    const dx = camera.x - e[12];
    const dy = camera.y - e[13];
    const dz = camera.z - e[14];
    const dist = Math.hypot(dx, dy, dz) || 1;
    const facing = (e[0] * dx + e[1] * dy + e[2] * dz) / dist; // 차 앞쪽이 카메라를 볼수록 1
    const head = Math.min(1, Math.max(0, facing * 4)) * night;
    const tail = Math.min(1, Math.max(0, -facing * 4)) * night;
    const wet = this.wet * (1 - this.world.tunnel);
    if (head > 0.01) {
      for (const p of model.headLights) {
        this.lp.copy(p).applyMatrix4(this.m);
        this.addGlow(this.lp, 1.0 * head, 0.95 * head, 0.82 * head, 1.5);
        if (wet > 0) this.addReflection(this.lp, e[13], camera, 0.85 * head * wet, 0.8 * head * wet, 0.7 * head * wet, 0.55);
      }
    }
    if (tail > 0.01) {
      const k = a.brake ? 1 : 0.4;
      for (const p of model.brakeLights) {
        this.lp.copy(p).applyMatrix4(this.m);
        this.addGlow(this.lp, 1.0 * tail * k, 0.08 * tail * k, 0.04 * tail * k, a.brake ? 1.1 : 0.75);
        if (wet > 0) this.addReflection(this.lp, e[13], camera, 1.3 * tail * (0.35 + k) * wet, 0.08 * tail * (0.35 + k) * wet, 0.04 * tail * (0.35 + k) * wet, 0.4);
      }
    }
  }

  /** 도로 위 자리 → this.m (차체 기울기 전) */
  private place(a: Agent) {
    const road = this.road;
    const s = Math.max(0, Math.min(road.length - 1, a.opposite ? -a.s : a.s));
    const w = road.toWorld(s, a.d, this.world3);
    road.sample(s, this.rs);
    const heading = w.heading + (a.opposite ? Math.PI : 0) + a.yaw;
    this.world.toScene(w.e, w.n, w.z, this.p);
    this.e.set(0, heading, Math.atan(this.rs.grade) * (a.opposite ? -1 : 1));
    this.q.setFromEuler(this.e);
    this.m.compose(this.p, this.q, this.sv.set(1, 1, 1));
  }

  /** 차마다 남기는 보이는 상태 (색·서스펜션) */
  private visOf(a: Agent): Vis {
    let v = this.vis.get(a);
    if (!v) {
      v = { t: -1, spin: Math.random() * 6, pitch: 0, pv: 0, roll: 0, rv: 0, yaw: a.yaw, steer: 0, color: new THREE.Color(a.color), colorKey: a.color };
      this.vis.set(a, v);
    }
    if (v.colorKey !== a.color) {
      v.color.set(a.color);
      v.colorKey = a.color;
    }
    return v;
  }

  /** 서스펜션: 가감속에 앞뒤로, 곡선·차로 변경에 좌우로 조금 기운다 (용수철-감쇠). 가까운 차만 */
  private motion(a: Agent, pool: Pool): Vis {
    const v = this.visOf(a);
    const dt = this.dt;
    if (dt <= 0) return v;
    // 한동안 멀리 있다가 다가온 차는 방향 변화를 새로 잰다
    if (this.lastTime - v.t > 0.25) v.yaw = a.yaw;
    v.t = this.lastTime;
    const speed = Math.max(a.v, 0.5);
    const yawRate = (a.yaw - v.yaw) / dt;
    v.yaw = a.yaw;
    const kPath = this.kappa * (a.opposite ? -1 : 1) + yawRate / speed;
    const heavy = a.heavy ? 0.55 : 1;
    const pitchT = Math.max(-0.03, Math.min(0.025, a.acc * 0.0042 * heavy));
    const rollT = Math.max(-0.04, Math.min(0.04, a.v * a.v * kPath * 0.009 * (a.heavy ? 1.3 : 1)));
    const w = 7;
    const z = 0.5;
    v.pv += (w * w * (pitchT - v.pitch) - 2 * z * w * v.pv) * dt;
    v.pitch += v.pv * dt;
    v.rv += (w * w * (rollT - v.roll) - 2 * z * w * v.rv) * dt;
    v.roll += v.rv * dt;
    v.steer += (Math.max(-0.5, Math.min(0.5, pool.wb * kPath * 1.1)) - v.steer) * Math.min(1, dt * 6);
    // 바퀴살이 거꾸로 도는 것처럼 보이지 않게 한 프레임에 0.5rad까지만
    v.spin += Math.min(0.5, (a.v * dt) / pool.r0);
    return v;
  }

  update(agents: Agent[], opposite: Agent[], time: number, camera: THREE.Vector3, maxDist?: number) {
    const set = this.world.settings;
    const draw = Math.min(maxDist ?? set.drawDistance, set.drawDistance);
    const near2 = set.lodNear * set.lodNear;
    const mid2 = set.lodMid * set.lodMid;
    this.dt = this.lastTime < 0 ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    for (const i of this.insts) i.n = i.nb = 0;
    const fwd = this.world.camera.getWorldDirection(this.fwd);
    const night = this.world.night > 0.05 ? this.world.night : 0;
    setLampLevels(this.bodyMat, Math.max(night, this.world.tunnel * 0.6), (time * 1.4) % 1);
    this.ng = 0;
    this.nr = 0;
    const blink = Math.floor(time * 1.6) % 2 === 0;

    // 1) 자리와 거리
    const list = this.list;
    list.length = 0;
    const measure = (a: Agent) => {
      const pool = this.pool(a.typeIndex);
      if (!pool) return;
      this.place(a);
      this.tmp.setFromMatrixPosition(this.m);
      const d2 = this.tmp.distanceToSquared(camera);
      if (d2 > draw * draw) return;
      let sl = this.slots[list.length];
      if (!sl) this.slots.push((sl = { a, pool, d2, m: new THREE.Matrix4(), kappa: 0, back: false }));
      sl.a = a;
      sl.pool = pool;
      sl.d2 = d2;
      sl.m.copy(this.m);
      sl.kappa = this.rs.kappa;
      // 차 뒤끝이 카메라보다 1m 앞까지는 뒤차로 친다
      sl.back = this.tmp.sub(camera).dot(fwd) - a.len / 2 < 1;
      list.push(sl);
    };
    for (const a of agents) measure(a);
    for (const a of opposite) measure(a);
    // 2) 가까운 차부터 (먼저 그린 차가 뒤차 화소를 가린다)
    list.sort(byDist);

    const add = (sl: Slot) => {
      const { a, pool, d2 } = sl;
      this.m.copy(sl.m);
      this.kappa = sl.kappa;
      this.back = sl.back;
      if (night) this.nightLights(a, pool.model, camera, night);
      const sigL = (a.hazard || a.signal < 0) && blink ? 1 : 0;
      const sigR = (a.hazard || a.signal > 0) && blink ? 1 : 0;
      const brake = a.brake ? 1 : 0;
      if (d2 >= mid2) {
        // 먼 차: 공용 모양, 기울기 없이
        const t = a.type;
        const far = t.length > 6 ? this.far.tall : this.far.car;
        if (far.n >= far.cap) return;
        this.bm.copy(this.m).scale(this.sv.set(a.len, t.height, a.width));
        this.put(far, this.bm, t.category === "화물" ? this.color.set(0x9aa0a6) : this.visOf(a).color, brake, sigL, sigR);
        return;
      }
      const vis = this.motion(a, pool);
      // 차체 행렬: 바퀴 축 높이를 중심으로 기울인다
      this.e.set(vis.roll, 0, vis.pitch, "YZX");
      this.q.setFromEuler(this.e);
      this.tm.compose(this.sv.set(0, pool.pivotY, 0), this.q, this.tmp.set(1, 1, 1));
      this.bm.makeTranslation(0, -pool.pivotY, 0).premultiply(this.tm).premultiply(this.m);
      if (d2 < near2) {
        const inst = (pool.near ??= this.inst(pool.model.body, NEAR_CAP, true, this.bodyMat, true, -0.7));
        if (inst.n < inst.cap) {
          this.put(inst, this.bm, vis.color, brake, sigL, sigR);
          this.putWheels(pool, vis);
          return;
        }
      }
      if (d2 < mid2) {
        const inst = (pool.mid ??= this.inst(pool.model.mid, MID_CAP, false, this.bodyMat, true));
        if (inst.n < inst.cap) {
          this.put(inst, this.bm, vis.color, brake, sigL, sigR);
          return;
        }
      }
      const t = a.type;
      const far = t.length > 6 ? this.far.tall : this.far.car;
      if (far.n >= far.cap) return;
      this.bm.copy(this.m).scale(this.sv.set(a.len, t.height, a.width));
      this.put(far, this.bm, t.category === "화물" ? this.color.set(0x9aa0a6) : vis.color, brake, sigL, sigR);
    };
    for (const sl of list) add(sl);

    const finish = (inst: Inst | null) => {
      if (!inst) return;
      const m = inst.mesh;
      m.count = inst.n;
      m.visible = inst.n > 0;
      if (inst.n > 0) {
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, inst.n * 16);
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) {
          m.instanceColor.clearUpdateRanges();
          m.instanceColor.addUpdateRange(0, inst.n * 3);
          m.instanceColor.needsUpdate = true;
        }
        inst.lamp.clearUpdateRanges();
        inst.lamp.addUpdateRange(0, inst.n * 4);
        inst.lamp.needsUpdate = true;
      }
    };
    for (const p of this.pools) {
      if (!p) continue;
      finish(p.near);
      finish(p.mid);
    }
    finish(this.wheels.car);
    finish(this.wheels.heavy);
    finish(this.far.car);
    finish(this.far.tall);

    const rf = this.reflect;
    rf.count = this.nr;
    rf.visible = this.nr > 0;
    if (this.nr > 0) {
      rf.instanceMatrix.clearUpdateRanges();
      rf.instanceMatrix.addUpdateRange(0, this.nr * 16);
      rf.instanceMatrix.needsUpdate = true;
      rf.instanceColor!.clearUpdateRanges();
      rf.instanceColor!.addUpdateRange(0, this.nr * 3);
      rf.instanceColor!.needsUpdate = true;
    }

    const g = this.glow.geometry;
    g.setDrawRange(0, this.ng);
    this.glow.visible = this.ng > 0;
    if (this.ng > 0) {
      for (const name of ["position", "color", "size"]) {
        const attr = g.getAttribute(name) as THREE.BufferAttribute;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, this.ng * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
  }

  /** 이번 프레임에 자리 잡은 차 중 카메라에서 maxDist 안 (물보라 등). m은 노면 위 자리·방향 */
  nearby(maxDist: number, fn: (m: THREE.Matrix4, a: Agent) => void) {
    const max2 = maxDist * maxDist;
    for (const sl of this.list) if (sl.d2 <= max2) fn(sl.m, sl.a);
  }

  private put(inst: Inst, m: THREE.Matrix4, color: THREE.Color, brake: number, sigL: number, sigR: number) {
    const i = inst.n++;
    if (this.back) inst.nb = inst.n;
    inst.mesh.setMatrixAt(i, m);
    if (inst.mesh.instanceColor) inst.mesh.setColorAt(i, color);
    inst.lamp.setXYZW(i, brake, sigL, sigR, 0);
  }

  /** 바퀴: 차체 기울기는 따르지 않고 굴러가고 앞바퀴는 꺾인다 */
  private putWheels(pool: Pool, vis: Vis) {
    for (const w of pool.model.wheels) {
      const inst = w.heavy ? this.wheels.heavy : this.wheels.car;
      if (inst.n >= inst.cap) return;
      const left = w.z < 0;
      const ang = (vis.spin * pool.r0) / w.r;
      // 휠 면이 바깥을 보게 왼쪽 바퀴는 뒤집는다. 뒤집으면 도는 방향도 반대
      this.e.set(0, (w.steer ? vis.steer : 0) + (left ? Math.PI : 0), left ? ang : -ang, "YZX");
      this.q.setFromEuler(this.e);
      this.wm.compose(this.p.set(w.x, w.r, w.z), this.q, this.sv.set(w.r, w.r, w.w)).premultiply(this.m);
      const i = inst.n++;
      if (this.back) inst.nb = inst.n;
      inst.mesh.setMatrixAt(i, this.wm);
    }
  }

  /** 몇 종류의 차가 지금 화면에 나오는지 (검수용) */
  visibleTypes(): string[] {
    return this.pools.filter((p): p is Pool => !!p && ((p.near?.n ?? 0) > 0 || (p.mid?.n ?? 0) > 0)).map((p) => p.model.type.id);
  }
}

// ---------- 먼 차: 공용 모양 (크기 1, 인스턴스 행렬로 늘인다) ----------

const FAR_GLASS: Surf = { color: 0x0b1117, r: 0.1, m: 0.2, c: 0, tag: TAG.GLASS };
const FAR_TAIL: Surf = { color: 0x8e0d14, r: 0.2, m: 0.1, c: 0, tag: TAG.TAIL };
const FAR_HEAD: Surf = { color: 0xe8eef6, r: 0.2, m: 0.3, c: 0, tag: TAG.DRL };
const FAR_DARK: Surf = { color: 0x151617, r: 0.9, m: 0, c: 0, tag: 0 };

/** 승용차 모양: 아래 몸체 + 좁은 유리 지붕 */
function farCar(): THREE.BufferGeometry {
  const m = new Mesher();
  const P = paintSurf(1, 0.5);
  box(m, 1, 0.42, 1, 0, 0.36, 0, P);
  box(m, 0.94, 0.12, 0.96, 0, 0.09, 0, FAR_DARK);
  box(m, 0.5, 0.36, 0.84, -0.06, 0.74, 0, FAR_GLASS);
  box(m, 0.44, 0.04, 0.8, -0.06, 0.93, 0, P);
  for (const s of [-1, 1]) {
    box(m, 0.02, 0.06, 0.22, -0.505, 0.5, s * 0.36, FAR_TAIL);
    box(m, 0.02, 0.05, 0.2, 0.505, 0.47, s * 0.35, FAR_HEAD);
  }
  return m.build();
}

/** 버스·트럭 모양: 상자 + 창 띠 */
function farTall(): THREE.BufferGeometry {
  const m = new Mesher();
  const P = paintSurf(1, 0.3);
  box(m, 1, 0.84, 1, 0, 0.56, 0, P);
  box(m, 0.96, 0.12, 0.9, 0, 0.08, 0, FAR_DARK);
  box(m, 0.02, 0.3, 0.88, 0.505, 0.66, 0, FAR_GLASS);
  for (const s of [-1, 1]) {
    box(m, 0.02, 0.05, 0.12, -0.505, 0.2, s * 0.38, FAR_TAIL);
    box(m, 0.02, 0.04, 0.12, 0.505, 0.2, s * 0.36, FAR_HEAD);
  }
  return m.build();
}
