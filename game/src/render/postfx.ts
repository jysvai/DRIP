// 후처리: 밤·터널에서 전조등·미등 빛이 은은하게 번지게 한다 (high 품질만).
// 장면은 평소처럼 화면에 바로 그리고(계단 현상 방지 그대로), 빛 번짐만 1/4 해상도로 따로 그려 위에 더한다.
// 낮에는 아무것도 하지 않는다 (추가 비용 없음).

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 밝은 부분만 남기며 반으로 줄인다 (부드러운 문턱)
const PREFILTER = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 pick(vec2 uv) {
  vec3 c = texture2D(tMap, uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = clamp(l - uThreshold, 0.0, 4.0) / max(l, 1e-4);
  return c * k;
}
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = pick(vUv) * 4.0 + pick(vUv - h) + pick(vUv + h) + pick(vUv + vec2(h.x, -h.y)) + pick(vUv - vec2(h.x, -h.y));
  gl_FragColor = vec4(s / 8.0, 1.0);
}`;

// 줄이기 (dual filter)
const DOWN = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture2D(tMap, vUv).rgb * 4.0;
  s += texture2D(tMap, vUv - h).rgb + texture2D(tMap, vUv + h).rgb;
  s += texture2D(tMap, vUv + vec2(h.x, -h.y)).rgb + texture2D(tMap, vUv - vec2(h.x, -h.y)).rgb;
  gl_FragColor = vec4(s / 8.0, 1.0);
}`;

// 키우기 (dual filter). uGain: 세기, uOut: 1이면 화면용으로 눌러 담는다
const UP = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uGain;
uniform float uOut;
varying vec2 vUv;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture2D(tMap, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture2D(tMap, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture2D(tMap, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture2D(tMap, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture2D(tMap, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture2D(tMap, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture2D(tMap, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture2D(tMap, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  vec3 c = s / 12.0 * uGain;
  // 화면(톤매핑 뒤)에 더할 때는 1을 넘지 않게 눌러 담는다
  if (uOut > 0.5) c = 1.0 - exp(-c);
  gl_FragColor = vec4(c, 1.0);
}`;

function pass(frag: string, additive: boolean, extra: Record<string, THREE.IUniform> = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, ...extra },
    vertexShader: VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NoBlending,
  });
}

export class PostFx {
  enabled = false;
  private size = { w: 1, h: 1, pr: 1 };
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private levels: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private prefilter = pass(PREFILTER, false, { uThreshold: { value: 1 } });
  private down = pass(DOWN, false);
  private up = pass(UP, true, { uGain: { value: 1 }, uOut: { value: 0 } });

  constructor(private renderer: THREE.WebGLRenderer) {}

  setSize(w: number, h: number, pr: number) {
    this.size = { w, h, pr };
    if (this.sceneRT) this.allocate();
  }

  private allocate() {
    this.sceneRT?.dispose();
    for (const l of this.levels) l.dispose();
    const { w, h, pr } = this.size;
    // 장면은 가로세로 1/4, 번짐 단계는 거기서 1/2씩
    const W = Math.max(8, Math.round((w * pr) / 4));
    const H = Math.max(8, Math.round((h * pr) / 4));
    this.sceneRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType });
    this.levels = [];
    for (let k = 1; k <= 4; k++) {
      this.levels.push(new THREE.WebGLRenderTarget(Math.max(2, W >> k), Math.max(2, H >> k), { type: THREE.HalfFloatType, depthBuffer: false }));
    }
  }

  private draw(mat: THREE.ShaderMaterial, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget | null, clear: boolean) {
    const r = this.renderer;
    mat.uniforms.tMap.value = src.texture;
    mat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    this.quad.material = mat;
    r.setRenderTarget(dst);
    if (clear) r.clear(true, false, false);
    this.quad.render(r);
  }

  /**
   * 장면을 화면에 그린 다음에 부른다. amount(0~1): 빛 번짐 정도.
   * 장면을 작게 한 번 더 그려 밝은 곳만 흐리게 퍼뜨려 화면에 더한다.
   */
  addGlow(scene: THREE.Scene, camera: THREE.Camera, amount: number) {
    if (!this.enabled || amount < 0.05) return;
    if (!this.sceneRT) this.allocate();
    const r = this.renderer;
    const autoClear = r.autoClear;
    const shadowAuto = r.shadowMap.autoUpdate;
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    // 1) 작은 화면에 장면 (톤매핑 전 밝기 그대로)
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);
    // 2) 밝은 곳만 남기며 줄인다
    const L = this.levels;
    this.prefilter.uniforms.uThreshold.value = 1.1 - 0.25 * amount;
    this.draw(this.prefilter, this.sceneRT!, L[0], true);
    for (let k = 1; k < L.length; k++) this.draw(this.down, L[k - 1], L[k], true);
    // 3) 키우며 윗단계에 더한다 (넓은 번짐 + 좁은 번짐)
    this.up.uniforms.uOut.value = 0;
    this.up.uniforms.uGain.value = 1;
    for (let k = L.length - 1; k > 0; k--) this.draw(this.up, L[k], L[k - 1], false);
    // 4) 화면에 더한다
    this.up.uniforms.uOut.value = 1;
    this.up.uniforms.uGain.value = 0.35 + 0.5 * amount;
    this.draw(this.up, L[0], null, false);
    r.setRenderTarget(null);
    r.autoClear = autoClear;
    r.shadowMap.autoUpdate = shadowAuto;
  }
}
