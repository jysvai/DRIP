// 플레이어 차: 겉모습, 운전석 실내(대시보드·운전대·필러·천장), 시점 세 가지, 거울 세 개.
// 한국 차는 왼쪽 운전석이라 눈 위치를 차 중심에서 왼쪽으로 옮긴다.
// 차 모델 좌표: x 앞, y 위, z 오른쪽 (vehicleModels.ts와 같다)

import * as THREE from "three";
import type { Road } from "../road/road";
import type { PlayerCar } from "../sim/player";
import { buildVehicleModel, type VehicleType } from "./vehicleModels";
import type { World } from "./world";

export type CameraMode = "cockpit" | "hood" | "chase";
export const CAMERA_MODES: CameraMode[] = ["cockpit", "hood", "chase"];
export const CAMERA_LABELS: Record<CameraMode, string> = { cockpit: "운전석", hood: "보닛", chase: "차 뒤" };

const STEER_RATIO = 14;
const MIRROR_EVERY = 1; // 한 프레임에 거울 하나씩 돌아가며 그린다

interface Mirror {
  cam: THREE.PerspectiveCamera;
  rt: THREE.WebGLRenderTarget;
  quad: THREE.Mesh;
  frame: HTMLDivElement;
  eye: THREE.Vector3;
  dir: THREE.Vector3;
  rect: { x: number; y: number; w: number; h: number };
}

function interiorMat(color: number) {
  // 실내는 반사광을 흉내 내려고 조금 스스로 밝힌다
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.35 });
}

/** 두 점 사이를 잇는 막대 (A필러 등) */
function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, t: number, mat: THREE.Material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, t, w), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  return m;
}

export class PlayerView {
  readonly car = new THREE.Group();
  private exterior = new THREE.Group();
  private interior = new THREE.Group();
  private wheelSpin = new THREE.Group();
  private brakeLights: THREE.Mesh[] = [];
  private brakeMat = new THREE.MeshBasicMaterial({ color: 0xff2a1f, toneMapped: false });
  private headBeam: THREE.SpotLight | null = null;
  private night = 0;
  private headPos = new THREE.Vector3();
  private sigL: THREE.Mesh[] = [];
  private sigR: THREE.Mesh[] = [];
  private eye: THREE.Vector3;
  private hoodEye: THREE.Vector3;
  private chaseYaw = 0;
  private chaseInit = false;
  private headShift = 0;
  private mirrors: Mirror[] = [];
  private overlay = new THREE.Scene();
  private overlayCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private mirrorTurn = 0;
  private frameCount = 0;
  private tmpW = { e: 0, n: 0, z: 0, heading: 0 };
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  mode: CameraMode = "cockpit";
  mirrorsOn = true;

