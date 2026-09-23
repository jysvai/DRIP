// 플레이어 차: 겉모습, 운전석 실내, 시점 세 가지, 거울 세 개, 후측방 카메라.
// 차체는 용수철-감쇠로 제동·가속에 앞뒤로, 곡선에서 좌우로 기울고 노면 따라 조금 떨린다. 바퀴는 굴러가고 앞바퀴는 꺾인다.
// 화면 흔들림(Shake): 신축이음·충돌 같은 충격은 쌓였다 줄어들고, 노면요철·고속 떨림·옆 트럭 풍압은 이어진다. 빠를수록 시야가 조금 넓어진다.
// 운전석 시점에서는 유리를 숨기고 차 안쪽 면·대시보드·운전대를 그린다. 눈 위치는 차종마다 다르다(모델의 cabin).
// 한국 차는 왼쪽 운전석. 차 모델 좌표: x 앞, y 위, z 오른쪽 (vehicleModels.ts와 같다)

import * as THREE from "three";
import type { Road } from "../road/road";
import type { LkaState } from "../sim/assist";
import type { PlayerCar } from "../sim/player";
import { createVehicleMaterial, setLampLevels, vehicleUniforms } from "./carMaterials";
import { buildCockpit, type Cockpit } from "./cockpit";
import { buildVehicleModel, wheelGeometry, type VehicleModel, type VehicleType, type WheelSpec } from "./vehicleModels";
import { WindshieldRain } from "./windshield";
import type { World } from "./world";

export type CameraMode = "cockpit" | "hood" | "chase";
export const CAMERA_MODES: CameraMode[] = ["cockpit", "hood", "chase"];
export const CAMERA_LABELS: Record<CameraMode, string> = { cockpit: "운전석", hood: "보닛", chase: "차 뒤" };

const STEER_RATIO = 14;
const MIRROR_ORDER = [0, 1, 0, 2];
/** 후측방 카메라: 렌더 타깃 크기(화소), 세로 시야각, 아래·바깥으로 기우는 정도 (뒤 1m당) */
const BVM = { size: 320, fov: 64, down: 0.24, out: 0.3 };

/** 방향지시등 깜빡임: 1.6Hz (분당 96번, 딸깍 소리와 같은 박자). 켜진 반쪽이면 true */
export function blinkOn(time: number): boolean {
  return Math.floor(time * 3.2) % 2 === 0;
}

/** 화면 위 원 (CSS 화소): 가운데와 반지름 */
export interface ScreenCircle {
  x: number;
  y: number;
  r: number;
}

interface Mirror {
  cam: THREE.PerspectiveCamera;
  rt: THREE.WebGLRenderTarget;
  quad: THREE.Mesh;
  frame: HTMLDivElement;
  eye: THREE.Vector3;
  dir: THREE.Vector3;
  size: [number, number];
  aspect: number;
  rect: { x: number; y: number; w: number; h: number };
}

interface WheelPart {
  pivot: THREE.Group;
  spin: THREE.Mesh;
  spec: WheelSpec;
}

