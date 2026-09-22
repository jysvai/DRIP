// 메뉴의 차량 미리보기: 고른 차를 작은 3D 무대 위에서 천천히 돌려 보여 준다.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildVehicleModel, type VehicleType } from "../render/vehicleModels";

export class VehiclePreview {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 2, 0.1, 200);
  private holder = new THREE.Group();
  private current: THREE.Object3D | null = null;
  private angle = 0.9;
  private raf = 0;
  private last = performance.now();
  private dragX: number | null = null;
  private spin = 0.25;

  constructor(parent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "preview3d";
    parent.appendChild(this.canvas);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 10, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, far: 40 });
    this.scene.add(key, new THREE.HemisphereLight(0xdfe8ef, 0x202424, 0.5));
    // 받침: 둥근 무대와 그림자
    const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const disc = new THREE.Mesh(new THREE.RingGeometry(0, 1, 64), new THREE.MeshBasicMaterial({ color: 0x3ee07a, transparent: true, opacity: 0.12 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.005;
    disc.name = "disc";
    this.scene.add(floor, disc, this.holder);

    this.canvas.addEventListener("pointerdown", (e) => {
      this.dragX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.dragX === null) return;
      this.angle += (e.clientX - this.dragX) * 0.01;
      this.dragX = e.clientX;
    });
    this.canvas.addEventListener("pointerup", () => (this.dragX = null));
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (!this.canvas.isConnected) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.dragX === null) this.angle += dt * this.spin;
      this.holder.rotation.y = this.angle;
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.frame();
  }

  private size = { l: 4.8, h: 1.5, w: 1.9 };

  /** 차 크기에 맞춰 카메라 거리를 잡는다 */
  private frame() {
    const { l, h } = this.size;
    // 비스듬히 본 차 길이가 화면 폭의 약 80%, 높이가 화면 높이의 약 60%가 되게
    const tv = Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    const th = tv * this.camera.aspect;
    const dist = Math.max((l * 0.55) / th, (h * 0.95) / tv) + l * 0.25;
    this.camera.position.set(dist * 0.72, h * 0.55 + dist * 0.3, dist * 0.62);
    this.camera.lookAt(0, h * 0.42, 0);
    const disc = this.scene.getObjectByName("disc");
    if (disc) disc.scale.setScalar(l * 0.62);
  }

  show(type: VehicleType, color: string) {
    if (this.current) {
      this.holder.remove(this.current);
      this.current.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
    }
    const model = buildVehicleModel(type, 7);
    const g = new THREE.Group();
    const paint = new THREE.Mesh(model.paint, new THREE.MeshPhysicalMaterial({ vertexColors: true, color, roughness: 0.3, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.08 }));
    const fixed = new THREE.Mesh(model.fixed, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }));
    for (const m of [paint, fixed]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    g.add(paint, fixed);
    // 모델 앞(+x)을 가운데로
    const box = new THREE.Box3().setFromObject(g);
    g.position.x = -(box.min.x + box.max.x) / 2;
    g.position.z = -(box.min.z + box.max.z) / 2;
    this.current = g;
    this.holder.add(g);
    this.size = { l: type.length, h: type.height, w: type.width };
    this.frame();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
