// 후처리: 밤·터널에서 전조등·미등 빛이 은은하게 번지게 한다 (high 품질만).
// 낮에는 쓰지 않고 바로 화면에 그린다 (추가 비용 없음).

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export class PostFx {
  enabled = false;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private size = { w: 1, h: 1, pr: 1 };

  constructor(private renderer: THREE.WebGLRenderer) {}

  setSize(w: number, h: number, pr: number) {
    this.size = { w, h, pr };
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    }
  }

  private init() {
    const { w, h, pr } = this.size;
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(this.renderer, rt);
    c.setPixelRatio(pr);
    c.setSize(w, h);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.55, 1.1);
    c.addPass(this.renderPass);
    c.addPass(this.bloom);
    c.addPass(new OutputPass());
    this.composer = c;
  }

  /** amount(0~1): 빛 번짐 정도. 후처리를 쓰면 true (화면에 이미 그렸다) */
  render(scene: THREE.Scene, camera: THREE.Camera, amount: number): boolean {
    if (!this.enabled || amount < 0.05) return false;
    if (!this.composer) this.init();
    this.renderPass!.scene = scene;
    this.renderPass!.camera = camera;
    this.bloom!.strength = 0.25 + 0.45 * amount;
    this.bloom!.threshold = 1.05 - 0.2 * amount;
    this.composer!.render();
    return true;
  }
}
