// 플레이어 차: 겉모습, 운전석 실내, 시점 세 가지, 거울 세 개.
// 차체는 용수철-감쇠로 제동·가속에 앞뒤로, 곡선에서 좌우로 기울고 노면 따라 조금 떨린다. 바퀴는 굴러가고 앞바퀴는 꺾인다.
// 운전석 시점에서는 유리를 숨기고 차 안쪽 면·대시보드·운전대를 그린다. 눈 위치는 차종마다 다르다(모델의 cabin).
// 한국 차는 왼쪽 운전석. 차 모델 좌표: x 앞, y 위, z 오른쪽 (vehicleModels.ts와 같다)

import * as THREE from "three";
import type { Road } from "../road/road";
import type { PlayerCar } from "../sim/player";
import { createVehicleMaterial, setLampLevels, vehicleUniforms } from "./carMaterials";
import { buildCockpit, type Cockpit } from "./cockpit";
import { buildVehicleModel, wheelGeometry, type VehicleModel, type VehicleType, type WheelSpec } from "./vehicleModels";
import type { World } from "./world";

export type CameraMode = "cockpit" | "hood" | "chase";
export const CAMERA_MODES: CameraMode[] = ["cockpit", "hood", "chase"];
export const CAMERA_LABELS: Record<CameraMode, string> = { cockpit: "운전석", hood: "보닛", chase: "차 뒤" };