/** 용수철-감쇠 하나 (값, 속도) */
class Spring {
  x = 0;
  v = 0;
  constructor(
    private w: number,
    private z: number,
  ) {}
  step(target: number, dt: number) {
    const w = this.w;
    // 큰 dt에서도 안정하게 잘게 나눈다
    const n = Math.max(1, Math.ceil(dt / 0.02));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (w * w * (target - this.x) - 2 * this.z * w * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** 여러 사인을 겹친 부드러운 잡음 (-1~1 근처). 채널마다 다른 위상 */
function wobble(t: number, k: number): number {
  return Math.sin(t * 1.0 + k * 1.7) * 0.5 + Math.sin(t * 2.3 + k * 3.1) * 0.3 + Math.sin(t * 5.7 + k * 0.9) * 0.2;
}

/** 화면 흔들림 설정: 켜기 1, 약하게 0.45, 끄기 0 */
export const SHAKE_SCALE = { on: 1, low: 0.45, off: 0 } as const;

/**
 * 화면 흔들림. 충격은 trauma(0~1)로 쌓고 크기는 trauma²에 비례해 줄어든다 (작은 충격은 살짝, 큰 충격은 확).
 * hum: 노면요철처럼 이어지는 빠른 상하 떨림, road: 거친 노면의 잔떨림, buffet: 옆 대형차 풍압(부호 = 밀리는 쪽).
 * rough: 노면 거칠기 (road/surface.ts roughnessAt). 보통 길은 0이라 떨지 않고, 공사 구간·눈길에서만 떤다.
 */
export class Shake {
  trauma = 0;
  hum = 0;
  road = 0;
  rough = 0;
  buffet = 0;
  scale = 1;
  private t = 0;
  private sway = 0;
  /** 이번 프레임 흔들림: 위치 (m, 차 기준 앞·위·오른쪽)와 각 (rad) */
  readonly out = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };

  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  step(dt: number) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.sway += (this.buffet - this.sway) * Math.min(1, dt * 5);
    const k = this.scale;
    const o = this.out;
    const tr = this.trauma * this.trauma;
    const T = this.t * 22;
    const H = this.t * 70;
    o.x = k * tr * wobble(T, 1) * 0.04;
    o.y = k * (tr * wobble(T, 2) * 0.05 + this.hum * Math.sin(H) * 0.006 + this.road * wobble(this.t * 18, 7) * 0.0035);
    o.z = k * (tr * wobble(T, 3) * 0.05 + this.sway * 0.06);
    o.pitch = k * (tr * wobble(T, 4) * 0.035 + this.hum * Math.sin(H * 1.3) * 0.004 + this.road * wobble(this.t * 15, 8) * 0.0016);
    o.yaw = k * (tr * wobble(T, 5) * 0.025 + this.sway * 0.004);
    o.roll = k * (tr * wobble(T, 6) * 0.05 + this.sway * 0.012);
  }
}

/** 노면 요철: 거리 s에 따라 정해지는 잔잔한 떨림 (-1~1) */
function roadNoise(s: number): number {
  return Math.sin(s * 3.7) * 0.45 + Math.sin(s * 9.9 + 1.3) * 0.3 + Math.sin(s * 1.61 + 0.7) * 0.25;
}

export class PlayerView {
  readonly car = new THREE.Group();
  /** 서스펜션 위 차체 (기울기·떨림). 모델 좌표는 inner 안에 */
  private body = new THREE.Group();
  private inner = new THREE.Group();
  private exterior: THREE.Mesh;
  private interior = new THREE.Group();
  private wheels: WheelPart[] = [];
  private model: VehicleModel;
  private bodyMat: THREE.MeshPhysicalMaterial;
  private wheelMat: THREE.MeshPhysicalMaterial;
  private cockpit: Cockpit;
  /** 앞유리 빗방울·와이퍼 (운전석 시점) */
  readonly windshield: WindshieldRain;
  private headBeam: THREE.SpotLight | null = null;
  private hiddenForMirror: THREE.Object3D[] = [];
  private night = 0;
  private headPos = new THREE.Vector3();
  private pivotY: number;
  private pitch = new Spring(8.5, 0.55);
  private roll = new Spring(7.5, 0.5);
  private heave = new Spring(14, 0.45);
  private headX = new Spring(6, 0.7);
  private headZ = new Spring(6, 0.7);
  private lookYaw = 0;
  private spinAngle = 0;
  private chase = { yaw: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false, fov: 60 };
  private mirrors: Mirror[] = [];
  private mirrorGlass = new THREE.Group();
  private overlay = new THREE.Scene();
  private overlayCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private mirrorTurn = 0;
  /** 후측방 화면 (BVM): 켜진 쪽(-1 왼쪽, 1 오른쪽, 0 꺼짐), 켠 뒤 한 번이라도 그렸는지 */
  private bvm: { cam: THREE.PerspectiveCamera; rt: THREE.WebGLRenderTarget; quad: THREE.Mesh; side: number; fresh: boolean };
  /** 계기판에 띄울 차로 유지 보조 상태 (Game이 매 프레임 넣는다) */
  readonly assist: { lka: LkaState; lkaSide: number } = { lka: "off", lkaSide: 0 };
  private frameCount = 0;
  private tmpW = { e: 0, n: 0, z: 0, heading: 0 };
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  mode: CameraMode = "cockpit";
  /** 화면 가장자리 거울 창 (차의 거울 유리에도 비치므로 기본은 끔, V로 켠다) */
  mirrorsOn = false;
  readonly shake = new Shake();
  /** 시점별 기본 시야각과, 속도에 따라 더 넓어지는 만큼 */
  private baseFov = 60;
  private fovBoost = 0;

