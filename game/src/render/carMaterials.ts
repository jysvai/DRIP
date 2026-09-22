// 차 재질: 물리 기반 재질 하나에 꼭짓점 속성(surf = 거칠기, 금속성, 클리어코트, 표시)을 읽게 해서
// 도색(클리어코트 금속 도장)·유리·크롬·고무·등화를 한 번에 그린다. 인스턴스마다 도색 색과 등화 상태가 다르다.

import * as THREE from "three";

export interface VehicleMaterialOptions {
  /** 등화(제동등·방향지시등)를 켜고 끄는 코드를 넣는다 */
  lamps?: boolean;
  /** 클리어코트 (낮은 화질에서는 끈다) */
  clearcoat?: boolean;
}

export interface VehicleUniforms {
  /** 인스턴스가 아닐 때 도색 색 */
  uPaint: { value: THREE.Color };
  /** x: 주간등 밝기, y: 밤(전조등·미등) 밝기, z: 경광등 박자(0~1), w: 제동등 밝기 */
  uLamp: { value: THREE.Vector4 };
  /** 인스턴스가 아닐 때 등화 상태. x: 제동, y: 왼쪽 깜빡이, z: 오른쪽, w: 후진 */
  uLampState: { value: THREE.Vector4 };
  /** 1이면 유리를 그리지 않는다 (운전석 시점) */
  uHideGlass: { value: number };
}

/** 인스턴스 메시에 붙이는 등화 상태 속성 이름 (vec4: 제동, 왼쪽, 오른쪽, 후진) */
export const LAMP_ATTR = "lampState";

const VERT_PARS = /* glsl */ `
attribute vec4 surf;
varying vec4 vSurf;
varying vec3 vEmit;
uniform vec3 uPaint;
uniform vec4 uLamp;
#ifdef DRIP_LAMPS
  #ifdef USE_INSTANCING
    attribute vec4 lampState;
  #else
    uniform vec4 uLampState;
  #endif
#endif
`;

const VERT_COLOR = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
float dripTag = surf.w;
float dripPaint = step( 15.5, dripTag );
dripTag -= 16.0 * dripPaint;
#ifdef USE_INSTANCING_COLOR
  vec3 dripPaintCol = instanceColor.rgb;
#else
  vec3 dripPaintCol = uPaint;
#endif
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor.rgb *= mix( vec3( 1.0 ), dripPaintCol, dripPaint );
#endif
// 밝은 색 도색은 솔리드(펄), 어두운 색은 메탈릭에 가깝게
float dripLum = dot( dripPaintCol, vec3( 0.2126, 0.7152, 0.0722 ) );
float dripMetal = mix( surf.y, surf.y * mix( 1.0, 0.3, smoothstep( 0.2, 0.7, dripLum ) ), dripPaint );
vSurf = vec4( surf.x, dripMetal, surf.z, dripTag );
vEmit = vec3( 0.0 );
#ifdef DRIP_LAMPS
  #ifdef USE_INSTANCING
    vec4 st = lampState;
  #else
    vec4 st = uLampState;
  #endif
  float e = 0.0;
  if ( dripTag > 0.5 && dripTag < 1.5 ) e = uLamp.y * 2.6;                       // 전조등
  else if ( dripTag > 1.5 && dripTag < 2.5 ) e = uLamp.y * 0.9 + st.x * uLamp.w;  // 미등 + 제동
  else if ( dripTag > 2.5 && dripTag < 3.5 ) e = st.y * 4.0;                      // 왼쪽 깜빡이
  else if ( dripTag > 3.5 && dripTag < 4.5 ) e = st.z * 4.0;                      // 오른쪽 깜빡이
  else if ( dripTag > 4.5 && dripTag < 5.5 ) e = st.x * uLamp.w * 1.2;            // 보조 제동등
  else if ( dripTag > 5.5 && dripTag < 6.5 ) e = st.w * 2.5;                      // 후진등
  else if ( dripTag > 6.5 && dripTag < 7.5 ) e = step( 0.5, uLamp.z ) * 5.0;      // 경광등 A
  else if ( dripTag > 7.5 && dripTag < 8.5 ) e = ( 1.0 - step( 0.5, uLamp.z ) ) * 5.0; // 경광등 B
  else if ( dripTag > 8.5 && dripTag < 9.5 ) e = 0.35 + uLamp.y * 1.4;            // 표시등 (택시등·행선지)
  else if ( dripTag > 9.5 && dripTag < 10.5 ) e = uLamp.x;                        // 주간등
  #ifdef USE_COLOR
    vec3 lampCol = color / max( max( color.r, color.g ), max( color.b, 0.02 ) );
  #else
    vec3 lampCol = vec3( 1.0 );
  #endif
  vEmit = lampCol * e;
#endif
`;

const FRAG_PARS = /* glsl */ `
varying vec4 vSurf;
varying vec3 vEmit;
uniform float uHideGlass;
`;

export function createVehicleMaterial(opts: VehicleMaterialOptions = {}): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    clearcoat: opts.clearcoat === false ? 0 : 1,
    clearcoatRoughness: 0.05,
  });
  const u: VehicleUniforms = {
    uPaint: { value: new THREE.Color(1, 1, 1) },
    uLamp: { value: new THREE.Vector4(1.3, 0, 0, 3.2) },
    uLampState: { value: new THREE.Vector4() },
    uHideGlass: { value: 0 },
  };
  mat.userData.u = u;
  if (opts.lamps) mat.defines = { DRIP_LAMPS: "" };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace("#include <color_pars_vertex>", "#include <color_pars_vertex>\n" + VERT_PARS).replace("#include <color_vertex>", VERT_COLOR);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <color_pars_fragment>", "#include <color_pars_fragment>\n" + FRAG_PARS)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n if ( uHideGlass > 0.5 && abs( vSurf.w - 12.0 ) < 0.5 ) discard;")
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness * vSurf.x;")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = metalness * vSurf.y;")
      .replace("#include <lights_physical_fragment>", THREE.ShaderChunk.lights_physical_fragment.replace("material.clearcoat = clearcoat;", "material.clearcoat = clearcoat * vSurf.z;"))
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += vEmit;");
  };
  mat.customProgramCacheKey = () => "drip-vehicle";
  return mat;
}

export function vehicleUniforms(mat: THREE.Material): VehicleUniforms {
  return mat.userData.u as VehicleUniforms;
}

/** 밤 정도(0~1)에 맞춰 등화 밝기를 정한다 */
export function setLampLevels(mat: THREE.Material, night: number, beaconPhase: number) {
  const u = vehicleUniforms(mat);
  if (!u) return;
  u.uLamp.value.set(1.3 + night * 1.2, night, beaconPhase, 3.2);
}