  constructor(
    private world: World,
    readonly type: VehicleType,
    color: string,
    hudRoot: HTMLElement,
  ) {
    const L = type.length;
    const W = type.width;
    const H = type.height;
    const model = buildVehicleModel(type, 7);
    for (const p of model.headLights) this.headPos.addScaledVector(p, 1 / model.headLights.length);
    const paint = new THREE.Mesh(model.paint, new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.45 }));
    const fixed = new THREE.Mesh(model.fixed, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }));
    for (const m of [paint, fixed]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.exterior.add(m);
    }
    const lampGeo = new THREE.BoxGeometry(0.07, 0.13, 0.28);
    const brakeMat = this.brakeMat;
    const sigMat = new THREE.MeshBasicMaterial({ color: 0xffa31a, toneMapped: false });
    for (const p of model.brakeLights) {
      const m = new THREE.Mesh(lampGeo, brakeMat);
      m.position.copy(p);
      this.brakeLights.push(m);
      this.exterior.add(m);
    }
    for (const [list, out] of [
      [model.signalLeft, this.sigL],
      [model.signalRight, this.sigR],
    ] as const) {
      for (const p of list) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.16), sigMat);
        m.position.copy(p);
        m.visible = false;
        out.push(m);
        this.exterior.add(m);
      }
    }
    this.car.add(this.exterior);

    // ---- 실내 ----
    const dashMat = interiorMat(0x1f2123);
    const trimMat = interiorMat(0x2c2d30);
    const headMat = interiorMat(0x9d998f);
    const front = L / 2;
    const glassBase = front - 0.29 * L; // 앞유리 아래
    const roofFront = front - 0.44 * L;
    const belt = 0.64 * H;
    this.eye = new THREE.Vector3(roofFront - 0.62, H * 0.81, -0.37);
    this.hoodEye = new THREE.Vector3(glassBase + 0.1, belt + 0.3, 0);

    // 운전석에서는 겉모습 대신 보닛 판만 보인다 (겉모습 안쪽 면이 비치지 않게)
    const hoodGeo = new THREE.BufferGeometry();
    const nose = 0.47 * H + 0.05;
    const hw = W / 2 - 0.06;
    hoodGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [glassBase, belt, -hw, glassBase, belt, hw, front - 0.12, nose, hw - 0.08, front - 0.12, nose, -hw + 0.08],
        3,
      ),
    );
    hoodGeo.setIndex([0, 2, 1, 0, 3, 2]);
    hoodGeo.computeVertexNormals();
    const hood = new THREE.Mesh(hoodGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.45, side: THREE.DoubleSide }));
    hood.receiveShadow = true;
    this.interior.add(hood);
    for (const side of [-1, 1]) {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.24), new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.4 }));
      housing.position.set(glassBase - 0.08, belt + 0.06, side * (W / 2 + 0.1));
      this.interior.add(housing);
    }

    // 대시보드: 앞끝이 보닛 뒤끝보다 조금 높고 앞에 있어야 둘 사이 틈으로 차 밑 도로가 보이지 않는다
    const dashShape = new THREE.Shape([
      new THREE.Vector2(roofFront + 0.02, belt - 0.01),
      new THREE.Vector2(glassBase + 0.06, belt + 0.01),
      new THREE.Vector2(glassBase + 0.06, belt - 0.45),
      new THREE.Vector2(roofFront + 0.1, belt - 0.5),
      new THREE.Vector2(roofFront - 0.05, belt - 0.16),
    ]);
    const dashGeo = new THREE.ExtrudeGeometry(dashShape, { depth: W - 0.16, bevelEnabled: false });
    dashGeo.translate(0, 0, -(W - 0.16) / 2);
    const dash = new THREE.Mesh(dashGeo, dashMat);
    dash.receiveShadow = true;
    this.interior.add(dash);
    // 계기판 덮개
    const binnacle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.42), trimMat);
    binnacle.position.set(roofFront + 0.1, belt + 0.02, this.eye.z);
    this.interior.add(binnacle);
    // 운전대
    const wheelBase = new THREE.Group();
    wheelBase.position.set(this.eye.x + 0.5, belt - 0.15, this.eye.z);
    wheelBase.rotation.z = -0.42;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.022, 10, 36), interiorMat(0x151617));
    rim.rotation.y = Math.PI / 2;
    this.wheelSpin.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.05, 16), trimMat);
    hub.rotation.z = Math.PI / 2;
    this.wheelSpin.add(hub);
    // 살 세 개: 아래, 왼쪽, 오른쪽
    const down = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.035), trimMat);
    down.position.set(0, -0.09, 0);
    this.wheelSpin.add(down);
    for (const side of [-1, 1]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.17), trimMat);
      spoke.position.set(0, 0, side * 0.09);
      this.wheelSpin.add(spoke);
    }
    wheelBase.add(this.wheelSpin);
    this.interior.add(wheelBase);
    // A필러, 천장, 문 안쪽
    for (const side of [-1, 1]) {
      this.interior.add(beam(new THREE.Vector3(glassBase - 0.02, belt, side * (W / 2 - 0.12)), new THREE.Vector3(roofFront, H - 0.07, side * (W / 2 - 0.16)), 0.09, 0.07, trimMat));
      const door = new THREE.Mesh(new THREE.BoxGeometry(glassBase - (roofFront - 1.6), belt - 0.3, 0.05), trimMat);
      door.position.set((glassBase + roofFront - 1.6) / 2, (belt + 0.3) / 2, side * (W / 2 - 0.07));
      this.interior.add(door);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(glassBase - (roofFront - 1.6), 0.03, 0.1), dashMat);
      sill.position.set((glassBase + roofFront - 1.6) / 2, belt + 0.01, side * (W / 2 - 0.1));
      this.interior.add(sill);
    }
    const headliner = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.04, W - 0.14), headMat);
    headliner.position.set(roofFront - 0.93, H - 0.06, 0);
    this.interior.add(headliner);
    const header = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, W - 0.2), trimMat);
    header.position.set(roofFront + 0.02, H - 0.08, 0);
    this.interior.add(header);
    // 햇빛가리개
    for (const z of [-0.37, 0.37]) {
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.015, 0.36), headMat);
      visor.position.set(roofFront - 0.1, H - 0.1, z);
      this.interior.add(visor);
    }
    this.car.add(this.interior);
    world.scene.add(this.car);

    // ---- 거울 ----
    const mk = (eye: THREE.Vector3, dir: THREE.Vector3, fov: number, aspect: number, w: number, h: number): Mirror => {
      const cam = new THREE.PerspectiveCamera(fov, aspect, 0.5, 900);
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 2 });
      const mat = new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.DoubleSide });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.overlay.add(quad);
      const frame = document.createElement("div");
      frame.className = "mirror";
      hudRoot.appendChild(frame);
      return { cam, rt, quad, frame, eye, dir: dir.normalize(), rect: { x: 0, y: 0, w: 0, h: 0 } };
    };
    const mirrorX = glassBase - 0.05;
    this.mirrors.push(mk(new THREE.Vector3(roofFront - 0.1, H - 0.12, 0), new THREE.Vector3(-1, -0.035, 0), 17, 3.2, 512, 160));
    this.mirrors.push(mk(new THREE.Vector3(mirrorX, belt + 0.02, -W / 2 - 0.12), new THREE.Vector3(-1, -0.03, -0.11), 21, 1.45, 320, 220));
    this.mirrors.push(mk(new THREE.Vector3(mirrorX, belt + 0.02, W / 2 + 0.12), new THREE.Vector3(-1, -0.03, 0.14), 21, 1.45, 320, 220));
    this.layoutMirrors();
    addEventListener("resize", () => this.layoutMirrors());
    this.setMode(this.mode);
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.interior.visible = mode === "cockpit";
    this.exterior.visible = mode !== "cockpit";
    this.chaseInit = false;
    this.world.camera.fov = mode === "chase" ? 60 : mode === "hood" ? 60 : 64;
    this.world.camera.near = mode === "cockpit" ? 0.05 : 0.1;
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

  private layoutMirrors() {
    const W = innerWidth;
    const H = innerHeight;
    const show = this.mirrorsOn;
    const rw = Math.min(380, W * 0.28);
    const sw = Math.min(230, W * 0.16);
    const rects = [
      { x: (W - rw) / 2, y: 10, w: rw, h: rw / 3.2 },
      { x: 12, y: H * 0.46, w: sw, h: sw / 1.45 },
      { x: W - 12 - sw, y: H * 0.46, w: sw, h: sw / 1.45 },
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
    this.interior.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && "emissiveIntensity" in m && m.emissiveIntensity > 0) m.emissiveIntensity = 0.35 * (1 - 0.9 * night);
    });
    if (night < 0.1 || this.headBeam) return;
    // 전조등 (하향등 정도): 차 앞 가운데에서 25m 앞 노면을 향해
    const beam = new THREE.SpotLight(0xfff1dc, 160 * night, 150, 0.42, 0.55, 1.3);
    beam.position.copy(this.headPos);
    beam.target.position.set(this.headPos.x + 25, 0, 0);
    this.car.add(beam, beam.target);
    this.headBeam = beam;
  }

  /** 차 위치·자세를 맞추고 카메라를 놓는다 */
  update(car: PlayerCar, road: Road, dt: number, signal: -1 | 0 | 1, hazard: boolean, time: number) {
    const w = road.toWorld(car.s, car.d, this.tmpW);
    const p = road.sample(car.s);
    this.world.toScene(w.e, w.n, w.z, this.car.position);
    const yaw = w.heading + car.theta;
    const roll = Math.max(-0.05, Math.min(0.05, -car.ay * 0.004));
    const pitch = Math.atan(p.grade) + Math.max(-0.03, Math.min(0.03, -car.ax * 0.003));
    this.car.rotation.set(roll, yaw, pitch, "YZX");
    this.car.updateMatrixWorld(true);

    this.wheelSpin.rotation.x = -car.steerAngle * STEER_RATIO;
    const braking = car.ax < -1.2 || (car.speed < 0.3 && car.vx === 0);
    // 밤에는 미등이 늘 켜져 있고 제동하면 더 밝아진다
    for (const m of this.brakeLights) m.visible = braking || this.night > 0.1;
    this.brakeMat.color.setHex(braking ? 0xff2a1f : 0x7a0c08);
    const blink = Math.floor(time * 1.6) % 2 === 0;
    const left = (signal === -1 || hazard) && blink;
    const right = (signal === 1 || hazard) && blink;
    for (const m of this.sigL) m.visible = left;
    for (const m of this.sigR) m.visible = right;

    const cam = this.world.camera;
    if (this.mode === "cockpit") {
      // 옆 가속도에 따라 머리가 조금 흔들린다
      this.headShift += (Math.max(-0.06, Math.min(0.06, car.ay * 0.008)) - this.headShift) * Math.min(1, dt * 6);
      this.v.copy(this.eye);
      this.v.z += this.headShift;
      cam.position.copy(this.car.localToWorld(this.v));
      this.v2.set(this.eye.x + 20, this.eye.y - 0.9, this.eye.z + this.headShift * 0.5);
      cam.up.set(0, 1, 0).applyQuaternion(this.car.quaternion);
      cam.lookAt(this.car.localToWorld(this.v2));
    } else if (this.mode === "hood") {
      cam.position.copy(this.car.localToWorld(this.v.copy(this.hoodEye)));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.car.localToWorld(this.v2.set(this.hoodEye.x + 20, this.hoodEye.y - 0.8, 0)));
    } else {
      if (!this.chaseInit) {
        this.chaseYaw = yaw;
        this.chaseInit = true;
      }
      let dy = yaw - this.chaseYaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.chaseYaw += dy * Math.min(1, dt * 4);
      const back = 7.2 + this.type.length * 0.25;
      const c = this.car.position;
      cam.position.set(c.x - Math.cos(this.chaseYaw) * back, c.y + 2.6, c.z + Math.sin(this.chaseYaw) * back);
      cam.up.set(0, 1, 0);
      cam.lookAt(c.x + Math.cos(this.chaseYaw) * 4, c.y + 1.2, c.z - Math.sin(this.chaseYaw) * 4);
    }
    cam.updateMatrixWorld(true);
  }

  /** 본 화면과 거울을 그린다 */
  render() {
    const r = this.world.renderer;
    const scene = this.world.scene;
    this.frameCount++;
    if (this.mirrorsOn && this.frameCount % MIRROR_EVERY === 0) {
      const m = this.mirrors[this.mirrorTurn++ % this.mirrors.length];
      m.cam.position.copy(this.car.localToWorld(this.v.copy(m.eye)));
      this.v2.copy(m.eye).addScaledVector(m.dir, 20);
      m.cam.up.set(0, 1, 0);
      m.cam.lookAt(this.car.localToWorld(this.v2));
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
    r.render(scene, this.world.camera);
    if (this.mirrorsOn) {
      r.clearDepth();
      r.render(this.overlay, this.overlayCam);
    }
  }
}