  constructor(
    private world: World,
    readonly type: VehicleType,
    color: string,
    private hudRoot: HTMLElement,
  ) {
    const model = (this.model = buildVehicleModel(type, 7));
    const cab = model.cabin;
    for (const p of model.headLights) this.headPos.addScaledVector(p, 1 / model.headLights.length);
    this.pivotY = (model.wheels[0]?.r ?? 0.33) + 0.12;

    // ---- 겉모습 ----
    this.bodyMat = createVehicleMaterial({ lamps: true });
    vehicleUniforms(this.bodyMat).uPaint.value.set(color);
    world.registerVehicleMaterial(this.bodyMat, 1);
    this.exterior = new THREE.Mesh(model.body, this.bodyMat);
    this.exterior.castShadow = true;
    this.exterior.receiveShadow = true;
    // 그림자에는 유리를 빼서 햇빛이 창으로 실내에 들어오게 한다
    this.exterior.customDepthMaterial = glassFreeDepth();
    this.inner.add(this.exterior);
    this.inner.position.y = -this.pivotY;
    this.body.position.y = this.pivotY;
    this.body.add(this.inner);
    this.car.add(this.body);

    this.wheelMat = createVehicleMaterial({});
    world.registerVehicleMaterial(this.wheelMat, 0.8);
    for (const w of model.wheels) {
      const pivot = new THREE.Group();
      pivot.position.set(w.x, w.r, w.z);
      const spin = new THREE.Mesh(wheelGeometry(w.heavy ? "heavy" : "car"), this.wheelMat);
      spin.scale.set(w.r, w.r, w.w);
      spin.castShadow = true;
      spin.receiveShadow = true;
      const flip = new THREE.Group();
      if (w.z < 0) flip.rotation.y = Math.PI;
      flip.add(spin);
      pivot.add(flip);
      this.car.add(pivot);
      this.wheels.push({ pivot, spin, spec: w });
    }

    // ---- 실내 ----
    this.cockpit = buildCockpit(model);
    world.registerVehicleMaterial(this.cockpit.material, 0.35);
    if (model.interior.getAttribute("position").count) {
      const shell = new THREE.Mesh(model.interior, this.cockpit.material);
      shell.receiveShadow = true;
      this.interior.add(shell);
    }
    this.interior.add(this.cockpit.group);
    this.windshield = new WindshieldRain(cab, type.width);
    this.inner.add(this.windshield.group);
    this.inner.add(this.interior);
    // 가까운 내 차(실내·차체)를 먼저 그려서 그 뒤에 가려지는 길·차는 색칠하지 않게 한다 (깊이 검사로 걸러진다)
    this.interior.traverse((o) => (o.renderOrder = -2));
    this.exterior.renderOrder = -1;
    world.scene.add(this.car);

    // ---- 거울: 화면 구석 창 + 차 안팎의 거울 유리 (운전석 시점에서만 비친다) ----
    const mk = (eye: THREE.Vector3, dir: THREE.Vector3, fov: number, aspect: number, w: number): Mirror => {
      const h = Math.round(w / aspect);
      // 거울에는 뒤 350m까지만 (멀리 있는 것은 작아서 안 보인다)
      const cam = new THREE.PerspectiveCamera(fov, aspect, 0.5, 350);
      const rt = mirrorTarget(w, h);
      const mat = mirrorMaterial(rt, 0xffffff, THREE.DoubleSide);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.overlay.add(quad);
      const frame = document.createElement("div");
      frame.className = "mirror";
      hudRoot.appendChild(frame);
      return { cam, rt, quad, frame, eye, dir: dir.normalize(), size: [w, h], aspect, rect: { x: 0, y: 0, w: 0, h: 0 } };
    };
    const side = cab.kind === "bus" || cab.kind === "truck" ? 0.16 : 0.11;
    const ga = (i: number) => cab.glass[i].w / cab.glass[i].h;
    this.mirrors.push(mk(cab.mirrorC.clone(), new THREE.Vector3(-1, -0.035, 0), 17, ga(0), 512));
    // 큰 차는 거울이 높아서 조금 더 아래를 본다
    const down = side > 0.12 ? -0.1 : -0.03;
    this.mirrors.push(mk(cab.mirrorL.clone(), new THREE.Vector3(-1, down, -side), 19, ga(1), 360));
    this.mirrors.push(mk(cab.mirrorR.clone(), new THREE.Vector3(-1, down, side + 0.03), 19, ga(2), 360));
    // 거울 유리에 비친 모습 (거울이라 좌우를 뒤집는다)
    this.mirrors.forEach((mr, i) => {
      const g = cab.glass[i];
      const geo = new THREE.PlaneGeometry(g.w, g.h);
      const uv = geo.getAttribute("uv");
      for (let k = 0; k < uv.count; k++) uv.setX(k, 1 - uv.getX(k));
      const mat = mirrorMaterial(mr.rt, 0xd8dde2);
      const glass = new THREE.Mesh(geo, mat);
      glass.position.set(g.c.x - 0.0015, g.c.y, g.c.z);
      glass.rotation.y = -Math.PI / 2;
      this.mirrorGlass.add(glass);
    });
    this.inner.add(this.mirrorGlass);
    // ---- 후측방 화면: 방향지시등을 켜면 그쪽 사이드미러 아래 카메라가 옆 차로 뒤쪽을 비춘다 (계기판 원 자리) ----
    const bvmRt = mirrorTarget(BVM.size, BVM.size);
    const bvmMat = mirrorMaterial(bvmRt, 0xffffff, THREE.DoubleSide, true);
    const bvmQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bvmMat);
    bvmQuad.visible = false;
    this.overlay.add(bvmQuad);
    for (const d of this.cockpit.bvm) d.material = bvmMat;
    this.bvm = { cam: new THREE.PerspectiveCamera(BVM.fov, 1, 0.05, 250), rt: bvmRt, quad: bvmQuad, side: 0, fresh: false };
    world.onQuality((_, s) => {
      for (const m of this.mirrors) m.rt.setSize(Math.round(m.size[0] * s.mirrorScale), Math.round(m.size[1] * s.mirrorScale));
      const n = Math.round(BVM.size * Math.min(1, s.mirrorScale));
      bvmRt.setSize(n, n);
    });
    this.layoutMirrors();
    addEventListener("resize", () => this.layoutMirrors());
    this.setMode(this.mode);
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    const cockpit = mode === "cockpit";
    this.interior.visible = cockpit;
    this.windshield.group.visible = cockpit;
    this.mirrorGlass.visible = cockpit;
    vehicleUniforms(this.bodyMat).uHideGlass.value = cockpit ? 1 : 0;
    this.chase.init = false;
    const big = this.model.cabin.kind === "bus" || this.model.cabin.kind === "truck";
    this.baseFov = mode === "chase" ? 60 : mode === "hood" ? 60 : big ? 64 : 60;
    this.world.camera.fov = this.baseFov + this.fovBoost;
    this.world.camera.near = cockpit ? 0.08 : 0.1;
    this.world.camera.updateProjectionMatrix();
    this.layoutMirrors();
  }