const STEER_RATIO = 14;

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
  private headBeam: THREE.SpotLight | null = null;
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
  private frameCount = 0;
  private tmpW = { e: 0, n: 0, z: 0, heading: 0 };
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  mode: CameraMode = "cockpit";
  mirrorsOn = true;

  constructor(
    private world: World,
    readonly type: VehicleType,
    color: string,
    hudRoot: HTMLElement,
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
    this.inner.add(this.interior);
    world.scene.add(this.car);

    // ---- 거울: 화면 구석 창 + 차 안팎의 거울 유리 (운전석 시점에서만 비친다) ----
    const mk = (eye: THREE.Vector3, dir: THREE.Vector3, fov: number, aspect: number, w: number): Mirror => {
      const h = Math.round(w / aspect);
      const cam = new THREE.PerspectiveCamera(fov, aspect, 0.5, 900);
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 2 });
      const mat = new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.DoubleSide });
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
    this.mirrors.push(mk(cab.mirrorL.clone(), new THREE.Vector3(-1, -0.03, -side), 19, ga(1), 360));
    this.mirrors.push(mk(cab.mirrorR.clone(), new THREE.Vector3(-1, -0.03, side + 0.03), 19, ga(2), 360));
    // 거울 유리에 비친 모습 (거울이라 좌우를 뒤집는다)
    this.mirrors.forEach((mr, i) => {
      const g = cab.glass[i];
      const geo = new THREE.PlaneGeometry(g.w, g.h);
      const uv = geo.getAttribute("uv");
      for (let k = 0; k < uv.count; k++) uv.setX(k, 1 - uv.getX(k));
      const mat = new THREE.MeshBasicMaterial({ map: mr.rt.texture, color: 0xd8dde2 });
      const glass = new THREE.Mesh(geo, mat);
      glass.position.set(g.c.x - 0.0015, g.c.y, g.c.z);
      glass.rotation.y = -Math.PI / 2;
      this.mirrorGlass.add(glass);
    });
    this.inner.add(this.mirrorGlass);
    world.onQuality((_, s) => {
      for (const m of this.mirrors) m.rt.setSize(Math.round(m.size[0] * s.mirrorScale), Math.round(m.size[1] * s.mirrorScale));
    });
    this.layoutMirrors();
    addEventListener("resize", () => this.layoutMirrors());
    this.setMode(this.mode);
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    const cockpit = mode === "cockpit";
    this.interior.visible = cockpit;
    this.mirrorGlass.visible = cockpit;
    vehicleUniforms(this.bodyMat).uHideGlass.value = cockpit ? 1 : 0;
    this.chase.init = false;
    const big = this.model.cabin.kind === "bus" || this.model.cabin.kind === "truck";
    this.world.camera.fov = mode === "chase" ? 60 : mode === "hood" ? 60 : big ? 64 : 60;
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
    const sw = Math.min(250, W * 0.17);
    const [a0, a1, a2] = this.mirrors.map((m) => m.aspect);
    const rects = [
      { x: (W - rw) / 2, y: 10, w: rw, h: rw / a0 },
      { x: 12, y: H * 0.46, w: sw, h: sw / a1 },
      { x: W - 12 - sw, y: H * 0.46, w: sw, h: sw / a2 },
    ];
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
    const bump = roadNoise(car.s) * vib;
    const pitchT = Math.max(-0.035, Math.min(0.028, car.ax * (heavy ? 0.0012 : 0.0021))) + bump * 0.0007;
    const rollT = Math.max(-0.05, Math.min(0.05, car.ay * (heavy ? 0.0075 : 0.0055)));
    const pitch = this.pitch.step(pitchT, h);
    const roll = this.roll.step(rollT, h);
    const heave = this.heave.step(bump * 0.0028, h);
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
    const blink = Math.floor(time * 1.6) % 2 === 0;
    const left = (signal === -1 || hazard) && blink;
    const right = (signal === 1 || hazard) && blink;
    vehicleUniforms(this.bodyMat).uLampState.value.set(braking ? 1 : 0, left ? 1 : 0, right ? 1 : 0, car.vx < -0.1 ? 1 : 0);
    setLampLevels(this.bodyMat, Math.max(this.night, this.world.tunnel * 0.6), (time * 1.4) % 1);
    setLampLevels(this.cockpit.material, Math.max(this.night, this.world.tunnel * 0.4), 0);
    // 실내 화면: 밤에는 눈부시지 않게 어둡게. 계기판에 지금 속도
    this.cockpit.screen.color.setScalar(1 - 0.55 * this.night);
    if (this.mode === "cockpit") {
      this.cockpit.display.update(speed * 3.6, car.vx < -0.1 ? "R" : speed < 0.1 ? "P" : "D", time);
      // 창으로 들어와 실내에 퍼지는 빛 (천장·기둥이 너무 어둡지 않게)
      const day = Math.min(1, this.world.daylight) * (1 - this.night);
      const f = Math.max(day * 0.5 * (1 - this.world.tunnel * 0.7), 0.02);
      vehicleUniforms(this.cockpit.material).uFill.value.setRGB(f, f * 0.98, f * 0.95);
    }

    // ---- 카메라 ----
    const cam = this.world.camera;
    this.car.updateMatrixWorld(true);
    if (this.mode === "cockpit") {
      // 머리: 가속하면 뒤로, 제동하면 앞으로, 곡선에서 바깥으로 조금. 노면 따라 살짝 흔들린다
      const hx = this.headX.step(Math.max(-0.035, Math.min(0.035, -car.ax * 0.0035)), h);
      const hz = this.headZ.step(Math.max(-0.04, Math.min(0.04, car.ay * 0.0045)), h);
      const hy = bump * 0.0015 * vib;
      // 곡선에서 가는 쪽을 조금 먼저 본다
      this.lookYaw += (Math.max(-0.07, Math.min(0.07, car.r * 0.35)) - this.lookYaw) * Math.min(1, h * 3);
      this.v.set(cab.eye.x + hx, cab.eye.y + hy, cab.eye.z + hz);
      cam.position.copy(this.inner.localToWorld(this.v));
      const down = heavy ? 0.075 : 0.05;
      this.v2.set(cab.eye.x + 20 * Math.cos(this.lookYaw), cab.eye.y - 20 * down, cab.eye.z + hz - 20 * Math.sin(this.lookYaw));
      cam.up.set(0, 1, 0).applyQuaternion(this.body.getWorldQuaternion(this.q));
      cam.lookAt(this.inner.localToWorld(this.v2));
    } else if (this.mode === "hood") {
      cam.position.copy(this.inner.localToWorld(this.v.copy(cab.hoodEye)));
      cam.up.set(0, 1, 0).applyQuaternion(this.car.getWorldQuaternion(this.q));
      cam.lookAt(this.inner.localToWorld(this.v2.set(cab.hoodEye.x + 20, cab.hoodEye.y - 0.8, 0)));
    } else {
      this.updateChase(yaw, speed, h);
    }
    cam.updateMatrixWorld(true);
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

  /** 본 화면과 거울을 그린다 */
  render() {
    const r = this.world.renderer;
    const scene = this.world.scene;
    this.frameCount++;
    const show = this.showMirrors;
    // 운전석 시점이면 거울 창을 꺼도 차의 거울 유리에 비치므로 계속 그린다
    if (this.mode === "cockpit" && this.frameCount % this.world.settings.mirrorEvery === 0) {
      const m = this.mirrors[this.mirrorTurn++ % this.mirrors.length];
      m.cam.position.copy(this.inner.localToWorld(this.v.copy(m.eye)));
      this.v2.copy(m.eye).addScaledVector(m.dir, 20);
      m.cam.up.set(0, 1, 0);
      m.cam.lookAt(this.inner.localToWorld(this.v2));
      m.cam.updateMatrixWorld(true);
      const vis = this.car.visible;
      this.car.visible = false;
      r.setRenderTarget(m.rt);
      r.clear();
      r.render(scene, m.cam);
      this.car.visible = vis;
    }
    r.setRenderTarget(null);
    r.shadowMap.needsUpdate = true;
    r.clear();
    const glow = Math.max(this.world.night, this.world.tunnel * 0.7);
    if (!this.world.post.render(scene, this.world.camera, glow)) r.render(scene, this.world.camera);
    if (show) {
      r.clearDepth();
      r.render(this.overlay, this.overlayCam);
    }
  }
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