  cycleMode(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  toggleMirrors() {
    this.mirrorsOn = !this.mirrorsOn;
    this.layoutMirrors();
  }

  /** 거울은 운전석 시점에서만 보인다 */
  private get showMirrors() {
    return this.mirrorsOn && this.mode === "cockpit";
  }

  private layoutMirrors() {
    const W = innerWidth;
    const H = innerHeight;
    const show = this.showMirrors;
    const rw = Math.min(380, W * 0.28);
    const [a0, a1, a2] = this.mirrors.map((m) => m.aspect);
    // 큰 차 거울은 세로로 길다: 폭을 줄인다
    const sw = Math.min(250, W * 0.17) * (a1 < 1 ? 0.6 : 1);
    const rects = [
      { x: (W - rw) / 2, y: 10, w: rw, h: rw / a0 },
      { x: 12, y: H * (a1 < 1 ? 0.38 : 0.46), w: sw, h: sw / a1 },
      { x: W - 12 - sw, y: H * (a2 < 1 ? 0.38 : 0.46), w: sw, h: sw / a2 },
    ];
    // 오른쪽 거울 창은 오른쪽 아래 내비 화면(.fascia)을 가리지 않게 그 위로 올린다
    const fascia = this.hudRoot.querySelector(".fascia")?.getBoundingClientRect();
    if (fascia && fascia.height > 0) {
      const r = rects[2];
      if (r.x + r.w > fascia.left && r.y + r.h > fascia.top - 10) r.y = Math.max(90, fascia.top - 10 - r.h);
    }
    this.overlayCam.left = 0;
    this.overlayCam.right = W;
    this.overlayCam.top = H;
    this.overlayCam.bottom = 0;
    this.overlayCam.updateProjectionMatrix();
    this.mirrors.forEach((m, i) => {
      const r = rects[i];
      m.rect = r;
      m.frame.style.cssText = `left:${r.x - 3}px;top:${r.y - 3}px;width:${r.w}px;height:${r.h}px;display:${show ? "block" : "none"}`;
      // 거울은 좌우가 뒤집혀 보인다
      m.quad.scale.set(-r.w, r.h, 1);
      m.quad.position.set(r.x + r.w / 2, H - r.y - r.h / 2, 0);
      m.quad.visible = show;
    });
  }

  /**
   * 후측방 화면을 켜고 끈다 (side 0이면 끔). spot은 계기판(HUD)에서 비워 둔 원 자리.
   * 운전석 시점이면 차 안 계기판 화면의 같은 쪽 원에도 띄운다.
   */
  setBvm(side: number, spot: ScreenCircle | null) {
    const b = this.bvm;
    if (side !== b.side) {
      b.side = side;
      b.fresh = false;
    }
    this.cockpit.bvm[0].visible = side === -1;
    this.cockpit.bvm[1].visible = side === 1;
    b.quad.visible = side !== 0 && spot !== null;
    if (spot) {
      // 거울처럼 좌우를 뒤집어 보여 준다 (사이드미러와 같은 방향)
      b.quad.scale.set(-2 * spot.r, 2 * spot.r, 1);
      b.quad.position.set(spot.x, this.overlayCam.top - spot.y, 0);
    }
  }

  /** 밤이면 전조등을 켜고 실내를 어둡게 한다. 첫 화면을 그리기 전에 부른다 (조명 수가 바뀌면 셰이더를 다시 만든다) */
  setNight(night: number) {
    this.night = night;
    if (night < 0.1 || this.headBeam) return;
    // 전조등 (하향등 정도): 차 앞 가운데에서 25m 앞 노면을 향해
    const beam = new THREE.SpotLight(0xfff1dc, 160 * night, 150, 0.42, 0.55, 1.3);
    beam.position.copy(this.headPos);
    beam.target.position.set(this.headPos.x + 25, 0, 0);
    this.inner.add(beam, beam.target);
    this.headBeam = beam;
  }

  /** 바퀴가 턱을 넘을 때 (신축이음 등): 차체가 튀고 화면이 한 번 흔들린다. front: 앞바퀴면 앞이 먼저 들린다 */
  bump(strength: number, front: boolean) {
    this.heave.v += 0.35 * strength;
    this.pitch.v += (front ? 0.12 : -0.12) * strength;
    this.shake.add(0.16 * strength);
  }

  /** 차 위치·자세를 맞추고 카메라를 놓는다 */
  update(car: PlayerCar, road: Road, dt: number, signal: -1 | 0 | 1, hazard: boolean, time: number) {
    const w = road.toWorld(car.s, car.d, this.tmpW);
    const p = road.sample(car.s);
    this.world.toScene(w.e, w.n, w.z, this.car.position);
    const yaw = w.heading + car.theta;
    this.car.rotation.set(0, yaw, Math.atan(p.grade), "YZX");
    this.world.heading = yaw;
    const speed = Math.abs(car.vx);
    const cab = this.model.cabin;
    const heavy = cab.kind === "bus" || cab.kind === "truck";

    // ---- 서스펜션 ----
    const h = Math.max(0, Math.min(0.1, dt));
    const vib = Math.min(1, speed / 30);
    // 노면 요철은 거친 곳(공사 구간·눈길)에서만. 보통 길에서는 가감속·곡선에 따른 차체 움직임만 남는다
    const bump = roadNoise(car.s) * vib * this.shake.rough;
    const pitchT = Math.max(-0.035, Math.min(0.028, car.ax * (heavy ? 0.0012 : 0.0021))) + bump * 0.0007;
    const rollT = Math.max(-0.05, Math.min(0.05, car.ay * (heavy ? 0.0075 : 0.0055))) + this.shake.buffet * 0.006;
    const pitch = this.pitch.step(pitchT, h);
    const roll = this.roll.step(rollT, h);
    // 노면요철을 밟으면 차체가 잘게 떤다
    const hum = this.shake.hum * Math.sin(time * 90) * 0.004 * Math.min(1, speed / 10);
    const heave = this.heave.step(bump * 0.0028 + hum, h);
    this.body.rotation.set(roll, 0, pitch, "YZX");
    this.body.position.y = this.pivotY + heave;

    // ---- 바퀴 ----
    const r0 = this.model.wheels[0]?.r ?? 0.33;
    const dAng = (car.vx * h) / r0;
    this.spinAngle += Math.sign(dAng) * Math.min(Math.abs(dAng), 0.5);
    for (const wp of this.wheels) {
      const a = (this.spinAngle * r0) / wp.spec.r;
      wp.spin.rotation.z = wp.spec.z < 0 ? a : -a;
      wp.pivot.rotation.y = wp.spec.steer ? car.steerAngle : 0;
    }
    this.cockpit.wheel.rotation.x = -car.steerAngle * STEER_RATIO * (heavy ? 1.4 : 1);

    // ---- 등화 ----
    const braking = car.ax < -1.2 || (car.speed < 0.3 && car.vx === 0);
    const blink = blinkOn(time);
    const left = (signal === -1 || hazard) && blink;
    const right = (signal === 1 || hazard) && blink;
    vehicleUniforms(this.bodyMat).uLampState.value.set(braking ? 1 : 0, left ? 1 : 0, right ? 1 : 0, car.vx < -0.1 ? 1 : 0);
    setLampLevels(this.bodyMat, Math.max(this.night, this.world.tunnel * 0.6), (time * 1.4) % 1);
    setLampLevels(this.cockpit.material, Math.max(this.night, this.world.tunnel * 0.4), 0);
    // 실내 화면: 밤에는 눈부시지 않게 어둡게. 계기판에 지금 속도
    this.cockpit.screen.color.setScalar(1 - 0.55 * this.night);
    if (this.mode === "cockpit") {
      this.cockpit.display.update(speed * 3.6, car.vx < -0.1 ? "R" : speed < 0.1 ? "P" : "D", time, {
        left,
        right,
        hazard,
        lka: this.assist.lka,
        lkaSide: this.assist.lkaSide,
        bvm: this.bvm.side,
      });
      // 창으로 들어와 실내에 퍼지는 빛 (천장·기둥이 너무 어둡지 않게)
      const day = Math.min(1, this.world.daylight) * (1 - this.night);
      const f = Math.max(day * 0.5 * (1 - this.world.tunnel * 0.7), 0.02);
      vehicleUniforms(this.cockpit.material).uFill.value.setRGB(f, f * 0.98, f * 0.95);
    }

    // ---- 앞유리: 빗방울은 뒤 하늘빛(안개 색)을 띠고, 밤·터널에서는 어둡다 ----
    const lit = Math.max(0.35, Math.min(1, this.world.daylight) * (1 - this.night) * (1 - this.world.tunnel * 0.6));
    this.windshield.update(h, speed * 3.6, this.world.tunnel > 0.5, lit, (this.world.scene.fog as THREE.Fog | null)?.color ?? null);

    // ---- 카메라 ----
    const cam = this.world.camera;
    this.car.updateMatrixWorld(true);
    const sh = this.shake;
    sh.road = sh.rough * Math.min(1, speed / 25);
    sh.step(h);
    // 속도감: 시속 60km부터 빨라질수록 시야를 넓힌다 (최대 +6도, 흔들림을 끄면 그대로)
    const boost = sh.scale > 0 && this.mode !== "chase" ? Math.max(0, Math.min(1, (speed * 3.6 - 60) / 120)) * 6 * Math.min(1, sh.scale + 0.3) : 0;
    this.fovBoost += (boost - this.fovBoost) * Math.min(1, h * 1.5);
    if (this.mode !== "chase" && Math.abs(cam.fov - (this.baseFov + this.fovBoost)) > 0.01) {
      cam.fov = this.baseFov + this.fovBoost;
      cam.updateProjectionMatrix();
    }
    if (this.mode === "cockpit") {
      // 머리: 가속하면 뒤로, 제동하면 앞으로, 곡선에서 바깥으로 조금. 노면 따라 살짝 흔들린다
      const hx = this.headX.step(Math.max(-0.035, Math.min(0.035, -car.ax * 0.0035)), h);
      const hz = this.headZ.step(Math.max(-0.04, Math.min(0.04, car.ay * 0.0045)), h);
      const hy = bump * 0.0015 * vib;
      // 곡선에서 가는 쪽을 조금 먼저 본다
      this.lookYaw += (Math.max(-0.07, Math.min(0.07, car.r * 0.35)) - this.lookYaw) * Math.min(1, h * 3);
      const o = sh.out;
      this.v.set(cab.eye.x + hx + o.x, cab.eye.y + hy + o.y, cab.eye.z + hz + o.z);
      cam.position.copy(this.inner.localToWorld(this.v));
      const down = heavy ? 0.075 : 0.05;
      this.v2.set(cab.eye.x + 20 * Math.cos(this.lookYaw), cab.eye.y - 20 * down, cab.eye.z + hz - 20 * Math.sin(this.lookYaw));
      cam.up.set(0, 1, 0).applyQuaternion(this.body.getWorldQuaternion(this.q));
      cam.lookAt(this.inner.localToWorld(this.v2));
      this.applyShake(1);
    } else if (this.mode === "hood") {
      const o = sh.out;
      cam.position.copy(this.inner.localToWorld(this.v.set(cab.hoodEye.x + o.x, cab.hoodEye.y + o.y, cab.hoodEye.z + o.z)));
      cam.up.set(0, 1, 0).applyQuaternion(this.car.getWorldQuaternion(this.q));
      cam.lookAt(this.inner.localToWorld(this.v2.set(cab.hoodEye.x + 20, cab.hoodEye.y - 0.8, 0)));
      this.applyShake(1);
    } else {
      this.updateChase(yaw, speed, h);
      // 뒤에서 보면 차가 흔들리는 것이 보이므로 화면은 덜 흔든다
      this.applyShake(0.4);
    }
    cam.updateMatrixWorld(true);
  }

  /** 카메라를 자기 축으로 조금 돌린다 (흔들림 각) */
  private applyShake(k: number) {
    const o = this.shake.out;
    if (!o.pitch && !o.yaw && !o.roll) return;
    const cam = this.world.camera;
    cam.rotateX(o.pitch * k);
    cam.rotateY(o.yaw * k);
    cam.rotateZ(o.roll * k);
  }

  /** 뒤따라가는 카메라: 방향·거리가 부드럽게 따라오고 빠를수록 시야가 넓어진다 */
  private updateChase(yaw: number, speed: number, dt: number) {
    const c = this.car.position;
    const cam = this.world.camera;
    const L = this.type.length;
    const H = this.type.height;
    const back = 5.2 + L * 0.62 + Math.min(1.5, speed * 0.03);
    const up = 1.35 + H * 0.72;
    const ch = this.chase;
    if (!ch.init) {
      ch.yaw = yaw;
      ch.init = true;
    }
    let dy = yaw - ch.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    ch.yaw += dy * (1 - Math.exp(-dt * 3.2));
    const want = this.v.set(c.x - Math.cos(ch.yaw) * back, c.y + up, c.z + Math.sin(ch.yaw) * back);
    const lookAt = this.v2.set(c.x + Math.cos(ch.yaw) * 6, c.y + H * 0.55, c.z - Math.sin(ch.yaw) * 6);
    if (!ch.pos.lengthSq() || ch.pos.distanceTo(want) > 30) {
      ch.pos.copy(want);
      ch.look.copy(lookAt);
    }
    // 높이는 천천히 (오르막·내리막에서 흔들리지 않게), 나머지는 빠르게
    const k = 1 - Math.exp(-dt * 9);
    ch.pos.x += (want.x - ch.pos.x) * k;
    ch.pos.z += (want.z - ch.pos.z) * k;
    ch.pos.y += (want.y - ch.pos.y) * (1 - Math.exp(-dt * 4));
    ch.look.lerp(lookAt, 1 - Math.exp(-dt * 10));
    cam.position.copy(ch.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(ch.look);
    const fov = 58 + Math.min(10, Math.max(0, speed - 12) * 0.2);
    ch.fov += (fov - ch.fov) * (1 - Math.exp(-dt * 2));
    if (Math.abs(cam.fov - ch.fov) > 0.01) {
      cam.fov = ch.fov;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * 거울에는 내 차가 비치지 않게 숨긴다. 차 전체를 숨기면 안에 단 전조등 조명까지 빠져
   * 조명 수가 바뀌고, 그러면 모든 재질이 셰이더를 다시 고르느라 느려진다. 그래서 조명만 남기고 숨긴다.
   */
  private hideSelf() {
    const hidden = this.hiddenForMirror;
    hidden.length = 0;
    const hide = (o: THREE.Object3D) => {
      if (o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    };
    for (const o of this.car.children) if (o !== this.body) hide(o);
    for (const o of this.body.children) if (o !== this.inner) hide(o);
    for (const o of this.inner.children) if (o !== this.headBeam && o !== this.headBeam?.target) hide(o);
  }

  private showSelf() {
    for (const o of this.hiddenForMirror) o.visible = true;
    this.hiddenForMirror.length = 0;
  }

  /**
   * 후측방 카메라: 사이드미러 바로 아래에서 뒤·아래·바깥을 넓게 본다. 실제 BVM처럼 내 차 옆면과 뒷바퀴가 안쪽 가장자리에 보인다.
   * 실내·앞유리 빗방울·거울 유리는 빼고, 운전석 시점에서 숨겨 둔 차 유리는 이 화면에서만 다시 보이게 한다.
   */
  private renderBvm() {
    const b = this.bvm;
    const r = this.world.renderer;
    const m = b.side < 0 ? this.model.cabin.mirrorL : this.model.cabin.mirrorR;
    this.v.set(m.x - 0.03, m.y - 0.1, m.z);
    b.cam.position.copy(this.inner.localToWorld(this.v));
    this.v2.set(m.x - 20, m.y - 0.1 - 20 * BVM.down, m.z + b.side * 20 * BVM.out);
    b.cam.up.set(0, 1, 0).applyQuaternion(this.body.getWorldQuaternion(this.q));
    b.cam.lookAt(this.inner.localToWorld(this.v2));
    b.cam.updateMatrixWorld(true);
    const hidden = this.hiddenForMirror;
    hidden.length = 0;
    for (const o of [this.interior, this.windshield.group, this.mirrorGlass]) {
      if (o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    }
    const glass = vehicleUniforms(this.bodyMat).uHideGlass;
    const hideGlass = glass.value;
    glass.value = 0;
    const au = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    this.world.mirrorPass(true);
    r.setRenderTarget(b.rt);
    r.clear();
    r.render(this.world.scene, b.cam);
    this.world.mirrorPass(false);
    r.shadowMap.autoUpdate = au;
    glass.value = hideGlass;
    this.showSelf();
    b.fresh = true;
  }

  /** 본 화면과 거울을 그린다 */
  render() {
    const r = this.world.renderer;
    const scene = this.world.scene;
    this.frameCount++;
    const show = this.showMirrors;
    // 후측방 화면: 켠 첫 프레임은 바로, 그 뒤로는 거울을 그리지 않는 프레임에 (거울 주기가 1이면 매 프레임)
    const every = this.world.settings.mirrorEvery;
    if (this.bvm.side && (!this.bvm.fresh || every === 1 || this.frameCount % every === 1)) this.renderBvm();
    // 운전석 시점이면 거울 창을 꺼도 차의 거울 유리에 비치므로 계속 그린다
    if (this.mode === "cockpit" && this.frameCount % this.world.settings.mirrorEvery === 0) {
      // 룸미러를 양옆 거울보다 두 배 자주 (가운데, 왼쪽, 가운데, 오른쪽)
      const m = this.mirrors[MIRROR_ORDER[this.mirrorTurn++ % MIRROR_ORDER.length]];
      m.cam.position.copy(this.inner.localToWorld(this.v.copy(m.eye)));
      this.v2.copy(m.eye).addScaledVector(m.dir, 20);
      m.cam.up.set(0, 1, 0);
      m.cam.lookAt(this.inner.localToWorld(this.v2));
      m.cam.updateMatrixWorld(true);
      this.hideSelf();
      // 그림자 지도는 본 화면에서만 새로 그린다 (거울은 앞 프레임 것을 쓴다)
      const au = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      this.world.mirrorPass(true);
      r.setRenderTarget(m.rt);
      r.clear();
      r.render(scene, m.cam);
      this.world.mirrorPass(false);
      r.shadowMap.autoUpdate = au;
      this.showSelf();
    }
    r.setRenderTarget(null);
    r.shadowMap.needsUpdate = true;
    r.clear();
    const glow = Math.max(this.world.night, this.world.tunnel * 0.7);
    r.render(scene, this.world.camera);
    this.world.post.addGlow(scene, this.world.camera, glow);
    if (show || this.bvm.quad.visible) {
      r.clearDepth();
      r.render(this.overlay, this.overlayCam);
    }
  }
}

/**
 * 거울 렌더 타깃. 본 화면처럼 톤매핑·sRGB 변환까지 마친 색을 담는다.
 * three.js는 그리는 곳이 화면인지 렌더 타깃인지에 따라 재질마다 셰이더 조합을 다시 따지는데,
 * 거울과 본 화면을 매 프레임 번갈아 그리면 이 계산이 프레임 CPU 시간의 3분의 1을 먹는다.
 * 렌더 타깃을 XR 화면처럼 표시해 두면 두 곳이 같은 셰이더를 쓴다.
 */
function mirrorTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 2 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  (rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  return rt;
}

/**
 * 거울 화면을 붙이는 재질: 이미 화면 색이라 sRGB를 풀어 두고 톤매핑 없이 그린다.
 * round: 둥근 화면 (후측방 화면). 원 밖은 버리고 가장자리를 조금 어둡게 한다
 */
function mirrorMaterial(rt: THREE.WebGLRenderTarget, color: number, side: THREE.Side = THREE.FrontSide, round = false): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map: rt.texture, color, side, toneMapped: false });
  const clip = round ? "float rr = length( vMapUv - 0.5 ) * 2.0;\nif ( rr > 1.0 ) discard;\ndiffuseColor.rgb *= 1.0 - 0.45 * smoothstep( 0.72, 1.0, rr );\n" : "";
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", "diffuseColor *= sRGBTransferEOTF( texture2D( map, vMapUv ) );\n" + clip);
  };
  m.customProgramCacheKey = () => (round ? "drip-mirror-round" : "drip-mirror");
  return m;
}

/** 유리는 그림자를 만들지 않는 깊이 재질 */
function glassFreeDepth(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 surf;\nvarying float vTag;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTag = surf.w;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vTag;")
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif ( abs( vTag - 12.0 ) < 0.5 ) discard;");
  };
  m.customProgramCacheKey = () => "drip-glass-free-depth";
  return m;
}
